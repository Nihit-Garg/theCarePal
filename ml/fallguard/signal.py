"""Signal processing shared by training and inference.

Everything is orientation-invariant: a phone can sit any way up in a pocket and a
band can be strapped either way round, so we never feed raw x/y/z to a model.
Instead, per event window, we estimate the gravity direction *before* the
candidate impact and express motion relative to it.

Mirrored line-for-line in web/src/engine/signal.js (parity checked by
ml/scripts/export_web_assets.py, which writes golden test vectors).
"""
from __future__ import annotations

import numpy as np

from . import config

EPS = 1e-6


def magnitude(acc: np.ndarray) -> np.ndarray:
    return np.sqrt((acc.astype(np.float64) ** 2).sum(axis=1))


def find_candidate_peaks(mag: np.ndarray, trigger_g: float) -> np.ndarray:
    """Stage 1 (always-on, nearly free): indices where |a| >= trigger and is the
    maximum within +/- PEAK_HALF_WIDTH samples. Ties resolve to the first sample."""
    h = config.PEAK_HALF_WIDTH
    out = []
    n = len(mag)
    for i in np.flatnonzero(mag >= trigger_g):
        lo, hi = max(0, i - h), min(n, i + h + 1)
        seg = mag[lo:hi]
        if mag[i] >= seg.max() and np.argmax(seg) + lo == i:
            out.append(i)
    return np.asarray(out, dtype=int)


def extract_window(acc: np.ndarray, peak: int) -> np.ndarray:
    """(WIN, 3) window with the peak at index PRE. Edges are padded by repeating
    the first/last sample (a fall right at the start of a stream still works)."""
    lo, hi = peak - config.PRE, peak + config.POST
    idx = np.clip(np.arange(lo, hi), 0, len(acc) - 1)
    return acc[idx].astype(np.float64)


def _moving_average(x: np.ndarray, k: int) -> np.ndarray:
    """Centered moving average with edge padding (same length as x)."""
    pad = k // 2
    xp = np.concatenate([np.repeat(x[:1], pad, 0), x, np.repeat(x[-1:], k - 1 - pad, 0)], 0)
    c = np.cumsum(np.concatenate([np.zeros((1, *x.shape[1:])), xp], 0), 0)
    return (c[k:] - c[:-k]) / k


def window_channels(win: np.ndarray) -> np.ndarray:
    """(4, WIN) orientation-invariant channels for the CNN:
    0 |a|            total acceleration (g)
    1 a_vert         component along pre-impact gravity (g)
    2 a_horiz        component perpendicular to it (g)
    3 tilt / 180     angle (deg/180) between smoothed acceleration and pre-impact gravity
    """
    g_pre = win[: config.FS].mean(0)                         # first 1 s of the window
    g_hat = g_pre / (np.linalg.norm(g_pre) + EPS)
    mag = np.sqrt((win ** 2).sum(1))
    vert = win @ g_hat
    horiz = np.sqrt(np.maximum(mag ** 2 - vert ** 2, 0.0))
    lp = _moving_average(win, 5)                             # 0.25 s smoothing
    cos = (lp @ g_hat) / (np.sqrt((lp ** 2).sum(1)) + EPS)
    tilt = np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))) / 180.0
    return np.stack([mag, vert, horiz, tilt]).astype(np.float32)


FEATURE_NAMES = [
    "peak_mag", "pre_min_mag", "pre_mean_mag", "pre_std_mag",
    "post_mean_mag", "post_std_mag", "post_still_frac",
    "max_jerk", "mag_range", "dyn_energy", "sma_dynamic",
    "freefall_to_impact_s", "tilt_change_deg", "post_vert_mean",
    "post_tilt_mean_deg", "horiz_peak", "vert_peak", "vert_min",
    "impact_width_s", "mag_kurtosis",
]


def window_features(win: np.ndarray) -> np.ndarray:
    """Hand-crafted features for the classic model (same window as the CNN)."""
    ch = window_channels(win).astype(np.float64)
    mag, vert, horiz, tilt = ch[0], ch[1], ch[2], ch[3] * 180.0
    P, fs = config.PRE, config.FS
    pre, post = mag[:P], mag[-fs:]                           # post = last 1 s
    g_pre = win[:fs].mean(0)
    g_post = win[-fs:].mean(0)
    cosang = g_pre @ g_post / (np.linalg.norm(g_pre) * np.linalg.norm(g_post) + EPS)
    dyn = mag - 1.0
    min_i = int(np.argmin(pre))
    above = np.flatnonzero(mag >= 0.5 * (mag[P] + 1.0))      # samples above half the peak excess
    m, s = mag.mean(), mag.std() + EPS
    feats = [
        mag[P],
        pre.min(),
        pre.mean(),
        pre.std(),
        post.mean(),
        post.std(),
        float(np.mean(np.abs(post - 1.0) < 0.1)),
        float(np.max(np.abs(np.diff(mag))) * fs),
        mag.max() - mag.min(),
        float(np.sum(dyn ** 2) / fs),
        float(np.sum(np.abs(dyn)) / fs),
        (P - min_i) / fs,
        float(np.degrees(np.arccos(np.clip(cosang, -1.0, 1.0)))),
        vert[-fs:].mean(),
        tilt[-fs:].mean(),
        horiz.max(),
        vert.max(),
        vert.min(),
        (above.max() - above.min() + 1) / fs if len(above) else 0.0,
        float(np.mean(((mag - m) / s) ** 4)),
    ]
    return np.asarray(feats, dtype=np.float32)
