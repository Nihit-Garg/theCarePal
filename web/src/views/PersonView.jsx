import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AlertOverlay from '../components/AlertOverlay.jsx';
import RecorderPanel from '../components/RecorderPanel.jsx';
import SignalChart from '../components/SignalChart.jsx';
import { FallEngine } from '../engine/engine.js';
import { MODES } from '../engine/fusion.js';
import { liveMotionSupported, requestMotionPermission, startLivePhone } from '../engine/livePhone.js';
import { FallModel, loadConfig } from '../engine/model.js';
import { notifyCaregiver } from '../engine/notify.js';
import { scoresText, timeStr } from '../format.js';
import { magnitude } from '../engine/signal.js';
import { HeartRateSim, ScenarioPlayer, loadReplays } from '../engine/sim.js';
import { useWakeLock } from '../engine/wakeLock.js';
import { LANGS } from '../i18n.js';
import { getIncidentStore } from '../incidents/index.js';
import { COUNTDOWN_S, STATUS, cancelIncident, createIncident, escalateIncident } from '../incidents/model.js';
import { usePref } from '../prefs.js';
import { uid } from '../uid.js';

export const PERSON = 'Asha (demo)';
const TABLE_POSE = [0.01, 0.02, 1.0];
const TRACE_S = 25;

/** Where each device's numbers are coming from right now — never leave the viewer guessing. */
function sourceLabel(clip, { synthetic }) {
  if (synthetic) return synthetic;
  if (!clip) return '';
  if (!clip.subject) return `Synthetic · ${clip.title.toLowerCase()} (still)`;
  return `Replay · UMAFall subject ${clip.subject.split(':')[1]} · ${clip.title}`;
}

