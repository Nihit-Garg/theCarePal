// Streaming stage-1 trigger + window extraction (port of fallguard/detector.py).
// One DeviceDetector per device. It never decides on its own whether to alarm —
// it emits scored candidates; the FallEngine applies thresholds and fusion.

import { extractWindow, magnitude } from './signal.js';

export class DeviceDetector {
  constructor(cfg, posCfg) {
    this.cfg = cfg;
    this.trigger = posCfg.trigger_g;
    this.maxKeep = cfg.fs * 60; // 60 s of history is plenty
    this.reset();
  }

  reset() {
    this.samples = [];  // [x,y,z] in g
    this.mags = [];
    this.offset = 0;    // global index of samples[0]
  }

  get length() { return this.offset + this.samples.length; }

  /** Push one fs-rate sample; returns a candidate {index, window} or null.
   * The sample at (n-1-post) is checked: by then we have its +/-0.5 s
   * neighbourhood (local max test) and the full 2.5 s after it (window). */
  push(sample) {
    const { pre, post, peak_half_width: h } = this.cfg;
    this.samples.push(sample);
    this.mags.push(magnitude(...sample));
    if (this.samples.length > this.maxKeep + 200) {
      const drop = this.samples.length - this.maxKeep;
      this.samples.splice(0, drop);
      this.mags.splice(0, drop);
      this.offset += drop;
    }
    const n = this.length;
    const i = n - 1 - post;
    if (i < 0) return null;
    const mi = this.mag(i);
    if (mi < this.trigger) return null;
    // local max within +/-h; earlier equal values win (numpy argmax semantics)
    for (let j = Math.max(0, i - h); j < i; j++) if (this.mag(j) >= mi) return null;
    for (let j = i + 1; j <= Math.min(n - 1, i + h); j++) if (this.mag(j) > mi) return null;
    const window = extractWindow((k) => this.get(k), n, i, pre, post);
    return { index: i, peakG: mi, window };
  }

  get(globalIdx) { return this.samples[Math.max(globalIdx - this.offset, 0)]; }
  mag(globalIdx) { return this.mags[Math.max(globalIdx - this.offset, 0)]; }

  /** Recent |a| values for charts / stillness checks. */
  recentMags(seconds) {
    return this.mags.slice(-Math.round(seconds * this.cfg.fs));
  }
}
