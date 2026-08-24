#!/usr/bin/env python3
"""動態實驗：直接調 AdobeClient.generate_video，驗證 timeout 行為。"""
import sys, time
sys.path.insert(0, "/app")
from adobe_client import AdobeClient
from core.token_mgr import token_manager
from core.models import VIDEO_MODEL_CATALOG

conf = None
for k, v in VIDEO_MODEL_CATALOG.items():
    if "kling3" in k and "5s" in k and "16x9" in k:
        conf = dict(v)
        print("using catalog key:", k, flush=True)
        break
if conf is None:
    for k, v in VIDEO_MODEL_CATALOG.items():
        if "kling3" in k and "5s" in k:
            conf = dict(v)
            print("using catalog key:", k, flush=True)
            break

client = AdobeClient()
print("generate_timeout:", client.generate_timeout, flush=True)
token = token_manager.get_available()
print("token ok:", bool(token), flush=True)
if not token:
    sys.exit(1)
t0 = time.time()
try:
    video_bytes, meta = client.generate_video(
        token=token,
        video_conf=conf or {},
        prompt="An emperor in flowing black and gold silk robes rides a large white polar bear gently across a snowy landscape at sunrise, cinematic wide shot",
        aspect_ratio="16:9",
        duration=5,
        timeout=600,
    )
    print("SUCCESS after", round(time.time() - t0, 1), "s; bytes:", len(video_bytes or b""), flush=True)
except Exception as e:
    print("FAILED after", round(time.time() - t0, 1), "s:", type(e).__name__, str(e)[:200], flush=True)
