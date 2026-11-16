/** Transport-independent Antigravity tool-card mapping and diagnostic redaction. */

export interface DisplayTool {
  toolName: string;
  args: Record<string, unknown>;
}

const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_ARG_BYTES = 4096;
export const MAX_TOOL_DIFF_BYTES = 64 * 1024;

const PEM_PRIVATE_KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i;
const PEM_PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gi;
const AUTH_SCHEME_RE = /\b(?:Bearer|Basic)\s+\S+/i;
const KNOWN_TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/;
const URL_USERINFO_RE = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s@]+@/i;

// Atomic identifier / flag matchers (`(?=...)` + backreference `\1`) prevent polynomial
// backtracking on long single-line inputs like `'token-'.repeat(5000)`.
const ATOMIC_ASSIGNMENT_RE = /(?<![A-Za-z0-9_-])(?:(?=([A-Za-z0-9_-]+))\1)["'\]]*\s*(?:=|:)\s*\S+/g;
const ATOMIC_CLI_FLAG_RE = /(?:^|\s)(?:(?=(--?[A-Za-z0-9_-]+))\1)(?:=|\s)\s*\S+/g;

const SECRET_IDENTIFIER_RE = /(?:authorization|cookie|credential|password|passwd|private[-_]?key|access[-_]?key|secret|token|api[-_]?key)|(?:^|[_-])key$/i;
const SECRET_FLAG_RE = /^(?:-u|--user)$/i;

function hasSecretAssignment(value: string): boolean {
  if (!value.includes('=') && !value.includes(':')) return false;
  ATOMIC_ASSIGNMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATOMIC_ASSIGNMENT_RE.exec(value)) !== null) {
    if (SECRET_IDENTIFIER_RE.test(match[1])) {
      return true;
    }
  }
  return false;
}

function hasSecretCliFlag(value: string): boolean {
  if (!value.includes('-')) return false;
  ATOMIC_CLI_FLAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATOMIC_CLI_FLAG_RE.exec(value)) !== null) {
    const flag = match[1];
    if (SECRET_FLAG_RE.test(flag) || SECRET_IDENTIFIER_RE.test(flag.replace(/^--?/, ''))) {
      return true;
    }
  }
  return false;
}

export function containsCredentialCarrier(value: string): boolean {
  if (!value) return false;
  if (PEM_PRIVATE_KEY_HEADER_RE.test(value)) return true;
  if (AUTH_SCHEME_RE.test(value)) return true;
  if (KNOWN_TOKEN_PREFIX_RE.test(value)) return true;
  if (value.includes('://') && value.includes('@') && URL_USERINFO_RE.test(value)) return true;
  if (hasSecretAssignment(value)) return true;
  if (hasSecretCliFlag(value)) return true;
  return false;
}

/**
 * Redact any line carrying credential-like tokens (and multi-line PEM blocks)
 * while keeping safe diagnostic lines intact.
 */
