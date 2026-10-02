#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LLM 摘要模块（OpenAI 兼容协议，零第三方依赖）。

默认对接 Groq 免费推理（Groq API 兼容层路径为 /openai/v1）：
  - 直连 Groq：设置 GROQ_API_KEY（走 https://api.groq.com/openai/v1）
  - 自建代理/隧道：设置 GROQ_PROXY_URL（指向 /openai/v1 兼容
    路径的本地转发地址，免 key），优先级高于直连
  - 任意 OpenAI 兼容服务：设置 OPENAI_BASE_URL + OPENAI_API_KEY

模型选择：SUMMARY_MODEL 环境变量（默认 openai/gpt-oss-120b，Groq 免费）。

用法：
  python3 llm_summarize.py "要总结的长文本"
  或作为模块：from llm_summarize import summarize
"""
import json
import os
import sys
import urllib.request

DEFAULT_MODEL = "openai/gpt-oss-120b"
GROQ_DIRECT = "https://api.groq.com/openai/v1"


def _resolve_endpoint():
    """返回 (base_url, api_key, model)"""
    model = os.environ.get("SUMMARY_MODEL", DEFAULT_MODEL)
    proxy = os.environ.get("GROQ_PROXY_URL", "").strip().rstrip("/")
    if proxy:
        return proxy, os.environ.get("GROQ_API_KEY", "local-proxy"), model
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    if groq_key:
        return GROQ_DIRECT, groq_key, model
    openai_base = os.environ.get("OPENAI_BASE_URL", "").strip().rstrip("/")
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_base and openai_key:
        return openai_base, openai_key, model
    return None, None, model


def summarize(text, max_chars=3000, timeout=60):
    """生成要点摘要；未配置任何端点时返回空字符串（调用方自行降级）。"""
    text = (text or "").strip()
    if not text:
        return ""
    base, key, model = _resolve_endpoint()
    if not base:
        return ""
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system",
             "content": "你是内容摘要助手。用简体中文输出 3-5 条要点，每条一句话，直接给结论。"},
            {"role": "user", "content": text[:max_chars]},
        ],
        "temperature": 0.3,
        "max_tokens": 400,
    }).encode()
    req = urllib.request.Request(
        base + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key or 'none'}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode("utf-8", "ignore"))
    content = (d.get("choices") or [{}])[0].get("message", {}).get("content", "")
    # 剥离推理模型可能的 <think> 段
    if "</think>" in content:
        content = content.split("</think>", 1)[1]
    return content.strip()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 llm_summarize.py \"长文本\"", file=sys.stderr)
        sys.exit(1)
    print(summarize(" ".join(sys.argv[1:])))
