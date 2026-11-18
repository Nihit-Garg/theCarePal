// Firestore-backed incident store: the person's phone and every caregiver's
// phone see the same incidents in real time. Loaded only when Firebase is
// configured (see docs/FIREBASE.md), so the SDK isn't in the default bundle.
//
// Security: clients sign in anonymously and firestore.rules only lets signed-in
// clients read/write the `incidents` collection with a valid shape. A real
// deployment would use TheCarePal's Firebase Auth accounts and restrict each
// incident to that family's care team.

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
  let lastError = null;
  const q = fs.query(col, fs.orderBy('createdAt', 'desc'), fs.limit(100));
  fs.onSnapshot(q, (snap) => {
    latest = snap.docs.map((d) => d.data());
    for (const fn of listeners) fn(latest);
  }, (err) => { lastError = err; console.error('Firestore listener failed', err); });

  return {
    kind: 'firebase',
    label: `Firebase (${config.projectId})`,
    get lastError() { return lastError; },
    subscribe(fn) {
      listeners.add(fn);
      fn(latest);
      return () => listeners.delete(fn);
    },
    async put(incident) {
      // Firestore rejects `undefined` field values; a JSON round-trip drops them
      // (incidents are plain data, so nothing else is lost).
      await fs.setDoc(fs.doc(col, incident.id), JSON.parse(JSON.stringify(incident)));
    },
    async clear() {
      throw new Error('Clearing is disabled for the shared Firebase store');
    },
  };
}
