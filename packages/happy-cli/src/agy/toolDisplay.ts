/** Transport-independent Antigravity tool-card mapping and diagnostic redaction. */

export interface DisplayTool {
  toolName: string;
  args: Record<string, unknown>;
}

const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_ARG_BYTES = 4096;

const CREDENTIAL_CARRIER_PATTERNS = [
  /\b(?:Bearer|Basic)\s+\S+/i,
  /\b[a-z0-9_-]*(?:authorization|cookie|credential|password|passwd|private[-_]?key|secret|token|api[-_]?key)[a-z0-9_-]*["']?\s*(?:=|:)\s*\S+/i,
  /(?:^|\s)--?[a-z0-9_-]*(?:authorization|cookie|credential|password|passwd|private[-_]?key|secret|token|api[-_]?key)[a-z0-9_-]*\s+\S+/i,
  /(?:^|\s)(?:-u|--user)(?:=|\s)\s*\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i,
];

export function containsCredentialCarrier(value: string): boolean {
  return CREDENTIAL_CARRIER_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Redact any line carrying credential-like tokens while keeping safe diagnostic
 * lines (such as `print timeout after 30m0s` or `Unknown model ...`) intact.
 */
export function sanitizeDiagnosticText(value: string, maxChars = 2000): string {
  const withoutAnsi = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (!withoutAnsi) return '';

  const sanitizedLines = withoutAnsi.split(/\r?\n/).map((line) =>
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
  const prefix = Buffer.from(value)
    .subarray(0, maxBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}...`;
}

function safeString(value: unknown, redacted = '[redacted]'): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (containsCredentialCarrier(value)) return redacted;
  const truncated = truncateUtf8(value);
  return containsCredentialCarrier(truncated) ? redacted : truncated;
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
 * Happy's native tool cards while copying only safe scalar fields.
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
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const filePath = safeString(values.Path ?? values.TargetFile);
      return { toolName: 'Edit', args: filePath ? { file_path: filePath } : {} };
    }
    case 'write_file':
    case 'write_to_file': {
      const filePath = safeString(values.Path ?? values.TargetFile);
      return { toolName: 'Write', args: filePath ? { file_path: filePath } : {} };
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
      // Show only the native task identifier, never the scheduled prompt or an
      // arbitrary condition expression (both may contain private user text).
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
