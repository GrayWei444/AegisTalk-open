/**
 * Add the identity signature to an outgoing X3DH_INIT (services/x3dhInitAuth.ts): signed by the unlocked identity
 * (groupKeyDelivery.currentSealer), iat on the server-corrected clock. Every INIT carries it — the receiver requires it
 * whenever I am already its friend (repair, PREKEY_REQUEST answer, re-add).
 */
import { currentSealer } from './groupKeyDelivery';
import { mqttService } from './mqtt';
import { signInitAuth, type InitAuth, type InitAuthFields } from './x3dhInitAuth';

export function withInitAuth<T extends InitAuthFields>(to: string, payload: T): T & { auth?: InitAuth } {
  const signer = currentSealer();
  if (!signer) return payload;
  return { ...payload, auth: signInitAuth(signer, to, payload, mqttService.serverNow()) };
}
