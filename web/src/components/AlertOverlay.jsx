import { useEffect, useState } from 'react';

export const COUNTDOWN_S = 30;

function pct(p) { return `${Math.round(p * 100)}%`; }

/** Full-screen alert with a 30 s cancel countdown. Big targets, plain words:
 * the person who just fell may be shaken, older, and not wearing glasses. */
export default function AlertOverlay({ alert, hrRise, onCancel, onHelpNow, onExpire, onClose }) {
  const [left, setLeft] = useState(COUNTDOWN_S);

  useEffect(() => {
    if (alert.status !== 'counting') return;
    const end = alert.startedAt + COUNTDOWN_S * 1000;
    const id = setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { clearInterval(id); onExpire(); }
    }, 200);
    return () => clearInterval(id);
  }, [alert.status, alert.startedAt, onExpire]);

  const sources = Object.entries(alert.scores).filter(([, c]) => c)
    .map(([id, c]) => `${id === 'wrist' ? 'Wearable' : 'Phone'} ${pct(c.p)}`).join(' · ');
  const ring = 2 * Math.PI * 54;

  if (alert.status === 'notified') {
    return (
      <div className="overlay notified" role="alertdialog" aria-labelledby="notified-title">
        <div className="overlay-card">
          <h2 id="notified-title">Caregiver notified</h2>
          <p className="muted">{alert.notifyResult}</p>
          <pre className="message">{alert.message}</pre>
          <button className="btn big" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" role="alertdialog" aria-labelledby="alert-title" aria-describedby="alert-desc">
      <div className="overlay-card">
        <h2 id="alert-title">Possible fall detected</h2>
        <p id="alert-desc">If you are OK, tap the button. Otherwise your caregiver will be alerted.</p>
        <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r="54" className="ring-bg" />
          <circle cx="60" cy="60" r="54" className="ring-fg"
            strokeDasharray={ring} strokeDashoffset={ring * (1 - left / COUNTDOWN_S)} />
          <text x="60" y="70" textAnchor="middle" className="ring-text">{left}</text>
        </svg>
        <p className="sr-only" aria-live="assertive">{left} seconds</p>
        <button className="btn ok" onClick={onCancel}>I'm OK — cancel</button>
        <button className="btn help" onClick={onHelpNow}>Get help now</button>
        <div className="alert-meta">
          <span>Detected by: {alert.modeLabel}</span>
          <span>{sources}</span>
          {hrRise != null && (
            <span className={hrRise >= 10 ? 'hr-up' : ''}>
              Heart rate {hrRise >= 0 ? '+' : ''}{Math.round(hrRise)} bpm since impact
              {hrRise >= 10 ? ' — supports a fall' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
