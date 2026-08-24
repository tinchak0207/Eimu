#!/usr/bin/env python3
"""image 對照組：同 active token 直接調 generate（image 路徑），驗證 Adobe 帳號本身活著。
同時再跑一次 video submit 確認 408 仍現。"""
import sys, time
sys.path.insert(0, "/app")
from core.token_mgr import token_manager
from adobe_client import AdobeClient

client = AdobeClient()
toks = token_manager.tokens
active = [t for t in toks if t.get("status") == "active"][0]["value"]

# A. image 對照（同帳號同代理）
t0 = time.time()
try:
    img = client.generate(
        token=active,
        prompt="a red apple on a wooden table",
        aspect_ratio="1:1",
        output_resolution="1K",
        upstream_model_id="gpt-image",
        upstream_model_version="gpt-image-2",
        timeout=120,
    )
    if isinstance(img, tuple):
        data, meta = img
    else:
        data, meta = img, {}
    n = len(data) if isinstance(data, (bytes, bytearray)) else 1
    print(f"A. IMAGE: OK ({time.time()-t0:.0f}s) size={n}", flush=True)
except Exception as e:
    print(f"A. IMAGE: {type(e).__name__} ({time.time()-t0:.0f}s): {str(e)[:140]}", flush=True)

# B. video submit 再確認
CONF = {
    "engine": "kling3", "upstream_model_id": "kling", "upstream_model_version": "kling_v3",
    "durations": (5, 10, 15), "ratios": ("16:9", "9:16"), "resolutions": ("720p",),
    "supports_audio": True, "duration": 5, "ratio": "16:9", "resolution": "720p",
}
t1 = time.time()
try:
    client.generate_video(
        token=active, video_conf=CONF,
        prompt="A snowflake drifting slowly in calm air, minimal",
        aspect_ratio="16:9", duration=5, timeout=3,
    )
    print(f"B. VIDEO: SUBMITTED", flush=True)
except Exception as e:
    print(f"B. VIDEO: {str(e)[:140]}", flush=True)
