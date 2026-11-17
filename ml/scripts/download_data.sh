#!/usr/bin/env bash
# Downloads the two public datasets into data/raw/ (~310 MB zipped, free).
#   UMAFall  — Casilari et al. 2017, figshare (CC BY 4.0), corrected version
#   SisFall  — Sucerquia et al. 2017; the original university host is offline,
#              so we use a public Hugging Face mirror of the unmodified release.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p data/raw/umafall data/raw/sisfall

if [ ! -f data/raw/umafall/.done ]; then
  echo "Downloading UMAFall..."
  curl -fL --retry 3 -o data/raw/umafall/umafall.zip https://ndownloader.figshare.com/files/43076140
  unzip -q -o data/raw/umafall/umafall.zip -d data/raw/umafall
  touch data/raw/umafall/.done
fi

if [ ! -f data/raw/sisfall/.done ]; then
  echo "Downloading SisFall..."
  curl -fL --retry 3 -o data/raw/sisfall/sisfall.zip \
    "https://huggingface.co/datasets/Trupal7/Sisfall_Dataset/resolve/main/SisFall_dataset.zip"
  unzip -q -o data/raw/sisfall/sisfall.zip -d data/raw/sisfall
  rm -rf data/raw/sisfall/__MACOSX
  touch data/raw/sisfall/.done
fi
echo "Datasets ready in data/raw/"
