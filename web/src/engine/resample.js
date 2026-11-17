// Port of fallguard.datasets.bin_resample, in streaming form.
// Any input rate (a browser's ~60 Hz DeviceMotion, a band's 25 Hz, a watch's 50 Hz)
// is averaged into fixed 1/fs bins; empty bins are linearly interpolated.

export class BinResampler {
  constructor(fs, onSample) {
    this.binMs = 1000 / fs;
    this.onSample = onSample; // (sample [x,y,z], binIndex) => void
    this.t0 = null;
    this.bin = -1;
    this.acc = [0, 0, 0];
    this.count = 0;
    this.last = null; // last emitted sample, for interpolation over gaps
  }

  push(tMs, x, y, z) {
    if (this.t0 === null) { this.t0 = tMs; this.bin = 0; }
    const b = Math.floor((tMs - this.t0) / this.binMs);
    if (b < this.bin) return; // out-of-order sample: drop
    if (b > this.bin) {
      this.flush(b);
    }
    this.acc[0] += x; this.acc[1] += y; this.acc[2] += z; this.count++;
  }

  flush(nextBin) {
    if (this.count > 0) {
      const s = this.acc.map((v) => v / this.count);
      const gap = this.last ? this.bin - this.last.bin : 1;
      for (let k = 1; k < gap; k++) { // fill empty bins between last and current
        const f = k / gap;
        this.onSample(this.last.s.map((v, i) => v + (s[i] - v) * f), this.last.bin + k);
      }
      this.onSample(s, this.bin);
      this.last = { s, bin: this.bin };
    }
    this.bin = nextBin;
    this.acc = [0, 0, 0];
    this.count = 0;
  }
}

/** Batch version, used by the parity test against Python. */
export function binResample(tMs, xyz, fs) {
  const out = [];
  const r = new BinResampler(fs, (s) => out.push(s));
  tMs.forEach((t, i) => r.push(t, ...xyz[i]));
  r.flush(Infinity);
  return out;
}
