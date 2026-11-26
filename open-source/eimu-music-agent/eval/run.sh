#!/usr/bin/env bash
# 复现本文分数：转 44.1 kHz 立体声 WAV → 官方评分器 → 汇总 → 与本文对照。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${SONGBENCH_DIR:-$HERE/songbench-toolkit}"
PY="$WORK/.venv/bin/python"; [ -x "$PY" ] || PY=python3
MEM="${MEM_LEVEL:-1}"          # 1=短曲全 GPU；长曲用 4（前端放 CPU），两者在正控制曲上逐维等价

mkdir -p "$HERE/out/wav"
if [ "${1:-}" != "--score-only" ]; then
  echo "== 转 44.1 kHz 立体声 WAV（格式错了分数会系统性偏移）=="
  for f in "$HERE"/audio/*.m4a; do
    ffmpeg -y -v error -i "$f" -ar 44100 -ac 2 -c:a pcm_s16le "$HERE/out/wav/$(basename "${f%.m4a}").wav"
  done
  echo "== 跑官方评分器 =="
  ( cd "$WORK" && "$PY" eval_gpu.py -i "$HERE/out/wav" -o "$HERE/out/result" --mem_level "$MEM" )
fi
echo "== 汇总 =="
"$PY" "$HERE/score.py" "$HERE/out/result" "$HERE/scores/eimu-delivered.reproduced.json"
