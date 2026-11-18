// crypto.randomUUID() exists only in secure contexts (HTTPS or localhost). Opening
// the dev server from a phone via its LAN IP over plain http has no secure
// context, so fall back to a random id (uniqueness, not secrecy, is all we need).
export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}
