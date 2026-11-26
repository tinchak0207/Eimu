#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B站视频转文字（yt-dlp 开源方案，零手写解析器）。

优先级：
  1. 官方 AI 字幕（ai-zh / CC 字幕，srt）—— 需要登录态（--cookies-from-browser chrome）
  2. 弹幕 XML（danmaku）—— 观众真实评论，匿名+登录态都可
  3. 视频简介（description）—— 兜底

字幕总结：scripts/llm_summarize.py（Groq 免费推理 / 任意 OpenAI 兼容服务）。

用法：
  python3 bilibili_transcribe.py <视频URL或av/BV号> [--summary]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from llm_summarize import summarize

VENVPY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".venv", "bin", "python")
PY = VENVPY if os.path.exists(VENVPY) else sys.executable


def _yt_dlp(args, timeout=90):
    cmd = [PY, "-m", "yt_dlp"] + args
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r


def _with_cookies(args):
    """优先项目导出的 cookies（state/bilibili_cookies.txt），否则浏览器提取。"""
    cookies = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "state", "bilibili_cookies.txt")
    if os.path.exists(cookies):
        return args + ["--cookies", cookies]
    return args + ["--cookies-from-browser", "chrome"]


def get_transcript(url, want_danmaku=True):
    """返回 {'subtitle': str, 'danmaku': [str], 'title': str, 'description': str}"""
    out = {"subtitle": "", "danmaku": [], "title": "", "description": ""}
    with tempfile.TemporaryDirectory() as td:
        base = os.path.join(td, "v")
        args = _with_cookies(["--skip-download", "--write-subs",
                              "--sub-langs", "ai-zh,zh-CN,zh,en",
                              "--sub-format", "srt/vtt",
                              "-o", base, url])
        try:
            _yt_dlp(args)
        except Exception:
            pass
        # 字幕文件
        for f in sorted(os.listdir(td)):
            if f.endswith((".srt", ".vtt")):
                raw = open(os.path.join(td, f), encoding="utf-8", errors="ignore").read()
                # srt/vtt → 纯文本（时间轴行与序号行丢弃）
                lines = []
                for ln in raw.splitlines():
                    ln = ln.strip()
                    if not ln or ln.isdigit() or "-->" in ln or ln.startswith(("WEBVTT", "Kind:", "Language:")):
                        continue
                    lines.append(ln)
                out["subtitle"] = " ".join(dict.fromkeys(lines))  # 去重保序
                break
        # 弹幕
        if want_danmaku and not out["subtitle"]:
            try:
                _yt_dlp(_with_cookies(["--skip-download", "--write-subs",
                                       "--sub-langs", "danmaku", "--sub-format", "xml",
                                       "-o", base, url]))
                for f in os.listdir(td):
                    if f.endswith(".xml"):
                        raw = open(os.path.join(td, f), encoding="utf-8", errors="ignore").read()
                        out["danmaku"] = re.findall(r"<d[^>]*>([^<]+)</d>", raw)
                        break
            except Exception:
                pass
        # 元数据
        try:
            r = _yt_dlp(["--skip-download", "--print", "%(title)s\n%(description)s", url], timeout=60)
            parts = r.stdout.strip().split("\n", 1)
            out["title"] = parts[0] if parts else ""
            out["description"] = parts[1].strip() if len(parts) > 1 else ""
        except Exception:
            pass
    return out


def summarize_text(text, max_chars=2000):
    """LLM 摘要（llm_summarize 模块：Groq 免费 / OpenAI 兼容，未配置返回空）。"""
    return summarize(text, max_chars=max_chars)


def main():
    ap = argparse.ArgumentParser(description="B站视频转文字（yt-dlp 开源方案）")
    ap.add_argument("url", help="B站视频 URL / av号 / BV号")
    ap.add_argument("--summary", action="store_true", help="调用 LLM 生成要点摘要")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    args = ap.parse_args()

    t = get_transcript(args.url)
    summary = summarize_text(t["subtitle"] or " ".join(t["danmaku"][:200])) if args.summary else ""

    if args.json:
        print(json.dumps({**t, "summary": summary}, ensure_ascii=False, indent=1))
        return
    print(f"标题: {t['title']}")
    src = "AI字幕" if t["subtitle"] else (f"弹幕({len(t['danmaku'])}条)" if t["danmaku"] else "简介")
    print(f"转写来源: {src}\n")
    if t["subtitle"]:
        print("== 字幕全文 ==")
        print(t["subtitle"][:1500])
    elif t["danmaku"]:
        print("== 弹幕摘录 ==")
        print(" / ".join(t["danmaku"][:40]))
    else:
        print("== 简介 ==")
        print(t["description"][:800])
    if summary:
        print("\n== AI 摘要 ==")
        print(summary)


if __name__ == "__main__":
    main()
