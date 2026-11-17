// Device selection + fusion (mirrors ml/fallguard/fusion.py).
//
//   wearable connected & worn & streaming  +  phone streaming & on the person  -> BOTH (fused)
//   wearable connected & worn & streaming                                     -> WEARABLE
//   phone streaming                                                           -> PHONE
//   nothing                                                                   -> NONE (warn)
//
// In BOTH mode each device's candidate is held for MATCH_S seconds so the other
// device's view of the same moment can be considered, then scores (normalised by
// each device's own threshold) are combined with the rule measured best in
// reports/fusion.md.

export const MATCH_S = 1.5;
export const STALE_S = 2.0;           // no samples for 2 s => device considered disconnected
export const PHONE_RESTING_S = 30;    // phone still AND flat this long => probably on a table

export const MODES = {
  BOTH: { key: 'BOTH', label: 'Phone + wearable (fused)' },
  WEARABLE: { key: 'WEARABLE', label: 'Wearable' },
  PHONE: { key: 'PHONE', label: 'Phone' },
  NONE: { key: 'NONE', label: 'No sensor' },
};

/** devices: { phone: DeviceStatus, wrist: DeviceStatus } with
 *  { connected, lastSampleT, worn (wearable), resting (phone) } */
export function selectMode(devices, now) {
  const fresh = (d) => d.connected && d.lastSampleT != null && now - d.lastSampleT < STALE_S;
  const wearOk = fresh(devices.wrist) && devices.wrist.worn;
  const phoneOk = fresh(devices.phone);
  if (wearOk && phoneOk && !devices.phone.resting) return MODES.BOTH;
  if (wearOk) return MODES.WEARABLE;
  if (phoneOk) return MODES.PHONE;
  return MODES.NONE;
}

/** Combine normalised scores (s >= 1 means that device alone would alarm). */
export function fuseScores(sPhone, sWrist, rule = 'mean') {
  if (rule === 'or') return Math.max(sPhone, sWrist) >= 1;
  if (rule === 'and') return Math.min(sPhone, sWrist) >= 1;
  return (sPhone + sWrist) / 2 >= 1;
}

/** Phone "resting on a surface": |a| essentially constant for PHONE_RESTING_S and
 * the screen facing up/down (gravity on the z axis). Stillness alone isn't enough —
 * a phone in the pocket of someone sitting quietly is also still, but not flat. */
export function isResting(mags, lastSample) {
  if (mags.length < 10 || !lastSample) return false;
  if (Math.abs(lastSample[2]) < 0.95 * Math.hypot(...lastSample)) return false;
  let lo = Infinity, hi = -Infinity;
  for (const m of mags) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
  return hi - lo < 0.03;
}
