// Incident lifecycle. Pure functions: every transition returns a NEW incident
// object, so the same logic works with any store (localStorage or Firestore).
//
//   countdown ──► cancelled                (person tapped "I'm OK")
//       │
//       └──────► escalated ──► acknowledged ──► resolved (outcome: fall | false_alarm | unsure)
//                (timeout or "Get help now")  (a caregiver is on it)
//
// Outcomes are the feedback loop: every incident a caregiver resolves is a labelled
// example (real fall or false alarm) for reviewing and later tuning thresholds per
// person. A person's own "I'm OK" is recorded as `person_ok` — NOT as a false alarm:
// people often fall and are fine, so treating cancellations as false alarms would
// bias tuning towards missing real falls.

import { uid } from '../uid.js';

export const COUNTDOWN_S = 30;
export const ACK_OVERDUE_S = 120; // escalated but nobody acknowledged for 2 min => overdue

export const STATUS = {
  COUNTDOWN: 'countdown',
  CANCELLED: 'cancelled',
  ESCALATED: 'escalated',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
};

export const OUTCOMES = {
  fall: 'Real fall',
  false_alarm: 'False alarm',
  unsure: 'Unsure',
};

const event = (type, text, at = Date.now()) => ({ at, type, text });

function round2(p) { return p == null ? null : Math.round(p * 100) / 100; }

/** Create an incident from an engine 'alarm' event. */
export function createIncident({ person, alarm, now = Date.now(), id = uid() }) {
  const scores = {};
  for (const [dev, c] of Object.entries(alarm.scores || {})) if (c) scores[dev] = round2(c.p);
  return {
    id,
    person,
    status: STATUS.COUNTDOWN,
    createdAt: now,
    updatedAt: now,
    countdownEndsAt: now + COUNTDOWN_S * 1000,
    detection: { mode: alarm.mode?.key ?? null, modeLabel: alarm.mode?.label ?? null, reason: alarm.reason ?? null, scores },
    hrRise: null,
    escalation: null,
    ack: null,
    resolution: null,
    events: [event('detected', `Possible fall detected (${alarm.mode?.label ?? 'unknown sensor'})`, now)],
  };
}

function assertStatus(inc, allowed, action) {
  if (!allowed.includes(inc.status)) throw new Error(`Cannot ${action} an incident that is ${inc.status}`);
}

export function cancelIncident(inc, now = Date.now()) {
  assertStatus(inc, [STATUS.COUNTDOWN], 'cancel');
  return { ...inc, status: STATUS.CANCELLED, updatedAt: now,
    resolution: { outcome: 'person_ok', by: inc.person, note: 'Cancelled by the person ("I\'m OK") — unconfirmed', at: now },
    events: [...inc.events, event('cancelled', 'Person tapped "I\'m OK"', now)] };
}

/** reason: 'timeout' (no response in 30 s) | 'help' (pressed "Get help now") */
export function escalateIncident(inc, { reason, hrRise = null, message = null }, now = Date.now()) {
  assertStatus(inc, [STATUS.COUNTDOWN], 'escalate');
  const text = reason === 'help' ? 'Person pressed "Get help now"' : `No response within ${COUNTDOWN_S} s`;
  return { ...inc, status: STATUS.ESCALATED, updatedAt: now, hrRise,
    escalation: { reason, at: now, message },
    events: [...inc.events, event('escalated', `${text} — caregivers notified`, now)] };
}

/** Allowed once escalated, or for a stale countdown (the person's device went
 * silent mid-alert, so it can never escalate by itself). */
export function acknowledgeIncident(inc, by, now = Date.now()) {
  if (!(inc.status === STATUS.ESCALATED || isStaleCountdown(inc, now))) {
    throw new Error(`Cannot acknowledge an incident that is ${inc.status}`);
  }
  const name = (by || '').trim() || 'A caregiver';
  return { ...inc, status: STATUS.ACKNOWLEDGED, updatedAt: now, ack: { by: name, at: now },
    events: [...inc.events, event('acknowledged', `${name} is responding`, now)] };
}

export function resolveIncident(inc, { outcome, note = '', by }, now = Date.now()) {
  assertStatus(inc, [STATUS.ESCALATED, STATUS.ACKNOWLEDGED], 'resolve');
  if (!OUTCOMES[outcome]) throw new Error(`Unknown outcome: ${outcome}`);
  const name = (by || '').trim() || 'A caregiver';
  return { ...inc, status: STATUS.RESOLVED, updatedAt: now,
    ack: inc.ack ?? { by: name, at: now },
    resolution: { outcome, note: note.trim(), by: name, at: now },
    events: [...inc.events, event('resolved', `${name}: ${OUTCOMES[outcome]}${note.trim() ? ` — ${note.trim()}` : ''}`, now)] };
}

/** A countdown whose deadline passed without the person's device escalating it
 * (e.g. the phone died or lost connection mid-alert). Caregivers must treat it as escalated. */
export function isStaleCountdown(inc, now = Date.now()) {
  return inc.status === STATUS.COUNTDOWN && now > inc.countdownEndsAt + 15000;
}

export function isOverdue(inc, now = Date.now()) {
  return inc.status === STATUS.ESCALATED && inc.escalation && now - inc.escalation.at > ACK_OVERDUE_S * 1000;
}

export function needsAttention(inc, now = Date.now()) {
  return inc.status === STATUS.ESCALATED || isStaleCountdown(inc, now);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Numbers an operations team would watch. */
export function incidentStats(incidents, { sinceMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const recent = incidents.filter((i) => now - i.createdAt <= sinceMs);
  const cancelled = recent.filter((i) => i.status === STATUS.CANCELLED).length;
  const resolved = recent.filter((i) => i.status === STATUS.RESOLVED);
  const falls = resolved.filter((i) => i.resolution.outcome === 'fall').length;
  const falseAlarms = resolved.filter((i) => i.resolution.outcome === 'false_alarm').length;
  const ackTimes = recent.filter((i) => i.ack && i.escalation).map((i) => (i.ack.at - i.escalation.at) / 1000);
  return {
    total: recent.length,
    cancelledByPerson: cancelled,
    confirmedFalls: falls,
    falseAlarms,
    open: recent.filter((i) => [STATUS.COUNTDOWN, STATUS.ESCALATED, STATUS.ACKNOWLEDGED].includes(i.status)).length,
    medianAckSeconds: median(ackTimes),
  };
}

/** CSV export for the ops team (one row per incident). */
export function incidentsToCsv(incidents) {
  const cols = ['id', 'person', 'created', 'status', 'sensor', 'phone_score', 'wearable_score', 'hr_rise_bpm',
    'escalation', 'ack_by', 'ack_seconds', 'outcome', 'note'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = incidents.map((i) => [
    i.id, i.person, new Date(i.createdAt).toISOString(), i.status, i.detection.modeLabel,
    i.detection.scores.phone, i.detection.scores.wrist, i.hrRise == null ? '' : Math.round(i.hrRise),
    i.escalation?.reason, i.ack?.by, i.ack && i.escalation ? Math.round((i.ack.at - i.escalation.at) / 1000) : '',
    i.resolution?.outcome, i.resolution?.note,
  ].map(q).join(','));
  return [cols.join(','), ...rows].join('\n');
}
