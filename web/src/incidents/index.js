// Picks the incident store: Firebase when configured in .env, otherwise the
// local (same-browser, multi-tab) store. The rest of the app doesn't care which.
import { LocalIncidentStore } from './localStore.js';

const env = import.meta.env;

export function firebaseConfigFromEnv() {
  if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_PROJECT_ID) return null;
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

let storePromise = null;

/** Firebase if configured, else the local store. If Firebase can't be reached
 * (offline, auth failure) we fall back to the local store for now but forget the
 * failure, so the next call — e.g. a reload or the caregiver screen — retries. */
export function getIncidentStore() {
  if (!storePromise) {
    const cfg = firebaseConfigFromEnv();
    storePromise = cfg
      ? import('./firebaseStore.js').then((m) => m.createFirebaseStore(cfg)).catch((err) => {
        console.error('Firebase unavailable, using the local store for now', err);
        storePromise = null; // retry next time
        const s = new LocalIncidentStore();
        s.label = `This browser only — Firebase unreachable (${err.message})`;
        return s;
      })
      : Promise.resolve(new LocalIncidentStore());
  }
  return storePromise;
}
