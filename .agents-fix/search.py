#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""聚合搜索引擎 — 免登录优先，广度优先。零第三方依赖（纯标准库）。

通道：
  - bilibili : 官方搜索 API + WBI 签名（匿名，需 Referer: search.bilibili.com）
  - web      : Bing RSS 直接爬取
  - 封闭平台  : Bing RSS site: 通道 + 强制域名过滤
               （xhs/threads/x/weibo/douyin/zhihu）

用法：
  search.py "关键词"                        # 全部平台
  search.py "关键词" --platform bilibili,xhs
  search.py "关键词" --platform all,-xhs
  search.py "关键词" --platform web --json
  search.py --list
"""
import argparse
import hashlib
import os
import subprocess
import html
import json
import re
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

# domain: 该平台的结果域名白名单（site: 通道强制过滤，保证结果真实来自目标站）
PLATFORMS = {
    "bilibili": {"label": "B站"},
    "web":      {"label": "开放网页"},
    "xhs":      {"label": "小红书"},
    "github":   {"label": "GitHub"},
    "tavily":   {"label": "Tavily"},
    "telegram": {"label": "Telegram"},
}
ORDER = ["bilibili", "xhs", "github", "tavily", "telegram", "web"]


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


# ---------- Bing RSS（真实链接，无 ck/a 混淆） ----------
def bing_search(q, n=DEFAULT_MAX, site=None, domains=None):
    query = (site + " " + q) if site else q
    url = ("https://www.bing.com/search?q=" + urllib.parse.quote(query)
           + "&format=rss&setlang=zh-hans&count=" + str(n))
    page = http_get(url).decode("utf-8", "ignore")
    results = []
    for item in re.findall(r"<item>([\s\S]*?)</item>", page):
        tm = re.search(r"<title>([\s\S]*?)</title>", item)
        lm = re.search(r"<link>([\s\S]*?)</link>", item)
        dm = re.search(r"<description>([\s\S]*?)</description>", item)
        if not tm or not lm:
            continue
        title = html.unescape(tm.group(1)).strip()
        url = html.unescape(lm.group(1)).strip()
        if not title or not url:
            continue
        # 强制域名过滤：site: 通道只保留目标站结果
        if domains and not any(d in url for d in domains):
            continue
        snippet = strip_html(dm.group(1)) if dm else ""
        results.append({"title": title, "url": url, "snippet": snippet[:300]})
        if len(results) >= n:
            break
    return results


def telegram_search(q, n=DEFAULT_MAX):
    """Telegram 全局搜索：Telethon SearchGlobal（登录态在 scout session 或 state/telegram.session）。
    需要环境变量 SCOUT_API_ID/SCOUT_API_HASH。失败自动回退 Bing site: 通道。"""
    # 修复版（2026-08-25）：根分区只读，session 迁到可写工作区
    script = os.path.expanduser("/home/lenovo/Desktop/image-app/.agents-fix/telegram_search.py")
    venv = os.path.expanduser("/home/lenovo/.agents/skills/aggregate-search/.venv/bin/python")
    r = subprocess.run([venv, script, q, "--limit", str(n)],
                       capture_output=True, text=True, timeout=45)
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("telegram_search.py 输出异常：" + (r.stdout or r.stderr)[:120])
    if not d.get("ok"):
        raise RuntimeError(str(d.get("error", "telegram 失败"))[:120])
    return d["results"]


def tavily_search(q, n=DEFAULT_MAX):
    """Tavily AI 搜索：直接调 REST API（key 读环境变量或本机记忆 note）。"""
    key = os.environ.get("TAVILY_API_KEY", "")
    if not key:
        mnote = os.path.expanduser("~/.codex/memories/extensions/ad_hoc/notes/tavily-api-key.md")
        if os.path.exists(mnote):
            m = re.search(r"tvly-[A-Za-z0-9_-]+", open(mnote, encoding="utf-8").read())
            if m:
                key = m.group(0)
    if not key:
        raise RuntimeError("TAVILY_API_KEY 未配置")
    body = json.dumps({"api_key": key, "query": q, "max_results": n,
                       "search_depth": "basic"}).encode()
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
    """小红书真实搜索：xhs-cli（登录态 cookie 在 ~/.xiaohongshu-cli/cookies.json）。
    需要文件写权限（xhs 会写搜索会话缓存）；失败自动回退 Bing site: 通道。"""
    bin_path = os.path.expanduser("~/.agents/skills/aggregate-search/.venv/bin/xhs")
    if not os.path.exists(bin_path):
        raise RuntimeError("xhs-cli 未安装（venv 缺失），请运行 auth.py 引导")
    try:
        r = subprocess.run([bin_path, "search", q, "--sort", "popular", "--json"],
                           capture_output=True, text=True, timeout=45)
    except FileNotFoundError:
        raise RuntimeError("xhs-cli 不可执行")
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("xhs-cli 输出非 JSON（可能未登录）：" + (r.stdout or r.stderr)[:120])
    if not d.get("ok"):
        raise RuntimeError("xhs-cli 失败: " + str(d.get("error", {}).get("message", ""))[:120])
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
    return results


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


def bilibili_search(q, n=DEFAULT_MAX):
    params = _enc_wbi({
        "search_type": "video", "keyword": q, "page": 1,
        "page_size": n, "platform": "pc",
    })
    url = "https://api.bilibili.com/x/web-interface/search/type?" + urllib.parse.urlencode(params)
    # Referer 必须：search.bilibili.com，否则 412（已实测）
    # 412 多为短时频率风控：等待 8s 重试，最多 2 次
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
    return results


# ---------- 分派 ----------
def search_platform(name, q, n=DEFAULT_MAX):
    if name == "bilibili":
        return bilibili_search(q, n)
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
            lines.append(f"## {label} — 无结果（该站内容未被搜索引擎收录，可用 auth.py 引导登录深搜）\n")
            continue
        lines.append(f"## {label} ({len(rs)} 条)")
        for i, r in enumerate(rs, 1):
            meta = " · ".join(x for x in [r.get("author"), r.get("date")] if x)
            tail = f" — {meta}" if meta else ""
            lines.append(f"{i}. [{r['title']}]({r['url']}){tail}")
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
    ap.add_argument("--list", action="store_true", help="列出平台")
    args = ap.parse_args()

    if args.list or not args.query:
        for k, v in PLATFORMS.items():
            print(f"{k:9s} {v['label']}")
        if not args.query:
            print("\n用法: search.py \"关键词\" [--platform bilibili,xhs] [--json]")
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
            return {"platform": name, "ok": True, "results": search_platform(name, args.query, args.max), "error": None}
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

