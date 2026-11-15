import { AgyBackend } from './AgyBackend';
import { AgyAcpBackend, type AgyAcpOptions } from './AgyAcpBackend';

/** Explicit rollback switch; never silently retry a possibly executed prompt on another transport. */
export function createAgyBackend(options: AgyAcpOptions, transport = process.env.HAPPY_AGY_TRANSPORT ?? 'acp') {
  if (transport === 'acp') return new AgyAcpBackend(options);
  if (transport === 'print') {
    if (options.resumeSessionId) throw new Error('Explicit ACP resume is unavailable with HAPPY_AGY_TRANSPORT=print');
    return new AgyBackend(options);
  }
  throw new Error('HAPPY_AGY_TRANSPORT must be acp or print');
}
