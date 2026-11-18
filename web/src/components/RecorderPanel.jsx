import { useEffect, useRef, useState } from 'react';
import { SessionRecorder } from '../engine/recorder.js';

const QUICK_LABELS = ['walking', 'sitting', 'stairs', 'commuting', 'sleeping', 'exercise'];

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Record what the engine sees, label it, export CSV for eval_recording.py. */
export default function RecorderPanel({ engine }) {
  const rec = useRef(null);
  const [state, setState] = useState({ recording: false, duration: 0, counts: { phone: 0, wrist: 0 }, hasData: false });
  const [last, setLast] = useState('');

  useEffect(() => {
    rec.current = new SessionRecorder(engine);
    return () => rec.current?.stop();
  }, [engine]);

  useEffect(() => {
    if (!state.recording) return;
    const id = setInterval(() => setState((s) => ({ ...s, duration: rec.current.duration, counts: { ...rec.current.counts } })), 500);
    return () => clearInterval(id);
  }, [state.recording]);

  const start = () => { rec.current.start(); setLast(''); setState({ recording: true, duration: 0, counts: { phone: 0, wrist: 0 }, hasData: true }); };
  const stop = () => { rec.current.stop(); setState((s) => ({ ...s, recording: false })); };
  const mark = (label) => { rec.current.mark(label); setLast(`${label} @ ${fmt(rec.current.duration)}`); };

  return (
    <details className="card recorder">
      <summary>Record data for real-world testing</summary>
      <p className="small muted">
        Records the 20 Hz streams the detector sees, its scores and alarms, and your labels. Carry the phone
        (with “This phone” selected) through normal activities, then download the CSV and run
        {' '}<code>python ml/scripts/eval_recording.py file.csv</code> to measure the real false-alarm rate.
        The data stays on this device until you download it.
      </p>
      <div className="row">
        {state.recording
          ? <button className="btn-sm danger" onClick={stop}>■ Stop recording</button>
          : <button className="btn-sm" onClick={start}>● Start recording</button>}
        <span className="small muted" aria-live="polite">
          {state.hasData && `${fmt(state.duration)} · phone ${state.counts.phone} · wearable ${state.counts.wrist} samples`}
        </span>
      </div>
      {state.recording && (
        <>
          <h3>Label what's happening</h3>
          <div className="chips">
            <button className="chip fall" onClick={() => mark('fall')}>I just did a test fall</button>
            {QUICK_LABELS.map((l) => <button key={l} className="chip" onClick={() => mark(l)}>{l}</button>)}
          </div>
          {last && <p className="small muted">Last label: {last}</p>}
        </>
      )}
      {!state.recording && state.hasData && (
        <button className="btn-sm" onClick={() => rec.current.download()}>⬇ Download CSV</button>
      )}
    </details>
  );
}
