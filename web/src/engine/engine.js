// FallEngine: receives fs-rate samples from any device, runs the per-device
// detectors and models, picks the active mode, fuses, and raises alarms.
// Device-agnostic: a "device" is just a stream of [x,y,z] in g plus optional
// heart rate and an on-body flag. Real adapters (Wear OS, HealthKit, BLE) and the
// simulator both feed it through the same three methods:
//   setDeviceStatus(id, patch) · pushSample(id, [x,y,z], t) · pushHeartRate(t, bpm)

import { DeviceDetector } from './detector.js';
import { MATCH_S, MODES, fuseScores, isResting, selectMode, PHONE_RESTING_S } from './fusion.js';

const DEVICE_IDS = ['phone', 'wrist'];

export class FallEngine {
  constructor(cfg, models, { rule = 'mean' } = {}) {
    this.cfg = cfg;
    this.models = models; // { phone: FallModel, wrist: FallModel }
    this.rule = rule;
    this.listeners = new Set();
    this.devices = {};
    for (const id of DEVICE_IDS) {
      this.devices[id] = {
        id, connected: false, worn: id === 'wrist' ? false : true, resting: false, lastSampleT: null,
        detector: new DeviceDetector(cfg, cfg.positions[id]),
        threshold: cfg.positions[id].threshold,
        candidates: [], // {t, p, pLgb, pCnn, peakG, ms}
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
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  setDeviceStatus(id, patch) {
    const d = this.devices[id];
    Object.assign(d, patch);
    if (patch.connected === false) { d.detector.reset(); d.candidates = []; d.lastSampleT = null; }
    this.emit('status', this.snapshot());
  }

  pushHeartRate(t, bpm) {
    this.hr.push({ t, bpm });
    if (this.hr.length > 600) this.hr.splice(0, this.hr.length - 600);
  }

  pushSample(id, sample, t) {
    const d = this.devices[id];
    if (!d.connected) return;
    d.lastSampleT = t;
    const cand = d.detector.push(sample);
    if (id === 'phone' && d.detector.length % this.cfg.fs === 0) {
      d.resting = d.detector.length > PHONE_RESTING_S * this.cfg.fs &&
        isResting(d.detector.recentMags(PHONE_RESTING_S), sample);
    }
    if (cand) this.scoreCandidate(d, cand, t - this.cfg.post / this.cfg.fs);
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
      if (c.s >= 1) this.raise(c.t, { [deviceId]: c }, `${deviceId === 'wrist' ? 'Wearable' : 'Phone'} model`);
    }
  }

  /** Call regularly (e.g. every 100 ms) with the current time. */
  tick(now) {
    const prev = this.mode;
    this.mode = selectMode(this.devices, now);
    if (prev !== this.mode) this.emit('mode', this.mode);
    // resolve fused decisions once both devices had time to report on the moment
    const ready = this.pending.filter((p) => now >= p.t + MATCH_S + 1.0);
    this.pending = this.pending.filter((p) => now < p.t + MATCH_S + 1.0);
    for (const p of ready.sort((a, b) => a.t - b.t)) {
      const best = (id) => {
        const near = this.devices[id].candidates.filter((x) => Math.abs(x.t - p.t) <= MATCH_S);
        return near.length ? near.reduce((a, b) => (b.p > a.p ? b : a)) : null;
      };
      const cp = best('phone'), cw = best('wrist');
      const sP = cp ? cp.s : 0, sW = cw ? cw.s : 0;
      if (fuseScores(sP, sW, this.rule)) this.raise(p.t, { phone: cp, wrist: cw }, `Fused (${this.rule}) score ${((sP + sW) / 2).toFixed(2)}`);
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
