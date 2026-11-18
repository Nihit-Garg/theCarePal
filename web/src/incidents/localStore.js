// Incident store that needs no account: localStorage for persistence, one key per
// incident, and the browser's `storage` event so every tab of this browser sees
// changes from the others. (Listeners in the same tab are called directly.)
// Demo: open the Person view in one tab and the Caregiver view in another.
//
// Writes are read-modify-write on a single incident's key (update(id, fn)), so two
// tabs acting on *different* incidents never clobber each other, and the transition
// function always sees the latest stored version of the incident it changes.

const PREFIX = 'fallguard.incident.';
const MAX = 200;

function storage() {
  try {
    const s = window.localStorage;
    s.getItem(PREFIX + 'probe');
    return s;
  } catch {
    return null; // private mode / blocked storage: memory only (this tab)
  }
}

export class LocalIncidentStore {
  kind = 'local';
  label = 'This browser (syncs between tabs)';

  constructor() {
    this.listeners = new Set();
    this.mem = new Map(); // id -> incident (source of truth when storage is blocked)
    this.load();
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key.startsWith(PREFIX)) { this.load(); this.emit(); }
    });
  }

  load() {
    const s = storage();
    if (!s) return;
    this.mem.clear();
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try { const inc = JSON.parse(s.getItem(k)); this.mem.set(inc.id, inc); } catch { /* skip corrupt */ }
    }
  }

  list() {
    return [...this.mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  emit() {
    const l = this.list();
    for (const fn of this.listeners) fn(l, { ready: true, error: null });
  }

  /** fn(list, { ready, error }) — same signature as the Firebase store. */
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.list(), { ready: true, error: null });
    return () => this.listeners.delete(fn);
  }

  write(inc) {
    this.mem.set(inc.id, inc);
    const s = storage();
    if (s) {
      try { s.setItem(PREFIX + inc.id, JSON.stringify(inc)); } catch { /* full: memory copy still works */ }
      this.prune(s);
    }
    this.emit();
  }

  prune(s) {
    const all = this.list();
    for (const old of all.slice(MAX)) { s.removeItem(PREFIX + old.id); this.mem.delete(old.id); }
  }

  /** Store a brand-new incident. */
  async create(incident) {
    this.write(incident);
    return incident;
  }

  /** Apply a transition to the LATEST stored version. fn may throw (invalid transition). */
  async update(id, fn) {
    const s = storage();
    let cur = this.mem.get(id);
    if (s) {
      try { const raw = s.getItem(PREFIX + id); if (raw) cur = JSON.parse(raw); } catch { /* use memory copy */ }
    }
    if (!cur) throw new Error('Incident not found');
    const next = fn(cur);
    this.write(next);
    return next;
  }

  async clear() {
    const s = storage();
    for (const id of this.mem.keys()) s?.removeItem(PREFIX + id);
    this.mem.clear();
    this.emit();
  }
}
