"""Loaders for the public datasets, harmonised to a common format.

Every recording becomes a `Recording`: tri-axial acceleration in g, resampled to
config.FS, plus metadata. Downstream code never sees dataset-specific quirks.

* UMAFall (Casilari et al., 2017): 19 subjects, phone in right trouser pocket
  (~200 Hz) and SensorTags on wrist/waist/chest/ankle (~20 Hz), recorded
  simultaneously. We use RIGHTPOCKET -> "phone" and WRIST -> "wrist".
* SisFall (Sucerquia et al., 2017): 38 subjects (15 aged 60+), one waist-worn
  device at 200 Hz. Used as extra "phone" data (waist ~ phone in pocket/holster).
"""
from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import config


@dataclass
class Recording:
    acc: np.ndarray            # (N, 3) float32, g, uniformly sampled at config.FS
    label: int                 # 1 = fall trial, 0 = activity of daily living (ADL)
    position: str              # "phone" | "wrist"
    dataset: str               # "umafall" | "sisfall"
    subject: str               # globally unique, e.g. "umafall:05"
    activity: str
    trial_id: str              # identical across positions for simultaneous UMAFall recordings
    elderly: bool = False
    meta: dict = field(default_factory=dict)

    @property
    def duration_s(self) -> float:
        return len(self.acc) / config.FS


def bin_resample(t_ms: np.ndarray, xyz: np.ndarray, fs: int = config.FS) -> np.ndarray:
    """Average samples into fixed 1/fs bins; fill empty bins by linear interpolation.

    Works for any input rate (20 Hz SensorTag, 200 Hz phone, ~60 Hz browser
    DeviceMotion) and acts as a simple anti-alias filter when downsampling.
    Mirrored in web/src/engine/resample.js.
    """
    order = np.argsort(t_ms, kind="stable")
    t_ms, xyz = t_ms[order], xyz[order]
    bin_ms = 1000.0 / fs
    idx = np.floor((t_ms - t_ms[0]) / bin_ms).astype(int)
    n = idx[-1] + 1
    sums = np.zeros((n, 3))
    counts = np.zeros(n)
    np.add.at(sums, idx, xyz)
    np.add.at(counts, idx, 1)
    out = np.full((n, 3), np.nan)
    ok = counts > 0
    out[ok] = sums[ok] / counts[ok, None]
    if not ok.all():
        grid = np.arange(n)
        for k in range(3):
            out[:, k] = np.interp(grid, grid[ok], out[ok, k])
    return out.astype(np.float32)


# --------------------------------------------------------------------------- UMAFall
_UMA_NAME = re.compile(r"UMAFall_Subject_(\d+)_(ADL|Fall)_(\w+?)_(\d+)_")
_UMA_SENSOR = re.compile(r"%\s*([0-9A-Fa-f:]{17});\s*(\d+);\s*(\w+);")
_UMA_POS = {"RIGHTPOCKET": "phone", "WRIST": "wrist"}


def load_umafall(root: Path | None = None) -> list[Recording]:
    root = root or config.RAW_DIR / "umafall"
    recs: list[Recording] = []
    for f in sorted(root.glob("*.csv")):
        m = _UMA_NAME.match(f.name)
        if not m:
            continue
        subj, kind, activity, trial = m.groups()
        sensor_pos: dict[int, str] = {}
        age = None
        with open(f, errors="ignore") as fh:
            for line in fh:
                if not line.startswith("%"):
                    continue
                sm = _UMA_SENSOR.match(line)
                if sm:
                    sensor_pos[int(sm.group(2))] = sm.group(3).upper()
                if line.startswith("% Age:"):
                    with contextlib.suppress(ValueError):
                        age = int(line.split(":")[1])
        df = pd.read_csv(f, comment="%", sep=";", header=None, usecols=range(7),
                         names=["t", "n", "x", "y", "z", "type", "sid"]).dropna()
        df = df[df["type"] == 0]  # accelerometer only
        trial_id = f"umafall:{subj}:{kind}:{activity}:{trial}"
        for sid, g in df.groupby("sid"):
            pos = _UMA_POS.get(sensor_pos.get(int(sid), ""))
            if pos is None or len(g) < config.FS * 2:
                continue
            acc = bin_resample(g["t"].to_numpy(float), g[["x", "y", "z"]].to_numpy(float))
            recs.append(Recording(
                acc=acc, label=int(kind == "Fall"), position=pos, dataset="umafall",
                subject=f"umafall:{subj}", activity=activity, trial_id=trial_id,
                elderly=bool(age and age >= 60), meta={"age": age, "t0_ms": float(g["t"].min())},
            ))
    return recs


# --------------------------------------------------------------------------- SisFall
# Columns 0-2: ADXL345 (+/-16 g, 13 bit). Gyro and the second accelerometer are ignored.
_SIS_ADXL_TO_G = (2 * 16) / (2 ** 13)
_SIS_FS = 200
_SIS_NAME = re.compile(r"([DF]\d{2})_(S[AE]\d{2})_R(\d{2})\.txt")


def load_sisfall(root: Path | None = None) -> list[Recording]:
    root = root or config.RAW_DIR / "sisfall" / "SisFall_dataset"
    recs: list[Recording] = []
    for f in sorted(root.glob("S*/*.txt")):
        m = _SIS_NAME.match(f.name)
        if not m:
            continue
        code, subj, trial = m.groups()
        raw = pd.read_csv(f, header=None, usecols=[0, 1, 2], skipinitialspace=True).dropna().to_numpy(float)
        if len(raw) < _SIS_FS * 2:
            continue
        t_ms = np.arange(len(raw)) * (1000.0 / _SIS_FS)
        acc = bin_resample(t_ms, raw * _SIS_ADXL_TO_G)
        recs.append(Recording(
            acc=acc, label=int(code.startswith("F")), position="phone", dataset="sisfall",
            subject=f"sisfall:{subj}", activity=code, trial_id=f"sisfall:{subj}:{code}:{trial}",
            elderly=subj.startswith("SE"),
        ))
    return recs


def load_all() -> dict[str, list[Recording]]:
    """Returns {"phone": [...], "wrist": [...]}."""
    recs = load_umafall() + load_sisfall()
    return {p: [r for r in recs if r.position == p] for p in config.POSITIONS}
