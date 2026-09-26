#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'PY'
import os, sys
out = sys.argv[1]
colors = [(255,60,60),(60,170,255),(255,190,30),(120,230,120)]
w,h=720,1280
for i,(r,g,b) in enumerate(colors,1):
    with open(os.path.join(out,f"{i}.ppm"),"wb") as f:
        f.write(f"P6\n{w} {h}\n255\n".encode())
        f.write(bytes((r,g,b))*(w*h))
PY
curl --fail --show-error --silent \
  -F duration=5 -F interval=0.2 \
  -F "images=@$TMP/1.ppm" -F "images=@$TMP/2.ppm" \
  -F "images=@$TMP/3.ppm" -F "images=@$TMP/4.ppm" \
  http://localhost:8080/render -o "$ROOT/test-video.mp4"
echo "Готово: $ROOT/test-video.mp4"
