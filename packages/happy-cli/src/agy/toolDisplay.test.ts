import { describe, expect, it } from 'vitest';
import {
  formatAgyQuestionAnswers,
  mapAgyToolToDisplay,
  parseAgyAskQuestionInput,
  sanitizeDiffText,
} from './toolDisplay';

describe('mapAgyToolToDisplay', () => {
  it('maps both current (read_file/edit_file/write_file) and legacy (view_file/replace_file_content/write_to_file) file tools', () => {
    expect(
      mapAgyToolToDisplay('read_file', {
        Path: '/work/src/index.ts',
        StartLine: 10,
        EndLine: 29,
      }),
    ).toEqual({
      toolName: 'Read',
      args: { file_path: '/work/src/index.ts', offset: 10, limit: 20 },
    });

    expect(
      mapAgyToolToDisplay('view_file', {
        AbsolutePath: '/work/package.json',
        StartLine: 1,
        EndLine: 15,
      }),
    ).toEqual({
      toolName: 'Read',
      args: { file_path: '/work/package.json', offset: 1, limit: 15 },
    });

    expect(
      mapAgyToolToDisplay('edit_file', {
        Path: '/work/src/app.ts',
        Target: 'const port = 3000;',
        Replacement: 'const port = 8080;',
      }),
    ).toEqual({
      toolName: 'Edit',
      args: {
        file_path: '/work/src/app.ts',
        old_string: 'const port = 3000;',
        new_string: 'const port = 8080;',
      },
    });

    expect(
      mapAgyToolToDisplay('multi_replace_file_content', {
        TargetFile: '/work/src/multi.ts',
        ReplacementChunks: [{ TargetContent: 'secret' }],
      }),
    ).toEqual({
      toolName: 'Edit',
      args: { file_path: '/work/src/multi.ts' },
    });

    expect(
      mapAgyToolToDisplay('multi_replace_file_content', {
        TargetFile: '/work/src/multi.ts',
        ReplacementChunks: [
          { TargetContent: 'const a = 1;', ReplacementContent: 'const a = 2;' },
          { TargetContent: 'const b = 3;', ReplacementContent: 'const b = 4;', AllowMultiple: true },
        ],
      }),
    ).toEqual({
      toolName: 'MultiEdit',
      args: {
        file_path: '/work/src/multi.ts',
        edits: [
          { old_string: 'const a = 1;', new_string: 'const a = 2;' },
          { old_string: 'const b = 3;', new_string: 'const b = 4;', replace_all: true },
        ],
      },
    });

    expect(
      mapAgyToolToDisplay('write_file', {
        Path: '/work/src/new.ts',
        Content: 'export const ok = true;\n',
      }),
    ).toEqual({
      toolName: 'Write',
      args: {
        file_path: '/work/src/new.ts',
        content: 'export const ok = true;\n',
      },
    });

    expect(
      mapAgyToolToDisplay('write_to_file', {
        TargetFile: '/work/src/legacy.ts',
        CodeContent: 'export const legacy = 1;\n',
      }),
    ).toEqual({
      toolName: 'Write',
      args: {
        file_path: '/work/src/legacy.ts',
        content: 'export const legacy = 1;\n',
      },
    });

    expect(
      mapAgyToolToDisplay('notebook_edit', {
        Path: '/work/analysis.ipynb',
        new_source: 'private notebook cell',
      }),
    ).toEqual({
      toolName: 'NotebookEdit',
      args: { notebook_path: '/work/analysis.ipynb' },
    });
  });

  it('maps search, directory, web, subagent, workflow, and task/mcp tools to Happy native cards', () => {
    expect(mapAgyToolToDisplay('list_dir', { DirectoryPath: '/work/packages' })).toEqual({
      toolName: 'LS',
      args: { path: '/work/packages' },
    });
    expect(mapAgyToolToDisplay('grep_search', { Query: 'AgyBackend', SearchPath: '/work/src' })).toEqual({
      toolName: 'Grep',
      args: { pattern: 'AgyBackend', path: '/work/src' },
    });
    expect(mapAgyToolToDisplay('find_by_name', { Pattern: '*.test.ts', SearchDirectory: '/work' })).toEqual({
      toolName: 'Glob',
      args: { pattern: '*.test.ts', path: '/work' },
    });
    expect(mapAgyToolToDisplay('search_web', { query: 'Antigravity CLI docs', domain: 'google.dev' })).toEqual({
      toolName: 'WebSearch',
      args: { query: 'Antigravity CLI docs', allowed_domains: ['google.dev'] },
    });
    expect(mapAgyToolToDisplay('read_url_content', { Url: 'https://example.com/docs' })).toEqual({
      toolName: 'WebFetch',
      args: { url: 'https://example.com/docs' },
    });
    expect(mapAgyToolToDisplay('read_url_content', { Url: 'https://user:secret@example.com/docs' })).toEqual({
      toolName: 'WebFetch',
      args: {},
    });
    expect(
      mapAgyToolToDisplay('invoke_subagent', {
        Role: 'Codebase Researcher',
        TypeName: 'research',
        Prompt: 'private prompt body',
      }),
    ).toEqual({
      toolName: 'Agent',
      args: { description: 'Codebase Researcher', subagent_type: 'research' },
    });
    expect(mapAgyToolToDisplay('run_workflow', { Script: 'private python code' })).toEqual({
      toolName: 'Workflow',
      args: {},
    });
    expect(
      mapAgyToolToDisplay('manage_task', {
        Action: 'status',
        TaskId: 'conv-uuid-123/task-42',
        Input: 'private input',
      }),
    ).toEqual({
      toolName: 'Bash',
      args: { command: 'manage_task status task-42' },
    });
    expect(
      mapAgyToolToDisplay('call_mcp_tool', {
        ServerName: 'github',
        ToolName: 'get_pull_request',
        Arguments: { token: 'secret' },
      }),
    ).toEqual({
      toolName: 'Bash',
      args: { command: 'mcp github.get_pull_request' },
    });
    expect(mapAgyToolToDisplay('run_command', {})).toEqual({
      toolName: 'Bash',
      args: { command: 'run_command' },
    });
  });

  it('ignores non-scalar or prototype-polluting fields and sanitizes unknown tool names', () => {
    const polluted = JSON.parse(
      '{"DirectoryPath":{"nested":"hidden","__proto__":{"polluted":true}},"Extra":"secret"}',
    );
    expect(mapAgyToolToDisplay('list_dir', polluted)).toEqual({
      toolName: 'LS',
      args: {},
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    expect(mapAgyToolToDisplay('bad tool/name!', { CommandLine: 'ls' })).toEqual({
      toolName: 'agy_tool',
      args: {},
    });
  });

  it('shows scheduling time and task without forwarding the scheduled prompt or condition body', () => {
    expect(mapAgyToolToDisplay('schedule', { DurationSeconds: 15, TimerCondition: 'conversation-123/task-42', Prompt: 'private scheduled work' }))
      .toEqual({ toolName: 'Bash', args: { command: 'schedule 15s for task-42' } });
    expect(mapAgyToolToDisplay('schedule', { DurationSeconds: 15, TimerCondition: `session/task-${'1'.repeat(4096)}` }))
      .toEqual({ toolName: 'Bash', args: { command: 'schedule 15s' } });
    for (const DurationSeconds of [NaN, Infinity, -1, 604801, 'secret=private', {}]) {
      expect(mapAgyToolToDisplay('schedule', { DurationSeconds, TimerCondition: 'private arbitrary condition', Prompt: 'private prompt' }))
        .toEqual({ toolName: 'Bash', args: { command: 'schedule' } });
    }
  });

  it('shows question and options for ask_question without forwarding credentials', () => {
    expect(mapAgyToolToDisplay('ask_question', {
      questions: [{ question: 'Which branch to merge?', options: ['main', 'develop'] }],
    })).toEqual({ toolName: 'Bash', args: { command: 'ask_question "Which branch to merge?" (main, develop)' } });

    expect(mapAgyToolToDisplay('ask_question', {
      questions: [
        { question: 'Q1', options: ['opt1', 'opt2', 'opt3', 'opt4'] },
        { question: 'Q2', options: [] },
      ],
    })).toEqual({ toolName: 'Bash', args: { command: 'ask_question "Q1" (opt1, opt2, opt3...) [+1 more]' } });

    expect(mapAgyToolToDisplay('ask_question', {
      question: 'Direct question without array',
      options: ['a', 'b'],
    })).toEqual({ toolName: 'Bash', args: { command: 'ask_question "Direct question without array" (a, b)' } });

    expect(mapAgyToolToDisplay('ask_question', {
      questions: [{ question: 'Bearer secret_token_value', options: ['yes', 'no'] }],
    })).toEqual({ toolName: 'Bash', args: { command: 'ask_question [redacted] (yes, no)' } });

    expect(mapAgyToolToDisplay('ask_question', {})).toEqual({
      toolName: 'Bash',
      args: { command: 'ask_question' },
    });
  });

  it('shows target recipient for send_message without forwarding message body', () => {
    expect(mapAgyToolToDisplay('send_message', {
      Recipient: 'session-abc/worker-1',
      Message: 'private message body with secret',
    })).toEqual({ toolName: 'Bash', args: { command: 'send_message to worker-1' } });

    expect(mapAgyToolToDisplay('send_message', {
      Message: 'private message without recipient',
    })).toEqual({ toolName: 'Bash', args: { command: 'send_message' } });
  });

  it('shows subagent name for define_subagent without forwarding prompt or description', () => {
    expect(mapAgyToolToDisplay('define_subagent', {
      Name: 'code-reviewer',
      Description: 'private description',
      SystemPrompt: 'private system instructions',
    })).toEqual({ toolName: 'Bash', args: { command: 'define_subagent code-reviewer' } });

    expect(mapAgyToolToDisplay('define_subagent', {})).toEqual({
      toolName: 'Bash',
      args: { command: 'define_subagent' },
    });
  });

  it('shows target subagent for manage_subagents kill', () => {
    expect(mapAgyToolToDisplay('manage_subagents', {
      Action: 'kill',
      ConversationIds: ['swarm-root/worker-2'],
    })).toEqual({ toolName: 'Bash', args: { command: 'manage_subagents kill worker-2' } });

    expect(mapAgyToolToDisplay('manage_subagents', {
      Action: 'list',
    })).toEqual({ toolName: 'Bash', args: { command: 'manage_subagents list' } });
  });

  it('redacts credential-carrying lines in Edit/Write diffs while keeping safe lines and empty replacements', () => {
    expect(mapAgyToolToDisplay('edit_file', {
      Path: '/work/config.ts',
      Target: 'const host = "localhost";\nconst apiKey = "sk-live-secret-123";\nexport default host;',
      Replacement: '',
    })).toEqual({
      toolName: 'Edit',
      args: {
        file_path: '/work/config.ts',
        old_string: 'const host = "localhost";\n[redacted]\nexport default host;',
        new_string: '',
      },
    });

    expect(mapAgyToolToDisplay('write_file', {
      Path: '/work/.env.example',
      Content: 'PORT=3000\nAuthorization: Bearer super-secret-token\nDEBUG=false',
    })).toEqual({
      toolName: 'Write',
      args: {
        file_path: '/work/.env.example',
        content: 'PORT=3000\n[redacted]\nDEBUG=false',
      },
    });
  });

  it('prevents ReDoS on long single-line diffs, redacts PEM/OPENAI_KEY/bracketed secrets, and marks omitted MultiEdit chunks', () => {
    const startedAt = performance.now();
    const longSafeLine = 'token-'.repeat(5000);
    expect(sanitizeDiffText(longSafeLine)).toBe(longSafeLine);
    const longUrlLikeLine = 'a'.repeat(50_000) + '://example.com/path @slopus/happy-wire';
    expect(sanitizeDiffText(longUrlLikeLine)).toBe(longUrlLikeLine);
    expect(performance.now() - startedAt).toBeLessThan(100);

    expect(sanitizeDiffText([
      'const header = true;',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      '-----END OPENSSH PRIVATE KEY-----',
      'OPENAI_KEY=sk-proj-1234567890abcdef',
      "process.env['API_KEY'] = 'live-secret';",
      'const footer = true;',
    ].join('\n'))).toBe([
      'const header = true;',
      '[redacted]',
      '[redacted]',
      '[redacted]',
      'const footer = true;',
    ].join('\n'));

    // Multi-byte Korean boundary safety
    const hangul = '가나다라마바사'.repeat(20);
    const truncatedHangul = sanitizeDiffText(hangul, 32)!;
    expect(truncatedHangul.endsWith('...')).toBe(true);
    expect(truncatedHangul).not.toContain('\uFFFD');

    // MultiEdit exceeding 64 KB budget must stay MultiEdit and surface omitted chunk count
    const hugeChunk = 'x'.repeat(40_000);
    const multi = mapAgyToolToDisplay('multi_replace_file_content', {
      TargetFile: '/work/large.ts',
      ReplacementChunks: [
        { TargetContent: hugeChunk, ReplacementContent: hugeChunk },
        { TargetContent: 'const hidden = 1;', ReplacementContent: 'const hidden = 2;' },
      ],
    });
    expect(multi.toolName).toBe('MultiEdit');
    const edits = multi.args.edits as Array<{ old_string: string; new_string: string }>;
    expect(edits).toHaveLength(2);
    expect(edits[1].new_string).toContain('1 more edit chunk(s) omitted');
  });

  it('parses valid ask_question schemas into interactive cards and rejects empty or credential-bearing inputs', () => {
    const single = parseAgyAskQuestionInput({
      questions: [{
        question: '어느 HA를 확인하면 될까요?',
        options: ['(Recommended) 기존 HA (10.8.0.14)', 'Simba HA', 'Simba HA'],
        is_multi_select: false,
      }],
    });
    expect(single).toEqual([{
      id: 'q_0',
      header: 'Question',
      question: '어느 HA를 확인하면 될까요?',
      options: [
        { label: '(Recommended) 기존 HA (10.8.0.14)', description: '' },
        { label: 'Simba HA', description: '' },
      ],
      isOther: true,
      isSecret: false,
    }]);
    expect(formatAgyQuestionAnswers(single!, { q_0: { answers: ['(Recommended) 기존 HA (10.8.0.14)'] } }))
      .toBe('(Recommended) 기존 HA (10.8.0.14)');

    const multi = parseAgyAskQuestionInput({
      questions: [
        { question: 'Pick features', options: ['Auth', 'Logs'], is_multi_select: true },
        { question: 'Pick env', options: ['Staging', 'Prod'] },
      ],
    });
    expect(multi?.[0]).toMatchObject({ id: 'q_0', header: 'Question 1', multiSelect: true });
    expect(multi?.[1]).toMatchObject({ id: 'q_1', header: 'Question 2' });
    expect(formatAgyQuestionAnswers(multi!, {
      q_0: { answers: ['Auth', 'Logs'] },
      q_1: { answers: ['Staging'] },
    })).toBe('1. Pick features\nAuth, Logs\n\n2. Pick env\nStaging');

    expect(parseAgyAskQuestionInput({})).toBeNull();
    expect(parseAgyAskQuestionInput({ questions: [{ question: 'No options', options: [] }] })).toBeNull();
    expect(parseAgyAskQuestionInput({ questions: [{ question: 'Bearer secret_token_123', options: ['a'] }] })).toBeNull();
    expect(parseAgyAskQuestionInput({ questions: [{ question: 'Safe?', options: ['sk-live-secret-token-value'] }] })).toBeNull();
    expect(parseAgyAskQuestionInput({ questions: [{ question: 'Oversized?', options: ['x'.repeat(5000)] }] })).toBeNull();
    expect(formatAgyQuestionAnswers(multi!, {
      q_0: { answers: ['Auth', 'Auth', 'Logs'] },
      q_1: { answers: ['Staging'] },
    })).toBe('1. Pick features\nAuth, Logs\n\n2. Pick env\nStaging');
    expect(formatAgyQuestionAnswers(single!, {})).toBeNull();
  });
});
