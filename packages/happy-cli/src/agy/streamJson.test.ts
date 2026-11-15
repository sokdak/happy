import { sessionEnvelopeSchema } from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';

import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import {
  AgyStreamTurnParser,
  MAX_STREAM_RECORD_BYTES,
} from './streamJson';
import { sanitizeDiagnosticText } from './toolDisplay';

describe('AgyStreamTurnParser', () => {
  it('streams multi-step progress, thinking, and tools into valid Happy wire envelopes without duplicating result.response', () => {
    const messages: AgentMessage[] = [];
    const mapper = new AcpSessionManager();
    const envelopes = mapper.startTurn();

    const parser = new AgyStreamTurnParser({
      turnNumber: 1,
      emit: (msg) => {
        messages.push(msg);
        envelopes.push(...mapper.mapMessage(msg));
      },
    });

    const records = [
      { event: 'init', conversation_id: 'conv-live-1', init: { model: 'gemini-4-carbon-high' } },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-live-1',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'reasoning',
          text_delta: 'Inspecting workspace files first.',
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: '먼저 설정 파일을 ',
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '확인하겠습니다.\n',
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { parameters: { Path: '/work/config.ts', StartLine: 1, EndLine: 20 } },
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 3,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { output: 'private file contents' },
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 4,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: '확인이 완료되었습니다.',
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 4,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '\n',
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: 'conv-live-1',
          status: 'SUCCESS',
          response: '확인이 완료되었습니다.\n',
          usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125 },
        },
      },
    ];

    // Feed split across arbitrary chunk boundaries and CRLF line endings
    const wire = records.map((r) => JSON.stringify(r)).join('\r\n');
    for (let i = 0; i < wire.length; i += 37) {
      parser.feed(wire.slice(i, i + 37));
    }
    parser.finish();
    envelopes.push(...mapper.endTurn('completed'));

    expect(parser.conversationId).toBe('conv-live-1');
    expect(parser.streamFailure).toBeNull();

    for (const env of envelopes) {
      expect(sessionEnvelopeSchema.safeParse(env).success).toBe(true);
    }

    expect(envelopes.map((e) => e.ev)).toEqual([
      { t: 'turn-start' },
      { t: 'text', text: 'Inspecting workspace files first.', thinking: true },
      { t: 'text', text: '먼저 설정 파일을 확인하겠습니다.' },
      {
        t: 'tool-call-start',
        call: expect.any(String),
        name: 'Read',
        title: 'Read',
        description: 'Running Read',
        args: { file_path: '/work/config.ts', offset: 1, limit: 20 },
      },
      { t: 'tool-call-end', call: expect.any(String) },
      { t: 'text', text: '확인이 완료되었습니다.' },
      { t: 'turn-end', status: 'completed' },
    ]);
    expect(JSON.stringify(messages)).not.toContain('private file contents');
  });

  it('redacts credential-bearing commands, tool outputs, and diagnostic text', () => {
    const messages: AgentMessage[] = [];
    const parser = new AgyStreamTurnParser({
      turnNumber: 2,
      emit: (msg) => messages.push(msg),
    });

    const secrets = [
      'bearer-secret-111',
      'flag-secret-222',
      'env-secret-333',
      'url-secret-444',
      'json-secret-555',
      'basic-user-secret-666',
      'escaped-secret-777',
    ];
    const commands = [
      `curl -H "Authorization: Bearer ${secrets[0]}" https://api.example.com`,
      `cli --api-key=${secrets[1]}`,
      `GITHUB_TOKEN=${secrets[2]} gh pr list`,
      `curl https://admin:${secrets[3]}@example.com/health`,
      `curl -d '{"client_secret":"${secrets[4]}"}'`,
      `curl -u admin:${secrets[5]} https://example.com`,
      String.raw`--password='prefix\'${secrets[6]}'`,
    ];

    for (const [idx, CommandLine] of commands.entries()) {
      parser.feed(
        `${JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: idx + 1,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: { parameters: { CommandLine } },
          },
        })}\n${JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: idx + 1,
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: { output: `Authorization: Bearer ${secrets[idx]}` },
          },
        })}\n`,
      );
    }
    parser.finish();

    const toolCalls = messages.filter((m) => m.type === 'tool-call');
    expect(toolCalls).toHaveLength(commands.length);
    for (const call of toolCalls) {
      if (call.type !== 'tool-call') throw new Error('unreachable');
      expect(call.args).toEqual({ command: '[redacted command]' });
    }
    for (const res of messages.filter((m) => m.type === 'tool-result')) {
      expect(res).toMatchObject({ result: { status: 'ERROR', stderr: '[redacted output]' } });
    }
    for (const secret of secrets) {
      expect(JSON.stringify(messages)).not.toContain(secret);
    }

    expect(
      sanitizeDiagnosticText(
        '[agy] print timeout after 30m0s with turn in progress\nAuthorization: Bearer top-secret-999',
      ),
    ).toBe('[agy] print timeout after 30m0s with turn in progress\n[redacted]');
  });

  it('recovers from oversized lines, malformed lines, non-object JSON, and missing ACTIVE tool steps', () => {
    const log = vi.fn();
    const messages: AgentMessage[] = [];
    const parser = new AgyStreamTurnParser({
      turnNumber: 1,
      emit: (msg) => messages.push(msg),
      log,
    });

    parser.feed('not-json-secret\nnull\n42\n["arr"]\n');
    parser.feed(`{"event":"ignored","blob":"${'x'.repeat(MAX_STREAM_RECORD_BYTES + 32)}hidden-secret`);
    parser.feed(
      `\n${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 9,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'list_dir',
          tool_info: { parameters: { DirectoryPath: '/work' } },
        },
      })}\n`,
    );
    // Final result without trailing newline should still be accepted if valid JSON event
    parser.feed(
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'recovered answer' },
      }),
    );
    parser.finish();

    expect(messages.filter((m) => m.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolName: 'LS', callId: 'agy:1:9', args: { path: '/work' } },
    ]);
    expect(messages.filter((m) => m.type === 'tool-result')).toEqual([
      { type: 'tool-result', toolName: 'LS', callId: 'agy:1:9', result: { status: 'DONE' } },
    ]);
    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'recovered answer' },
    ]);
    expect(log).toHaveBeenCalledWith(`ignored oversized agy stream-json record (>${MAX_STREAM_RECORD_BYTES} bytes)`);
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret');
  });
});
