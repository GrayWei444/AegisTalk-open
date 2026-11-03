/**
 * Imported first by main.tsx (before any other module runs): consume the one-shot "pick a server" flag, then narrow
 * connect-src to the chosen server unless this page is the pick page (services/connectPolicy.ts). Kept separate so its
 * dependency graph is tiny (serverChoice + the '@ext/server' leaf).
 */
import { consumeServerPick, narrowConnectSrc } from './connectPolicy';

consumeServerPick();
narrowConnectSrc();
