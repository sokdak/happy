/**
 * Agy AgentBackend Implementation
 *
 * Drives the `agy` (Antigravity) CLI per turn via:
 *   `agy ... --output-format stream-json --print "<prompt>"`
 *
 * `stream-json` emits NDJSON `init`, `step_update`, and `result` events over stdout,
 * allowing Happy to surface intermediate progress messages, reasoning/thinking, and
 * native tool cards (`Read`, `Edit`, `Write`, `Bash`, `LS`, `Grep`, `Glob`, etc.)
 * in real time during long-running turns while keeping per-turn `--model` and
 * permission-mode flags intact.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { PermissionMode } from '@/api/types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';
import { resolveAgyBin, AGY_PRINT_TIMEOUT, resolveAgyModelName } from './constants';
import { buildAgyArgs } from './cliArgs';
import { readAgyConversationId } from './conversationStore';
import { AgyStreamTurnParser } from './streamJson';
import { containsCredentialCarrier, sanitizeDiagnosticText } from './toolDisplay';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

const MAX_AGY_ERROR_DETAIL_CHARS = 2_000;

export interface AgyBackendOptions {
  /** Working directory the agy process runs in (and the conversation cache key). */
  cwd: string;
  /** Initial permission mode; updated per turn from message meta. */
  permissionMode: PermissionMode;
  /** Initial model display name; updated per turn from message meta. */
  model?: string;
  /** Initial Happy effort key; used to resolve models with agy-specific variants. */
  effort?: string;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Optional override for resolving the resume conversation id (tests). */
  resolveConversationId?: (cwd: string) => string | null;
}

/** Parse an agy duration string ("30m", "30s", "1h") to milliseconds; defaults to 30m. */
function parsePrintTimeoutMs(value: string): number {
  const m = /^(\d+)\s*(s|m|h)$/.exec(value.trim());
  if (!m) return 30 * 60_000;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : n * 1_000;
}

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly cwd: string;
  private readonly printTimeout: string;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly resolveConversationId: (cwd: string) => string | null;

  private permissionMode: PermissionMode;
  private model?: string;
  private effort?: string;
  private conversationId: string | null = null;
  private child: ChildProcess | null = null;
  private turnSequence = 0;

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.effort = opts.effort;
    this.printTimeout = opts.printTimeout ?? AGY_PRINT_TIMEOUT;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.resolveConversationId = opts.resolveConversationId ?? readAgyConversationId;
  }

  /** Update the permission mode applied to subsequent turns. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Update the model applied to subsequent turns. */
  setModel(model: string | undefined): void {
    this.model = model;
  }

  /** Update the effort applied to subsequent turns. */
  setEffort(effort: string | undefined): void {
    this.effort = effort;
  }

  async startSession(): Promise<StartSessionResult> {
    // agy spawns lazily per prompt; there is nothing long-lived to start.
    // Deliberately do NOT seed from the cwd conversation cache: it holds whatever
    // conversation last ran in this cwd — possibly another live session's — so
    // seeding would cross-resume it. A fresh session starts a fresh conversation.
    return { sessionId: this.cwd };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    const turnNumber = ++this.turnSequence;
    const args = buildAgyArgs({
      prompt,
      model: this.model ? resolveAgyModelName(this.model, this.effort) : undefined,
      conversationId: this.conversationId,
      permissionMode: this.permissionMode,
      addDirs: [this.cwd],
      printTimeout: this.printTimeout,
    });

    this.emit({ type: 'status', status: 'running' });

    // Snapshot the cwd cache as a fallback in case the child exits before emitting
    // `init` on stdout; `stream-json` normally announces the exact `conversation_id`
    // directly in its `init` / `step_update` / `result` events.
    const preTurnCacheId =
      this.conversationId === null ? this.resolveConversationId(this.cwd) : null;

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(resolveAgyBin(), args, {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
        // agy --print blocks until stdin reaches EOF. We never write stdin, so
        // give the child an empty stdin (immediate EOF) instead of an open pipe;
        // otherwise it hangs forever and the turn never completes.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const parser = new AgyStreamTurnParser({
        turnNumber,
        emit: (msg) => this.emit(msg),
        log: (msg) => this.log(msg),
      });

      // Node can fire both 'error' and 'close' on spawn failure; act on the first only.
      let settled = false;
      let stderrTail = '';
      const watchdog = setTimeout(() => {
        this.log(`agy turn exceeded ${this.printTimeout}; killing process`);
        child.kill('SIGKILL');
      }, parsePrintTimeoutMs(this.printTimeout) + 30_000);
      const cleanup = () => {
        clearTimeout(watchdog);
        if (this.child === child) {
          this.child = null;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (chunk) {
          parser.feed(chunk);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trimEnd();
        if (text) {
          if (containsCredentialCarrier(text)) {
            this.log(`agy stderr redacted (${Buffer.byteLength(chunk, 'utf8')} bytes)`);
          } else {
            this.log(`stderr: ${text}`);
          }
        }
        stderrTail = `${stderrTail}${chunk}`.slice(-MAX_AGY_ERROR_DETAIL_CHARS * 2);
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `agy executable not found. Install the Antigravity CLI, or set HAPPY_AGY_PATH to its absolute path (tried 'agy' on PATH and ~/.local/bin/agy).`
          : sanitizeDiagnosticText(err.message, MAX_AGY_ERROR_DETAIL_CHARS) || 'agy spawn failed';
        this.emit({ type: 'status', status: 'error', detail });
        reject(err);
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        parser.finish({ failed: code !== 0 });

        // Prefer the deterministic `conversation_id` emitted by our child's
        // `stream-json` events; fall back to the cwd cache diff only if stdout
        // produced no id (e.g. early crash before `init`).
        if (this.conversationId === null) {
          if (parser.conversationId) {
            this.conversationId = parser.conversationId;
            this.log(`pinned agy conversation ${parser.conversationId} from stream-json`);
          } else {
            const cid = this.resolveConversationId(this.cwd);
            if (cid && cid !== preTurnCacheId) {
              this.conversationId = cid;
              this.log(`pinned agy conversation ${cid}`);
            } else {
              this.log('agy conversation cache unchanged after turn; not adopting (will retry next turn)');
            }
          }
        }

        const stderrDetail = sanitizeDiagnosticText(stderrTail, MAX_AGY_ERROR_DETAIL_CHARS);
        if (code === 0 && !parser.streamFailure) {
          this.emit({ type: 'status', status: 'idle' });
          resolve();
        } else {
          const failureReason = stderrDetail || parser.streamFailure;
          const detail = code === 0
            ? (failureReason ?? 'agy stream reported failure')
            : failureReason
              ? `agy exited with code ${code ?? 'null'}: ${failureReason}`
              : `agy exited with code ${code ?? 'null'}`;
          this.emit({ type: 'status', status: 'error', detail });
          reject(new Error(detail));
        }
      });
    });
  }

  async cancel(_sessionId?: SessionId): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.handlers.clear();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}
