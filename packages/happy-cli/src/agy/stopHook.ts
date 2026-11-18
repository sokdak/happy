/** Removable, opt-in workaround for early end_turn in AGY 1.5.9 ACP. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { projectPath } from '@/projectPath';

export const STOP_HOOK_LIMITS = {
  maxContinuations: 60,
  maxStalledContinuations: 24,
  maxContinuationMs: 900_000,
  initialBackoffMs: 5_000,
  maxBackoffMs: 30_000,
} as const;
export type StopHookLimits = { [K in keyof typeof STOP_HOOK_LIMITS]: number };
type Decision = { decision?: 'continue'; reason?: string };
type Turn = {
  sessionId: string; active: boolean; count: number; stalled: number;
  progress: number; lastProgress: number; delayMs: number; firstContinuationAt?: number;
  lastExecution: number; seen: boolean; fullyIdle?: boolean; issue?: string;
};
const REASON = 'An existing background task is still running. Do not rerun or duplicate commands, and do not create new schedule timers. '
  + 'Check the existing task status once; if it has finished, complete the requested followup, and if it is still running, end your response briefly without extra polling so Happy can wait before rechecking. '
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
  private readonly limits: StopHookLimits;
  private turn?: Turn;
  private listeners = new Set<() => void>();
  constructor(limits: Partial<StopHookLimits> = STOP_HOOK_LIMITS, private readonly now = Date.now) {
    this.limits = { ...STOP_HOOK_LIMITS, ...limits };
  }
  private notify(): void { for (const listener of [...this.listeners]) listener(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  begin(sessionId: string): void {
    this.turn = { sessionId, active: true, count: 0, stalled: 0, progress: 0, lastProgress: 0, delayMs: 0, lastExecution: -1, seen: false };
    this.notify();
  }
  // A socket accepted during a previous turn can never act on the next one.
  epoch(): unknown { return this.turn; }
  cancel(): void { if (this.turn?.active) { this.turn.active = false; this.notify(); } }
  progress(): void { if (this.turn?.active) { this.turn.progress++; this.notify(); } }
  canContinue(epoch: unknown, execution: number): boolean {
    const t = this.turn;
    return Boolean(t && t === epoch && t.active && !t.issue && t.fullyIdle === false && t.lastExecution === execution);
  }
  hasProgressSince(epoch: unknown, baseline: number): boolean {
    const t = this.turn;
    return Boolean(t && t === epoch && t.progress !== baseline);
  }
  plannedDelayMs(epoch = this.epoch()): number {
    const t = this.turn;
    return t && t === epoch && t.active && !t.issue ? t.delayMs : 0;
  }
  snapshot() { return this.turn ? { ...this.turn } : undefined; }
  decide(input: unknown, epoch = this.epoch()): Decision {
    const t = this.turn;
    if (!t?.active || epoch !== t || t.issue) return {};
    const fail = (issue: string): Decision => { t.issue = issue; this.notify(); return {}; };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid hook input');
    const d = input as Record<string, unknown>;
    if (typeof d.conversationId !== 'string') return fail('invalid hook input');
    if (d.conversationId !== t.sessionId) return {};
    if (d.hookEventName !== 'Stop' || typeof d.terminationReason !== 'string'
      || typeof d.fullyIdle !== 'boolean' || typeof d.continuationActive !== 'boolean'
      || !Number.isSafeInteger(d.executionNum) || (d.executionNum as number) < 0) {
      return fail('invalid hook input');
    }
    t.seen = true;
    // Preserve cancellation, errors and all native invocation/token limits.
    if (d.terminationReason !== 'NO_TOOL_CALL') return fail('native stop: ' + d.terminationReason.slice(0, 80));
    const execution = d.executionNum as number;
    if (execution < t.lastExecution || (execution === t.lastExecution && t.fullyIdle)) return {};
    if (!d.fullyIdle && execution === t.lastExecution) return fail('repeated hook execution');
    t.lastExecution = execution;
    t.fullyIdle = d.fullyIdle;
    // Retire any reply still in backoff for an earlier execution.
    this.notify();
    if (d.fullyIdle) {
      t.delayMs = 0;
      return {};
    }
    if (t.count >= this.limits.maxContinuations) return fail('continuation limit reached');
    const now = this.now();
    if (t.progress !== t.lastProgress) {
      t.stalled = 0;
      t.firstContinuationAt = now;
    }
    if (t.firstContinuationAt !== undefined && now - t.firstContinuationAt >= this.limits.maxContinuationMs) {
      return fail('continuation time limit reached');
    }
    if (t.stalled >= this.limits.maxStalledContinuations) return fail('no completed tool progress');
    t.firstContinuationAt ??= now;
    const remainingMs = Math.max(0, this.limits.maxContinuationMs - (now - t.firstContinuationAt));
    const initialBackoffMs = Math.max(0, this.limits.initialBackoffMs);
    const maxBackoffMs = Math.max(0, this.limits.maxBackoffMs);
    const rawBackoffMs = Math.min(maxBackoffMs, initialBackoffMs * (t.stalled + 1));
    t.delayMs = Math.min(rawBackoffMs, remainingMs);
    t.lastProgress = t.progress;
    t.stalled++;
    t.count++;
    return { decision: 'continue', reason: REASON };
  }
  finish(): string | undefined {
    const t = this.turn;
    if (!t) return 'Stop hook was not initialized';
    if (t.active) { t.active = false; this.notify(); }
    if (t.issue) return 'Stop hook stopped: ' + t.issue;
    if (!t.seen) return 'Stop hook did not report a valid result';
    if (t.fullyIdle !== true) return 'Background completion was not confirmed';
    return undefined;
  }
}

function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** One private Unix socket/config root per AGY process, never global/project settings. */
export class AgyStopHook {
  readonly policy: AgyStopPolicy;
  readonly workspace: string;
  readonly socketPath: string;
  private readonly root: string;
  private readonly server: Server;
  private sockets = new Set<Socket>();
  private closed = false;
  private constructor(limits: StopHookLimits) {
    this.policy = new AgyStopPolicy(limits);
    this.root = mkdtempSync(join(tmpdir(), 'happy-agy-hook-'));
    this.workspace = join(this.root, 'workspace');
    this.socketPath = join(this.root, 'control.sock');
    this.server = createServer(socket => {
      if (this.closed || this.sockets.size >= 16) { socket.destroy(); return; }
      this.sockets.add(socket);
      const epoch = this.policy.epoch();
      let buffer = '';
      let handled = false;
      let responded = false;
      let cleanupWait: (() => void) | undefined;
      socket.setEncoding('utf8');
      socket.setTimeout(1500, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('close', () => {
        cleanupWait?.();
        if (!responded) this.policy.decide(null, epoch);
        this.sockets.delete(socket);
      });
      socket.on('data', chunk => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4096) { handled = true; this.policy.decide(null, epoch); socket.destroy(); return; }
        if (!buffer.includes('\n')) return;
        handled = true;
        socket.setTimeout(0);
        let input: unknown;
        try { input = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); } catch { input = null; }
        const decision = this.policy.decide(input, epoch);
        const delayMs = decision.decision === 'continue' ? this.policy.plannedDelayMs(epoch) : 0;
        if (decision.decision !== 'continue' || delayMs <= 0) {
          responded = true;
          socket.end(JSON.stringify(decision) + '\n');
          return;
        }
        const { lastExecution, progress } = this.policy.snapshot()!;
        let settled = false;
        const finishWait = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          if (this.closed || socket.destroyed || !socket.writable) return;
          responded = true;
          const payload = this.policy.canContinue(epoch, lastExecution) ? decision : {};
          socket.end(JSON.stringify(payload) + '\n');
        };
        cleanupWait = finishWait;
        const timer = setTimeout(finishWait, delayMs);
        const unsubscribe = this.policy.subscribe(() => {
          if (!this.policy.canContinue(epoch, lastExecution) || this.policy.hasProgressSince(epoch, progress)) {
            finishWait();
          }
        });
      });
    });
    // A controller error must invalidate even a prior idle observation.
    this.server.on('error', () => { this.policy.decide(null); });
  }
  static async create(limits: Partial<StopHookLimits> = {}): Promise<AgyStopHook> {
    if (process.platform === 'win32') throw new Error('HAPPY_AGY_STOP_HOOK is currently supported on Unix hosts only');
    const resolved: StopHookLimits = { ...STOP_HOOK_LIMITS, ...limits };
    const hook = new AgyStopHook(resolved);
    try {
      mkdirSync(join(hook.workspace, '.agents'), { recursive: true, mode: 0o700 });
      const maxBackoffMs = Math.max(0, resolved.maxBackoffMs);
      const clientTimeoutMs = Math.min(120_000, Math.max(2_500, maxBackoffMs + 2_500));
      const hookTimeoutSec = Math.max(5, Math.ceil((clientTimeoutMs + 2_500) / 1_000));
      const command = [process.execPath, join(projectPath(), 'scripts', 'agy-stop-hook.cjs'), hook.socketPath, String(clientTimeoutMs)].map(shellQuote).join(' ');
      writeFileSync(join(hook.workspace, '.agents', 'hooks.json'), JSON.stringify({
        'happy-acp-background': { Stop: [{ type: 'command', command, timeout: hookTimeoutSec }] },
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
