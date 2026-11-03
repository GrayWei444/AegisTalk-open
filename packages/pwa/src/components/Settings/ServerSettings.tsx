/**
 * Server choice (open-source step 5c, ported from AegisTrans components/Settings/ServerSettings.tsx): shows which server
 * this install uses and lets the user change it — to a self-hosted server, or back to the build's default.
 *
 * Used in Settings (signed in: switching asks first, because it locks the app — services/serverSwitch.ts), on the welcome
 * screens (compact) and, in the community edition, as the first-run choice (firstRun: no current server, the form is open,
 * "Use this server"). Flow: type the API URL → check (GET /api/chat/server-config) → confirm → switchServer() (disconnect,
 * lock, store, reload).
 * The page's connect-src is narrowed to the active server (services/connectPolicy.ts): to check another URL the page
 * first reloads once into "pick" mode (beginServerPick), then the form opens by itself.
 */
import { useState, type FormEvent } from 'react';
import { useCommunityStrings, type CommunityStringKey } from '../../i18n/communityStrings';
import {
  defaultServerIsOfficial,
  discoverServer,
  getActiveServer,
  hasDefaultServer,
  webHost,
  type CustomServer,
  type DiscoveryFailure,
} from '../../services/serverChoice';
import { switchServer } from '../../services/serverSwitch';
import { beginServerPick, endServerPick, narrowedConnectPolicy, serverPickRequested } from '../../services/connectPolicy';

interface ServerSettingsProps {
  /** signed in: confirm before switching (it locks the app) */
  signedIn: boolean;
  /** compact style for the welcome screens */
  compact?: boolean;
  /** community first run: no server yet, the form is open, the button says "Use this server" */
  firstRun?: boolean;
  /** this build cannot register on a server whose registration is external (community build) */
  warnExternal?: boolean;
}

type FailReason = DiscoveryFailure | 'save_failed';

export function ServerSettings({ signedIn, compact = false, firstRun = false, warnExternal = false }: ServerSettingsProps) {
  const s = useCommunityStrings();
  const active = getActiveServer();
  const [editing, setEditing] = useState(firstRun || serverPickRequested());
  const [url, setUrl] = useState(active && !active.isDefault ? active.apiUrl : '');
  const [busy, setBusy] = useState<'idle' | 'checking' | 'switching'>('idle');
  const [failure, setFailure] = useState<FailReason | null>(null);
  const [found, setFound] = useState<CustomServer | null>(null);

  const kindLabel = !active
    ? ''
    : active.isOfficial
      ? s('server.official')
      : active.name || s(active.isDefault ? 'server.default' : 'server.custom');
  const activeLabel = active ? `${kindLabel} · ${webHost(active.apiUrl) ?? active.apiUrl}` : '';

  const startEditing = () => {
    // narrowed to the current server: discovery cannot reach another URL from this page → reload once without it
    if (narrowedConnectPolicy()) beginServerPick();
    else setEditing(true);
  };

  const cancel = () => {
    setFound(null);
    setFailure(null);
    if (serverPickRequested()) {
      endServerPick();
      window.location.reload();   // back to the narrowed policy
      return;
    }
    setEditing(false);
  };

  const handleCheck = async (e: FormEvent) => {
    e.preventDefault();
    if (busy !== 'idle') return;
    setFailure(null);
    setFound(null);
    setBusy('checking');
    const result = await discoverServer(url);
    setBusy('idle');
    if (result.ok) setFound(result.server);
    else setFailure(result.reason);
  };

  const doSwitch = async (next: CustomServer | null) => {
    if (busy !== 'idle') return;
    if (signedIn && !confirm(s('server.confirmSwitch'))) return;
    setBusy('switching');
    try {
      await switchServer(next);
    } catch {
      setBusy('idle');
      setFailure('save_failed');
    }
  };

  const wrapper = compact || firstRun ? 'mt-6 text-sm w-full max-w-xs text-left' : 'p-4 border-b border-[var(--surface-border)]';

  return (
    <div className={wrapper} data-testid="server-settings">
      {!compact && !firstRun && <h2 className="text-sm font-medium text-on-surface-secondary mb-3">{s('server.title')}</h2>}

      {active && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-on-surface-secondary truncate text-sm">
            {s('server.current')}: <span className="text-on-surface-primary" data-testid="server-current">{activeLabel}</span>
          </span>
          {!editing && (
            <button type="button" onClick={startEditing} className="text-accent hover:opacity-80 shrink-0 text-sm">
              {s('server.change')}
            </button>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-2">
          <form onSubmit={handleCheck} className="space-y-2">
            <label className="text-sm text-on-surface-secondary block" htmlFor="aegistalk-server-url">
              {s('server.urlLabel')}
            </label>
            <input
              id="aegistalk-server-url"
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setFound(null); setFailure(null); }}
              className="w-full px-3 py-2 bg-surface-tertiary text-on-surface-primary text-base rounded-lg border border-[var(--surface-border)] focus:outline-none focus:border-accent"
            />
            <p className="text-xs text-on-surface-tertiary leading-relaxed">{s('server.urlHint')}</p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy !== 'idle' || url.trim() === ''}
                className="flex-1 py-2 rounded-lg bg-surface-tertiary text-on-surface-primary disabled:opacity-50"
              >
                {busy === 'checking' ? s('server.checking') : s('server.check')}
              </button>
              {!firstRun && (
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy === 'switching'}
                  className="flex-1 py-2 rounded-lg bg-surface-tertiary text-on-surface-secondary disabled:opacity-50"
                >
                  {s('server.cancel')}
                </button>
              )}
            </div>
          </form>

          {failure && (
            <p className="text-sm text-red-400" role="alert">
              {s(`server.err.${failure}` as CommunityStringKey)}
            </p>
          )}

          {found && (
            <div className="rounded-lg bg-surface-tertiary p-3 space-y-2">
              <p className="text-on-surface-primary" data-testid="server-found">
                {s('server.found')}: {found.name ?? webHost(found.apiUrl)}
              </p>
              <p className="text-xs text-on-surface-tertiary break-all">MQTT: {found.mqttUrl}</p>
              <p className={`text-xs ${found.registration === 'external' && warnExternal ? 'text-red-400' : 'text-on-surface-secondary'}`}>
                {s(`server.policy.${found.registration}` as CommunityStringKey)}
              </p>
              <button
                type="button"
                onClick={() => doSwitch(found)}
                disabled={busy !== 'idle'}
                className="w-full py-2 rounded-lg bg-mist-500 text-white disabled:opacity-50"
              >
                {busy === 'switching' ? s('server.switching') : s(firstRun ? 'server.use' : 'server.switch')}
              </button>
            </div>
          )}

          {active && !active.isDefault && hasDefaultServer() && (
            <button
              type="button"
              onClick={() => doSwitch(null)}
              disabled={busy !== 'idle'}
              className="w-full py-2 rounded-lg bg-surface-tertiary text-on-surface-secondary disabled:opacity-50"
            >
              {busy === 'switching'
                ? s('server.switching')
                : s(defaultServerIsOfficial() ? 'server.useOfficial' : 'server.useDefault')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ServerSettings;
