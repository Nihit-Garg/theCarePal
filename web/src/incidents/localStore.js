// Incident store that needs no account: localStorage for persistence plus a
// BroadcastChannel so every tab of this browser sees changes instantly.
// Demo: open the Person view in one tab and the Caregiver view in another.

const KEY = 'fallguard.incidents.v1';
const CHANNEL = 'fallguard-incidents';
const MAX = 200;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return []; // private mode / blocked storage: behave as empty
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // storage full or blocked: the in-memory list + broadcast still work for this session
  }
}

export class LocalIncidentStore {
  kind = 'local';
  label = 'This browser (sync between tabs)';

  constructor() {
    this.listeners = new Set();
    this.list = readAll();
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
    this.channel?.addEventListener('message', () => this.reload());
    window.addEventListener('storage', (e) => { if (e.key === KEY) this.reload(); });
  }

  reload() {
    this.list = readAll();
    this.emit();
  }

  emit() {
    const sorted = [...this.list].sort((a, b) => b.createdAt - a.createdAt);
    for (const fn of this.listeners) fn(sorted);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn([...this.list].sort((a, b) => b.createdAt - a.createdAt));
    return () => this.listeners.delete(fn);
  }

  /** Insert or replace a whole incident (transitions in model.js return full objects). */
  async put(incident) {
    this.list = [incident, ...readAll().filter((i) => i.id !== incident.id)];
    writeAll(this.list);
    this.emit();
    this.channel?.postMessage({ type: 'changed', id: incident.id });
  }

  async clear() {
    this.list = [];
    writeAll([]);
    this.emit();
    this.channel?.postMessage({ type: 'changed' });
  }
}
