import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findAgyBin } from '@/agy/constants';
import { findDeepSeekCli, supportsDeepSeekNode } from '@/deepseek/options';
import { detectCLIAvailability } from './detectCLI';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/person'),
    platform: vi.fn(() => 'darwin'),
  },
}));
vi.mock('@/agy/constants', () => ({ findAgyBin: vi.fn() }));
vi.mock('@/deepseek/options', () => ({ findDeepSeekCli: vi.fn(), supportsDeepSeekNode: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedFindAgyBin = vi.mocked(findAgyBin);
const mockedPlatform = vi.mocked(os.platform);

describe('CLI availability detection', () => {
  it('advertises DeepSeek only with its own CLI, supported Node, key, and allowing policy', () => {
    expect(detectCLIAvailability({}).deepseek).toBe(false);
    expect(detectCLIAvailability({ DEEPSEEK_API_KEY: '  ' }).deepseek).toBe(false);
    expect(detectCLIAvailability({ DEEPSEEK_API_KEY: 'key' }).deepseek).toBe(true);
    expect(detectCLIAvailability({ DEEPSEEK_API_KEY: 'key', HAPPY_ENABLED_AGENTS: 'codex' }).deepseek).toBe(false);
    expect(detectCLIAvailability({ DEEPSEEK_API_KEY: 'key', HAPPY_ENABLED_AGENTS: 'deepseek' }).deepseek).toBe(true);
    vi.mocked(findDeepSeekCli).mockReturnValue(undefined);
    expect(detectCLIAvailability({ DEEPSEEK_API_KEY: 'key' }).deepseek).toBe(false);
    vi.mocked(findDeepSeekCli).mockReturnValue('/bin/dsh');
    vi.mocked(supportsDeepSeekNode).mockReturnValue(false);
    expect(detectCLIAvailability({ DEEPSEEK_API_KEY: 'key' }).deepseek).toBe(false);
  });
  beforeEach(() => {
    vi.mocked(findDeepSeekCli).mockReturnValue('/bin/dsh');
    vi.mocked(supportsDeepSeekNode).mockReturnValue(true);
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
    mockedFindAgyBin.mockReset();
    mockedFindAgyBin.mockReturnValue(undefined);
    mockedPlatform.mockReturnValue('darwin');
  });

  it('reports Antigravity only when its executable resolver finds an installation', () => {
    expect(detectCLIAvailability().agy).toBe(false);

    mockedFindAgyBin.mockReturnValue('/home/person/.local/bin/agy');

    expect(detectCLIAvailability().agy).toBe(true);
  });

  it('applies the agent policy, so an installed but disallowed agent is never advertised', () => {
    // Everything on PATH — the point is that detection alone does not decide.
    mockedExecSync.mockImplementation(() => '');
    mockedExistsSync.mockReturnValue(true);
    mockedFindAgyBin.mockReturnValue('/home/person/.local/bin/agy');

    expect(detectCLIAvailability({})).toMatchObject({
      claude: true,
      codex: true,
      gemini: true,
      openclaw: true,
      agy: true,
    });

    expect(detectCLIAvailability({ HAPPY_ENABLED_AGENTS: 'gemini' })).toMatchObject({
      claude: false,
      codex: false,
      gemini: true,
      openclaw: false,
      agy: false,
    });
  });
});
