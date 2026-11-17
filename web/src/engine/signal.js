// Port of ml/fallguard/signal.py — keep the two in sync.
// Parity is tested against Python-generated golden vectors (npm test).

const EPS = 1e-6;
const f32 = Math.fround;

export function magnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

/** (WIN x 3) window centred so the peak sits at index `pre`; indices are clamped
 * to [0, n-1] exactly like numpy's np.clip in extract_window. `get(i)` -> [x,y,z]. */
export function extractWindow(get, n, peak, pre, post) {
  const win = [];
  for (let i = peak - pre; i < peak + post; i++) win.push(get(Math.min(Math.max(i, 0), n - 1)));
  return win;
}

function movingAverage(win, k) {
  const pad = Math.floor(k / 2);
  const n = win.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = [0, 0, 0];
    for (let j = i - pad; j < i - pad + k; j++) {
      const r = win[Math.min(Math.max(j, 0), n - 1)];
      s[0] += r[0]; s[1] += r[1]; s[2] += r[2];
    }
    out.push([s[0] / k, s[1] / k, s[2] / k]);
  }
  return out;
}

function meanRows(rows) {
  const s = [0, 0, 0];
  for (const r of rows) { s[0] += r[0]; s[1] += r[1]; s[2] += r[2]; }
  return s.map((v) => v / rows.length);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const degrees = (rad) => (rad * 180) / Math.PI;
const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Orientation-invariant channels: [|a|, a_vert, a_horiz, tilt/180], each length WIN.
 * Returned as float32 (like the Python version) so the CNN sees identical input. */
export function windowChannels(win, fs) {
  const gPre = meanRows(win.slice(0, fs));
  const gn = norm(gPre) + EPS;
  const gHat = gPre.map((v) => v / gn);
  const lp = movingAverage(win, 5);
  const n = win.length;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const r = win[i];
    const mag = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    const vert = dot(r, gHat);
    const horiz = Math.sqrt(Math.max(mag * mag - vert * vert, 0));
    const cos = dot(lp[i], gHat) / (norm(lp[i]) + EPS);
    ch[0][i] = mag; ch[1][i] = vert; ch[2][i] = horiz;
    ch[3][i] = degrees(Math.acos(clip(cos, -1, 1))) / 180;
  }
  return ch;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

/** The 20 hand-crafted features (same order as FEATURE_NAMES in Python). */
export function windowFeatures(win, fs, pre) {
  const ch = windowChannels(win, fs);
  const mag = Array.from(ch[0]);
  const vert = Array.from(ch[1]);
  const horiz = Array.from(ch[2]);
  const tilt = Array.from(ch[3], (v) => v * 180);
  const n = mag.length;
  const preMag = mag.slice(0, pre);
  const post = mag.slice(n - fs);
  const gPre = meanRows(win.slice(0, fs));
  const gPost = meanRows(win.slice(n - fs));
  const cosang = dot(gPre, gPost) / (norm(gPre) * norm(gPost) + EPS);
  const dyn = mag.map((v) => v - 1);
  let minI = 0;
  for (let i = 1; i < preMag.length; i++) if (preMag[i] < preMag[minI]) minI = i;
  const half = 0.5 * (mag[pre] + 1);
  let aMin = -1, aMax = -1;
  mag.forEach((v, i) => { if (v >= half) { if (aMin < 0) aMin = i; aMax = i; } });
  let maxJerk = 0;
  for (let i = 1; i < n; i++) maxJerk = Math.max(maxJerk, Math.abs(mag[i] - mag[i - 1]));
  const m = mean(mag), s = std(mag) + EPS;
  const feats = [
    mag[pre],
    Math.min(...preMag),
    mean(preMag),
    std(preMag),
    mean(post),
    std(post),
    mean(post.map((v) => (Math.abs(v - 1) < 0.1 ? 1 : 0))),
    maxJerk * fs,
    Math.max(...mag) - Math.min(...mag),
    dyn.reduce((a, v) => a + v * v, 0) / fs,
    dyn.reduce((a, v) => a + Math.abs(v), 0) / fs,
    (pre - minI) / fs,
    degrees(Math.acos(clip(cosang, -1, 1))),
    mean(vert.slice(n - fs)),
    mean(tilt.slice(n - fs)),
    Math.max(...horiz),
    Math.max(...vert),
    Math.min(...vert),
    aMin >= 0 ? (aMax - aMin + 1) / fs : 0,
    mean(mag.map((v) => ((v - m) / s) ** 4)),
  ];
  return Float32Array.from(feats, f32);
}
