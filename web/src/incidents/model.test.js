import { describe, expect, it } from 'vitest';
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

  it('person cancels -> recorded as "person OK" (unconfirmed), NOT as a false alarm', () => {
    const inc = cancelIncident(make(), T0 + 5000);
    expect(inc.status).toBe(STATUS.CANCELLED);
    expect(inc.resolution.outcome).toBe('person_ok');
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
    expect(st).toMatchObject({ total: 3, cancelledByPerson: 1, confirmedFalls: 1, falseAlarms: 1, open: 0, medianAckSeconds: 30 });
  });

  it('exports CSV with proper quoting', () => {
    const csv = incidentsToCsv(incs).split('\n');
    expect(csv[0]).toMatch(/^id,person,created,status/);
    expect(csv).toHaveLength(4);
    expect(csv[3]).toContain('"clapping, ""loudly"""');
  });
});
