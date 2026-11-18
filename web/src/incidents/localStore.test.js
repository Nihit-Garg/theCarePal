// The local store's key guarantee: update() applies a transition to the LATEST stored
// version, so a second caregiver acting on a stale screen gets an error instead of
// silently overwriting the first one's acknowledgement.
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalIncidentStore } from './localStore.js';
import { STATUS, acknowledgeIncident, createIncident, escalateIncident } from './model.js';

function fakeWindow() {
  const data = new Map();
  globalThis.window = {
    addEventListener() {},
    localStorage: {
      get length() { return data.size; },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, String(v)),
      removeItem: (k) => data.delete(k),
    },
  };
}

const alarm = { mode: { key: 'PHONE', label: 'Phone' }, reason: 'x', scores: { phone: { p: 0.99 } } };

describe('LocalIncidentStore', () => {
  beforeEach(fakeWindow);

  it('persists, lists newest first, and notifies subscribers', async () => {
    const st = new LocalIncidentStore();
    const seen = [];
    st.subscribe((list, meta) => seen.push([list.length, meta.ready]));
    await st.create(createIncident({ person: 'A', alarm, now: 1000, id: 'a' }));
    await st.create(createIncident({ person: 'B', alarm, now: 2000, id: 'b' }));
    expect(new LocalIncidentStore().list().map((i) => i.id)).toEqual(['b', 'a']); // survives a "reload"
    expect(seen.at(-1)).toEqual([2, true]);
  });

  it('a second acknowledgement fails instead of overwriting the first', async () => {
    const st = new LocalIncidentStore();
    await st.create(escalateIncident(createIncident({ person: 'A', alarm, id: 'x' }), { reason: 'help' }));
    await st.update('x', (cur) => acknowledgeIncident(cur, 'Nurse Priya'));
    // Ravi's screen still shows it as escalated, but the store applies his action to the latest version
    await expect(st.update('x', (cur) => acknowledgeIncident(cur, 'Ravi'))).rejects.toThrow(/acknowledged/);
    const inc = st.list()[0];
    expect(inc.status).toBe(STATUS.ACKNOWLEDGED);
    expect(inc.ack.by).toBe('Nurse Priya');
  });
});
