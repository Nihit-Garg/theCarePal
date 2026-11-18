import { describe, expect, it } from 'vitest';
import { SessionRecorder, CSV_HEADER } from '../engine/recorder.js';
import {
  ACK_OVERDUE_S, COUNTDOWN_S, STATUS, acknowledgeIncident, cancelIncident, createIncident, escalateIncident,
  incidentStats, incidentsToCsv, isOverdue, isStaleCountdown, needsAttention, resolveIncident,
} from './model.js';

const alarm = {
  mode: { key: 'BOTH', label: 'Phone + wearable (fused)' },
  reason: 'Fused (mean) score 1.20',
  scores: { phone: { p: 0.97 }, wrist: { p: 0.61 } },
};
const T0 = 1_700_000_000_000;
const make = () => createIncident({ person: 'Asha', alarm, now: T0, id: 'inc-1' });

describe('incident lifecycle', () => {
  it('starts in countdown with the detection details', () => {
    const inc = make();
    expect(inc.status).toBe(STATUS.COUNTDOWN);
    expect(inc.countdownEndsAt).toBe(T0 + COUNTDOWN_S * 1000);
    expect(inc.detection.scores).toEqual({ phone: 0.97, wrist: 0.61 });
    expect(inc.events).toHaveLength(1);
  });

  it('person cancels -> labelled as a false alarm', () => {
    const inc = cancelIncident(make(), T0 + 5000);
    expect(inc.status).toBe(STATUS.CANCELLED);
    expect(inc.resolution.outcome).toBe('false_alarm');
  });

  it('escalate -> acknowledge -> resolve, keeping a timeline', () => {
    let inc = escalateIncident(make(), { reason: 'timeout', hrRise: 21 }, T0 + 30000);
    expect(needsAttention(inc, T0 + 31000)).toBe(true);
    inc = acknowledgeIncident(inc, 'Nurse Priya', T0 + 45000);
    expect(inc.ack).toEqual({ by: 'Nurse Priya', at: T0 + 45000 });
    inc = resolveIncident(inc, { outcome: 'fall', note: 'Found on floor, no injury', by: 'Nurse Priya' }, T0 + 600000);
    expect(inc.status).toBe(STATUS.RESOLVED);
    expect(inc.events.map((e) => e.type)).toEqual(['detected', 'escalated', 'acknowledged', 'resolved']);
  });

  it('rejects impossible transitions', () => {
    expect(() => cancelIncident(cancelIncident(make()))).toThrow();
    expect(() => acknowledgeIncident(make(), 'x', T0 + 1000)).toThrow(); // still counting down
    expect(() => resolveIncident(make(), { outcome: 'fall' })).toThrow();
    const esc = escalateIncident(make(), { reason: 'help' }, T0 + 1000);
    expect(() => resolveIncident(esc, { outcome: 'banana' })).toThrow();
  });

  it('a countdown whose device went silent becomes stale and can be acknowledged', () => {
    const inc = make();
    const late = inc.countdownEndsAt + 16000;
    expect(isStaleCountdown(inc, late)).toBe(true);
    expect(needsAttention(inc, late)).toBe(true);
    expect(acknowledgeIncident(inc, 'Ravi', late).status).toBe(STATUS.ACKNOWLEDGED);
  });

  it('flags escalations nobody acknowledged as overdue', () => {
    const inc = escalateIncident(make(), { reason: 'timeout' }, T0);
    expect(isOverdue(inc, T0 + (ACK_OVERDUE_S - 1) * 1000)).toBe(false);
    expect(isOverdue(inc, T0 + (ACK_OVERDUE_S + 1) * 1000)).toBe(true);
  });
});

describe('ops stats and export', () => {
  const incs = [
    cancelIncident(make(), T0 + 1000),
    resolveIncident(acknowledgeIncident(escalateIncident({ ...make(), id: 'b' }, { reason: 'timeout' }, T0), 'A', T0 + 20000),
      { outcome: 'fall', by: 'A' }, T0 + 60000),
    resolveIncident(acknowledgeIncident(escalateIncident({ ...make(), id: 'c' }, { reason: 'help' }, T0), 'B', T0 + 40000),
      { outcome: 'false_alarm', by: 'B', note: 'clapping, "loudly"' }, T0 + 60000),
  ];

  it('counts falls, false alarms and median response time', () => {
    const st = incidentStats(incs, { now: T0 + 100000 });
    expect(st).toMatchObject({ total: 3, cancelledByPerson: 1, confirmedFalls: 1, falseAlarms: 2, open: 0, medianAckSeconds: 30 });
  });

  it('exports CSV with proper quoting', () => {
    const csv = incidentsToCsv(incs).split('\n');
    expect(csv[0]).toMatch(/^id,person,created,status/);
    expect(csv).toHaveLength(4);
    expect(csv[3]).toContain('"clapping, ""loudly"""');
  });
});

describe('session recorder', () => {
  function fakeEngine() {
    const taps = new Set(), listeners = new Set();
    return {
      tap: (fn) => { taps.add(fn); return () => taps.delete(fn); },
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      sample: (dev, v, t) => taps.forEach((fn) => fn('sample', dev, v, t)),
      emit: (type, d) => listeners.forEach((fn) => fn(type, d)),
    };
  }

  it('records samples, labels and alarms as CSV, and stops cleanly', () => {
    const eng = fakeEngine();
    const rec = new SessionRecorder(eng);
    rec.start('test');
    const t0 = rec.t0;
    eng.sample('phone', [0, 0, 1], t0 + 0.05);
    eng.sample('wrist', [0.1, 0.2, 0.9], t0 + 0.05);
    rec.mark('fall');
    eng.emit('alarm', { t: t0 + 0.04, mode: { key: 'BOTH' }, reason: 'x' });
    rec.stop();
    eng.sample('phone', [9, 9, 9], t0 + 1); // after stop: ignored
    const lines = rec.toCsv().trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.filter((l) => l.includes(',phone,'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('mark_fall'))).toBe(true);
    expect(lines.some((l) => l.includes(',alarm,BOTH x'))).toBe(true);
    const ts = lines.slice(1).map(parseFloat);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts); // sorted by time
    expect(rec.counts).toEqual({ phone: 1, wrist: 1 });
  });
});