export function sanitizeDiagnosticText(value: string, maxChars = 2000): string {
  const withoutAnsi = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (!withoutAnsi) return '';

  const bounded = withoutAnsi.length > maxChars * 4
    ? withoutAnsi.slice(-maxChars * 4)
    : withoutAnsi;
  const withoutPem = bounded.replace(PEM_PRIVATE_KEY_BLOCK_RE, '[redacted]');
  const sanitizedLines = withoutPem.split(/\r?\n/).map((line) =>
    containsCredentialCarrier(line) ? '[redacted]' : line,
  );
  return sanitizedLines.join('\n').trim().slice(-maxChars);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function truncateUtf8(value: string, maxBytes = MAX_TOOL_ARG_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 3) return '.'.repeat(Math.max(0, maxBytes));
  const prefix = Buffer.from(value)
    .subarray(0, maxBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}...`;
}

function safeString(value: unknown, redacted = '[redacted]'): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const totalBytes = Buffer.byteLength(value, 'utf8');
  // Bound input before regex scanning to prevent CPU DoS on multi-megabyte strings.
  const bounded = totalBytes > MAX_TOOL_ARG_BYTES + 1024
    ? Buffer.from(value, 'utf8').subarray(0, MAX_TOOL_ARG_BYTES + 1024).toString('utf8').replace(/\uFFFD$/, '')
    : value;
  if (containsCredentialCarrier(bounded)) return redacted;
  const truncated = truncateUtf8(bounded, MAX_TOOL_ARG_BYTES);
  return containsCredentialCarrier(truncated) ? redacted : truncated;
}

/**
 * Sanitize code/file diff payloads line-by-line (and across multi-line PEM blocks)
 * so safe source lines render in Edit/Write diff views while credential-carrying
 * lines are replaced with `[redacted]`.
 */
export function sanitizeDiffText(value: unknown, maxBytes = MAX_TOOL_DIFF_BYTES): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0) return '';

  const totalBytes = Buffer.byteLength(value, 'utf8');
  const wasOversized = totalBytes > maxBytes;
  const windowBytes = maxBytes + 4096;
  let boundedInput = totalBytes > windowBytes
    ? Buffer.from(value, 'utf8').subarray(0, windowBytes).toString('utf8').replace(/\uFFFD$/, '')
    : value;

  // If we sliced mid-stream at `windowBytes`, drop any incomplete trailing line so a line
  // whose credential suffix lay past `windowBytes` cannot survive after earlier redactions shrink.
  if (totalBytes > windowBytes) {
    const lastNewline = boundedInput.lastIndexOf('\n');
    if (lastNewline > 0) {
      boundedInput = boundedInput.slice(0, lastNewline);
    }
  }

  const withoutPem = boundedInput.replace(PEM_PRIVATE_KEY_BLOCK_RE, '[redacted]');
  const redactedLines = withoutPem.replace(/[^\r\n]+/g, (line) =>
    containsCredentialCarrier(line) ? '[redacted]' : line,
  );
  let truncated = truncateUtf8(redactedLines, wasOversized ? Math.max(4, maxBytes - 4) : maxBytes);
  truncated = truncated.replace(/[^\r\n]+$/u, (tail) =>
    containsCredentialCarrier(tail) ? '[redacted]' : tail,
  );
  if (wasOversized && !truncated.endsWith('...')) {
    truncated = truncateUtf8(`${truncated}\n...`, maxBytes);
  }
  return truncated;
}

function safeLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeToolName(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_TOOL_NAME_BYTES) return 'agy_tool';
  return /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : 'agy_tool';
}

function safeHttpUrl(value: unknown): string | undefined {
  const candidate = safeString(value);
  if (!candidate || candidate === '[redacted]') return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Translate Antigravity tool calls (both current `read_file`/`edit_file`/`write_file`
 * and legacy `view_file`/`replace_file_content`/`write_to_file` schemas) into
 * Happy's native tool cards while sanitizing credentials and bounding payload sizes.
 */
export function mapAgyToolToDisplay(toolName: string, parameters: unknown): DisplayTool {
  const values = isPlainRecord(parameters) ? parameters : {};
  const fallback: DisplayTool = { toolName: safeToolName(toolName), args: {} };

  switch (toolName.toLowerCase()) {
    case 'list_dir':
    case 'list_directory': {
      const path = safeString(values.DirectoryPath ?? values.Path);
      return { toolName: 'LS', args: path ? { path } : {} };
    }
    case 'read_file':
    case 'view_file':
    case 'sed_file': {
      const filePath = safeString(values.Path ?? values.AbsolutePath);
      const offset = safeLine(values.StartLine);
      const endLine = safeLine(values.EndLine);
      const limit = offset !== undefined && endLine !== undefined && endLine >= offset
        ? endLine - offset + 1
        : undefined;
      return {
        toolName: 'Read',
        args: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      };
    }
    case 'edit_file':
    case 'replace_file_content': {
      const filePath = safeString(values.Path ?? values.TargetFile ?? values.file_path);
      const oldString = sanitizeDiffText(values.Target ?? values.TargetContent ?? values.old_string);
      const newString = sanitizeDiffText(values.Replacement ?? values.ReplacementContent ?? values.new_string);
      const replaceAll = typeof values.AllowMultiple === 'boolean'
        ? values.AllowMultiple
        : typeof values.replace_all === 'boolean'
          ? values.replace_all
          : undefined;
      return {
        toolName: 'Edit',
        args: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(oldString !== undefined ? { old_string: oldString } : {}),
          ...(newString !== undefined ? { new_string: newString } : {}),
          ...(replaceAll !== undefined ? { replace_all: replaceAll } : {}),
        },
      };
    }
    case 'multi_replace_file_content': {
      const filePath = safeString(values.Path ?? values.TargetFile ?? values.file_path);
      const allRawChunks = Array.isArray(values.ReplacementChunks) ? values.ReplacementChunks : [];
      const rawChunks = allRawChunks.slice(0, 64);
      let remainingBytes = MAX_TOOL_DIFF_BYTES;
      let omittedValidChunks = Math.max(0, allRawChunks.length - rawChunks.length);
      const edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
      for (const chunk of rawChunks) {
        if (!isPlainRecord(chunk)) continue;
        const hasValidPair = typeof (chunk.TargetContent ?? chunk.Target ?? chunk.old_string) === 'string'
          && typeof (chunk.ReplacementContent ?? chunk.Replacement ?? chunk.new_string) === 'string';
        if (!hasValidPair) continue;
        if (remainingBytes <= 128) {
          omittedValidChunks += 1;
          continue;
        }
        const perFieldBudget = Math.max(64, Math.floor(remainingBytes / 2));
        const oldChunk = sanitizeDiffText(chunk.TargetContent ?? chunk.Target ?? chunk.old_string, perFieldBudget)!;
        const newChunk = sanitizeDiffText(chunk.ReplacementContent ?? chunk.Replacement ?? chunk.new_string, perFieldBudget)!;
        remainingBytes -= Buffer.byteLength(oldChunk, 'utf8') + Buffer.byteLength(newChunk, 'utf8');
        const allowMultiple = typeof chunk.AllowMultiple === 'boolean' ? chunk.AllowMultiple : undefined;
        edits.push({
          old_string: oldChunk,
          new_string: newChunk,
          ...(allowMultiple !== undefined ? { replace_all: allowMultiple } : {}),
        });
      }
      if (omittedValidChunks > 0 && edits.length > 0) {
        edits.push({
          old_string: '',
          new_string: `... [${omittedValidChunks} more edit chunk(s) omitted]`,
        });
        return {
          toolName: 'MultiEdit',
          args: {
            ...(filePath ? { file_path: filePath } : {}),
            edits,
          },
        };
      }
      if (edits.length > 1) {
        return {
          toolName: 'MultiEdit',
          args: {
            ...(filePath ? { file_path: filePath } : {}),
            edits,
          },
        };
      }
      if (edits.length === 1) {
        return {
          toolName: 'Edit',
          args: {
            ...(filePath ? { file_path: filePath } : {}),
            old_string: edits[0].old_string,
            new_string: edits[0].new_string,
            ...(edits[0].replace_all !== undefined ? { replace_all: edits[0].replace_all } : {}),
          },
        };
      }
      // Fall back to top-level Target/Replacement (e.g. from ACP diffBlock) if present.
      const fallbackOld = sanitizeDiffText(values.Target ?? values.TargetContent ?? values.old_string);
      const fallbackNew = sanitizeDiffText(values.Replacement ?? values.ReplacementContent ?? values.new_string);
      return {
        toolName: 'Edit',
        args: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(fallbackOld !== undefined ? { old_string: fallbackOld } : {}),
          ...(fallbackNew !== undefined ? { new_string: fallbackNew } : {}),
        },
      };
    }
    case 'write_file':
    case 'write_to_file': {
      const filePath = safeString(values.Path ?? values.TargetFile ?? values.file_path);
      const content = sanitizeDiffText(values.Content ?? values.CodeContent ?? values.content);
      return {
        toolName: 'Write',
        args: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(content !== undefined ? { content } : {}),
        },
      };
    }
    case 'notebook_edit': {
      const notebookPath = safeString(values.Path ?? values.TargetFile ?? values.notebook_path);
      return {
        toolName: 'NotebookEdit',
        args: notebookPath ? { notebook_path: notebookPath } : {},
      };
    }
    case 'run_command': {
      const command = safeString(values.CommandLine, '[redacted command]') ?? 'run_command';
      return { toolName: 'Bash', args: { command } };
    }
    case 'command_status':
    case 'send_command_input': {
      return { toolName: 'Bash', args: { command: toolName.toLowerCase() } };
    }
    case 'manage_task': {
      const rawAction = values.Action;
      const action = rawAction === 'list'
        || rawAction === 'status'
        || rawAction === 'kill'
        || rawAction === 'send_input'
        ? rawAction
        : undefined;
      const rawTaskId = safeString(values.TaskId);
      const taskId = rawTaskId && rawTaskId !== '[redacted]'
        ? rawTaskId.split('/').filter(Boolean).at(-1)
        : undefined;
      const command = ['manage_task', action, taskId].filter(Boolean).join(' ');
      return { toolName: 'Bash', args: { command } };
    }
    case 'schedule': {
      const seconds = values.DurationSeconds;
      const duration = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 604_800
        ? `${seconds}s` : undefined;
      const condition = values.TimerCondition;
      const task = typeof condition === 'string' && /^[a-zA-Z0-9-]+\/(task-\d{1,12})$/.test(condition)
        ? condition.split('/').at(-1) : undefined;
      return { toolName: 'Bash', args: { command: ['schedule', duration, task ? `for ${task}` : undefined].filter(Boolean).join(' ') } };
    }
    case 'call_mcp_tool': {
      const server = safeString(values.ServerName);
      const tool = safeString(values.ToolName);
      const target = [server, tool].filter((part) => part && part !== '[redacted]').join('.');
      return { toolName: 'Bash', args: { command: target ? `mcp ${target}` : 'mcp tool' } };
    }
    case 'list_resources':
    case 'read_resource': {
      const server = safeString(values.ServerName);
      const suffix = server && server !== '[redacted]' ? ` ${server}` : '';
      return { toolName: 'Bash', args: { command: `mcp ${toolName.toLowerCase()}${suffix}` } };
    }
    case 'search_web': {
      const query = safeString(values.query);
      const domain = safeString(values.domain);
      return {
        toolName: 'WebSearch',
        args: {
          ...(query && query.length >= 2 ? { query } : {}),
          ...(domain && domain !== '[redacted]' ? { allowed_domains: [domain] } : {}),
        },
      };
    }
    case 'grep_search': {
      const pattern = safeString(values.Query);
      const path = safeString(values.SearchPath);
      return {
        toolName: 'Grep',
        args: {
          ...(pattern ? { pattern } : {}),
          ...(path ? { path } : {}),
        },
      };
    }
    case 'find_by_name': {
      const pattern = safeString(values.Pattern);
      const path = safeString(values.SearchDirectory);
      return {
        toolName: 'Glob',
        args: {
          ...(pattern ? { pattern } : {}),
          ...(path ? { path } : {}),
        },
      };
    }
    case 'open_browser_url':
    case 'read_url_content': {
      const url = safeHttpUrl(values.Url ?? values.url);
      return { toolName: 'WebFetch', args: url ? { url } : {} };
    }
    case 'invoke_subagent': {
      const description = safeString(values.Role) ?? safeString(values.TypeName);
      const subagentType = safeString(values.TypeName);
      return {
        toolName: 'Agent',
        args: {
          ...(description ? { description } : {}),
          ...(subagentType ? { subagent_type: subagentType } : {}),
        },
      };
    }
    case 'define_subagent': {
      const name = safeString(values.Name ?? values.name);
      const command = ['define_subagent', name && name !== '[redacted]' ? name : undefined].filter(Boolean).join(' ');
      return { toolName: 'Bash', args: { command } };
    }
    case 'send_message': {
      const rawRecipient = safeString(values.Recipient ?? values.recipient);
      const recipient = rawRecipient && rawRecipient !== '[redacted]'
        ? rawRecipient.split('/').filter(Boolean).at(-1)
        : undefined;
      const command = ['send_message', recipient ? `to ${recipient}` : undefined].filter(Boolean).join(' ');
      return { toolName: 'Bash', args: { command } };
    }
    case 'manage_subagents': {
      const rawAction = safeString(values.Action ?? values.action);
      const action = rawAction && /^[a-z_]+$/i.test(rawAction) ? rawAction : undefined;
      const rawId = Array.isArray(values.ConversationIds) ? safeString(values.ConversationIds[0]) : safeString(values.ConversationId);
      const targetId = rawId && rawId !== '[redacted]' ? rawId.split('/').filter(Boolean).at(-1) : undefined;
      const command = ['manage_subagents', action, targetId].filter(Boolean).join(' ');
      return { toolName: 'Bash', args: { command } };
    }
    case 'swarm': {
      const rawAction = safeString(values.Action ?? values.action);
      const action = rawAction && /^[a-z_]+$/i.test(rawAction) ? rawAction : undefined;
      const command = ['swarm', action].filter(Boolean).join(' ');
      return { toolName: 'Bash', args: { command } };
    }
    case 'ask_question': {
      const rawQuestions = Array.isArray(values.questions)
        ? values.questions
        : (isPlainRecord(values.question) || typeof values.question === 'string' ? [values] : []);
      const firstQ = isPlainRecord(rawQuestions[0]) ? rawQuestions[0] : null;
      const questionText = safeString(firstQ?.question);
      const rawOptions = Array.isArray(firstQ?.options) ? firstQ.options : [];
      const options = rawOptions
        .map((opt) => safeString(opt))
        .filter((opt): opt is string => Boolean(opt) && opt !== '[redacted]');
      const optionsSnippet = options.length > 0
        ? ` (${options.slice(0, 3).join(', ')}${options.length > 3 ? '...' : ''})`
        : '';
      const moreSnippet = rawQuestions.length > 1 ? ` [+${rawQuestions.length - 1} more]` : '';
      const questionSnippet = questionText && questionText !== '[redacted]'
        ? ` "${questionText.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"').slice(0, 80)}"`
        : questionText === '[redacted]' ? ' [redacted]' : '';
      const command = `ask_question${questionSnippet}${optionsSnippet}${moreSnippet}`;
      return { toolName: 'Bash', args: { command } };
    }
    case 'run_workflow': {
      return { toolName: 'Workflow', args: {} };
    }
    default:
      return fallback;
  }
}
