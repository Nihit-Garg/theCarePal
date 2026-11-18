// FallEngine: receives fs-rate samples from any device, runs the per-device
// detectors and models, picks the active mode, fuses, and raises alarms.
// Device-agnostic: a "device" is just a stream of [x,y,z] in g at cfg.fs plus
// optional heart rate and an on-body flag. Real adapters (Wear OS, HealthKit, BLE)
// and the simulator feed it through the same three methods:
//   setDeviceStatus(id, patch) · pushSample(id, [x,y,z], t) · pushHeartRate(t, bpm)
// Samples must already be at cfg.fs: wrap a device's native rate with BinResampler
// (see livePhone.js). Observers: on(fn) for detection events, tap(fn) for every
// raw sample (the recorder).

import { DeviceDetector } from './detector.js';
import { MODES, PHONE_RESTING_S, fuseScores, isResting, margin, selectMode } from './fusion.js';

const DEVICE_IDS = ['phone', 'wrist'];
const INFERENCE_MARGIN_S = 0.5;

export class FallEngine {
  constructor(cfg, models) {
    this.cfg = cfg;
    this.models = models; // { phone: FallModel, wrist: FallModel }
    if (!cfg.fusion) throw new Error('model_config.json has no "fusion" settings — re-run ml/scripts/export_models.py');
    this.fusion = cfg.fusion; // exported from ml/fallguard/fusion.py, never duplicated here
    // A fused decision about a peak at time t waits until the other device's
    // candidate (peak up to match_s later) has been detected (post seconds after
    // its peak) and scored.
    this.fuseWait = this.fusion.match_s + cfg.post / cfg.fs + INFERENCE_MARGIN_S;
    this.thresholds = { phone: cfg.positions.phone.threshold, wrist: cfg.positions.wrist.threshold };
    this.listeners = new Set();
    this.taps = new Set();
    this.inflight = new Set();
    this.devices = {};
    for (const id of DEVICE_IDS) {
      this.devices[id] = {
        id, connected: false, worn: id !== 'wrist', resting: false, lastSampleT: null,
        detector: new DeviceDetector(cfg, cfg.positions[id]),
        threshold: cfg.positions[id].threshold,
        candidates: [], // {t, p, pLgb, pCnn, peakG, ms, s}
      };
    }
    this.hr = []; // {t, bpm}
    this.pending = [];
    this.lastAlarmT = -Infinity;
    this.ignoreBefore = -Infinity; // impacts before this time belong to an already-handled alert
    this.mode = MODES.NONE;
    this.suspended = false; // true while an alert countdown is on screen
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** fn(kind, deviceId, value, t): kind 'sample' (value [x,y,z]) or 'hr' (value bpm). */
  tap(fn) { this.taps.add(fn); return () => this.taps.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  /** Emits 'status' (with snapshot()) only when something actually changed. */
  setDeviceStatus(id, patch) {
    const d = this.devices[id];
    const changed = Object.entries(patch).some(([k, v]) => d[k] !== v);
    if (!changed) return;
    Object.assign(d, patch);
    if (patch.connected === false) { d.detector.reset(); d.candidates = []; d.lastSampleT = null; d.resting = false; }
    this.emit('status', this.snapshot());
  }

  pushHeartRate(t, bpm) {
    for (const fn of this.taps) fn('hr', 'wrist', bpm, t);
    this.hr.push({ t, bpm });
    if (this.hr.length > 600) this.hr.splice(0, this.hr.length - 600);
  }

  pushSample(id, sample, t) {
    const d = this.devices[id];
    if (!d.connected) return;
    d.lastSampleT = t;
    for (const fn of this.taps) fn('sample', id, sample, t);
    const cand = d.detector.push(sample);
    if (id === 'phone' && d.detector.length % this.cfg.fs === 0) {
      const resting = d.detector.length > PHONE_RESTING_S * this.cfg.fs &&
        isResting(d.detector.recentMags(PHONE_RESTING_S), sample);
      if (resting !== d.resting) this.setDeviceStatus('phone', { resting });
    }
    if (cand) {
      const job = this.scoreCandidate(d, cand, t - this.cfg.post / this.cfg.fs);
      this.inflight.add(job);
      job.finally(() => this.inflight.delete(job));
    }
  }

  /** Resolves when every candidate pushed so far has been scored (used by tests). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  async scoreCandidate(d, cand, peakT) {
    try {
      const r = await this.models[d.id].predict(cand.window);
      const c = { t: peakT, peakG: cand.peakG, ...r, s: r.p / d.threshold };
      d.candidates.push(c);
      d.candidates = d.candidates.filter((x) => peakT - x.t < 30);
      this.emit('candidate', { device: d.id, ...c });
      this.decide(d.id, c);
    } catch (err) {
      this.emit('error', { message: `Model inference failed on ${d.id}: ${err.message}` });
    }
  }

  decide(deviceId, c) {
    const mode = this.mode;
    if (mode === MODES.BOTH) {
      this.pending.push({ t: c.t, deviceId });
    } else if ((mode === MODES.WEARABLE && deviceId === 'wrist') || (mode === MODES.PHONE && deviceId === 'phone')) {
      if (c.p >= this.devices[deviceId].threshold) this.raise(c.t, { [deviceId]: c }, `${deviceId === 'wrist' ? 'Wearable' : 'Phone'} model`);
    }
  }

  /** Call regularly (e.g. every 50–100 ms) with the current time. */
  tick(now) {
    const prev = this.mode;
    this.mode = selectMode(this.devices, now);
    if (prev !== this.mode) this.emit('mode', this.mode);
    const ready = this.pending.filter((p) => now >= p.t + this.fuseWait);
    this.pending = this.pending.filter((p) => now < p.t + this.fuseWait);
    for (const p of ready.sort((a, b) => a.t - b.t)) {
      const best = (id) => {
        // +1e-6: times are floats (i / fs); Python compares integer sample indices
        const near = this.devices[id].candidates.filter((x) => Math.abs(x.t - p.t) <= this.fusion.match_s + 1e-6);
        return near.length ? near.reduce((a, b) => (b.p > a.p ? b : a)) : null;
      };
      const cp = best('phone'), cw = best('wrist');
      if (fuseScores(cp?.p ?? null, cw?.p ?? null, this.thresholds, this.fusion)) {
        const clip = this.fusion.logodds_clip;
        const m = margin(cp?.p ?? null, this.thresholds.phone, clip) + margin(cw?.p ?? null, this.thresholds.wrist, clip);
        this.raise(p.t, { phone: cp, wrist: cw }, `Fused (${this.fusion.rule}) evidence ${m >= 0 ? '+' : ''}${m.toFixed(1)}`);
      }
    }
  }

  /** Call when an alert is closed (cancelled or handled). Re-arms detection right
   * away — a person can stumble, tap "I'm OK", and then really fall seconds later —
   * while ignoring late candidates from the impact that was just handled. */
  resume(now) {
    this.suspended = false;
    this.ignoreBefore = now;
    this.lastAlarmT = -Infinity;
    this.pending = this.pending.filter((p) => p.t >= now);
  }

  raise(t, scores, reason) {
    const refractory = this.cfg.refractory_s;
    if (this.suspended || t < this.ignoreBefore || t - this.lastAlarmT < refractory) return;
    this.lastAlarmT = t;
    this.emit('alarm', { t, mode: this.mode, scores, reason, hrBaseline: this.hrBaseline(t) });
  }

  /** Mean heart rate over the 30 s before the impact (null if no wearable HR). */
  hrBaseline(t) {
    const pts = this.hr.filter((h) => h.t >= t - 30 && h.t < t - 2);
    return pts.length >= 3 ? pts.reduce((a, h) => a + h.bpm, 0) / pts.length : null;
  }

  /** Largest HR rise after impact vs baseline — a supporting signal, never a gate
   * (beta-blockers, common in older adults, blunt the heart-rate response). */
  hrRiseSince(t, baseline) {
    if (baseline == null) return null;
    const after = this.hr.filter((h) => h.t >= t);
    if (!after.length) return null;
    return Math.max(...after.map((h) => h.bpm)) - baseline;
  }

  snapshot() {
    const out = { mode: this.mode, devices: {} };
    for (const id of DEVICE_IDS) {
      const { connected, worn, resting, lastSampleT } = this.devices[id];
      out.devices[id] = { connected, worn, resting, lastSampleT };
    }
    return out;
  }
}

