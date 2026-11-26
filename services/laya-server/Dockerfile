FROM python:3.12-slim

WORKDIR /app

# curl 供 HEALTHCHECK 用；其余不装（映像越小，免费层部署越快）
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# torch 走 CPU-only 索引：Laya 是 421M 分类头，CPU 推理 ~170ms 足够，
# 装 CUDA 版会让映像膨胀到数 GB（免费层多数跑 ARM/无 GPU，装了也用不上）。
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY server.py .

# 模型权重 ~650MB 于首次启动时自 HF Hub 下载并快取。
# 设 HF_HOME 到挂载点可让快取跨容器重启存活（免费层多半无持久碟，重启需重载）。
ENV HF_HOME=/data/hf \
    LAYA_PORT=8082 \
    LAYA_SUBFOLDER=multilingual \
    LAYA_THREADS=2 \
    LAYA_PRELOAD=true \
    TOKENIZERS_PARALLELISM=false

EXPOSE 8082

# start-period 给足：冷启动载模型实测 ~17-19s，加上首次下载权重。
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8082/healthz || exit 1

CMD ["python3", "server.py"]