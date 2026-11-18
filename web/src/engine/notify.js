// Optional second channel: with VITE_ALERT_WEBHOOK_URL set (e.g. a Firebase Cloud
// Function that sends an FCM push or SMS), each escalation is also POSTed there.
// Runs in parallel with the incident-store write, so one dead channel never blocks
// the other. Returns { status: 'sent' | 'failed' | 'skipped', text }.
import { scoresText } from '../format.js';

const WEBHOOK = import.meta.env.VITE_ALERT_WEBHOOK_URL;

export async function notifyCaregiver({ person, message, alert }) {
  if (!WEBHOOK) return { status: 'skipped', text: 'No webhook configured.' };
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'possible_fall', person, message, detectedAt: new Date(alert.startedAt).toISOString(),
        mode: alert.mode?.key, hrRise: alert.hrRise, scores: scoresText(alert.scores, ', '),
      }),
    });
    return res.ok ? { status: 'sent', text: 'Webhook delivered.' } : { status: 'failed', text: `Webhook returned ${res.status}.` };
  } catch (err) {
    return { status: 'failed', text: `Webhook unreachable (${err.message}).` };
  }
}
