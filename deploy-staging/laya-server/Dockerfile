FROM python:3.12-slim

WORKDIR /app

# curl 供 HEALTHCHECK 用；其餘不裝（映像越小，免費層部署越快）
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# torch 走 CPU-only 索引：Laya 是 421M 分類頭，CPU 推理 ~170ms 足夠，
# 裝 CUDA 版會讓映像膨脹到數 GB（免費層多數跑 ARM/無 GPU，裝了也用不上）。
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY server.py .

# 模型權重 ~650MB 於首次啟動時自 HF Hub 下載並快取。
# 設 HF_HOME 到掛載點可讓快取跨容器重啟存活（免費層多半無持久碟，重啟需重載）。
ENV HF_HOME=/data/hf \
    LAYA_PORT=8082 \
    LAYA_SUBFOLDER=multilingual \
    LAYA_THREADS=2 \
    LAYA_PRELOAD=true \
    TOKENIZERS_PARALLELISM=false

EXPOSE 8082

# start-period 給足：冷啟動載模型實測 ~17-19s，加上首次下載權重。
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8082/healthz || exit 1

CMD ["python3", "server.py"]