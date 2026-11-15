import { describe, expect, it } from 'vitest';
import { createAgyBackend } from './createBackend';
import { AgyAcpBackend } from './AgyAcpBackend';
import { AgyBackend } from './AgyBackend';
const options = { cwd: '/work', permissionMode: 'default' as const };
describe('explicit Antigravity transport selection', () => {
  it('selects the isolated ACP adapter and retains an explicit print fallback', () => {
    expect(createAgyBackend(options, 'acp')).toBeInstanceOf(AgyAcpBackend);
    expect(createAgyBackend(options, 'print')).toBeInstanceOf(AgyBackend);
  });
  it('rejects typos and refuses to cross-resume an ACP ID on the print transport', () => {
    expect(() => createAgyBackend(options, 'typo')).toThrow('must be');
    expect(() => createAgyBackend({ ...options, resumeSessionId: 'saved' }, 'print')).toThrow('unavailable');
  });
});
