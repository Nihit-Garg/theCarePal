"""Measure the shipped detector on a real-world recording.

    python ml/scripts/eval_recording.py recording.csv [--out reports/real_world/run1]

Input formats
  * FallGuard CSV — exported from the demo's "Record data" panel
    (columns t,device,ax,ay,az,hr,event,detail; t in seconds; acceleration in g;
    `mark_fall` events are the user's "I just did a test fall" labels).
  * Any accelerometer CSV (e.g. from a sensor-logger app on a phone or watch):
        --generic --time-col time --x x --y y --z z --time-unit s|ms|ns --units g|ms2 --device phone|wrist
    The signal must INCLUDE gravity (raw accelerometer, not "user acceleration").

Outputs: printed summary, <out>.json, and <out>.png (timeline with |a|, stage-2
scores, alarms and your fall marks). Reported per device present:
  * hours recorded, alarms, false alarms (alarms not within -10 s..+5 s of a fall mark),
    false alarms per hour, and marked falls detected.
  * For FallGuard CSVs: how many alarms the browser raised during recording, as a
    cross-check that Python and browser agree.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from fallguard import config
from fallguard.datasets import bin_resample
from fallguard.detector import alarms_from_candidates, score_recording
from fallguard.onnx_model import OnnxEnsemble
from fallguard.signal import magnitude

MARK_BEFORE_S, MARK_AFTER_S = 10.0, 5.0   # the user taps "I just fell" a few seconds after impact
TIME_SCALE = {"s": 1000.0, "ms": 1.0, "ns": 1e-6}


def load_fallguard_csv(path: Path) -> tuple[dict, list[float], int]:
    df = pd.read_csv(path)
    streams = {}
    for dev in ("phone", "wrist"):
        d = df[(df["device"] == dev) & df["ax"].notna()]
        if len(d) >= config.FS * 5:
            streams[dev] = (d["t"].to_numpy(float), d[["ax", "ay", "az"]].to_numpy(float))
    marks = df.loc[df["event"] == "mark_fall", "t"].astype(float).tolist()
    app_alarms = int((df["event"] == "alarm").sum())
    return streams, marks, app_alarms


def load_generic_csv(path: Path, a) -> tuple[dict, list[float], None]:
    df = pd.read_csv(path)
    t = df[a.time_col].to_numpy(float) * TIME_SCALE[a.time_unit] / 1000.0  # -> seconds
    xyz = df[[a.x, a.y, a.z]].to_numpy(float)
    if a.units == "ms2":
        xyz = xyz / config.G
    rest = float(np.median(np.linalg.norm(xyz, axis=1)))
    if not 0.8 < rest < 1.2:
        print(f"WARNING: median |a| = {rest:.2f} g (expected ~1 g). Is gravity included and are --units right?")
    return {a.device: (t - t[0], xyz)}, [], None


def evaluate(streams: dict, marks: list[float]) -> tuple[dict, dict]:
    results, plot = {}, {}
    for dev, (t, xyz) in streams.items():
        acc = bin_resample(t * 1000.0, xyz)          # any rate -> 20 Hz, same as training
        t0 = t.min()
        model = OnnxEnsemble(dev)
        cands = score_recording(acc, model, model.trigger_g)
        alarms = alarms_from_candidates(cands, model.threshold)
        alarm_t = t0 + alarms / config.FS
        matched = np.zeros(len(alarm_t), bool)
        detected = 0
        for m in marks:
            near = (alarm_t >= m - MARK_BEFORE_S) & (alarm_t <= m + MARK_AFTER_S)
            detected += bool(near.any())
            matched |= near
        hours = len(acc) / config.FS / 3600
        fa = int((~matched).sum())
        results[dev] = {
            "hours": round(hours, 3), "stage1_candidates": len(cands.peaks), "alarms": len(alarms),
            "false_alarms": fa, "false_alarms_per_hour": round(fa / hours, 2) if hours else None,
            "marked_falls": len(marks), "marked_falls_detected": detected,
            "alarm_times_s": [round(float(x), 1) for x in alarm_t],
            "trigger_g": model.trigger_g, "threshold": model.threshold,
        }
        plot[dev] = (t0 + np.arange(len(acc)) / config.FS, magnitude(acc), t0 + cands.peaks / config.FS,
                     cands.probs, alarm_t, model.threshold)
    return results, plot


def save_plot(plot: dict, marks: list[float], path: Path) -> None:
    fig, axes = plt.subplots(len(plot), 1, figsize=(12, 3.2 * len(plot)), squeeze=False, sharex=True)
    for ax, (dev, (tt, mag, ct, cp, at, thr)) in zip(axes[:, 0], plot.items()):
        ax.plot(tt, mag, lw=0.6, color="#2f6fdb" if dev == "phone" else "#0f9d8a", label="|a| (g)")
        ax2 = ax.twinx()
        ax2.scatter(ct, cp, s=12, color="#555", label="stage-2 score")
        ax2.axhline(thr, ls="--", color="#d6342c", lw=0.8)
        ax2.set_ylim(0, 1.05)
        ax2.set_ylabel("score")
        for x in at:
            ax.axvline(x, color="#d6342c", lw=1.2)
        for m in marks:
            ax.axvline(m, color="black", ls=":", lw=1.2)
        ax.set_title(f"{dev}: red = alarm, dotted = your fall mark, dashed = threshold")
        ax.set_ylabel("|a| (g)")
    axes[-1, 0].set_xlabel("time (s)")
    fig.tight_layout()
    fig.savefig(path, dpi=110)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path)
    ap.add_argument("--out", type=Path, help="output path prefix (default: next to the CSV)")
    ap.add_argument("--generic", action="store_true", help="plain accelerometer CSV (see options below)")
    ap.add_argument("--time-col", default="time")
    ap.add_argument("--x", default="x")
    ap.add_argument("--y", default="y")
    ap.add_argument("--z", default="z")
    ap.add_argument("--time-unit", choices=list(TIME_SCALE), default="s")
    ap.add_argument("--units", choices=["g", "ms2"], default="g")
    ap.add_argument("--device", choices=list(config.POSITIONS), default="phone")
    a = ap.parse_args()

    streams, marks, app_alarms = load_generic_csv(a.csv, a) if a.generic else load_fallguard_csv(a.csv)
    if not streams:
        raise SystemExit("No accelerometer stream with at least 5 s of data found in the CSV.")
    results, plot = evaluate(streams, marks)
    out = a.out or a.csv.with_suffix("")
    out.parent.mkdir(parents=True, exist_ok=True)
    summary = {"file": str(a.csv), "devices": results, "app_alarms_during_recording": app_alarms}
    out.with_suffix(".json").write_text(json.dumps(summary, indent=2))
    save_plot(plot, marks, out.with_suffix(".png"))

    for dev, r in results.items():
        print(f"{dev:6s} {r['hours'] * 60:6.1f} min  alarms={r['alarms']}  false alarms={r['false_alarms']} "
              f"({r['false_alarms_per_hour']}/h)  marked falls detected={r['marked_falls_detected']}/{r['marked_falls']}")
    if app_alarms is not None:
        print(f"browser raised {app_alarms} alarm(s) while recording (cross-check; fused mode can differ from per-device)")
    print(f"wrote {out.with_suffix('.json')} and {out.with_suffix('.png')}")


if __name__ == "__main__":
    main()
