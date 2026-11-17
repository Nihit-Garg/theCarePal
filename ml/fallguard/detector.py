"""Two-stage streaming detector — the exact logic the browser runs.

Stage 1: cheap trigger. |a| >= trigger_g and a local max within +/-0.5 s.
Stage 2: classify the 4 s window around that peak (model probability).
Alarm:   probability >= threshold, and no alarm in the previous REFRACTORY_S.

Detection latency is POST_S (2.5 s) after impact: we deliberately wait to see
whether the person stays down, which is what separates a fall from sitting down hard.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import config
from .signal import extract_window, find_candidate_peaks, magnitude


@dataclass
class Candidates:
    """Stage-1 output for one recording, plus the stage-2 probability of each."""
    peaks: np.ndarray   # sample indices
    probs: np.ndarray   # model probability per peak


def score_recording(acc: np.ndarray, model, trigger_g: float) -> Candidates:
    peaks = find_candidate_peaks(magnitude(acc), trigger_g)
    if len(peaks) == 0:
        return Candidates(peaks, np.zeros(0, dtype=np.float32))
    wins = np.stack([extract_window(acc, p) for p in peaks])
    return Candidates(peaks, model.predict_proba(wins))


def alarms_from_candidates(c: Candidates, threshold: float) -> np.ndarray:
    """Apply the threshold and refractory period; returns alarm sample indices."""
    refractory = int(config.REFRACTORY_S * config.FS)
    alarms: list[int] = []
    for p, pr in zip(c.peaks, c.probs):
        if pr >= threshold and (not alarms or p - alarms[-1] >= refractory):
            alarms.append(int(p))
    return np.asarray(alarms, dtype=int)


def main_impact(acc: np.ndarray) -> int:
    """Index of the fall impact in a fall recording (largest |a|)."""
    return int(np.argmax(magnitude(acc)))
