# Sharing incidents across devices with Firebase (optional, ~10 minutes, free)

Without Firebase, incidents sync between **tabs of the same browser** (localStorage and
its cross-tab `storage` event). That's enough to demo the person and caregiver screens side by side
on one laptop. With Firebase, the person's phone and every caregiver's phone see the
same incidents **live**, the way TheCarePal's nurse app would.

The app picks the store automatically (`web/src/incidents/index.js`): if the
`VITE_FIREBASE_*` variables are set it uses Firestore, otherwise the local store. The
caregiver screen shows which one is active ("Sync: …").

## 1. Create the project (Spark plan, free)
1. https://console.firebase.google.com → **Add project** → name it (e.g. `fallguard-demo`).
   Google Analytics isn't needed.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
3. **Build → Firestore Database → Create database** → *Start in production mode* →
   location `asia-south1 (Mumbai)`, close to the users.
4. Firestore → **Rules** tab → paste the contents of [`firestore.rules`](../firestore.rules) → **Publish**.
   (Or, with the Firebase CLI from the repo root, which has a `firebase.json`:
   `firebase deploy --only firestore:rules --project <your-project-id>`.)
5. **Project settings (⚙) → Your apps → Web (`</>`)** → register an app (no hosting needed)
   → copy `apiKey`, `authDomain`, `projectId` and `appId`.

## 2. Configure the app
```bash
cp web/.env.example web/.env
```
Fill in the four `VITE_FIREBASE_*` values, then restart `npm run dev`. Open the
Caregiver screen: it should say **Sync: Firebase (your-project-id)**.

For the GitHub Pages deployment, add the same four values as **repository secrets**
(Settings → Secrets and variables → Actions). `.github/workflows/pages.yml` passes them to the build.

## 3. Demo across two phones
* Phone A (the "person"): open the app → **Person**.
* Phone B (the "caregiver"): open the app → **Caregiver**, and tick "Sound on new alerts".
* On A, play a fall and press **Get help now**. B chimes within a second. Tap **I'm on it**,
  and A shows "Nurse Priya is responding".

## Security notes
* A Firebase **web config is not a secret**: it identifies the project, and it ships to
  every browser anyway. Access is controlled by Auth + the rules. It still lives in `.env`
  (not in git) as the brief asks. In the Google Cloud console, restrict the API key to your
  domains (HTTP referrers).
* The rules require sign-in, check that documents are well-formed, make `id`, `person` and
  `createdAt` immutable, only let the event timeline **grow**, and forbid deletes. They do
  **not** stop a signed-in client from changing an incident's status or other fields. This is
  **demo-level**: anyone who loads the app gets an anonymous account and can read all incidents.
  In production, use TheCarePal's real accounts and restrict each incident to that person's
  care team (see the comment in `firestore.rules`).
* Updates run in **Firestore transactions** on the latest server version, so two caregivers
  pressing "I'm on it" can't overwrite each other; the second gets a clear error.
* If the live connection fails (rules, expired auth, network), the caregiver screen shows a red
  **"Sync lost"** banner and keeps retrying. It never shows "All clear" because sync broke.
* Only incident metadata is stored (time, sensor, scores, heart-rate change, who
  responded, outcome). **Raw sensor data never leaves the device.**
