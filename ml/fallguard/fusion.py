"""Combining phone and wearable when both are available.

Each device runs its own two-stage detector. A candidate event from either device
is matched with the other device's best candidate within +/-MATCH_S seconds, and
the two scores are combined. Rules compared in eval_fusion.py:

* "or"      alarm if either device alone would (max sensitivity, most false alarms)
* "and"     alarm only if both would (fewest false alarms, misses falls one device saw poorly)
* "mean"    alarm if mean(p / threshold) >= 1. Lopsided: with a high phone threshold
            (~0.9) the phone's score can never exceed ~1.1, so it can never carry a
            decision on its own. Kept for comparison (it was the first version).
* "logodds" (shipped) each device contributes its evidence margin over its own threshold,
            m = logit(p) - logit(threshold), clipped to +/-LOGODDS_CLIP, and the alarm
            fires if m_phone + m_wrist >= 0. Symmetric: a very confident device can
            outvote a hesitant one, but not one that is confident it was *not* a fall.
            A device with no stage-1 candidate near the moment counts as -LOGODDS_CLIP.
            The clip (3) was fixed before evaluation, not tuned.

Mirrored in web/src/engine/fusion.js; constants are exported to model_config.json.
"""
from __future__ import annotations

import numpy as np

from . import config
from .detector import Candidates

MATCH_S = 1.5
LOGODDS_CLIP = 3.0
RULES = ("or", "and", "mean", "logodds")
DEFAULT_RULE = "logodds"


def logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return float(np.log(p / (1 - p)))


def margin(p: float | None, threshold: float, clip: float | None = None) -> float:
    """Evidence for a fall relative to this device's own threshold (0 = on the line)."""
    clip = LOGODDS_CLIP if clip is None else clip  # read at call time, not definition time
    if p is None:
        return -clip
    return float(np.clip(logit(p) - logit(threshold), -clip, clip))


def fuse_scores(p_phone: float | None, p_wrist: float | None, thr_phone: float, thr_wrist: float,
                rule: str = DEFAULT_RULE) -> bool:
    """p_* is the device's best probability near the moment, or None if it had no candidate."""
    if rule == "logodds":
        return margin(p_phone, thr_phone) + margin(p_wrist, thr_wrist) >= 0
    s_p, s_w = (p_phone or 0.0) / thr_phone, (p_wrist or 0.0) / thr_wrist
    if rule == "or":
        return max(s_p, s_w) >= 1
    if rule == "and":
        return min(s_p, s_w) >= 1
    if rule == "mean":
        return (s_p + s_w) / 2 >= 1
    raise ValueError(f"unknown fusion rule {rule!r}")


def _best_nearby(c: Candidates, idx: int, tol: int) -> float | None:
    if len(c.peaks) == 0:
        return None
    near = np.abs(c.peaks - idx) <= tol
    return float(c.probs[near].max()) if near.any() else None


def fuse(phone: Candidates, wrist: Candidates, thr_phone: float, thr_wrist: float,
         rule: str = DEFAULT_RULE) -> np.ndarray:
    """Alarm indices for one synchronised recording."""
    tol = int(MATCH_S * config.FS)
    events = sorted(int(p) for p in np.concatenate([phone.peaks, wrist.peaks]))
    refractory = int(config.REFRACTORY_S * config.FS)
    alarms: list[int] = []
    for idx in events:
        fire = fuse_scores(_best_nearby(phone, idx, tol), _best_nearby(wrist, idx, tol), thr_phone, thr_wrist, rule)
        if fire and (not alarms or idx - alarms[-1] >= refractory):
            alarms.append(idx)
    return np.asarray(alarms, dtype=int)
