import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import AlertOverlay from './components/AlertOverlay.jsx';
import SignalChart from './components/SignalChart.jsx';
import { FallEngine } from './engine/engine.js';
import { MODES } from './engine/fusion.js';
import { liveMotionSupported, requestMotionPermission, startLivePhone } from './engine/livePhone.js';
import { FallModel, loadConfig } from './engine/model.js';
import { notifyCaregiver } from './engine/notify.js';
import { HeartRateSim, ScenarioPlayer, loadReplays } from './engine/sim.js';
import { magnitude } from './engine/signal.js';

const PERSON = 'Asha (demo)';
const TABLE_POSE = [0.01, 0.02, 1.0];
const TRACE_S = 25;

function timeStr(d = new Date()) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function App() {
  const [boot, setBoot] = useState({ state: 'loading', msg: 'Loading models…' });
  const [cfg, setCfg] = useState(null);
  const [clips, setClips] = useState([]);
  const [mode, setMode] = useState(MODES.NONE);
  const [wearable, setWearable] = useState({ connected: true, worn: true });
  const [phone, setPhone] = useState({ source: 'sim', onTable: false }); // sim | live | off
  const [normalDay, setNormalDay] = useState(true);
  const [nowPlaying, setNowPlaying] = useState('');
  const [hr, setHr] = useState(null);
  const [log, setLog] = useState([]);
  const [alert, setAlert] = useState(null);
  const [hrRise, setHrRise] = useState(null);
  const [liveMsg, setLiveMsg] = useState('');

  const engineRef = useRef(null);
  const playerRef = useRef(null);
  const store = useRef({ trace: { phone: [], wrist: [] }, cands: { phone: [], wrist: [] } });
  const devRef = useRef({ wearable, phone });
  devRef.current = { wearable, phone };

  const addLog = useCallback((kind, text) => {
    setLog((l) => [{ id: crypto.randomUUID(), time: timeStr(), kind, text }, ...l].slice(0, 60));
  }, []);

  // ---- boot: config, models, replays --------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await loadConfig();
        const [phoneModel, wristModel, replays] = await Promise.all([
          FallModel.load(c, 'phone'), FallModel.load(c, 'wrist'), loadReplays(),
        ]);
        if (cancelled) return;
        const engine = new FallEngine(c, { phone: phoneModel, wrist: wristModel });
        engineRef.current = engine;
        const player = new ScenarioPlayer(replays, c.fs);
        player.onClipStart = (clip) => setNowPlaying(clip.title);
        playerRef.current = player;
        setCfg(c);
        setClips(replays);
        setBoot({ state: 'ready' });
      } catch (err) {
        if (!cancelled) setBoot({ state: 'error', msg: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- engine events ------------------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    return engine.on((type, data) => {
      if (type === 'mode') { setMode(data); addLog('mode', `Active sensor: ${data.label}`); }
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
        setAlert({ ...data, status: 'counting', startedAt: Date.now(), modeLabel: data.mode.label });
        addLog('alarm', `Possible fall — ${data.reason}`);
        navigator.vibrate?.([400, 200, 400]);
      }
      if (type === 'error') addLog('error', data.message);
    });
  }, [boot.state, addLog]);

  // ---- simulation clock (20 Hz) ------------------------------------------------------
  useEffect(() => {
    if (boot.state !== 'ready') return;
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
          const bpm = hrSim.update(1, s.clip, s.clipIdx, fs);
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
    setAlert(null);
  }, []);

  const notify = useCallback(async (why) => {
    const a = alert;
    if (!a) return;
    const rise = engineRef.current.hrRiseSince(a.t, a.hrBaseline);
    const scores = Object.entries(a.scores).filter(([, c]) => c)
      .map(([id, c]) => `${id === 'wrist' ? 'wearable' : 'phone'} ${Math.round(c.p * 100)}%`).join(', ');
    const message = [
      `⚠️ Possible fall: ${PERSON}`,
      `Time: ${timeStr(new Date(a.startedAt))}`,
      `Sensor: ${a.modeLabel} (${scores})`,
      rise != null ? `Heart rate: ${rise >= 0 ? '+' : ''}${Math.round(rise)} bpm after impact` : 'Heart rate: not available',
      why === 'help' ? 'They pressed "Get help now".' : 'No response within 30 seconds.',
      'Please check on them now. (Automated alert — not a medical diagnosis.)',
    ].join('\n');
    const result = await notifyCaregiver({ person: PERSON, message, alert: { ...a, hrRise: rise } });
    setAlert({ ...a, status: 'notified', message, notifyResult: result });
    addLog('notify', `Caregiver notified (${why === 'help' ? 'help requested' : 'no response'})`);
  }, [alert, addLog]);

  const onCancel = useCallback(() => { addLog('cancel', 'Alert cancelled — person is OK'); endAlert(); }, [addLog, endAlert]);
  const onExpire = useCallback(() => notify('timeout'), [notify]);
  const onHelpNow = useCallback(() => notify('help'), [notify]);

  const play = (clip) => {
    playerRef.current.play(clip);
    addLog('play', `Scenario: ${clip.title} (${clip.kind === 'fall' ? 'fall' : 'everyday activity'})`);
  };

  const enableLive = async () => {
    setLiveMsg('');
    try {
      await requestMotionPermission();
      setPhone((p) => ({ ...p, source: 'live' }));
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

  return (
    <div className="app">
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
          <p className="hr">{hr != null ? `♥ ${hr} bpm` : '♥ —'}</p>
          <div className="toggles">
            <label><input type="checkbox" checked={wearable.connected} onChange={(e) => setWearable((w) => ({ ...w, connected: e.target.checked }))} /> Connected</label>
            <label><input type="checkbox" checked={wearable.worn} disabled={!wearable.connected} onChange={(e) => setWearable((w) => ({ ...w, worn: e.target.checked }))} /> Worn</label>
          </div>
        </article>
        <article className={`device ${phoneActive ? 'active' : ''}`}>
          <header><span className="dot phone" /> Phone (pocket)</header>
          <p className="state">{phoneState}{phoneActive ? ' · in use' : ''}</p>
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
          {liveMsg && <p className="small error">{liveMsg}</p>}
        </article>
      </section>
      {mode === MODES.NONE && <p className="warn">No sensor is active — falls cannot be detected right now.</p>}
      {mode === MODES.PHONE && phone.onTable && <p className="warn">Phone hasn't moved for a while — it may not be on the person.</p>}

      <section className="card">
        <div className="row">
          <h2>Live signal</h2>
          <span className="muted small">{nowPlaying ? `Now: ${nowPlaying}` : ''}</span>
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
        <h2>Activity log</h2>
        <ul className="log">
          {log.length === 0 && <li className="muted">Events will appear here.</li>}
          {log.map((e) => <li key={e.id} className={`log-${e.kind}`}><time>{e.time}</time> {e.text}</li>)}
        </ul>
      </section>

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
        <AlertOverlay alert={alert} hrRise={hrRise} onCancel={onCancel} onHelpNow={onHelpNow}
          onExpire={onExpire} onClose={endAlert} />
      )}
    </div>
  );
}
