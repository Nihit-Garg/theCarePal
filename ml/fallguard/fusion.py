"""Combining phone and wearable when both are available.

Each device runs its own two-stage detector. A candidate event from either device
is matched with the other device's candidates within +/-MATCH_S seconds. Scores
are normalised by each device's own threshold (s = p / thr, so s >= 1 means "this
device alone would alarm"), then combined. Rules compared in eval_fusion.py:

* "or"   alarm if either device alone would (max sensitivity, most false alarms)
* "and"  alarm only if both would (fewest false alarms, misses falls one device saw poorly)
* "mean" alarm if the average normalised score >= 1 — a confident device can
         carry a hesitant one, but one device's spike alone isn't enough

Mirrored in web/src/engine/fusion.js.
"""
from __future__ import annotations

import numpy as np

from . import config
from .detector import Candidates

MATCH_S = 1.5
RULES = ("or", "and", "mean")


def _best_nearby(c: Candidates, idx: int, tol: int) -> float:
    if len(c.peaks) == 0:
        return 0.0
    near = np.abs(c.peaks - idx) <= tol
    return float(c.probs[near].max()) if near.any() else 0.0


def fuse(phone: Candidates, wrist: Candidates, thr_phone: float, thr_wrist: float, rule: str) -> np.ndarray:
    """Alarm indices for one synchronised recording."""
    tol = int(MATCH_S * config.FS)
    events = sorted([(int(p), "phone") for p in phone.peaks] + [(int(p), "wrist") for p in wrist.peaks])
    refractory = int(config.REFRACTORY_S * config.FS)
    alarms: list[int] = []
    for idx, _ in events:
        s_p = _best_nearby(phone, idx, tol) / thr_phone
        s_w = _best_nearby(wrist, idx, tol) / thr_wrist
        fire = {"or": max(s_p, s_w) >= 1, "and": min(s_p, s_w) >= 1, "mean": (s_p + s_w) / 2 >= 1}[rule]
        if fire and (not alarms or idx - alarms[-1] >= refractory):
            alarms.append(idx)
    return np.asarray(alarms, dtype=int)
