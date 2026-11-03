/**
 * Switch the chat server (open-source step 5c, ported from AegisTrans services/serverSwitch.ts): disconnect cleanly,
 * lock, store the new choice, reload.
 *
 * What switching does to local data (docs/SELF_HOSTING.md "Pointing the apps at your server", docs/EDITIONS.md §6):
 *   - nothing is deleted at switch time. Accounts are per server: the account on this phone (identity, friends, groups,
 *     messages) belongs to the server it was created on (services/serverAccount.ts records which one);
 *   - the encryption key is dropped from the session (lock), so the next start asks for the PIN — or, on another server,
 *     shows the "this account belongs to <old server>" screen instead of using the account there;
 *   - switching back to the account's server unlocks it with the PIN as before;
 *   - starting a new account (or restoring a kit / receiving a transfer for another account) on the new server wipes the
 *     old account from this phone first (serverAccount.wipeLocalAccount; abort if the wipe fails).
 * The reload restarts every module (API base, broker, connect-src policy) from the new choice: no half-old connection.
 *
 * Order (security review L2): shut down first, then store the choice for the next load, then reload. The page's server
 * choice is not changed in place (storeServerForNextLoad): while the old account is still shutting down, its token
 * refresh (the request lists its groups and friends' presence topics), device-claim heartbeat or push requests go to the
 * old server only, never signed by the old identity to the new one.
 */
import { mqttService } from './mqtt';
import { storeServerForNextLoad, type CustomServer } from './serverChoice';
import { endServerPick } from './connectPolicy';
import { clearEncryptionKey } from './keyEncryption';

const SHUTDOWN_TIMEOUT_MS = 1500;
const PROBE_KEY = 'aegis_server_store_probe';

/** next = null: back to the build's default server. Throws if the choice cannot be stored — then nothing changed. */
export async function switchServer(next: CustomServer | null): Promise<void> {
  // can the choice be stored at all (private mode / full storage throws here)? never sign out without being able to switch
  localStorage.setItem(PROBE_KEY, JSON.stringify(next));
  localStorage.removeItem(PROBE_KEY);

  try {
    await mqttService.gracefulShutdown(SHUTDOWN_TIMEOUT_MS);
  } catch {
    /* a failed shutdown does not block the switch: the reload closes the connection anyway */
  }
  try {
    mqttService.disconnect();
  } catch {
    /* ignore */
  }
  clearEncryptionKey();
  try {
    const { flushToStore } = await import('./database');
    await flushToStore({ seal: true });   // same as logout (App.exitChat): land the web SQLite blob before the reload
  } catch {
    /* native: no-op; web: the last write was already landed by the store */
  }
  try {
    storeServerForNextLoad(next);
  } finally {
    endServerPick();
    window.location.reload();   // stored or not (the probe passed), this page is shut down and locked: start again
  }
}
