"""Estimate the battery cost of running the detector on a phone and on a wearable.

    python ml/scripts/battery_estimate.py

Analytical model with every assumption written down. Two inputs are measured:
  * how often stage 1 fires (candidates per hour of daily activity, from the data)
  * stage-2 inference time (ONNX Runtime on this machine, scaled for mobile CPUs)
Writes reports/battery.md and reports/battery.json.
"""
from __future__ import annotations

import json
import pickle
import time

import numpy as np
import onnxruntime as ort

from fallguard import config
from fallguard.datasets import load_recordings
from fallguard.signal import find_candidate_peaks, magnitude, window_channels, window_features

# ---- assumptions (typical datasheet / published values; adjust for a given device) ----
DEVICES = {
    "phone": dict(battery_wh=4500e-3 * 3.85,       # 4500 mAh, 3.85 V
                  accel_mw=0.30,                     # MEMS accel @ 20 Hz, low-power mode
                  wake_mj=5.0,                       # AP wake from suspend + FIFO drain
                  cpu_active_mw=1000.0,              # one core busy during inference
                  mobile_slowdown=8.0),              # vs this laptop CPU
    "wrist": dict(battery_wh=300e-3 * 3.85,         # 300 mAh smartwatch
                  accel_mw=0.10,
                  wake_mj=1.0,
                  cpu_active_mw=150.0,
                  mobile_slowdown=20.0),
}
BATCH_S = 5            # sensor FIFO batching: wake every 5 s (latency stays < 8 s)
WAKING_HOURS = 16      # hours/day with daily activity; the rest is sleep (few candidates)
REAL_LIFE_FACTOR = 0.25  # real days are far calmer than back-to-back lab ADL clips
PPG_CONTINUOUS_MW = 1.5  # optical heart rate, continuous
PPG_BURST_S = 60         # our design: HR burst only when stage 2 is at least half-convinced
BURST_AT = 0.5           # ... i.e. score >= 0.5 x the wearable's alarm threshold
BLE_STREAM_MW = 1.2      # streaming raw 20 Hz accel to the phone over BLE


def load_meta() -> dict:
    return json.loads((config.WEB_MODELS_DIR / "model_config.json").read_text())


def candidate_rates(data, meta: dict) -> dict[str, float]:
    out = {}
    for pos, recs in data.items():
        trig = meta["positions"][pos]["trigger_g"]
        adl = [r for r in recs if not r.label]
        n = sum(len(find_candidate_peaks(magnitude(r.acc), trig)) for r in adl)
        out[pos] = n / (sum(r.duration_s for r in adl) / 3600)
    return out


def burst_rate_per_hour(meta: dict) -> float:
    """Out-of-fold wrist candidates on ADL with score >= BURST_AT x threshold, per hour
    (from eval_fusion.py's cached held-out scores)."""
    scored = pickle.loads((config.PROCESSED_DIR / "fusion_scores.pkl").read_bytes())
    thr = meta["positions"]["wrist"]["threshold"]
    n = hours = 0.0
    for _, wr, c in scored:
        if not wr.label:
            n += int((c["wrist"].probs >= BURST_AT * thr).sum())
            hours += wr.duration_s / 3600
    return n / hours


def inference_ms(pos: str, meta: dict) -> float:
    files = meta["positions"][pos]["models"]
    lgb = ort.InferenceSession(str(config.WEB_MODELS_DIR / files["lightgbm"]))
    cnn = ort.InferenceSession(str(config.WEB_MODELS_DIR / files["cnn"]))
    win = np.random.default_rng(0).normal(0, 0.3, (config.WIN, 3)) + np.array([0.0, 0.0, 1.0])
    for _ in range(20):  # warm-up
        lgb.run(None, {"features": window_features(win)[None]})
    t0 = time.perf_counter()
    reps = 300
    for _ in range(reps):
        lgb.run(None, {"features": window_features(win)[None]})
        cnn.run(None, {"channels": window_channels(win)[None]})
    return (time.perf_counter() - t0) / reps * 1000


