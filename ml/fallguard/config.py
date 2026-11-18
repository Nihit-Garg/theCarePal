"""Shared constants. The browser reads the signal/detector values from
web/public/models/model_config.json, which export_models.py writes from here —
re-export after changing anything."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw"
PROCESSED_DIR = ROOT / "data" / "processed"
REPORTS_DIR = ROOT / "reports"
WEB_MODELS_DIR = ROOT / "web" / "public" / "models"
WEB_DATA_DIR = ROOT / "web" / "public" / "replays"

# --- signal ---
FS = 20                      # Hz. Lowest native rate in our data (UMAFall SensorTags); cheap on battery.
BIN_MS = 1000 // FS          # every source is bin-averaged into 50 ms bins (doubles as anti-alias filter)
G = 9.80665

# --- event window around a candidate impact peak ---
PRE_S, POST_S = 1.5, 2.5     # 1.5 s before impact (free fall), 2.5 s after (lying still?)
PRE = int(PRE_S * FS)        # 30 samples
POST = int(POST_S * FS)      # 50 samples
WIN = PRE + POST             # 80 samples
PEAK_HALF_WIDTH = int(0.5 * FS)  # a peak must be the max within +/-0.5 s

# --- streaming alarm logic ---
REFRACTORY_S = 10.0          # one physical event => at most one alarm

# The two sensor positions we train a model for.
POSITIONS = ("phone", "wrist")
