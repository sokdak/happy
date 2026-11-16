/** Removable, opt-in workaround for early end_turn in AGY 1.5.9 ACP. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { projectPath } from '@/projectPath';

export const STOP_HOOK_LIMITS = { maxContinuations: 12, maxStalledContinuations: 4, maxContinuationMs: 300_000 } as const;
type Limits = { [K in keyof typeof STOP_HOOK_LIMITS]: number };
type Decision = { decision?: 'continue'; reason?: string };
type Turn = {
  sessionId: string; active: boolean; count: number; stalled: number;
  progress: number; lastProgress: number; firstContinuationAt?: number;
  lastExecution: number; seen: boolean; fullyIdle?: boolean; issue?: string;
};
const REASON = 'An existing background task is still running. Do not rerun or duplicate commands. '
  + 'Use the available task wait/status tools to wait for the existing task, then finish the requested followup. '
  + 'Do not start unrelated work or change permissions. Do not inspect, modify, disable or work around hooks or their configuration. '
  + 'If the task is an intentionally long-running server or watcher, explain that it remains running; do not stop or restart it. '
  + 'Happy bounds these continuation requests and will report unconfirmed completion if necessary.';

export function agyStopHookEnabled(value = process.env.HAPPY_AGY_STOP_HOOK): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error('HAPPY_AGY_STOP_HOOK must be 0 or 1');
}

/** Pure policy kept separate from the local transport for adversarial tests. */
export class AgyStopPolicy {
  private turn?: Turn;
  constructor(private readonly limits: Limits = STOP_HOOK_LIMITS, private readonly now = Date.now) {}
  begin(sessionId: string): void {
    this.turn = { sessionId, active: true, count: 0, stalled: 0, progress: 0, lastProgress: 0, lastExecution: -1, seen: false };
  }
  // A socket accepted during a previous turn can never act on the next one.
  epoch(): unknown { return this.turn; }
  cancel(): void { if (this.turn) this.turn.active = false; }
  progress(): void { if (this.turn?.active) this.turn.progress++; }
  snapshot() { return this.turn ? { ...this.turn } : undefined; }
  decide(input: unknown, epoch = this.epoch()): Decision {
    const t = this.turn;
    if (!t?.active || epoch !== t) return {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) { t.issue = 'invalid hook input'; return {}; }
    const d = input as Record<string, unknown>;
    if (typeof d.conversationId !== 'string') { t.issue = 'invalid hook input'; return {}; }
    if (d.conversationId !== t.sessionId) { t.issue = 'hook session mismatch'; return {}; }
    if (d.hookEventName !== 'Stop' || typeof d.terminationReason !== 'string'
      || typeof d.fullyIdle !== 'boolean' || typeof d.continuationActive !== 'boolean'
      || !Number.isSafeInteger(d.executionNum) || (d.executionNum as number) < 0) {
      t.issue = 'invalid hook input'; return {};
    }
    t.seen = true;
    t.fullyIdle = d.fullyIdle;
    // Preserve cancellation, errors and all native invocation/token limits.
    if (d.terminationReason !== 'NO_TOOL_CALL') { t.issue = 'native stop: ' + d.terminationReason.slice(0, 80); return {}; }
    if (d.fullyIdle) return {};
    // Once a limit/invalid input is seen, later hooks cannot reopen this turn.
    if (t.issue) return {};
    if ((d.executionNum as number) <= t.lastExecution) { t.issue = 'repeated hook execution'; return {}; }
    t.lastExecution = d.executionNum as number;
    if (t.count >= this.limits.maxContinuations) { t.issue = 'continuation limit reached'; return {}; }
    if (t.firstContinuationAt !== undefined && this.now() - t.firstContinuationAt >= this.limits.maxContinuationMs) {
      t.issue = 'continuation time limit reached'; return {};
    }
    if (t.progress !== t.lastProgress) t.stalled = 0;
    if (t.stalled >= this.limits.maxStalledContinuations) { t.issue = 'no completed tool progress'; return {}; }
    t.firstContinuationAt ??= this.now();
    t.lastProgress = t.progress;
    t.stalled++;
    t.count++;
    return { decision: 'continue', reason: REASON };
  }
  finish(): string | undefined {
    const t = this.turn;
    if (!t) return 'Stop hook was not initialized';
    t.active = false;
    if (!t.seen) return 'Stop hook did not report a valid result';
    if (t.issue) return 'Stop hook stopped: ' + t.issue;
    if (t.fullyIdle !== true) return 'Background completion was not confirmed';
    return undefined;
  }
}

function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** One private Unix socket/config root per AGY process, never global/project settings. */
export class AgyStopHook {
  readonly policy = new AgyStopPolicy();
  readonly workspace: string;
  readonly socketPath: string;
  private readonly root: string;
  private readonly server: Server;
  private sockets = new Set<Socket>();
  private closed = false;
  private constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'happy-agy-hook-'));
    this.workspace = join(this.root, 'workspace');
    this.socketPath = join(this.root, 'control.sock');
    this.server = createServer(socket => {
      if (this.closed || this.sockets.size >= 16) { socket.destroy(); return; }
      this.sockets.add(socket);
      const epoch = this.policy.epoch();
      let buffer = '';
      let handled = false;
      socket.setEncoding('utf8');
      socket.setTimeout(1500, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('close', () => {
        if (!handled) this.policy.decide(null, epoch);
        this.sockets.delete(socket);
      });
      socket.on('data', chunk => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4096) { handled = true; this.policy.decide(null, epoch); socket.destroy(); return; }
        if (!buffer.includes('\n')) return;
        handled = true;
        let input: unknown;
        try { input = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); } catch { input = null; }
        socket.end(JSON.stringify(this.policy.decide(input, epoch)) + '\n');
      });
    });
    // A controller error must invalidate even a prior idle observation.
    this.server.on('error', () => { this.policy.decide(null); });
  }
  static async create(): Promise<AgyStopHook> {
    if (process.platform === 'win32') throw new Error('HAPPY_AGY_STOP_HOOK is currently supported on Unix hosts only');
    const hook = new AgyStopHook();
    try {
      mkdirSync(join(hook.workspace, '.agents'), { recursive: true, mode: 0o700 });
      const command = [process.execPath, join(projectPath(), 'scripts', 'agy-stop-hook.cjs'), hook.socketPath].map(shellQuote).join(' ');
      writeFileSync(join(hook.workspace, '.agents', 'hooks.json'), JSON.stringify({
        'happy-acp-background': { Stop: [{ type: 'command', command, timeout: 5 }] },
      }), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        hook.server.once('error', reject);
        hook.server.listen(hook.socketPath, () => { hook.server.off('error', reject); resolve(); });
      });
      return hook;
    } catch (error) { hook.close(); throw error; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.policy.cancel();
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