def main() -> None:
    data = load_recordings()
    meta = load_meta()
    rates = candidate_rates(data, meta)
    bursts_h = burst_rate_per_hour(meta)
    res = {}
    for pos, d in DEVICES.items():
        ms_local = inference_ms(pos, meta)
        ms_dev = ms_local * d["mobile_slowdown"]
        cands_day = rates[pos] * REAL_LIFE_FACTOR * WAKING_HOURS
        j = {  # joules per day
            "accelerometer": d["accel_mw"] / 1000 * 86400,
            "batched wake-ups": 86400 / BATCH_S * d["wake_mj"] / 1000,
            "stage-1 trigger": 86400 * config.FS * 50e-9 * d["cpu_active_mw"] / 1000,  # ~50 ns/sample
            "stage-2 inference": cands_day * ms_dev / 1000 * d["cpu_active_mw"] / 1000,
        }
        if pos == "wrist":
            bursts_day = bursts_h * REAL_LIFE_FACTOR * WAKING_HOURS
            j["heart-rate bursts (60 s, only if score >= half threshold)"] = bursts_day * PPG_BURST_S * PPG_CONTINUOUS_MW / 1000
        battery_j = d["battery_wh"] * 3600
        res[pos] = {
            "candidates_per_hour_lab": round(rates[pos], 1),
            "candidates_per_day_assumed": round(cands_day),
            "inference_ms_this_machine": round(ms_local, 3),
            "inference_ms_device_est": round(ms_dev, 2),
            "joules_per_day": {k: round(v, 2) for k, v in j.items()},
            "total_pct_battery_per_day": round(100 * sum(j.values()) / battery_j, 2),
        }
        if pos == "wrist":
            res[pos]["hr_bursts_per_hour_lab"] = round(bursts_h, 1)
            res[pos]["alternatives_pct_per_day"] = {
                "heart-rate burst after every stage-1 candidate (naive)": round(100 * cands_day * PPG_BURST_S * PPG_CONTINUOUS_MW / 1000 / battery_j, 1),
                "continuous heart rate instead of bursts": round(100 * PPG_CONTINUOUS_MW / 1000 * 86400 / battery_j, 1),
                "stream raw accel to phone over BLE instead of on-watch inference": round(100 * BLE_STREAM_MW / 1000 * 86400 / battery_j, 1),
            }
    (config.REPORTS_DIR / "battery.json").write_text(json.dumps(res, indent=2))

    lines = ["# Battery impact estimate", "",
             "Analytical estimate, not a measurement on hardware. Assumptions are at the top of "
             "`ml/scripts/battery_estimate.py`; candidate rates and inference time are measured.", ""]
    for pos, r in res.items():
        lines += [f"## {'Phone' if pos == 'phone' else 'Wearable (wrist)'}: ~{r['total_pct_battery_per_day']}% of battery per day", "",
                  f"* Stage 1 fires {r['candidates_per_hour_lab']}/h on lab ADL clips; assuming real days are "
                  f"{REAL_LIFE_FACTOR:.0%} as busy over {WAKING_HOURS} waking hours ≈ {r['candidates_per_day_assumed']} stage-2 runs/day.",
                  f"* Stage 2 (features + LightGBM + CNN) takes {r['inference_ms_this_machine']} ms here, "
                  f"~{r['inference_ms_device_est']} ms estimated on the device.", "",
                  "| Component | Joules/day |", "|---|---|"]
        lines += [f"| {k} | {v} |" for k, v in r["joules_per_day"].items()]
        if "alternatives_pct_per_day" in r:
            lines += ["", f"* Heart-rate bursts: stage 2 scores >= {BURST_AT:.0%} of the alarm threshold {r['hr_bursts_per_hour_lab']}/h "
                      "on held-out lab ADL. The pre-impact baseline comes from the watch's own periodic background heart-rate readings."]
            lines += ["", "Design choices this avoids (% battery/day on their own):", ""]
            lines += [f"* {k}: {v}%" for k, v in r["alternatives_pct_per_day"].items()]
        lines.append("")
    lines += ["Takeaways: the two-stage design makes the ML almost free; the accelerometer and wake-ups "
              "dominate, so FIFO batching matters more than model size. On a watch, continuous optical "
              "heart rate would cost more than everything else combined, which is why heart rate is only "
              "sampled in a burst when stage 2 already suspects a fall. (A first version burst on every stage-1 "
              "candidate; this estimate showed that would cost more than continuous heart rate.)", ""]
    (config.REPORTS_DIR / "battery.md").write_text("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
