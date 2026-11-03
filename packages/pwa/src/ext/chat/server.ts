/**
 * '@ext/server' (chat): the community edition has no default server — the app asks on first run
 * (ChatAuthScreen, step 1) and stores the choice (services/serverChoice.ts). No extra connect-src origins, no brand links
 * of its own (the chosen server's server-config provides privacy / terms / support links).
 */
import type { EditionServerConfig } from '../types';

export const defaultServer: EditionServerConfig | null = null;

export const connectSources: readonly string[] = [];

export const brandLegal: { privacyPolicyUrl?: string; termsOfServiceUrl?: string; supportEmail?: string } | undefined = undefined;
