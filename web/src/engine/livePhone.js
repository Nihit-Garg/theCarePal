// Live phone accelerometer via the W3C DeviceMotion API — works in Chrome on
// Android and Safari on iOS (needs HTTPS and, on iOS, a permission tap).
// accelerationIncludingGravity is m/s^2; we convert to g and bin-resample to fs.
// Axis sign conventions differ between browsers; the models only use
// orientation-invariant channels, so that doesn't matter.

import { BinResampler } from './resample.js';

const G = 9.80665;

export function liveMotionSupported() {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
}

export async function requestMotionPermission() {
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    const res = await DME.requestPermission(); // iOS 13+
    if (res !== 'granted') throw new Error('Motion permission was denied');
  }
}

/** Starts streaming; returns a stop() function. onSample([x,y,z], tSeconds). */
export function startLivePhone(fs, onSample, onNoData) {
  // Each output sample is stamped with its bin's time (t0 + bin / fs), not the moment
  // it was emitted: emission happens one bin late, and gap-filled bins come in bursts.
  let t0 = null;
  const resampler = new BinResampler(fs, (s, bin) => onSample(s, t0 / 1000 + bin / fs));
  let got = false;
  const handler = (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    got = true;
    const now = performance.now();
    if (t0 === null) t0 = now;
    resampler.push(now, a.x / G, a.y / G, a.z / G);
  };
  window.addEventListener('devicemotion', handler);
  const timer = setTimeout(() => { if (!got) onNoData?.(); }, 2500); // desktops never fire
  return () => { window.removeEventListener('devicemotion', handler); clearTimeout(timer); };
}
