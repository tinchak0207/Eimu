#!/usr/bin/env python3
"""帳號級 vs IP 級判定的最後一塊：換 prompt 重測。
19:43/19:50 出現 451 video_unsafe / legal_error —— Adobe 有在處理請求（非純負載丟棄）。
408 可能與 prompt（snowflake）或 submit 端點的併發策略有關。換 3 個不同 prompt 測。"""
import sys, time
sys.path.insert(0, "/app")
from core.token_mgr import token_manager
from adobe_client import AdobeClient

client = AdobeClient()
CONF = {
    "engine": "kling3", "upstream_model_id": "kling", "upstream_model_version": "kling_v3",
    "durations": (5, 10, 15), "ratios": ("16:9", "9:16"), "resolutions": ("720p",),
    "supports_audio": True, "duration": 5, "ratio": "16:9", "resolution": "720p",
}
toks = token_manager.tokens
active = [t for t in toks if t.get("status") == "active"][0]["value"]

prompts = [
    "A friendly golden retriever running on a beach at sunset",
    "Gentle ocean waves rolling onto white sand, aerial view",
    "A cup of coffee steaming on a wooden cafe table",
]
for p in prompts:
    t0 = time.time()
    try:
        client.generate_video(
            token=active, video_conf=CONF,
            prompt=p, aspect_ratio="16:9", duration=5, timeout=3,
        )
        r = "SUBMITTED"
    except Exception as e:
        r = str(e)[:130]
    print(f"[{p[:30]}...] ({time.time()-t0:.1f}s) {r}", flush=True)
    time.sleep(2)
