#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""聚合搜索引擎 — 免登录优先，广度优先。
支持平台：
  - bilibili : 官方搜索 API + WBI 签名（匿名，需 Referer: search.bilibili.com）
  - web      : Bing RSS 开放网页直接检索
  - github   : GitHub 官方 Search API
  - reddit   : Reddit 历史存档 API（arctic-shift，免 key）
  - tavily   : Tavily AI 搜索 API（需 TAVILY_API_KEY 环境变量）
  - xhs      : 小红书（通过 xhs-cli 或登录态 Cookie 检索）
  - telegram : Telegram 全局搜索（Telethon messages.SearchGlobal）

用法：
  search.py "关键词"                        # 全部平台
  search.py "关键词" --platform bilibili,reddit,github
  search.py "关键词" --platform all,-xhs
  search.py "关键词" --platform web --json
  search.py --list
"""
import argparse
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
TIMEOUT = 15
DEFAULT_MAX = 8

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.environ.get("AGGREGATE_SEARCH_STATE_DIR", os.path.join(BASE_DIR, "state"))


def _load_dotenv():
    """轻量 .env 加载（KEY=VALUE 每行一条），便于本地演示免手动 export。"""
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    except Exception:
        pass


_load_dotenv()

PLATFORMS = {
    "bilibili": {"label": "B站"},
    "web":      {"label": "开放网页（已停用，勿用）"},
    "reddit":   {"label": "Reddit"},
    "github":   {"label": "GitHub"},
    "xhs":      {"label": "小红书"},
    "tavily":   {"label": "Tavily"},
    "telegram": {"label": "Telegram"},
}
ORDER = ["bilibili", "reddit", "github", "xhs", "tavily", "telegram"]


# ---------- HTTP ----------
def http_get(url, headers=None, timeout=TIMEOUT):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def strip_html(s):
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(re.sub(r"\s+", " ", s)).strip()


# ---------- Bing RSS（已禁用） ----------
# 2026-08-26 决策：web 平台整源停用。Bing RSS 结果被垃圾 SEO 站点（黑料网等）污染，
# 对推荐/选购类查询产生无效结果。需要开放网页搜索时改用 tavily 平台。
def bing_search(q, n=DEFAULT_MAX, site=None, domains=None):
    raise RuntimeError("web/Bing 源已停用（结果被垃圾 SEO 污染）。请改用 tavily 平台，或搜索 bilibili/reddit/github")


CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

def _reject_chinese_on_english_platform(platform, q):
    """语言纪律闸门：英文平台（Reddit/GitHub）用中文关键词必然空手而归。
    检测到中文查询直接报错，提示先翻译成英文。"""
    if CJK_RE.search(q):
        raise RuntimeError(
            f"{platform} 是英文平台，中文关键词搜不到内容。请先把「{q}」翻译成英文"
            f"（例如「猫粮推荐」→ cat food recommendation）再搜索")


def reddit_search(q, n=DEFAULT_MAX):
    """Reddit 全局检索（arctic-shift 镜像存档，免 key）。
    存档通道无命中时，回退 Tavily 域名过滤（include_domains=reddit.com）。"""
    _reject_chinese_on_english_platform("Reddit", q)
    try:
        sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))
        from reddit_miner import quick_search
        results = quick_search(q, n=n)
    except Exception:
        results = []
    if results:
        return results
    try:
        return tavily_search(q + " reddit", n=n, include_domains=["reddit.com"])
    except Exception:
        raise RuntimeError("Reddit 存档无结果且 Tavily 回退不可用（未配置 TAVILY_API_KEY）")


def telegram_search(q, n=DEFAULT_MAX):
    """Telegram 全局搜索：Telethon SearchGlobal。"""
    script = os.path.join(BASE_DIR, "scripts", "telegram_search.py")
    # 优先项目 venv（含 telethon），其次当前解释器
    venv_python = os.path.join(BASE_DIR, ".venv", "bin", "python")
    python_bin = venv_python if os.path.exists(venv_python) else sys.executable
    r = subprocess.run([python_bin, script, q, "--limit", str(n)],
                       capture_output=True, text=True, timeout=45)
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("telegram_search.py 输出异常：" + (r.stdout or r.stderr)[:120])
    if not d.get("ok"):
        raise RuntimeError(str(d.get("error", "telegram 失败"))[:120])
    return d["results"]


def tavily_search(q, n=DEFAULT_MAX, include_domains=None):
    """Tavily AI 搜索：直接调用 REST API（读取 TAVILY_API_KEY 环境变量）。"""
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise RuntimeError("TAVILY_API_KEY 未配置，请设置环境变量 export TAVILY_API_KEY=tvly-...")
    payload = {"api_key": key, "query": q, "max_results": n, "search_depth": "basic"}
    if include_domains:
        payload["include_domains"] = include_domains
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        "https://api.tavily.com/search", data=body,
        headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode("utf-8", "ignore"))
    results = []
    for it in d.get("results", []):
        score = it.get("score")
        sn = (it.get("content") or "")[:300]
        if score is not None:
            sn = f"[相关性 {int(score * 100)}%] " + sn
        results.append({"title": it.get("title", ""), "url": it.get("url", ""), "snippet": sn})
    return results


def xhs_search(q, n=DEFAULT_MAX):
    """小红书搜索：优先 xhs-cli 真实站内搜索（需登录态）；
    未安装 / 未登录 / 被风控时自动回退 Bing site: 通道（域名过滤保证结果来自小红书）。"""
    bin_path = os.path.join(BASE_DIR, ".venv", "bin", "xhs")
    if not os.path.exists(bin_path):
        import shutil
        bin_path = shutil.which("xhs")
    if not bin_path or not os.path.exists(bin_path):
        return _xhs_bing_fallback(q, n, reason="xhs-cli 未安装")
    try:
        r = subprocess.run([bin_path, "search", q, "--sort", "popular", "--json"],
                           capture_output=True, text=True, timeout=45)
    except FileNotFoundError:
        return _xhs_bing_fallback(q, n, reason="xhs-cli 不可执行")
    except subprocess.TimeoutExpired:
        return _xhs_bing_fallback(q, n, reason="xhs-cli 超时")
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        return _xhs_bing_fallback(q, n, reason="输出非 JSON（可能未登录）")
    if not d.get("ok"):
        return _xhs_bing_fallback(q, n, reason=str(d.get("error", {}).get("message", ""))[:60])
    results = []
    for it in d.get("data", {}).get("items") or []:
        nc = it.get("note_card", {})
        title = nc.get("display_title") or ""
        if not title:
            continue
        user = nc.get("user", {})
        info = nc.get("interact_info", {})
        author = user.get("nickname", "")
        likes = info.get("liked_count", "")
        comments = info.get("comment_count", "")
        note_id = it.get("id", "")
        url = f"https://www.xiaohongshu.com/explore/{note_id}" if note_id else ""
        snippet = f"作者:{author} 点赞:{likes} 评论:{comments}"
        results.append({"title": title, "url": url, "snippet": snippet, "author": author})
        if len(results) >= n:
            break
    if not results:
        return _xhs_bing_fallback(q, n, reason="站内无结果")
    return results


def _xhs_fallback(q, n, reason=""):
    """小红书兜底通道：Tavily 域名过滤（真实小红书链接）。
    Bing site: 回退已随 web 源一并停用。"""
    try:
        results = tavily_search("小红书 " + q, n=n, include_domains=["xiaohongshu.com"])
    except Exception:
        results = []
    for r in results:
        r["via"] = "fallback"
        if reason:
            r["snippet"] = (f"[站内通道降级: {reason}] " + r.get("snippet", ""))[:300]
    return results


def _xhs_bing_fallback(q, n, reason=""):
    return _xhs_fallback(q, n, reason)


def github_search(q, n=DEFAULT_MAX):
    """GitHub 仓库搜索：免 key 官方 API（未认证限 10 req/min）。"""
    url = ("https://api.github.com/search/repositories?q=" + urllib.parse.quote(q)
           + "&sort=stars&order=desc&per_page=" + str(n))
    page = http_get(url).decode("utf-8", "ignore")
    d = json.loads(page)
    if "items" not in d:
        raise RuntimeError("GitHub API: " + d.get("message", "unknown")[:100])
    results = []
    for it in d["items"]:
        desc = it.get("description") or ""
        lang = it.get("language") or ""
        stars = it.get("stargazers_count", 0)
        snippet = f"{desc[:180]} | {lang} | ★{stars}"
        results.append({"title": it.get("full_name", ""), "url": it.get("html_url", ""), "snippet": snippet})
    return results


# ---------- Bilibili（WBI 签名 + Referer，匿名） ----------
MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
_WBI_KEY_CACHE = {"t": 0, "img": "", "sub": ""}


def _wbi_keys():
    if time.time() - _WBI_KEY_CACHE["t"] < 3600 and _WBI_KEY_CACHE["img"]:
        return _WBI_KEY_CACHE["img"], _WBI_KEY_CACHE["sub"]
    page = http_get("https://api.bilibili.com/x/web-interface/nav").decode("utf-8", "ignore")
    d = json.loads(page)
    img = d["data"]["wbi_img"]["img_url"].rsplit("/", 1)[-1].split(".")[0]
    sub = d["data"]["wbi_img"]["sub_url"].rsplit("/", 1)[-1].split(".")[0]
    _WBI_KEY_CACHE.update(t=time.time(), img=img, sub=sub)
    return img, sub


def _enc_wbi(params):
    img, sub = _wbi_keys()
    mixin = "".join((img + sub)[i] for i in MIXIN_TAB)[:32]
    p = {k: "".join(c for c in str(v) if c not in "!'()*") for k, v in params.items() if v is not None}
    p["wts"] = int(time.time())
    p = dict(sorted(p.items()))
    query = urllib.parse.urlencode(p)
    p["w_rid"] = hashlib.md5((query + mixin).encode()).hexdigest()
    return p


def bilibili_search(q, n=DEFAULT_MAX, transcribe=False):
    params = _enc_wbi({
        "search_type": "video", "keyword": q, "page": 1,
        "page_size": n, "platform": "pc",
    })
    url = "https://api.bilibili.com/x/web-interface/search/type?" + urllib.parse.urlencode(params)
    page = None
    for attempt in range(3):
        try:
            page = http_get(url, headers={"Referer": "https://search.bilibili.com/"}).decode("utf-8", "ignore")
            break
        except urllib.error.HTTPError as e:
            if e.code == 412 and attempt < 2:
                time.sleep(8)
                continue
            raise
    assert page is not None
    d = json.loads(page)
    if d.get("code") != 0:
        raise RuntimeError(f"B站 API code={d.get('code')} msg={d.get('message')}")
    results = []
    for it in (d.get("data") or {}).get("result") or []:
        if "arcurl" not in it:
            continue
        results.append({
            "title": strip_html(it.get("title", "")),
            "url": it.get("arcurl", ""),
            "snippet": strip_html(it.get("description", ""))[:300],
            "author": it.get("author", ""),
            "date": time.strftime("%Y-%m-%d", time.localtime(it.get("pubdate", 0))) if it.get("pubdate") else "",
        })
        if len(results) >= n:
            break
    # 视频转文字（yt-dlp AI 字幕/弹幕，开源方案）
    if transcribe and results:
        sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))
        try:
            from bilibili_transcribe import get_transcript
            from llm_summarize import summarize
            for r in results[:3]:  # 只转写 top 3，控制耗时
                try:
                    t = get_transcript(r["url"])
                    if t["subtitle"]:
                        r["transcript"] = t["subtitle"][:600]
                        summary = summarize(t["subtitle"])
                        if summary:
                            r["summary"] = summary
                    elif t["danmaku"]:
                        r["danmaku_sample"] = t["danmaku"][:15]
                except Exception:
                    continue
        except ImportError:
            pass
    return results


# ---------- 分派 ----------
def search_platform(name, q, n=DEFAULT_MAX, transcribe=False):
    if name == "bilibili":
        return bilibili_search(q, n, transcribe=transcribe)
    if name == "reddit":
        return reddit_search(q, n)
    if name == "github":
        return github_search(q, n)
    if name == "tavily":
        return tavily_search(q, n)
    if name == "telegram":
        return telegram_search(q, n)
    if name == "web":
        return bing_search(q, n)
    if name == "xhs":
        return xhs_search(q, n)


# ---------- 输出 ----------
def render_markdown(query, platforms_out):
    lines = [f"# 搜索「{query}」— 聚合结果\n"]
    for p in platforms_out:
        label = PLATFORMS[p["platform"]]["label"]
        if not p["ok"]:
            lines.append(f"## {label} — 失败: {p.get('error', '')[:150]}\n")
            continue
        rs = p["results"]
        if not rs:
            lines.append(f"## {label} — 无结果\n")
            continue
        lines.append(f"## {label} ({len(rs)} 条)")
        for i, r in enumerate(rs, 1):
            meta = " · ".join(x for x in [r.get("author"), r.get("date")] if x)
            tail = f" — {meta}" if meta else ""
            lines.append(f"{i}. [{r['title']}]({r['url']}){tail}")
            if r.get("summary"):
                lines.append(f"   > 📝 摘要: {r['summary'][:200]}")
            if r.get("transcript"):
                lines.append(f"   > 🎬 字幕: {r['transcript'][:180]}…")
            if r.get("danmaku_sample"):
                lines.append(f"   > 💬 弹幕: {' / '.join(r['danmaku_sample'][:8])}")
            if r.get("snippet"):
                lines.append(f"   {r['snippet'][:120]}")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="聚合搜索（免登录优先）")
    ap.add_argument("query", nargs="?", help="搜索关键词")
    ap.add_argument("--platform", default="all", help="逗号分隔平台别名；all 或 all,-xhs 排除")
    ap.add_argument("--max", type=int, default=DEFAULT_MAX, help="每平台最大结果数")
    ap.add_argument("--workers", type=int, default=3, help="并发数")
    ap.add_argument("--interval", type=float, default=0.6, help="每平台请求间隔秒")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--transcribe", action="store_true",
                    help="B站视频转文字（yt-dlp AI 字幕/弹幕，前3条结果）")
    ap.add_argument("--list", action="store_true", help="列出平台")
    args = ap.parse_args()

    if args.list or not args.query:
        for k, v in PLATFORMS.items():
            print(f"{k:9s} {v['label']}")
        if not args.query:
            print("\n用法: search.py \"关键词\" [--platform bilibili,reddit,github] [--json]")
        return

    raw = [x.strip() for x in args.platform.split(",") if x.strip()]
    names = list(PLATFORMS)
    if raw and raw != ["all"]:
        if raw[0] == "all":
            names = [x for x in names if x not in [r[1:] for r in raw[1:] if r.startswith("-")]]
        else:
            names = [x for x in raw if x in PLATFORMS]
            unknown = [x for x in raw if x not in PLATFORMS]
            if unknown:
                print(f"未知平台: {unknown}", file=sys.stderr)
    names = [x for x in ORDER if x in names] + [x for x in names if x not in ORDER]

    def run(name):
        time.sleep(args.interval)
        try:
            return {"platform": name, "ok": True,
                    "results": search_platform(name, args.query, args.max, transcribe=args.transcribe),
                    "error": None}
        except Exception as e:
            return {"platform": name, "ok": False, "results": [], "error": str(e)}

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        outs = list(ex.map(run, names))

    if args.json:
        print(json.dumps({"query": args.query, "platforms": outs}, ensure_ascii=False, indent=1))
    else:
        print(render_markdown(args.query, outs))


if __name__ == "__main__":
    main()
