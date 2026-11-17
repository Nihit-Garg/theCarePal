// Caregiver notification. With VITE_ALERT_WEBHOOK_URL set (e.g. a Firebase Cloud
// Function that writes to Firestore and sends FCM pushes to the nurse app), the
// alert is POSTed there. Without it, the demo just shows the message it would send.

const WEBHOOK = import.meta.env.VITE_ALERT_WEBHOOK_URL;

export async function notifyCaregiver({ person, message, alert }) {
  if (!WEBHOOK) return 'Demo mode: no webhook configured, so this is the message that would be sent.';
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'possible_fall', person, message, detectedAt: new Date(alert.startedAt).toISOString(),
        mode: alert.mode?.key, hrRise: alert.hrRise,
        scores: Object.fromEntries(Object.entries(alert.scores).filter(([, c]) => c).map(([k, c]) => [k, c.p])),
      }),
    });
    return res.ok ? 'Sent to the caregiver webhook.' : `Webhook returned ${res.status} — escalate by phone.`;
  } catch (err) {
    return `Could not reach the webhook (${err.message}) — escalate by phone.`;
  }
}
