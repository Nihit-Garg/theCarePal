// Device selection + fusion (mirrors ml/fallguard/fusion.py).
//
//   wearable connected & worn & streaming  +  phone streaming & not resting on a table -> BOTH (fused)
//   wearable connected & worn & streaming                                              -> WEARABLE
//   phone streaming                                                                    -> PHONE
//   nothing                                                                            -> NONE (warn)
//
// Fusion settings (rule, matching window, log-odds clip) come from
// model_config.json, written by export_models.py from the Python constants, so
// the two implementations can't drift apart.

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

const logit = (p) => { const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(q / (1 - q)); };

/** Evidence for a fall relative to a device's own threshold (0 = on the line),
 * clipped to +/-clip. A device with no candidate near the moment counts as -clip. */
export function margin(p, threshold, clip) {
  if (p == null) return -clip;
  return Math.min(Math.max(logit(p) - logit(threshold), -clip), clip);
}

/** pPhone / pWrist: each device's best probability near the moment, or null if it
 * had no candidate. fusion: { rule, logodds_clip } from model_config.json. */
export function fuseScores(pPhone, pWrist, thr, fusion) {
  const { rule, logodds_clip: clip } = fusion;
  if (rule === 'logodds') return margin(pPhone, thr.phone, clip) + margin(pWrist, thr.wrist, clip) >= 0;
  const sP = (pPhone ?? 0) / thr.phone, sW = (pWrist ?? 0) / thr.wrist;
  if (rule === 'or') return Math.max(sP, sW) >= 1;
  if (rule === 'and') return Math.min(sP, sW) >= 1;
  if (rule === 'mean') return (sP + sW) / 2 >= 1;
  throw new Error(`Unknown fusion rule: ${rule}`);
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
