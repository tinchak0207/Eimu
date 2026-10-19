#!/usr/bin/env bash
# smoke_modal.sh — blender-modal POC 真云三连 smoke（研究片U 唯一未证项=Eevee EGL serverless，一次判生死）
#
# 用法（项目负责人一行）：
#   cd /home/user/Desktop/image-app/deploy-staging/blender-modal && ./smoke_modal.sh
# 可选环境变数：
#   BLENDER_MODAL_GPU=T4        # T4 起步（几分钱纪律）；Eevee EGL 败则 L4 重判
#   SKIP_WEB=1                  # 跳过第 4 步（web endpoint/worker 链路验证）
#
# 步骤：
#   [0] 本地验证：py_compile + modal_common 自测 + ffmpeg image2 本地实弹
#   [1] 单帧 Eevee @GPU（EGL 生死判定——gpu.init() 失败=死，png 验真）
#   [2] 单帧 Cycles（仅在 Eevee 败时跑后备确认；Eevee 活也记录但不重跑）
#   [3] 10 帧小链 starmap 分发 + ffmpeg 合片 + ffprobe 验真
#   [4] deploy + HMAC secret + modal_worker.py 经 web endpoint 走 still+chain
#   末尾输出每步实测秒数与花费估算（T4 列表价 $0.59/h 为估算基准，以 Modal 定价页为准）
set -uo pipefail
cd "$(dirname "$0")"

MODAL="${MODAL:-/home/user/.venvs/modal/bin/modal}"
GPU="${BLENDER_MODAL_GPU:-T4}"
export BLENDER_MODAL_GPU="$GPU"
mkdir -p out; chmod 700 out 2>/dev/null

gpu_cost() { # $1=gpu-seconds（估）→ $ 输出（T4 列表价 $0.59/h 基准）
  python3 -c "print(f'\${float('$1')*(0.59/3600):.4f}')"
}

S1=0; S2=0; S3=0; S4=0
echo "======== [0/4] 本地验证 ========"
python3 -m py_compile modal_common.py modal_app.py modal_worker.py || { echo "SMOKE ABORT: py_compile 失败"; exit 1; }
echo "py_compile 3/3 OK"
python3 modal_common.py || { echo "SMOKE ABORT: modal_common 自测失败"; exit 1; }
# ffmpeg image2 配方本地实弹（与云端 combine 同一参数构造）
python3 - <<'PYEOF' || { echo "SMOKE ABORT: 本地 ffmpeg image2 失败"; exit 1; }
import os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath("modal_common.py")))
from modal_common import ffmpeg_image2_args
with tempfile.TemporaryDirectory() as td:
    fd = os.path.join(td, "frames"); os.makedirs(fd)
    for i in range(3):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                        "-i", f"testsrc=duration=0.1:size=128x72:rate=10",
                        "-frames:v", "1", os.path.join(fd, f"frame_{i:04d}.png")], check=True)
    out = os.path.join(td, "a.mp4")
    p = subprocess.run(ffmpeg_image2_args(fd, 30, out), capture_output=True, text=True)
    assert p.returncode == 0, p.stderr[-400:]
    assert os.path.getsize(out) > 1000
    print(f"local ffmpeg image2: 3 frames -> mp4 {os.path.getsize(out)} bytes PASS")
PYEOF

echo "======== [1/4] 单帧 Eevee @${GPU}（EGL 生死判定） ========"
t0=$(date +%s)
EEVEE_OK=1
"$MODAL" run modal_app.py::demo --engine eevee --mode still --frame 1 2>&1 | tee out/smoke1_eevee.log || EEVEE_OK=0
grep -q "gpu_ctx=egl" out/smoke1_eevee.log || EEVEE_OK=0
grep -q "magic_ok=True" out/smoke1_eevee.log || EEVEE_OK=0
t1=$(date +%s); S1=$((t1-t0))
# 亮度方差验真（片F 带宽 1336-7153 口径；PIL 可用才验）
if [ "$EEVEE_OK" = "1" ] && python3 -c "import PIL" 2>/dev/null; then
  python3 - <<'PYEOF' || EEVEE_OK=0
from PIL import Image
import statistics
px = list(Image.open("out/demo_eevee_f1.png").convert("L").getdata())
v = statistics.pvariance(px)
print(f"eevee still brightness variance={v:.0f}")
assert v > 500, f"variance={v} 太低（疑似黑帧）"
PYEOF
fi
if [ "$EEVEE_OK" = "1" ]; then
  echo ">>> EGL 判决：EEVEE EGL 活（gpu_ctx=egl + 真 PNG 验真过）——研究片U 唯一未证项转已证"
