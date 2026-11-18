import { useEffect, useRef, useState } from 'react';
import { speak, startAlarm } from '../engine/alertFx.js';
import { t } from '../i18n.js';
import { COUNTDOWN_S, STATUS } from '../incidents/model.js';

function pct(p) { return `${Math.round(p * 100)}%`; }

/** Full-screen alert with a 30 s cancel countdown. Big targets, plain words,
 * sound + vibration + voice: the person who just fell may be shaken, older,
 * not wearing glasses, or unable to see the screen from the floor. */
export default function AlertOverlay({ alert, incident, hrRise, lang, fx, onCancel, onHelpNow, onExpire, onClose }) {
  const s = t(lang);
  const [left, setLeft] = useState(COUNTDOWN_S);
  const spokeLeft = useRef(false);

  // alarm tone + vibration + spoken prompt while counting down
  useEffect(() => {
    if (alert.status !== 'counting') return;
    return startAlarm({ sound: fx.sound, voice: fx.voice, text: s.say, lang: s.speechLang });
  }, [alert.status, fx.sound, fx.voice, s.say, s.speechLang]);

  useEffect(() => {
    if (alert.status !== 'counting') return;
    const end = alert.startedAt + COUNTDOWN_S * 1000;
    const id = setInterval(() => {
      const sec = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(sec);
      if (sec === 10 && !spokeLeft.current && fx.voice) { spokeLeft.current = true; speak(s.sayLeft(10), s.speechLang); }
      if (sec === 0) { clearInterval(id); onExpire(); }
    }, 200);
    return () => clearInterval(id);
  }, [alert.status, alert.startedAt, onExpire, fx.voice, s]);

  useEffect(() => {
    if (alert.status === 'notified' && fx.voice) speak(s.sayNotified, s.speechLang);
  }, [alert.status, fx.voice, s]);

  const sources = Object.entries(alert.scores).filter(([, c]) => c)
    .map(([id, c]) => `${id === 'wrist' ? 'Wearable' : 'Phone'} ${pct(c.p)}`).join(' · ');
  const ring = 2 * Math.PI * 54;

  if (alert.status === 'notified') {
    const acked = incident && [STATUS.ACKNOWLEDGED, STATUS.RESOLVED].includes(incident.status);
    return (
      <div className="overlay notified" role="alertdialog" aria-labelledby="notified-title">
        <div className="overlay-card">
          <h2 id="notified-title">{s.notifiedTitle}</h2>
          <p className={`ack-status ${acked ? 'acked' : ''}`} aria-live="polite">
            {acked ? `✓ ${s.ackBy(incident.ack.by)}` : s.waitingAck}
          </p>
          <details>
            <summary className="small">Message sent to caregivers</summary>
            <pre className="message">{alert.message}</pre>
            <p className="small muted">{alert.notifyResult}</p>
          </details>
          <button className="btn big" onClick={onClose}>{s.done}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" role="alertdialog" aria-labelledby="alert-title" aria-describedby="alert-desc" lang={lang}>
      <div className="overlay-card">
        <h2 id="alert-title">{s.alertTitle}</h2>
        <p id="alert-desc">{s.alertBody}</p>
        <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r="54" className="ring-bg" />
          <circle cx="60" cy="60" r="54" className="ring-fg"
            strokeDasharray={ring} strokeDashoffset={ring * (1 - left / COUNTDOWN_S)} />
          <text x="60" y="70" textAnchor="middle" className="ring-text">{left}</text>
        </svg>
        <p className="sr-only" aria-live="assertive">{s.seconds(left)}</p>
        <button className="btn ok" onClick={onCancel}>{s.ok}</button>
        <button className="btn help" onClick={onHelpNow}>{s.help}</button>
        <div className="alert-meta">
          <span>{s.detectedBy}: {alert.modeLabel}</span>
          <span>{sources}</span>
          {hrRise != null && (
            <span className={hrRise >= 10 ? 'hr-up' : ''}>
              ♥ {hrRise >= 0 ? '+' : ''}{Math.round(hrRise)} bpm
              {hrRise >= 10 ? ' — supports a fall' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
