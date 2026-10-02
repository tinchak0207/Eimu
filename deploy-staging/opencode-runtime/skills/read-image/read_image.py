#!/usr/bin/env python3
"""读图：本机路径或 http(s) URL → new-api 中控视觉模型（默认 glm-5.3-flash）。

2026-09-29 换血：原 Groq qwen/qwen3.6-27b 通路已死（404 模型不存在／403／SSL EOF），
且只收本机路径。现与 vision_analyze 同一条中控通路（NEWAPI_BASE_URL + NEWAPI_API_KEY），
模型可用 NEWAPI_VISION_MODEL 覆盖。用法：python3 read_image.py <图片路径或URL> [提问]
"""
import base64, json, mimetypes, os, sys, urllib.request, urllib.error

PROMPT = "请详细描述这张图片的内容：主体人物/物体、场景、构图、风格、光线、色调、细节。用中文回答，直接给描述，不要额外说明。"


def main():
    if len(sys.argv) < 2:
        print("usage: read_image.py <image-path-or-url> [question]", file=sys.stderr)
        sys.exit(2)
    src = sys.argv[1]
    question = sys.argv[2] if len(sys.argv) > 2 else PROMPT
    key = os.environ.get("NEWAPI_API_KEY", "").strip()
    base = os.environ.get("NEWAPI_BASE_URL", "http://127.0.0.1:3001/v1").rstrip("/")
    model = os.environ.get("NEWAPI_VISION_MODEL", "").strip() or "glm-5.3-flash"
    if not key:
        print("NEWAPI_API_KEY missing in process env", file=sys.stderr)
        sys.exit(2)
    if src.startswith(("http://", "https://")):
        image_url = src
    else:
        if not os.path.isfile(src):
            print("file not found:", src, file=sys.stderr)
            sys.exit(2)
        data = open(src, "rb").read()
        if len(data) > 20 * 1024 * 1024:
            print("image too large (>20MB)", file=sys.stderr)
            sys.exit(2)
        mime = mimetypes.guess_type(src)[0] or "image/png"
        image_url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": question},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]}],
        "max_tokens": 2048,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"读图失败 HTTP {e.code}: {e.read()[:300].decode(errors='replace')}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # 网络层
        print(f"读图失败：{e!r}", file=sys.stderr)
        sys.exit(1)
    content = (resp.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    if not content.strip():
        print("读图失败：模型返回空内容", file=sys.stderr)
        sys.exit(1)
    print(content)


if __name__ == "__main__":
    main()
