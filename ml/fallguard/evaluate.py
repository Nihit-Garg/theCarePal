"""Training-window construction, threshold selection and event-level metrics.

Metrics are computed the way the product experiences them — by streaming every
held-out recording through the full detector — not on pre-cut windows:

* sensitivity  = fall recordings with an alarm within +/-3 s of the impact / fall recordings
* specificity  = ADL recordings with no alarm / ADL recordings
* FA per hour  = alarms during ADL recordings / hours of ADL recordings
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import config
from .datasets import Recording
from .detector import Candidates, alarms_from_candidates, main_impact
from .signal import extract_window, find_candidate_peaks, magnitude

MATCH_TOL = 3 * config.FS  # an alarm counts as "the fall" if within 3 s of impact


def choose_trigger(recs: list[Recording], pct: float = 1.0) -> float:
    """Stage-1 threshold: low enough that ~99% of training falls pass it."""
    peaks = [magnitude(r.acc)[main_impact(r.acc)] for r in recs if r.label]
    return float(np.floor(np.percentile(peaks, pct) * 20) / 20)  # round down to 0.05 g


def training_windows(recs: list[Recording], trigger_g: float) -> tuple[np.ndarray, np.ndarray]:
    """Positives: the impact of each fall (+/-2 sample jitter). Negatives: every other
    stage-1 candidate in ADLs, and candidates > 3 s away from the impact in fall trials
    (walking before the fall, moving after it)."""
    wins, ys = [], []
    for r in recs:
        mag = magnitude(r.acc)
        peaks = find_candidate_peaks(mag, trigger_g * 0.9)
        if r.label:
            imp = main_impact(r.acc)
            for d in (-2, -1, 0, 1, 2):
                wins.append(extract_window(r.acc, imp + d))
                ys.append(1)
            peaks = peaks[np.abs(peaks - imp) > MATCH_TOL]
        for p in peaks:
            wins.append(extract_window(r.acc, p))
            ys.append(0)
    return np.stack(wins).astype(np.float32), np.asarray(ys, dtype=np.int64)


@dataclass
class RecResult:
    rec: Recording
    cands: Candidates
    fold_thr: float = 0.5  # the threshold this result was evaluated with (set per outer fold)


def event_counts(results: list[RecResult], threshold: float) -> dict:
    return counts_from_alarms((rr.rec, alarms_from_candidates(rr.cands, threshold)) for rr in results)


def counts_from_alarms(pairs) -> dict:
    """pairs: iterable of (recording, alarm sample indices) — from one device or fused."""
    tp = fn = tn = fp_trials = fa = 0
    adl_s = 0.0
    for rec, alarms in pairs:
        if rec.label:
            imp = main_impact(rec.acc)
            if len(alarms) and np.min(np.abs(alarms - imp)) <= MATCH_TOL:
                tp += 1
            else:
                fn += 1
        else:
            adl_s += rec.duration_s
            fa += len(alarms)
            if len(alarms):
                fp_trials += 1
            else:
                tn += 1
    return dict(tp=tp, fn=fn, tn=tn, fp_trials=fp_trials, false_alarms=fa, adl_hours=adl_s / 3600)


def summarize(c: dict) -> dict:
    sens = c["tp"] / max(c["tp"] + c["fn"], 1)
    spec = c["tn"] / max(c["tn"] + c["fp_trials"], 1)
    fah = c["false_alarms"] / max(c["adl_hours"], 1e-9)
    out = dict(sensitivity=round(sens, 4), specificity=round(spec, 4), false_alarms_per_hour=round(fah, 3))
    out.update(c)
    out["adl_hours"] = round(c["adl_hours"], 3)
    return out


def choose_threshold(results: list[RecResult], target_sens: float = 0.95) -> float:
    """Highest threshold that still reaches the target sensitivity on validation subjects.

    Why sensitivity-first: every alarm gets a 30 s "I'm OK" countdown, so a false
    alarm costs the person one tap, while a missed fall can mean a long lie on the floor.
    """
    grid = np.round(np.arange(0.05, 0.991, 0.01), 2)
    sens = np.array([summarize(event_counts(results, t))["sensitivity"] for t in grid])
    ok = np.flatnonzero(sens >= target_sens)
    return float(grid[ok[-1]] if len(ok) else grid[int(np.argmax(sens))])


def subject_folds(subjects: list[str], k: int, seed: int = 42) -> list[set[str]]:
    rng = np.random.default_rng(seed)
    s = np.array(sorted(set(subjects)))
    rng.shuffle(s)
    return [set(s[i::k]) for i in range(k)]
