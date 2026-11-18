"""Run the *shipped* ONNX models from Python — the exact files the browser uses
(web/public/models). Used to evaluate real-world recordings without retraining."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

from . import config
from .signal import window_channels, window_features


class OnnxEnsemble:
    """Mean of the exported LightGBM and CNN probabilities, plus the deployed
    trigger and threshold for one position ("phone" or "wrist")."""

    def __init__(self, position: str, models_dir: Path | None = None) -> None:
        models_dir = Path(models_dir or config.WEB_MODELS_DIR)
        meta = json.loads((models_dir / "model_config.json").read_text())
        pos = meta["positions"][position]
        self.position = position
        self.trigger_g = float(pos["trigger_g"])
        self.threshold = float(pos["threshold"])
        self.lgb = ort.InferenceSession(str(models_dir / pos["models"]["lightgbm"]))
        self.cnn = ort.InferenceSession(str(models_dir / pos["models"]["cnn"]))

    def predict_proba(self, wins: np.ndarray) -> np.ndarray:
        feats = np.stack([window_features(w) for w in wins]).astype(np.float32)
        chans = np.stack([window_channels(w) for w in wins]).astype(np.float32)
        p_lgb = self.lgb.run(None, {"features": feats})[1][:, 1]
        p_cnn = self.cnn.run(None, {"channels": chans})[0]
        return ((p_lgb + p_cnn) / 2).astype(np.float32)
