#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm install

mkdir -p public/ffmpeg
cp -f node_modules/@ffmpeg/core/dist/esm/* public/ffmpeg/

mkdir -p public/fonts
if [ ! -f public/fonts/DejaVuSans.ttf ]; then
  tmpzip="$(mktemp)"
  curl -fsSL -o "$tmpzip" \
    "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip"
  tmpdir="$(mktemp -d)"
  unzip -qo "$tmpzip" -d "$tmpdir"
  find "$tmpdir" -name "DejaVuSans.ttf" -exec cp {} public/fonts/DejaVuSans.ttf \;
  rm -rf "$tmpzip" "$tmpdir"
fi

echo "Bootstrap complete."
