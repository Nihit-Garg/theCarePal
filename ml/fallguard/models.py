"""The two stage-2 classifiers we compare.

* ClassicModel — LightGBM on 20 hand-crafted, interpretable features.
* CNNModel     — a ~6k-parameter 1D CNN on the 4 orientation-invariant channels.

Both take raw (n, WIN, 3) windows in g, so they are interchangeable inside the detector.
"""
from __future__ import annotations

import lightgbm as lgb  # must be imported before torch on macOS (two OpenMP runtimes clash)
import numpy as np
import torch
from torch import nn

from .signal import FEATURE_NAMES, window_channels, window_features

# PyTorch and LightGBM bundle different OpenMP runtimes; on macOS running both
# multi-threaded in one process segfaults. The models are tiny, so 1 thread is plenty.
torch.set_num_threads(1)


SEED = 42


class ClassicModel:
    name = "lightgbm"

    def __init__(self) -> None:
        self.clf = lgb.LGBMClassifier(
            n_estimators=200, learning_rate=0.05, num_leaves=15, max_depth=5,
            min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
            reg_lambda=1.0, class_weight="balanced", random_state=SEED, verbose=-1, n_jobs=1,
        )

    @staticmethod
    def featurize(wins: np.ndarray) -> np.ndarray:
        return np.stack([window_features(w) for w in wins])

    def fit(self, wins, y) -> ClassicModel:
        self.clf.fit(self.featurize(wins), y)
        return self

    def predict_proba(self, wins: np.ndarray) -> np.ndarray:
        return self.clf.predict_proba(self.featurize(wins))[:, 1].astype(np.float32)

    def feature_importance(self) -> dict[str, float]:
        imp = self.clf.booster_.feature_importance("gain")
        return dict(sorted(zip(FEATURE_NAMES, imp / imp.sum()), key=lambda kv: -kv[1]))


class FallCNN(nn.Module):
    """Input (batch, 4, 80) channels from signal.window_channels. Output: fall logit.
    Input scaling is inside the graph so the exported ONNX takes raw channels."""

    def __init__(self) -> None:
        super().__init__()
        self.register_buffer("scale", torch.tensor([4.0, 4.0, 4.0, 1.0]).view(1, 4, 1))
        self.net = nn.Sequential(
            nn.Conv1d(4, 16, 5, padding=2), nn.BatchNorm1d(16), nn.ReLU(), nn.MaxPool1d(2),
            nn.Conv1d(16, 32, 5, padding=2), nn.BatchNorm1d(32), nn.ReLU(), nn.MaxPool1d(2),
            nn.Conv1d(32, 32, 3, padding=1), nn.BatchNorm1d(32), nn.ReLU(),
            nn.AdaptiveAvgPool1d(1), nn.Flatten(), nn.Dropout(0.2), nn.Linear(32, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = torch.clamp(x, -8.0, 8.0) / self.scale
        return self.net(x).squeeze(-1)


class CNNModel:
    """Trained for a fixed 30 epochs with a cosine learning-rate schedule (no early
    stopping: all non-test people are used for training; the threshold is chosen
    separately by inner cross-validation)."""
    name = "cnn"

    def __init__(self, epochs: int = 30, batch: int = 128, lr: float = 2e-3) -> None:
        self.epochs, self.batch, self.lr = epochs, batch, lr
        self.net = FallCNN()

    @staticmethod
    def channels(wins: np.ndarray) -> np.ndarray:
        return np.stack([window_channels(w) for w in wins])

    def fit(self, wins, y) -> CNNModel:
        torch.manual_seed(SEED)
        rng = np.random.default_rng(SEED)
        X = torch.from_numpy(self.channels(wins))
        Y = torch.from_numpy(np.asarray(y, dtype=np.float32))
        pos_weight = (len(Y) - Y.sum()) / Y.sum().clamp(min=1.0)
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.lr, weight_decay=1e-3)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, self.epochs)
        for _ in range(self.epochs):
            self.net.train()
            perm = rng.permutation(len(X))
            for i in range(0, len(perm), self.batch):
                b = perm[i:i + self.batch]
                xb = X[b].clone()
                # augmentation: device-to-device gain differences + sensor noise
                s = torch.empty(len(b), 1, 1).uniform_(0.85, 1.15)
                xb[:, :3] = xb[:, :3] * s + 0.02 * torch.randn_like(xb[:, :3])
                opt.zero_grad()
                loss_fn(self.net(xb), Y[b]).backward()
                opt.step()
            sched.step()
        self.net.eval()
        return self

    def predict_proba(self, wins: np.ndarray) -> np.ndarray:
        self.net.eval()
        with torch.no_grad():
            return torch.sigmoid(self.net(torch.from_numpy(self.channels(wins)))).numpy().astype(np.float32)

    @property
    def n_params(self) -> int:
        return sum(p.numel() for p in self.net.parameters())


class EnsembleModel:
    """Mean of the LightGBM and CNN probabilities (they make different mistakes)."""
    name = "ensemble"

    def __init__(self) -> None:
        self.members = [ClassicModel(), CNNModel()]

    def fit(self, wins, y) -> EnsembleModel:
        for m in self.members:
            m.fit(wins, y)
        return self

    def predict_proba(self, wins: np.ndarray) -> np.ndarray:
        return np.mean([m.predict_proba(wins) for m in self.members], axis=0).astype(np.float32)
