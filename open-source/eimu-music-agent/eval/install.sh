#!/usr/bin/env bash
# 装好复现环境：SongBench 官方仓库 + 我们的评测器补丁 + Python 依赖。
# 需要：git、python3.10+、ffmpeg。GPU 建议 8 GB 显存（峰值约 5.1 GB）；CPU 也能跑，只是慢。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${SONGBENCH_DIR:-$HERE/songbench-toolkit}"

if [ ! -d "$WORK" ]; then
  git clone https://github.com/Tencent/SongBench.git "$WORK"
fi

cd "$WORK"
if ! grep -q "mem_level" eval_gpu.py 2>/dev/null; then
  patch -p0 < "$HERE/eval_gpu.patch"
  echo "已应用 eval_gpu.patch"
fi

python3 -m venv .venv 2>/dev/null || true
./.venv/bin/pip install -U pip
./.venv/bin/pip install -r requirements.txt

cat <<'EOF'

权重还需手动放好（受 SongBench 许可约束，不由本仓库分发）：
  songbench-toolkit/ckpt/songbench.safetensors
  MuQ-large-msd-iter（按官方 README 的路径）
放好后跑：./run.sh
EOF
