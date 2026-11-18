import { describe, expect, it, vi } from 'vitest';
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { getResumeAvailability } from './sessionResume';
import { MetadataSchema, MachineMetadataSchema, type Machine, type Session } from '@/sync/storageTypes';

const session = { metadata: { flavor: 'agy', machineId: 'machine', agySessionId: 'native-agy' } } as Session;
const machine = { active: true, metadata: { resumeSupport: { rpcAvailable: true, agy: true } } } as Machine;
describe('AGY resume availability shared by app and web', () => {
  it('resumes native DeepSeek sessions only on a daemon advertising the ACP route', () => {
    const native = { metadata: { flavor: 'deepseek', machineId: 'machine', deepseekSessionId: 'dsh-native' } } as Session;
    expect(getResumeAvailability(native, machine, false).canResume).toBe(false);
    const compatible = { ...machine, metadata: { resumeSupport: { rpcAvailable: true, deepseek: true } } } as Machine;
    expect(getResumeAvailability(native, compatible, false).canResume).toBe(true);
    expect(getResumeAvailability({ metadata: { flavor: 'deepseek', machineId: 'machine', claudeSessionId: 'legacy' } } as Session, compatible, false).canResume).toBe(false);
    expect(MetadataSchema.parse({ path: '/repo', host: 'host', deepseekSessionId: 'dsh-native' }).deepseekSessionId).toBe('dsh-native');
  });
  it('enables resume for a disconnected ACP session on a compatible online machine', () => {
    expect(getResumeAvailability(session, machine, false).canResume).toBe(true);
  });
  it('keeps native IDs and the daemon capability when parsing synced metadata', () => {
    expect(MetadataSchema.parse({ path: '/project', host: 'host', agySessionId: 'native-agy' }).agySessionId).toBe('native-agy');
    expect(MachineMetadataSchema.parse({ host: 'host', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/tmp/happy', homeDir: '/tmp', resumeSupport: { rpcAvailable: true, agy: true } }).resumeSupport?.agy).toBe(true);
  });
  it('does not offer AGY resume on an older daemon, an offline machine or a live session', () => {
    expect(getResumeAvailability(session, { ...machine, metadata: { resumeSupport: { rpcAvailable: true } } } as Machine, false).canResume).toBe(false);
    expect(getResumeAvailability(session, { ...machine, active: false }, false).canResume).toBe(false);
    expect(getResumeAvailability(session, machine, true).canResume).toBe(false);
  });
  it('refuses old print sessions even if they carry a stale ID from another agent', () => {
    expect(getResumeAvailability({ metadata: { flavor: 'agy', machineId: 'machine', claudeSessionId: 'stale' } } as Session, machine, false))
      .toMatchObject({ canResume: false, message: 'sessionInfo.resumeSessionMissingBackendId' });
  });
  it('preserves Claude and Codex resume on existing daemons', () => {
    const older = { ...machine, metadata: { resumeSupport: { rpcAvailable: true } } } as Machine;
    for (const metadata of [{ flavor: 'claude', claudeSessionId: 'claude' }, { flavor: 'codex', codexThreadId: 'codex' }]) {
      expect(getResumeAvailability({ metadata: { ...metadata, machineId: 'machine' } } as Session, older, false).canResume).toBe(true);
    }
  });
});
