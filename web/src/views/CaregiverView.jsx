import { useEffect, useRef, useState } from 'react';
import { attentionChime, unlockAudio } from '../engine/alertFx.js';
import { getIncidentStore } from '../incidents/index.js';
import {
  OUTCOMES, STATUS, acknowledgeIncident, incidentStats, incidentsToCsv, isOverdue, isStaleCountdown,
  needsAttention, resolveIncident,
} from '../incidents/model.js';
import { usePref } from '../prefs.js';

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

function scoresText(inc) {
  const parts = Object.entries(inc.detection.scores).map(([d, p]) => `${d === 'wrist' ? 'wearable' : 'phone'} ${Math.round(p * 100)}%`);
  return parts.join(' · ');
}

function IncidentCard({ inc, now, me, onSave }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn) => {
    setBusy(true);
    try { await onSave(fn()); } finally { setBusy(false); }
  };
  const stale = isStaleCountdown(inc, now);
  const overdue = isOverdue(inc, now);
  const left = Math.max(0, Math.ceil((inc.countdownEndsAt - now) / 1000));
  const cls = needsAttention(inc, now) ? 'urgent' : inc.status === STATUS.COUNTDOWN ? 'pending' : inc.status === STATUS.ACKNOWLEDGED ? 'handling' : 'closed';

  return (
    <article className={`incident ${cls}`} aria-label={`Incident for ${inc.person}`}>
      <header className="row">
        <strong>{inc.person}</strong>
        <span className="small muted">{clock(inc.createdAt)} · {ago(inc.createdAt, now)}</span>
      </header>
      <p className="inc-status">
        {inc.status === STATUS.COUNTDOWN && !stale && <>Possible fall — waiting for them to respond ({left}s)</>}
        {stale && <>No update from their device after the countdown — treat as unanswered</>}
        {inc.status === STATUS.ESCALATED && <>{inc.escalation.reason === 'help' ? 'Asked for help' : 'Did not respond'} — needs someone now{overdue && <span className="badge danger">Overdue</span>}</>}
        {inc.status === STATUS.ACKNOWLEDGED && <>{inc.ack.by} is responding</>}
        {inc.status === STATUS.CANCELLED && <>Cancelled by {inc.person} (“I'm OK”)</>}
        {inc.status === STATUS.RESOLVED && <>Resolved: <span className={`badge ${inc.resolution.outcome}`}>{OUTCOMES[inc.resolution.outcome]}</span> by {inc.resolution.by}</>}
      </p>
      <p className="small muted">
        {inc.detection.modeLabel} · {scoresText(inc)}
        {inc.hrRise != null && ` · heart rate ${inc.hrRise >= 0 ? '+' : ''}${Math.round(inc.hrRise)} bpm`}
      </p>

      {(inc.status === STATUS.ESCALATED || stale) && (
        <button className="btn-sm primary" disabled={busy}
          onClick={() => act(() => acknowledgeIncident(inc, me))}>I'm on it</button>
      )}
      {[STATUS.ESCALATED, STATUS.ACKNOWLEDGED].includes(inc.status) && (
        <div className="resolve">
          <input type="text" placeholder="Note (optional): what happened?" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Resolution note" />
          <div className="row">
            {Object.entries(OUTCOMES).map(([k, label]) => (
              <button key={k} className={`btn-sm outcome-${k}`} disabled={busy}
                onClick={() => act(() => resolveIncident(inc, { outcome: k, note, by: me }))}>{label}</button>
            ))}
          </div>
        </div>
      )}

      <details>
        <summary className="small">Timeline</summary>
        <ol className="timeline">
          {inc.events.map((e, i) => <li key={i}><time>{clock(e.at)}</time> {e.text}</li>)}
        </ol>
        {inc.escalation?.message && <pre className="message">{inc.escalation.message}</pre>}
      </details>
    </article>
  );
}

/** Caregiver / nurse / operations screen. Live list of incidents from the shared
 * store, with acknowledge + resolve, and the numbers an ops team would watch. */
export default function CaregiverView() {
  const [store, setStore] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [me, setMe] = usePref('caregiverName', 'Nurse Priya');
  const [chime, setChime] = useState(false);
  const [error, setError] = useState('');
  const seenUrgent = useRef(new Set());

  useEffect(() => {
    let unsub = () => {};
    getIncidentStore().then((s) => { setStore(s); unsub = s.subscribe(setIncidents); });
    return () => unsub();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // chime once for every incident that newly needs attention
  useEffect(() => {
    for (const inc of incidents) {
      if (needsAttention(inc, now) && !seenUrgent.current.has(inc.id)) {
        seenUrgent.current.add(inc.id);
        if (chime) attentionChime();
      }
    }
  }, [incidents, now, chime]);

  const save = async (inc) => {
    setError('');
    try { await store.put(inc); } catch (err) { setError(err.message); }
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([incidentsToCsv(incidents)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'fallguard-incidents.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const urgent = incidents.filter((i) => needsAttention(i, now));
  const pending = incidents.filter((i) => i.status === STATUS.COUNTDOWN && !isStaleCountdown(i, now));
  const handling = incidents.filter((i) => i.status === STATUS.ACKNOWLEDGED);
  const history = incidents.filter((i) => [STATUS.CANCELLED, STATUS.RESOLVED].includes(i.status));
  const st = incidentStats(incidents, { now });

  const section = (title, list, empty) => (
    <section className="card">
      <h2>{title} <span className="count">{list.length}</span></h2>
      {list.length === 0 ? <p className="small muted">{empty}</p>
        : list.map((inc) => <IncidentCard key={inc.id} inc={inc} now={now} me={me} onSave={save} />)}
    </section>
  );

  return (
    <div className="caregiver">
      <header className="top">
        <div>
          <h1>Caregiver</h1>
          <p className="muted">Alerts for the people you look after</p>
        </div>
        <span className={`pill ${urgent.length ? 'mode-NONE' : ''}`}>{urgent.length ? `${urgent.length} need attention` : 'All clear'}</span>
      </header>

      <section className="card settings-row">
        <label>You are <input type="text" value={me} onChange={(e) => setMe(e.target.value)} aria-label="Your name" /></label>
        <label><input type="checkbox" checked={chime} onChange={(e) => { if (e.target.checked) unlockAudio(); setChime(e.target.checked); }} /> Sound on new alerts</label>
        <span className="small muted">Sync: {store ? store.label : 'connecting…'}</span>
      </section>
      {error && <p className="warn">{error}</p>}

      <section className="stats" aria-label="Last 7 days">
        <div><b>{st.total}</b><span>alerts (7 days)</span></div>
        <div><b>{st.confirmedFalls}</b><span>confirmed falls</span></div>
        <div><b>{st.falseAlarms}</b><span>false alarms</span></div>
        <div><b>{st.medianAckSeconds == null ? '—' : `${Math.round(st.medianAckSeconds)}s`}</b><span>median time to respond</span></div>
      </section>

      {section('Needs attention', urgent, 'Nothing needs attention right now.')}
      {pending.length > 0 && section('Waiting for the person to respond', pending, '')}
      {handling.length > 0 && section('Being handled', handling, '')}
      {section('History', history, 'Resolved and cancelled alerts will appear here. Every outcome you record helps tune the detector.')}

      <div className="row">
        <button className="btn-sm" onClick={exportCsv} disabled={!incidents.length}>⬇ Export incidents (CSV)</button>
        {store?.kind === 'local' && (
          <button className="btn-sm" onClick={() => store.clear()} disabled={!incidents.length}>Clear demo data</button>
        )}
      </div>
    </div>
  );
}
