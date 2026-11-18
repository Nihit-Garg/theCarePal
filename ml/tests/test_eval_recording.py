"""End-to-end test of eval_recording.py with the shipped ONNX models, on a
recording built from a held-out demo replay (no datasets needed)."""
import json
import subprocess
import sys

import numpy as np
import pytest

from fallguard import config

SCRIPT = config.ROOT / "ml" / "scripts" / "eval_recording.py"


def _replay(kind: str) -> dict:
    index = json.loads((config.WEB_DATA_DIR / "index.json").read_text())
    meta = next(i for i in index if i["kind"] == kind)
    return json.loads((config.WEB_DATA_DIR / f"{meta['id']}.json").read_text())


def _write_fallguard_csv(path, phone: np.ndarray, mark_t: float | None):
    lines = ["t,device,ax,ay,az,hr,event,detail", "0.000,,,,,,start,test"]
    for i, (x, y, z) in enumerate(phone):
        lines.append(f"{i / config.FS:.3f},phone,{x:.4f},{y:.4f},{z:.4f},,,")
    if mark_t is not None:
        lines.append(f"{mark_t:.3f},,,,,,mark_fall,fall")
    path.write_text("\n".join(lines) + "\n")


@pytest.mark.skipif(not (config.WEB_MODELS_DIR / "model_config.json").exists(), reason="models not exported")
def test_detects_a_marked_fall_without_false_alarms(tmp_path):
    fall = np.array(_replay("fall")["phone"])
    rng = np.random.default_rng(0)
    still = lambda pose, s: np.tile(pose, (int(s * config.FS), 1)) + rng.normal(0, 0.003, (int(s * config.FS), 3))  # noqa: E731
    phone = np.concatenate([still(fall[0], 60), fall, still(fall[-1], 60)])
    impact_t = (60 * config.FS + int(np.argmax(np.linalg.norm(fall, axis=1)))) / config.FS
    csv = tmp_path / "rec.csv"
    _write_fallguard_csv(csv, phone, mark_t=impact_t + 3)

    out = subprocess.run([sys.executable, str(SCRIPT), str(csv), "--out", str(tmp_path / "res")],
                         capture_output=True, text=True, check=True)
    assert "marked falls detected=1/1" in out.stdout
    res = json.loads((tmp_path / "res.json").read_text())["devices"]["phone"]
    assert res["false_alarms"] == 0
    assert (tmp_path / "res.png").exists()


@pytest.mark.skipif(not (config.WEB_MODELS_DIR / "model_config.json").exists(), reason="models not exported")
def test_generic_csv_in_ms2(tmp_path):
    rng = np.random.default_rng(1)
    t = np.arange(0, 120, 0.01)                                  # 100 Hz, 2 min, sitting still
    xyz = np.tile([0.0, 0.0, config.G], (len(t), 1)) + rng.normal(0, 0.05, (len(t), 3))
    csv = tmp_path / "logger.csv"
    csv.write_text("time,x,y,z\n" + "\n".join(f"{a:.3f},{b:.4f},{c:.4f},{d:.4f}" for a, (b, c, d) in zip(t, xyz)))
    out = subprocess.run([sys.executable, str(SCRIPT), str(csv), "--generic", "--units", "ms2", "--out", str(tmp_path / "g")],
                         capture_output=True, text=True, check=True)
    assert "alarms=0" in out.stdout
    assert "WARNING" not in out.stdout
