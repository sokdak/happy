import type { AgentState, Metadata, Session } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';

/** Reattach only with a complete encrypted Happy identity and an explicit native ID. */
export function agyReconnectSession(metadata: Metadata, state: AgentState, nativeId: string | undefined, env = process.env): Session | null {
  const keys = ['SESSION_ID', 'ENCRYPTION_KEY', 'ENCRYPTION_VARIANT', 'SEQ', 'METADATA_VERSION', 'AGENT_STATE_VERSION'] as const;
  if (env.HAPPY_AGY_RECONNECT_METADATA === undefined && !keys.some(key => env[`HAPPY_RECONNECT_${key}`] !== undefined)) return null;
  const values = keys.map(key => env[`HAPPY_RECONNECT_${key}`]);
  if (values.some(value => !value) || !nativeId?.trim()) throw new Error('Antigravity resume requires a complete Happy reconnect identity and an explicit ACP session ID');
  const [id, key, variant, seq, metadataVersion, agentStateVersion] = values as string[];
  const numbers = [seq, metadataVersion, agentStateVersion].map(Number);
  if ((variant !== 'legacy' && variant !== 'dataKey') || numbers.some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error('Invalid Happy reconnect identity');
  }
  let saved: Metadata;
  try {
    saved = JSON.parse(env.HAPPY_AGY_RECONNECT_METADATA ?? 'null');
    if (!saved || saved.flavor !== 'agy' || saved.agySessionId !== nativeId
      || saved.path !== metadata.path || saved.machineId !== metadata.machineId) throw new Error();
  } catch { throw new Error('Missing or mismatched Antigravity reconnect metadata'); }
  const encryptionKey = decodeBase64(key);
  if (encryptionKey.length !== 32) throw new Error('Invalid Happy reconnect key');
  return { id, encryptionKey, encryptionVariant: variant, seq: numbers[0], metadataVersion: numbers[1],
    agentStateVersion: numbers[2], metadata: { ...saved, ...metadata }, agentState: state };
}
