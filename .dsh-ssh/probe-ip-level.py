#!/usr/bin/env python3
"""帳號級 vs IP 級 408 判定（v5）——決定性實驗：
同一 active token，分別走【直連】與【代理池不同端口】submit 影片請求。
- 若全出口 408 → 帳號級（或 Adobe 服務級）
- 若部分出口 200/queued → IP 級（代理池換 IP 可解）
"""
import sys, time
sys.path.insert(0, "/app")
from core.token_mgr import token_manager
from adobe_client import AdobeClient

CONF = {
    "engine": "kling3", "upstream_model_id": "kling", "upstream_model_version": "kling_v3",
    "durations": (5, 10, 15), "ratios": ("16:9", "9:16"), "resolutions": ("720p",),
    "supports_audio": True, "duration": 5, "ratio": "16:9", "resolution": "720p",
}

toks = token_manager.tokens
active = [t for t in toks if t.get("status") == "active"][0]["value"]

def probe(client, label):
    t0 = time.time()
    try:
        client.generate_video(
            token=active, video_conf=CONF,
            prompt="A snowflake drifting slowly in calm air, minimal",
            aspect_ratio="16:9", duration=5, timeout=3,
        )
        return f"{label} ({time.time()-t0:.1f}s): SUCCESS/SUBMITTED"
    except Exception as e:
        return f"{label} ({time.time()-t0:.1f}s): {str(e)[:120]}"

# A. 直連（proxy 設 None）
c_direct = AdobeClient()
c_direct.proxy = None
print(probe(c_direct, "A. direct   "), flush=True)

# B. 代理池端口 24000（默認）
c_p0 = AdobeClient()
print(probe(c_p0, "B. pool:24000"), flush=True)

# C. 代理池其他端口（24001-24015 輪換出口 IP）
for port in (24001, 24005, 24010, 24015):
    c = AdobeClient()
    c.proxy = f"http://172.19.0.1:{port}"
    print(probe(c, f"C. pool:{port}"), flush=True)
    time.sleep(2)
