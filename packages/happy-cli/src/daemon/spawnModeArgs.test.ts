import { describe, expect, it } from 'vitest';
import { appendDaemonSpawnModeArgs, shouldForwardDaemonPermissionMode } from './spawnModeArgs';

describe('daemon spawn mode arguments', () => {
  it('forwards Codex default because it is a concrete ask-first policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'codex');

    expect(args).toEqual(['--permission-mode', 'default']);
  });

  it('leaves Claude default ambient', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude');

    expect(args).toEqual([]);
  });

  it('forwards explicit Codex permission, model, and effort selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'yolo',
      modelMode: 'gpt-5.6-sol',
      effortLevel: 'medium',
    }, 'codex');

    expect(args).toEqual([
      '--permission-mode', 'yolo',
      '--model', 'gpt-5.6-sol',
      '--effort', 'medium',
    ]);
  });

  it('uses the same Codex default rule for resume launches', () => {
    expect(shouldForwardDaemonPermissionMode('codex', 'default')).toBe(true);
    expect(shouldForwardDaemonPermissionMode('claude', 'default')).toBe(false);
  });

  it.each(['plan', 'acceptEdits', 'yolo'])('forwards AGY %s permission, model, and effort selections', (permissionMode) => {
    const args: string[] = [];
    appendDaemonSpawnModeArgs(args, {
      directory: '/repo', permissionMode,
      modelMode: 'Gemini 4 Argon', effortLevel: 'high',
    }, 'agy');
    expect(args).toEqual([
      '--permission-mode', permissionMode,
      '--model', 'Gemini 4 Argon', '--effort', 'high',
    ]);
  });

  it('keeps the AGY default model and permission mode ambient', () => {
    const args: string[] = [];
    appendDaemonSpawnModeArgs(args, {
      directory: '/repo', permissionMode: 'default', modelMode: 'default',
    }, 'agy');
    expect(args).toEqual([]);
  });

  it.each(['gemini', 'openclaw'])('does not send unsupported launch settings to %s', (agent) => {
    const args: string[] = [];
    appendDaemonSpawnModeArgs(args, {
      directory: '/repo', permissionMode: 'plan', modelMode: 'model', effortLevel: 'high',
    }, agent);
    expect(args).toEqual([]);
  });
});
