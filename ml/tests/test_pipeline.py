"""Unit tests for the signal pipeline. No datasets needed: `pytest ml/tests`."""
import numpy as np
import pytest

from fallguard import config
from fallguard.datasets import bin_resample
from fallguard.detector import Candidates, alarms_from_candidates
from fallguard.evaluate import RecResult, event_counts, summarize
from fallguard.signal import (
    FEATURE_NAMES,
    extract_window,
    find_candidate_peaks,
    window_channels,
    window_features,
)

RNG = np.random.default_rng(0)


def random_rotation() -> np.ndarray:
    q, r = np.linalg.qr(RNG.normal(size=(3, 3)))
    q *= np.sign(np.diag(r))
    if np.linalg.det(q) < 0:
        q[:, 0] *= -1
    return q


def fake_fall(n=config.WIN) -> np.ndarray:
    """Standing (gravity on z), free fall, impact, then lying (gravity on x)."""
    w = np.tile([0.0, 0.0, 1.0], (n, 1))
    w[20:28] = [0.0, 0.0, 0.3]          # free fall
    w[config.PRE] = [1.5, 0.5, 3.5]     # impact
    w[config.PRE + 3:] = [1.0, 0.0, 0.05]  # lying still on the side
    return w + RNG.normal(0, 0.01, w.shape)


def test_channels_are_orientation_invariant():
    """The core device-agnostic claim: however the phone sits in the pocket or the
    band is strapped, the model sees the same input."""
    w = fake_fall()
    rotated = w @ random_rotation().T
    np.testing.assert_allclose(window_channels(w), window_channels(rotated), atol=1e-4)
    np.testing.assert_allclose(window_features(w), window_features(rotated), rtol=1e-3, atol=1e-3)


def test_channels_are_invariant_to_axis_sign_flips():
    """iOS and Android report accelerationIncludingGravity with opposite signs."""
    w = fake_fall()
    np.testing.assert_allclose(window_channels(w), window_channels(-w), atol=1e-5)


def test_fall_features_look_like_a_fall():
    f = dict(zip(FEATURE_NAMES, window_features(fake_fall())))
    assert f["peak_mag"] > 3
    assert f["pre_min_mag"] < 0.5           # free fall before impact
    assert f["tilt_change_deg"] > 60        # standing -> lying
    assert f["post_still_frac"] > 0.9       # stayed down


def test_bin_resample_downsamples_and_fills_gaps():
    t = np.arange(0, 1000, 5.0)             # 200 Hz for 1 s
    xyz = np.tile([0, 0, 1.0], (len(t), 1))
    out = bin_resample(t, xyz)
    assert out.shape == (20, 3)
    np.testing.assert_allclose(out, np.tile([0, 0, 1.0], (20, 1)), atol=1e-6)
    t_gap = np.array([0.0, 10.0, 160.0])    # bins 1 and 2 empty
    out = bin_resample(t_gap, np.array([[0, 0, 0], [0, 0, 0], [3.0, 3.0, 3.0]]))
    np.testing.assert_allclose(out[:, 0], [0, 1, 2, 3], atol=1e-6)


def test_candidate_peaks_are_local_maxima_above_trigger():
    mag = np.ones(100)
    mag[[20, 25, 60]] = [3.0, 2.5, 2.2]      # 25 is within 0.5 s of a bigger peak
    assert find_candidate_peaks(mag, 2.0).tolist() == [20, 60]


def test_extract_window_pads_edges():
    acc = np.arange(30, dtype=float).reshape(10, 3)
    w = extract_window(acc, 2)
    assert w.shape == (config.WIN, 3)
    np.testing.assert_array_equal(w[0], acc[0])   # padded with the first sample
    np.testing.assert_array_equal(w[-1], acc[-1])


def test_refractory_merges_one_event_into_one_alarm():
    c = Candidates(np.array([100, 110, 100 + int(config.REFRACTORY_S * config.FS)]), np.array([0.9, 0.95, 0.9]))
    assert alarms_from_candidates(c, 0.5).tolist() == [100, 300]


def test_event_metrics():
    class Rec:
        def __init__(self, label, peak):
            self.label = label
            self.acc = np.tile([0, 0, 1.0], (200, 1))
            self.acc[peak] = [0, 0, 4.0]

        @property
        def duration_s(self):
            return len(self.acc) / config.FS

    fall, adl = Rec(1, 50), Rec(0, 80)
    res = [RecResult(fall, Candidates(np.array([51]), np.array([0.9]))),
           RecResult(adl, Candidates(np.array([80]), np.array([0.7])))]
    m = summarize(event_counts(res, 0.8))   # ADL candidate below threshold
    assert m["sensitivity"] == 1.0 and m["specificity"] == 1.0 and m["false_alarms"] == 0
    m = summarize(event_counts(res, 0.6))   # now the ADL candidate alarms
    assert m["false_alarms"] == 1
    assert m["false_alarms_per_hour"] == pytest.approx(1 / (200 / config.FS / 3600))