else
  echo ">>> EGL 判决：EEVEE EGL 败（见 out/smoke1_eevee.log 的 gpu_ctx 行）——退路=engine 一行换 cycles"
fi

echo "======== [2/4] 单帧 Cycles（后备确认） ========"
if [ "$EEVEE_OK" = "1" ]; then
  echo "Eevee 已活，按项目负责人纪律跳过 Cycles 后备（省 GPU 秒）；需要时: modal run modal_app.py::demo --engine cycles --mode still"
  S2=0
else
  t0=$(date +%s)
  "$MODAL" run modal_app.py::demo --engine cycles --mode still --frame 1 2>&1 | tee out/smoke2_cycles.log
  t1=$(date +%s); S2=$((t1-t0))
  grep -q "magic_ok=True" out/smoke2_cycles.log && echo "Cycles 后备确认 PASS" || echo "Cycles 后备也败——回报事实，勿再重试"
fi

echo "======== [3/4] 10 帧小链 starmap + 合片 ========"
t0=$(date +%s)
"$MODAL" run modal_app.py::demo --engine eevee --mode chain --frames 10 --fps 30 2>&1 | tee out/smoke3_chain.log
t1=$(date +%s); S3=$((t1-t0))
CHAIN_OK=1
grep -q "frames ok=10/10" out/smoke3_chain.log || CHAIN_OK=0
if [ -s out/demo_eevee_chain.mp4 ]; then
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,nb_frames,duration -of csv=p=0 out/demo_eevee_chain.mp4 | tee out/smoke3_ffprobe.txt
else
  CHAIN_OK=0
fi

if [ "${SKIP_WEB:-0}" != "1" ]; then
  echo "======== [4/4] web endpoint（HMAC）+ modal_worker 链路 ========"
  KEY_FILE=out/.hmac_key
  if [ ! -s "$KEY_FILE" ]; then
    openssl rand -hex 32 > "$KEY_FILE" && chmod 600 "$KEY_FILE"
  fi
  KEY=$(cat "$KEY_FILE")
  "$MODAL" secret create blender-modal-hmac BLENDER_MODAL_HMAC_KEY="$KEY" >/dev/null 2>&1 \
    && echo "secret blender-modal-hmac 已写入" \
    || echo "secret blender-modal-hmac 已存在（新建版本失败非致命，沿用现值——若 worker 鉴权 401 删 secret 重跑）"
  "$MODAL" deploy modal_app.py 2>&1 | tee out/smoke4_deploy.log
  URL=$(grep -oE 'https://[^[:space:]]+\.modal\.run' out/smoke4_deploy.log | head -1)
  if [ -z "$URL" ]; then echo "SMOKE: 未解析到 endpoint URL（见 smoke4_deploy.log）"; else
    echo "endpoint=$URL"
    t0=$(date +%s)
    BLENDER_MODAL_ENDPOINT="$URL" BLENDER_MODAL_HMAC_KEY="$KEY" python3 modal_worker.py still --engine eevee | tee out/smoke4_web_still.log
    t1=$(date +%s); S4=$((t1-t0))
    grep -q '"ok": true' out/smoke4_web_still.log && echo "web still PASS（bridge 形回应）" || echo "web still FAIL"
    t0=$(date +%s)
    BLENDER_MODAL_ENDPOINT="$URL" BLENDER_MODAL_HMAC_KEY="$KEY" python3 modal_worker.py chain --frames 10 --fps 30 --out out/web_chain.mp4 | tee out/smoke4_web_chain.log
    t1=$(date +%s); S4=$((S4+t1-t0))
    grep -q '"ok": true' out/smoke4_web_chain.log && ffprobe -v error -show_entries format=duration -of csv=p=0 out/web_chain.mp4 \
      && echo "web chain PASS（单帧循环+本地 ffmpeg 合片，bridge /v1/execute 形状）" || echo "web chain FAIL"
  fi
else
  S4=0
fi

GPU_S=$((S1 + S2 + S3 + S4))
echo "======== smoke 总结 ========"
echo "EGL 判决: $([ "$EEVEE_OK" = "1" ] && echo "EEVEE EGL 活" || echo "EEVEE EGL 败（退 cycles）")"
echo "步骤墙钟秒: still_eevee=${S1}s cycles=${S2}s chain=${S3}s web=${S4}s（含容器冷启+排队；$GPU）"
echo "花费估算（全部墙钟按 GPU 秒计，偏保守）: $(gpu_cost "$GPU_S")"
[ "$CHAIN_OK" = "1" ] && echo "CHAIN: PASS" || echo "CHAIN: FAIL（见 out/smoke3_chain.log）"
exit 0
