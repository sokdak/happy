import { describe, expect, it } from 'vitest';
import { mapAgyToolToDisplay } from './toolDisplay';

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
        Target: 'private old body',
        Replacement: 'private new body',
      }),
    ).toEqual({
      toolName: 'Edit',
      args: { file_path: '/work/src/app.ts' },
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
      mapAgyToolToDisplay('write_file', {
        Path: '/work/src/new.ts',
        Content: 'private file body',
      }),
    ).toEqual({
      toolName: 'Write',
      args: { file_path: '/work/src/new.ts' },
    });

    expect(
      mapAgyToolToDisplay('write_to_file', {
        TargetFile: '/work/src/legacy.ts',
        CodeContent: 'private file body',
      }),
    ).toEqual({
      toolName: 'Write',
      args: { file_path: '/work/src/legacy.ts' },
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
});
