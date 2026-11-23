import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { agyReconnectSession } from './reconnect';

const env = {
  HAPPY_AGY_RECONNECT_METADATA: JSON.stringify({ flavor: 'agy', agySessionId: 'native-existing', summary: { text: 'Existing title' } }),
  HAPPY_RECONNECT_SESSION_ID: 'happy-existing', HAPPY_RECONNECT_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey', HAPPY_RECONNECT_SEQ: '41',
  HAPPY_RECONNECT_METADATA_VERSION: '2', HAPPY_RECONNECT_AGENT_STATE_VERSION: '3',
};
afterEach(() => vi.unstubAllEnvs());
describe('AGY resume-in-place identity', () => {
  it('advertises AGY resume only for the ACP transport', () => {
    vi.stubEnv('HAPPY_AGY_TRANSPORT', 'acp');
    expect(detectResumeSupport('/tmp/nonexistent-happy-resume-fixture').agy).toBe(true);
    vi.stubEnv('HAPPY_AGY_TRANSPORT', 'print');
    expect(detectResumeSupport('/tmp/nonexistent-happy-resume-fixture').agy).toBe(false);
  });
  it('retains the Happy ID, encryption key and message/version cursors', () => {
    expect(agyReconnectSession({} as Metadata, {}, 'native-existing', env)).toMatchObject({
      metadata: { summary: { text: 'Existing title' } },
      id: 'happy-existing', seq: 41, metadataVersion: 2, agentStateVersion: 3, agentStateUnhydrated: true,
      encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'dataKey',
    });
    expect(agyReconnectSession({} as Metadata, {}, undefined, {})).toBeNull();
  });
  it.each([
    { HAPPY_RECONNECT_ENCRYPTION_KEY: undefined }, { HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'unknown' },
    { HAPPY_AGY_RECONNECT_METADATA: undefined }, { HAPPY_AGY_RECONNECT_METADATA: '{}' },
    { HAPPY_RECONNECT_SEQ: '-1' }, { HAPPY_RECONNECT_SEQ: 'bad' }, { HAPPY_RECONNECT_ENCRYPTION_KEY: 'AQID' },
  ])('rejects incomplete or invalid reconnect data instead of creating a new session (%j)', override => {
    expect(() => agyReconnectSession({} as Metadata, {}, 'native-existing', { ...env, ...override })).toThrow();
  });
  it('requires the native ID even when the Happy identity is available', () => {
    expect(() => agyReconnectSession({} as Metadata, {}, undefined, env)).toThrow('explicit ACP session ID');
  });
});
