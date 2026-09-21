import type { PlatformRuntime } from '../types.js';
import { LmsError } from '../../errors.js';

const incomplete = (): never => {
  throw new LmsError('NOT_IMPLEMENTED', 'Implement and review this platform runtime before registering it.');
};

/** Compiled for interface drift detection; deliberately nonfunctional and unregistered. */
export const runtime: PlatformRuntime = {
  configure(_context) {
    // Pin origin, disable writes/debug logging, disable upstream plaintext credential stores.
    incomplete();
  },
  async validate(_context, _candidate) {
    // Read identity using the upstream client. Reject redirects/HTML/401/403.
    // Return an opaque StoredCredential only after the probe succeeds; never persist here.
    return incomplete();
  },
  async install(_context, _credential, _persist) {
    // Install only this worker's credential. null must still allow offline tools/list.
    // Use persist(updatedCredential) for refresh; never write directly to the vault or disk.
    incomplete();
  },
  async serve() {
    // Import a pinned MCP server and connect stdio. stdout is exclusively MCP protocol.
    // Do not start upstream interactive login, browser import, timers or a second transport.
    incomplete();
  },
};
