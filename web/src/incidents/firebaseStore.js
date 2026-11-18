// Firestore-backed incident store: the person's phone and every caregiver's
// phone see the same incidents in real time. Loaded only when Firebase is
// configured (see docs/FIREBASE.md), so the SDK isn't in the default bundle.
//
// * update(id, fn) runs in a transaction: fn always gets the latest server
//   version, so two caregivers pressing "I'm on it" can't overwrite each other —
//   the second one gets a clear "already acknowledged" error instead.
// * Listener failures are reported to subscribers (the caregiver screen shows a
//   red "sync lost" banner) and the listener is re-established with back-off.
//   A safety screen must never show "All clear" because sync silently broke.
//
// Security: anonymous sign-in + firestore.rules (demo level; see docs/FIREBASE.md).

const plain = (o) => JSON.parse(JSON.stringify(o)); // Firestore rejects `undefined` values

export async function createFirebaseStore(config) {
  const [{ initializeApp }, fs, { getAuth, signInAnonymously }] = await Promise.all([
    import('firebase/app'), import('firebase/firestore'), import('firebase/auth'),
  ]);
  const app = initializeApp(config);
  await signInAnonymously(getAuth(app));
  const db = fs.getFirestore(app);
  const col = fs.collection(db, 'incidents');

  const listeners = new Set();
  let latest = [];
  let meta = { ready: false, error: null };
  const emit = () => { for (const fn of listeners) fn(latest, meta); };

  let retryMs = 2000;
  const listen = () => {
    const q = fs.query(col, fs.orderBy('createdAt', 'desc'), fs.limit(100));
    fs.onSnapshot(q, (snap) => {
      retryMs = 2000;
      latest = snap.docs.map((d) => d.data());
      meta = { ready: true, error: null };
      emit();
    }, (err) => {
      console.error('Firestore listener failed; retrying', err);
      meta = { ready: meta.ready, error: err.message || String(err) };
      emit();
      setTimeout(listen, retryMs); // a failed listener is dead: start a new one
      retryMs = Math.min(retryMs * 2, 60000);
    });
  };
  listen();

  return {
    kind: 'firebase',
    label: `Firebase (${config.projectId})`,
    subscribe(fn) {
      listeners.add(fn);
      fn(latest, meta);
      return () => listeners.delete(fn);
    },
    async create(incident) {
      await fs.setDoc(fs.doc(col, incident.id), plain(incident));
      return incident;
    },
    async update(id, fn) {
      const ref = fs.doc(col, id);
      return fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('Incident not found');
        const next = fn(snap.data());
        tx.set(ref, plain(next));
        return next;
      });
    },
    async clear() {
      throw new Error('Clearing is disabled for the shared Firebase store');
    },
  };
}