export default function PersonView({ embedded = false }) {
  const [boot, setBoot] = useState({ state: 'loading', msg: 'Loading models…' });
  const [cfg, setCfg] = useState(null);
  const [clips, setClips] = useState([]);
  const [mode, setMode] = useState(MODES.NONE);
  const [wearable, setWearable] = useState({ connected: true, worn: true });
  const [phone, setPhone] = useState({ source: 'sim', onTable: false }); // sim | live | off
  const [normalDay, setNormalDay] = useState(true);
  const [clip, setClip] = useState(null);
  const [hr, setHr] = useState(null);
  const [log, setLog] = useState([]);
  const [alert, setAlert] = useState(null);
  const [incident, setIncident] = useState(null);
  const [hrRise, setHrRise] = useState(null);
  const [liveMsg, setLiveMsg] = useState('');
  const [lang, setLang] = usePref('lang', 'en');
  const [fx, setFx] = usePref('alertFx', { sound: true, voice: true });
  const [incStore, setIncStore] = useState(null);
  const [replayMsg, setReplayMsg] = useState('');
  const [phoneResting, setPhoneResting] = useState(false); // detected by the engine, not the checkbox

  const engineRef = useRef(null);
  const playerRef = useRef(null);
  const incRef = useRef(null); // latest version of the current incident
  const store = useRef({ trace: { phone: [], wrist: [] }, cands: { phone: [], wrist: [] } });
  const devRef = useRef({ wearable, phone });
  devRef.current = { wearable, phone };
  const wakeLock = useWakeLock(phone.source === 'live');

  const addLog = useCallback((kind, text) => {
    setLog((l) => [{ id: uid(), time: timeStr(), kind, text }, ...l].slice(0, 60));
  }, []);

  // ---- boot: config, models, replays, incident store ----------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Detection needs only the config + models. Replays (simulation) and the
        // incident store load separately, so neither can delay or block detection.
        const c = await loadConfig();
        const [phoneModel, wristModel] = await Promise.all([FallModel.load(c, 'phone'), FallModel.load(c, 'wrist')]);
        let replays = [];
        try {
          replays = await loadReplays();
        } catch (err) {
          setReplayMsg(`Demo recordings unavailable (${err.message}) — use “This phone”.`);
        }
        if (cancelled) return;
        engineRef.current = new FallEngine(c, { phone: phoneModel, wrist: wristModel });
        if (replays.length) {
          const player = new ScenarioPlayer(replays, c.fs);
          player.onClipStart = setClip;
          playerRef.current = player;
        } else {
          setWearable({ connected: false, worn: true });
          setPhone({ source: 'off', onTable: false });
        }
        setCfg(c);
        setClips(replays);
        setBoot({ state: 'ready' });
      } catch (err) {
        if (!cancelled) setBoot({ state: 'error', msg: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let alive = true;
    getIncidentStore().then((st) => alive && setIncStore(st));
    return () => { alive = false; };
  }, []);

  // ---- follow the current incident (a caregiver may acknowledge it from another device) --
  useEffect(() => {
    if (!incStore) return;
    return incStore.subscribe((list) => {
      const cur = incRef.current && list.find((i) => i.id === incRef.current.id);
      if (cur) { incRef.current = cur; setIncident(cur); }
    });
  }, [incStore]);

  /** Create the incident; returns false if it couldn't be stored. */
  const createInc = useCallback(async (inc) => {
    incRef.current = inc;
    setIncident(inc);
    if (!incStore) { addLog('error', 'Incident store not ready — the caregiver screen will not see this alert'); return false; }
    try { await incStore.create(inc); return true; } catch (err) {
      addLog('error', `Could not save the incident: ${err.message}`);
      return false;
    }
  }, [incStore, addLog]);

  /** Apply a person-side transition only if the incident is still counting down —
   * a caregiver may already have acknowledged it (e.g. this phone was frozen in the
   * background). Never throws: the alert UI must keep working whatever the store says. */
  const transition = useCallback(async (fn) => {
    const id = incRef.current?.id;
    if (!id || !incStore) return false;
    try {
      const next = await incStore.update(id, (cur) => (cur.status === STATUS.COUNTDOWN ? fn(cur) : cur));
      incRef.current = next;
      setIncident(next);
      return true;
    } catch (err) {
      addLog('error', `Could not update the incident: ${err.message}`);
      return false;
    }
  }, [incStore, addLog]);

  // ---- engine events ------------------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    return engine.on((type, data) => {
      if (type === 'mode') { setMode(data); addLog('mode', `Active sensor: ${data.label}`); }
      if (type === 'status') setPhoneResting(data.devices.phone.resting);
      if (type === 'candidate') {
        const c = store.current.cands[data.device];
        c.push(data);
        if (c.length > 30) c.shift();
        const dev = data.device === 'wrist' ? 'Wearable' : 'Phone';
        if (data.s < 1) addLog('reject', `${dev}: impact ${data.peakG.toFixed(1)} g scored ${Math.round(data.p * 100)}% — not a fall`);
      }
      if (type === 'alarm') {
        engine.suspended = true;
        setHrRise(null);
        createInc(createIncident({ person: PERSON, alarm: data }));
        setAlert({ ...data, status: 'counting', startedAt: Date.now(), modeLabel: data.mode.label });
        addLog('alarm', `Possible fall — ${data.reason}`);
      }
      if (type === 'error') addLog('error', data.message);
    });
  }, [boot.state, addLog, createInc]);

  // ---- simulation clock (20 Hz) ------------------------------------------------------
  useEffect(() => {
    if (boot.state !== 'ready' || !playerRef.current) return;
    const engine = engineRef.current, player = playerRef.current, fs = cfg.fs;
    const hrSim = new HeartRateSim();
    const start = performance.now() / 1000;
    let emitted = 0, lastHr = 0;
    const id = setInterval(() => {
      const now = performance.now() / 1000;
      const { wearable: w, phone: p } = devRef.current;
      engine.setDeviceStatus('wrist', { connected: w.connected, worn: w.worn });
      engine.setDeviceStatus('phone', { connected: p.source !== 'off' });
      let due = Math.floor((now - start) * fs) - emitted;
      if (due > 40) { emitted += due - 40; due = 40; } // tab was in background: skip ahead
      for (let k = 0; k < due; k++) {
        const t = start + (emitted + 1) / fs;
        const s = player.next();
        emitted++;
        if (w.connected) {
          const ws = w.worn ? s.wrist : TABLE_POSE;
          engine.pushSample('wrist', ws, t);
          store.current.trace.wrist.push({ t, m: magnitude(...ws) });
        }
        if (p.source === 'sim') {
          const ps = p.onTable ? TABLE_POSE : s.phone;
          engine.pushSample('phone', ps, t);
          store.current.trace.phone.push({ t, m: magnitude(...ps) });
        }
        if (t - lastHr >= 1) {
          lastHr = t;
          const bpm = hrSim.update(1, s.clip, s.clipIdx);
          if (w.connected && w.worn) { engine.pushHeartRate(t, bpm); setHr(bpm); } else setHr(null);
        }
      }
      for (const tr of Object.values(store.current.trace)) {
        while (tr.length && now - tr[0].t > TRACE_S) tr.shift();
      }
      engine.tick(now);
    }, 50);
    return () => clearInterval(id);
  }, [boot.state, cfg]);

  // ---- live phone sensor ---------------------------------------------------------------
  useEffect(() => {
    if (phone.source !== 'live' || !engineRef.current) return;
    const engine = engineRef.current;
    engine.setDeviceStatus('phone', { connected: false }); // reset buffers from the simulator
    const stop = startLivePhone(cfg.fs, (s, t) => {
      engine.setDeviceStatus('phone', { connected: true });
      engine.pushSample('phone', s, t);
      store.current.trace.phone.push({ t, m: magnitude(...s) });
    }, () => setLiveMsg('No motion data — open this page on a phone (HTTPS) to use its real sensor.'));
    return stop;
  }, [phone.source, cfg]);

  useEffect(() => { if (playerRef.current) playerRef.current.normalDay = normalDay; }, [normalDay, boot.state]);

  // ---- heart-rate confirmation while the countdown runs --------------------------------
  useEffect(() => {
    if (!alert || alert.status !== 'counting') return;
    const id = setInterval(() => setHrRise(engineRef.current.hrRiseSince(alert.t, alert.hrBaseline)), 1000);
    return () => clearInterval(id);
  }, [alert]);

  const endAlert = useCallback(() => {
    engineRef.current.resume(performance.now() / 1000);
    incRef.current = null;
    setIncident(null);
    setAlert(null);
  }, []);

  const notify = useCallback(async (why) => {
    const a = alert;
    if (!a || a.status !== 'counting') return;
    const rise = engineRef.current.hrRiseSince(a.t, a.hrBaseline);
    const message = [
      `⚠️ Possible fall: ${PERSON}`,
      `Time: ${timeStr(a.startedAt)}`,
      `Sensor: ${a.modeLabel} (${scoresText(a.scores, ', ')})`,
      rise != null ? `Heart rate: ${rise >= 0 ? '+' : ''}${Math.round(rise)} bpm after impact` : 'Heart rate: not available',
      why === 'help' ? 'They pressed "Get help now".' : `No response within ${COUNTDOWN_S} seconds.`,
      'Please check on them now. (Automated alert — not a medical diagnosis.)',
    ].join('\n');
    setAlert({ ...a, status: 'notified', delivery: 'sending', message, notifyResult: '' });
    // Both channels in parallel: a dead network for one must not block the other.
    const [stored, hook] = await Promise.all([
      transition((cur) => escalateIncident(cur, { reason: why, hrRise: rise, message })),
      notifyCaregiver({ person: PERSON, message, alert: { ...a, hrRise: rise } }),
    ]);
    const delivered = stored || hook.status === 'sent';
    const where = stored ? `Caregiver screen: ${incStore.label}.` : 'Caregiver screen: not reached.';
    setAlert((cur) => cur && { ...cur, delivery: delivered ? 'sent' : 'failed', notifyResult: `${where} ${hook.text}` });
    addLog(delivered ? 'notify' : 'error', delivered
      ? `Caregiver alerted (${why === 'help' ? 'help requested' : 'no response'})`
      : 'Could not reach any caregiver channel');
  }, [alert, addLog, transition, incStore]);

  const onCancel = useCallback(() => {
    transition(cancelIncident); // recorded as "person OK", not as a false alarm
    addLog('cancel', 'Alert cancelled — person is OK');
    endAlert();
  }, [addLog, endAlert, transition]);
  const onExpire = useCallback(() => notify('timeout'), [notify]);
  const onHelpNow = useCallback(() => notify('help'), [notify]);

  const play = (c) => {
    playerRef.current.play(c);
    addLog('play', `Scenario: ${c.title} (${c.kind === 'fall' ? 'fall' : 'everyday activity'})`);
  };

  const enableLive = async () => {
    setLiveMsg('');
    try {
      await requestMotionPermission();
      setPhone((p) => ({ ...p, source: 'live' }));
      // Real data must not be fused with (or recorded alongside) the simulated watch.
      setWearable((w) => ({ ...w, connected: false }));
      addLog('mode', 'Using this phone\'s real sensor — simulated wearable disconnected');
    } catch (e) {
      setLiveMsg(e.message);
    }
  };

  const thresholds = useMemo(() => cfg && ({ phone: cfg.positions.phone.threshold, wrist: cfg.positions.wrist.threshold }), [cfg]);
  const falls = useMemo(() => clips.filter((c) => c.kind === 'fall'), [clips]);
  const adls = useMemo(() => {
    const seen = new Set();
    return clips.filter((c) => c.kind === 'adl' && !seen.has(c.activity) && seen.add(c.activity));
  }, [clips]);

  if (boot.state !== 'ready') {
    return (
      <main className="boot">
        <h1>FallGuard</h1>
        <p className={boot.state === 'error' ? 'error' : 'muted'}>{boot.msg}</p>
        {boot.state === 'error' && (/model config|replays/i.test(boot.msg)
          ? <p className="muted">Model files are missing: run <code>python ml/scripts/export_models.py</code>, then reload.</p>
          : <p className="muted">The on-device ML runtime failed to start. Try reloading, or a recent Chrome/Safari.</p>)}
      </main>
    );
  }

  const wristState = !wearable.connected ? 'Disconnected' : !wearable.worn ? 'Not worn' : 'Streaming';
  const phoneState = phone.source === 'off' ? 'Off' : phone.onTable && phone.source === 'sim' ? 'Resting on a table' : phone.source === 'live' ? 'Live sensor' : 'Streaming';
  const wristActive = mode === MODES.WEARABLE || mode === MODES.BOTH;
  const phoneActive = mode === MODES.PHONE || mode === MODES.BOTH;
  const wristSource = wearable.connected
    ? sourceLabel(clip, { synthetic: !wearable.worn && 'Synthetic · watch lying on a table' }) : '';
  const phoneSource = phone.source === 'live' ? "Live · this device's accelerometer"
    : phone.source === 'sim' ? sourceLabel(clip, { synthetic: phone.onTable && 'Synthetic · phone lying on a table' }) : '';

  return (
    <div className={`person ${embedded ? 'embedded' : ''}`}>
      <header className="top">
        <div>
          <h1>FallGuard</h1>
          <p className="muted">Fall detection for {PERSON} · phone + wearable</p>
        </div>
        <span className={`pill mode-${mode.key}`}>{mode.label}</span>
      </header>

      <p className="disclaimer" role="note">
        Supports nurses and families — it does <strong>not</strong> diagnose or replace medical judgement.
        Demo streams real recordings from public datasets (UMAFall); the heart rate is simulated.
      </p>

      <section className="devices" aria-label="Devices">
        <article className={`device ${wristActive ? 'active' : ''}`}>
          <header><span className="dot wrist" /> Wearable (wrist)</header>
          <p className="state">{wristState}{wristActive ? ' · in use' : ''}</p>
          <p className="hr">{hr != null ? `♥ ${hr} bpm` : '♥ —'} <span className="small muted">(simulated)</span></p>
          {wristSource && <p className="source">{wristSource}</p>}
          <div className="toggles">
            <label><input type="checkbox" checked={wearable.connected} onChange={(e) => setWearable((w) => ({ ...w, connected: e.target.checked }))} /> Connected</label>
            <label><input type="checkbox" checked={wearable.worn} disabled={!wearable.connected} onChange={(e) => setWearable((w) => ({ ...w, worn: e.target.checked }))} /> Worn</label>
          </div>
        </article>
        <article className={`device ${phoneActive ? 'active' : ''}`}>
          <header><span className="dot phone" /> Phone (pocket)</header>
          <p className="state">{phoneState}{phoneActive ? ' · in use' : ''}</p>
          {phoneSource && <p className="source">{phoneSource}</p>}
          <div className="seg" role="radiogroup" aria-label="Phone source">
            {[['sim', 'Simulated'], ['live', 'This phone'], ['off', 'Off']].map(([k, label]) => (
              <button key={k} role="radio" aria-checked={phone.source === k} className={phone.source === k ? 'on' : ''}
                onClick={() => (k === 'live' ? enableLive() : setPhone((p) => ({ ...p, source: k })))}
                disabled={k === 'live' && !liveMotionSupported()}>{label}</button>
            ))}
          </div>
          <div className="toggles">
            <label><input type="checkbox" checked={phone.onTable} disabled={phone.source !== 'sim'} onChange={(e) => setPhone((p) => ({ ...p, onTable: e.target.checked }))} /> Left on a table</label>
          </div>
          {phone.source === 'live' && wakeLock === 'on' && <p className="small muted">Screen kept awake so the sensor keeps streaming.</p>}
          {phone.source === 'live' && ['unsupported', 'error'].includes(wakeLock) && <p className="small warn-text">Keep the screen on — browsers pause sensors when it locks.</p>}
          {liveMsg && <p className="small error">{liveMsg}</p>}
          {replayMsg && <p className="small error">{replayMsg}</p>}
        </article>
      </section>
      {mode === MODES.NONE && <p className="warn">No sensor is active — falls cannot be detected right now.</p>}
      {phoneResting && mode !== MODES.NONE && (
        <p className="warn">The phone has been still and flat for 30 s — it looks like it's on a table, not on the person.
          {mode === MODES.PHONE ? ' Falls may be missed.' : ' Using the wearable only.'}</p>
      )}

      <section className="card">
        <div className="row">
          <h2>Live signal</h2>
          <span className="muted small">{clip ? `Now: ${clip.title}` : ''}</span>
        </div>
        <SignalChart store={store} thresholds={thresholds} />
      </section>

      <section className="card">
        <div className="row">
          <h2>Try a scenario</h2>
          <label className="small"><input type="checkbox" checked={normalDay} onChange={(e) => setNormalDay(e.target.checked)} /> Normal day in background</label>
        </div>
        <h3>Falls</h3>
        <div className="chips">
          {falls.map((c) => <button key={c.id} className="chip fall" onClick={() => play(c)}>{c.title}</button>)}
        </div>
        <h3>Everyday activities <span className="muted small">(should not alarm)</span></h3>
        <div className="chips">
          {adls.map((c) => <button key={c.id} className="chip" onClick={() => play(c)}>{c.title}</button>)}
        </div>
      </section>

      <section className="card">
        <h2>Alert settings</h2>
        <div className="toggles">
          <div className="seg" role="radiogroup" aria-label="Alert language">
            {Object.entries(LANGS).map(([k, label]) => (
              <button key={k} role="radio" aria-checked={lang === k} className={lang === k ? 'on' : ''} onClick={() => setLang(k)}>{label}</button>
            ))}
          </div>
          <label><input type="checkbox" checked={fx.sound} onChange={(e) => setFx((f) => ({ ...f, sound: e.target.checked }))} /> Alarm sound</label>
          <label><input type="checkbox" checked={fx.voice} onChange={(e) => setFx((f) => ({ ...f, voice: e.target.checked }))} /> Spoken prompt</label>
        </div>
      </section>

      <section className="card">
        <h2>Activity log</h2>
        <ul className="log">
          {log.length === 0 && <li className="muted">Events will appear here.</li>}
          {log.map((e) => <li key={e.id} className={`log-${e.kind}`}><time>{e.time}</time> {e.text}</li>)}
        </ul>
      </section>

      <RecorderPanel engine={engineRef.current} />

      <details className="card about">
        <summary>About the models</summary>
        {Object.entries(cfg.positions).map(([pos, p]) => (
          <div key={pos} className="model-row">
            <h3>{pos === 'wrist' ? 'Wearable (wrist)' : 'Phone'}</h3>
            <p className="small">
              Ensemble of LightGBM + 1D-CNN ({p.cnn_params.toLocaleString()} params), running on this device via ONNX Runtime Web.
              Trigger {p.trigger_g} g · threshold {p.threshold.toFixed(2)} · models {((p.model_bytes.lightgbm + p.model_bytes.cnn) / 1024).toFixed(0)} KB.
            </p>
            <p className="small">
              Cross-validated (unseen people): sensitivity {(p.cv_metrics.sensitivity * 100).toFixed(1)}%,
              specificity {(p.cv_metrics.specificity * 100).toFixed(1)}%, {p.cv_metrics.false_alarms_per_hour.toFixed(2)} false alarms per hour of lab activity.
            </p>
          </div>
        ))}
        <p className="small muted">Demo recordings are from UMAFall subjects {cfg.demo_subjects.join(', ')}, who were excluded from training the models used here.</p>
      </details>

      {alert && (
        <AlertOverlay alert={alert} incident={incident} hrRise={hrRise} lang={lang} fx={fx}
          onCancel={onCancel} onHelpNow={onHelpNow} onExpire={onExpire} onClose={endAlert} />
      )}
    </div>
  );
}
