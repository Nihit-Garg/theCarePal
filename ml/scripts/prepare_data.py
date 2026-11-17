"""Load raw datasets, harmonise them and cache to data/processed/recordings.pkl.

    python ml/scripts/prepare_data.py
"""
import collections
import pickle

from fallguard import config
from fallguard.datasets import load_all


def main() -> None:
    data = load_all()
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    out = config.PROCESSED_DIR / "recordings.pkl"
    with open(out, "wb") as fh:
        pickle.dump(data, fh)
    for pos, recs in data.items():
        c = collections.Counter((r.dataset, "fall" if r.label else "adl") for r in recs)
        hours = sum(r.duration_s for r in recs if not r.label) / 3600
        subjects = len({r.subject for r in recs})
        print(f"{pos:6s} recordings={len(recs):5d} subjects={subjects:3d} ADL hours={hours:5.2f} {dict(c)}")
    print("saved", out)


if __name__ == "__main__":
    main()
