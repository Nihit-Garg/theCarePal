// Records everything the engine sees (20 Hz samples per device, heart rate,
// detector candidates, alarms) plus the user's own labels, and exports a CSV.
// Purpose: real-world validation. Carry the phone for a few hours of normal life,
// export, then run `python ml/scripts/eval_recording.py file.csv` to measure the
// real false-alarm rate on unscripted activity (see docs/REAL_WORLD_TEST.md).

export const CSV_HEADER = 't,device,ax,ay,az,hr,event,detail';

export class SessionRecorder {
  constructor(engine) {
    this.engine = engine;
    this.rows = [];
    this.t0 = null;
    this.untap = null;
    this.unlisten = null;
    this.counts = { phone: 0, wrist: 0 };
  }

  get recording() { return this.untap !== null; }
  get duration() { return this.t0 == null ? 0 : performance.now() / 1000 - this.t0; }

  rel(t) { return (t - this.t0).toFixed(3); }

  start(note = '') {
    if (this.recording) return;
    this.rows = [];
    this.counts = { phone: 0, wrist: 0 };
    this.t0 = performance.now() / 1000;
    this.event('start', note || `recorded ${new Date().toISOString()}`);
    this.untap = this.engine.tap((kind, dev, v, t) => {
      if (kind === 'sample') {
        this.counts[dev]++;
        this.rows.push(`${this.rel(t)},${dev},${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)},,,`);
      } else if (kind === 'hr') {
        this.rows.push(`${this.rel(t)},${dev},,,,${v},,`);
      }
    });
    this.unlisten = this.engine.on((type, d) => {
      if (type === 'candidate') this.event('candidate', `${d.device} p=${d.p.toFixed(3)} peak=${d.peakG.toFixed(2)}g`, d.t);
      if (type === 'alarm') this.event('alarm', `${d.mode.key} ${d.reason}`, d.t);
    });
  }

  /** A user label: 'fall' marks a deliberate test fall; anything else is an activity label. */
  event(kind, detail = '', t = performance.now() / 1000) {
    if (this.t0 == null) return;
    const safe = String(detail).replace(/[,\n\r]/g, ' ');
    this.rows.push(`${this.rel(t)},,,,,,${kind},${safe}`);
  }

  mark(label) { this.event(label === 'fall' ? 'mark_fall' : 'mark_activity', label); }

  stop() {
    if (!this.recording) return;
    this.event('stop');
    this.untap(); this.unlisten();
    this.untap = this.unlisten = null;
  }

  toCsv() {
    // events can be logged with slightly earlier timestamps (peak time), so sort by t
    const sorted = [...this.rows].sort((a, b) => parseFloat(a) - parseFloat(b));
    return [CSV_HEADER, ...sorted].join('\n') + '\n';
  }

  download(filename = `fallguard-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`) {
    const url = URL.createObjectURL(new Blob([this.toCsv()], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
