/**
 * The account on this phone belongs to another server than the active one (open-source step 5c: accounts are per server,
 * services/serverAccount.ts). Shown by App instead of the login screen. Two ways out:
 *   - switch back to the account's server (the account unlocks with its PIN there, nothing lost);
 *   - start a new account on this server: wipe the old account from this phone first (abort if that fails), reload, then
 *     the normal new-account flow.
 * The account is never used on this server.
 */
import { useState } from 'react';
import { useCommunityStrings } from '../../i18n/communityStrings';
import { getActiveServer, webHost } from '../../services/serverChoice';
import { switchServer } from '../../services/serverSwitch';
import { wipeLocalAccount, type AccountOwner } from '../../services/serverAccount';

export function ServerMismatchScreen({ owner }: { owner: AccountOwner }) {
  const s = useCommunityStrings();
  const active = getActiveServer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ownerLabel = owner.server ? (owner.server.name || webHost(owner.server.apiUrl) || owner.server.apiUrl) : s('mismatch.defaultServer');
  const activeLabel = active ? (active.name || webHost(active.apiUrl) || active.apiUrl) : '';

  const switchBack = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await switchServer(owner.server);
    } catch {
      setBusy(false);
      setError(s('server.err.save_failed'));
    }
  };

  const startOver = async () => {
    if (busy || !confirm(s('mismatch.startOverConfirm'))) return;
    setBusy(true);
    try {
      await wipeLocalAccount();
    } catch (err) {
      console.error('[ServerMismatch] wipe failed:', (err as Error)?.message ?? err);
      setBusy(false);
      setError(s('mismatch.wipeFailed'));
      return;
    }
    window.location.reload();
  };

  return (
    <div className="min-h-[100dvh] bg-surface-primary flex flex-col items-center justify-center p-6 text-center safe-area-top" data-testid="server-mismatch">
      <h1 className="text-xl font-semibold text-on-surface-primary mb-3">{s('mismatch.title')}</h1>
      <p className="text-on-surface-secondary mb-8 max-w-sm">{s('mismatch.desc', { owner: ownerLabel, active: activeLabel })}</p>
      {error && <p className="text-red-400 text-sm mb-4" role="alert">{error}</p>}
      <button
        onClick={() => void switchBack()}
        disabled={busy}
        className="w-full max-w-xs px-8 py-3 bg-accent hover:opacity-90 text-white rounded-xl font-medium transition-all disabled:opacity-50"
      >
        {s('mismatch.switchBack', { owner: ownerLabel })}
      </button>
      <button
        onClick={() => void startOver()}
        disabled={busy}
        className="mt-4 w-full max-w-xs px-8 py-3 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-xl font-medium transition-all disabled:opacity-50"
      >
        {s('mismatch.startOver')}
      </button>
    </div>
  );
}

export default ServerMismatchScreen;
