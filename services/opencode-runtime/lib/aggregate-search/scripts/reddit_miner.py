#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Reddit 知识挖掘器（基于 arctic-shift 公开历史存档 API，免 key、免爬虫风控）。

支持功能：
  - 关键词/板块检索
  - 句式滤镜（问题 / 作品展示 / 痛点吐槽）
  - 意图分类与态度极性分析
  - 评论高频短语与趋势挖掘
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

API = "https://arctic-shift.photon-reddit.com/api"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) aggregate-search/1.0"}
DEFAULT_SUBREDDITS = ["StableDiffusion", "OpenAI", "ChatGPT", "aiwars"]

QUESTION_RE = re.compile(
    r"\b(how (do|can|to)|where (can|do|is)|is there (a|any)|any way|what('s| is) the best|"
    r"can i|could i|should i|does (anyone|anybody)|does .* work|why (does|can't|cant)|"
    r"which (is|are)|recommend|suggest|alternative|vs\.?|worth it|any (good|free)|"
    r"what (is|are) the|has anyone|is it (possible|worth|safe|legal|free)|"
    r"am i (the only|wrong)|help (me|with)|question about)\b", re.IGNORECASE)

SHOWCASE_RE = re.compile(
    r"\b(i (just )?(made|built|created|finished|released|launched|published|trained)|"
    r"check out|look (what|at)|finally (finished|got|made)|my (first|latest|new)|"
    r"here'?s (my|a)|open[- ]source|showcase|demo|milestone|achievement|"
    r"i'm (sharing|excited)|i wrote|i made a|i built a)\b", re.IGNORECASE)

PROBLEM_RE = re.compile(
    r"\b(can'?t|cannot|won'?t|broken|not working|doesn'?t work|isn'?t working|"
    r"error|failed|failure|stuck|frustrat|disappoint|hate |awful|terrible|waste of|"
    r"refund|banned|blocked|crash|bug|issue with|problem with|why (won'?t|doesn'?t|can'?t))\b",
    re.IGNORECASE)

GENERIC_INTENTS = [
    ("free_cost",     ["free", "cheap", "no cost", "pricing", "price", "cost", "worth it", "subscription", "paid", "refund"],                       "价格/免费"),
    ("alternative",   ["alternative", "instead of", "better than", "replace", "vs ", "similar to", "like .* but", "switch from", "migrate"],       "替代/对比"),
    ("recommend",     ["recommend", "suggest", "best", "top ", "favorite", "which should", "what should i", "pick"],                               "推荐/选择"),
    ("beginner",      ["beginner", "newbie", "getting started", "first time", "start with", "tutorial", "guide", "learn", "noob", "explain"],     "入门/教程"),
    ("troubleshoot",  ["error", "issue", "problem", "broken", "not working", "failed", "bug", "fix ", "help", "crash", "doesn't work", "issue with"], "问题排查"),
    ("api_dev",       ["api", "sdk", "code", "develop", "integrat", "endpoint", "script", "python", "javascript", "function", "framework"],       "开发/API"),
    ("install",       ["install", "download", "setup", "configure", "requirement", "dependency", "compatib"],                                     "安装配置"),
    ("legal",         ["license", "commercial", "copyright", "legal", "terms", "rights", "sell", "fair use", "tos", "patent", "trademark"],        "授权/法律"),
    ("quality",       ["quality", "output", "result", "resolution", "fidelity", "accurate", "detail", "realistic", "looks"],                       "质量效果"),
    ("safety",        ["security", "privacy", "safe", "malware", "scam", "trust", "legit", "reliable", "vpn", "data"],                            "安全/信任"),
    ("language",      ["chinese", "中文", "english", "language", "translate", "japanese", "korean", "multilingual", "localiz"],                    "多语言"),
    ("web_online",    ["online", "web ", "browser", "no install", "cloud", "website", "hosted", "saas"],                                          "在线/网页"),
    ("mobile",        ["app ", "android", "ios", "iphone", "mobile", "tablet"],                                                                   "移动端"),
    ("future_trend",  ["future", "trend", "2026", "roadmap", "next", "upcoming", "newest", "latest", "news"],                                     "趋势/未来"),
]

ATTITUDES = [
    ("praise",   ["love", "amazing", "awesome", "incredible", "finally", "game changer", "best ever",
                  "impressed", "works perfectly", "excellent", "brilliant", "perfect", "great experience",
                  "huge improvement", "very happy"],                                          "赞赏"),
    ("complain", ["hate", "awful", "terrible", "waste", "disappointed", "frustrated", "frustrating",
                  "broken", "useless", "sucks", "refund", "regret", "worst", "disaster",
                  "nightmare", "not worth"],                                                  "吐槽"),
    ("warning",  ["scam", "beware", "avoid", "don't buy", "red flag", "stay away", "caution",
                  "dangerous", "rip-off", "fake", "fraud", "trap", "not worth it", "do not"], "警示"),
    ("asking",   ["anyone", "help", "how do", "can i", "share your", "experience", "recommend",
                  "suggest", "is there", "what's the best", "advice", "tips", "question about",
                  "any way", "worth it"],                                                    "求助"),
]

STOPWORDS = set("""
the a an and or but of to in on for with at by from as is are was were be been it its this that
these those i you he she we they me him her us them my your our their not no do does did have has
had will would can could should may might about into over under more most some any all each what
when where why how who which there here just very really so up out off like get got one two new
""".split())


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get(url, retries=4, backoff=5):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 422):
                time.sleep(backoff)
                continue
            return {"error": f"HTTP{e.code}"}
        except Exception as e:
            if attempt == retries - 1:
                return {"error": str(e)[:100]}
            time.sleep(3)
    return {"error": "exhausted"}


def _reject_chinese_query(query, ctx="Reddit 挖掘"):
    if re.search(r"[\u4e00-\u9fff\u3400-\u4dbf]", query or ""):
        raise SystemExit(
            f"语言纪律：{ctx} 是英文平台，中文关键词搜不到内容。"
            f"请先把「{query}」翻译成英文（例如「猫粮推荐」→ cat food recommendation）再运行")


def quick_search(query, n=8, subreddit=None, days=180):
    """快速聚合检索接口，直接供 search.py 调用。
    arctic-shift 的 title 检索必须搭配 subreddit/author，
    无指定板块时轮询候选板块（每板块限流重试）。
    """
    _reject_chinese_query(query)
    now = datetime.now(timezone.utc)
    before_ts = int(now.timestamp())
    after_ts = int((now - timedelta(days=days)).timestamp())

    # 候选板块：大流量泛技术板块 + 关键词中显式出现的板块名
    query_lower = query.lower()
    candidates = []
    for sr in ["StableDiffusion", "OpenAI", "ChatGPT", "LocalLLaMA",
               "artificial", "technology", "singularity", "MachineLearning"]:
        if sr.lower() in query_lower:
            candidates = [sr]
            break
    if not candidates:
        candidates = ["StableDiffusion", "OpenAI", "ChatGPT", "LocalLLaMA",
                      "artificial", "technology", "singularity"]

    # 单板块模式
    if subreddit:
        candidates = [subreddit]

    kws = [k for k in query_lower.split() if len(k) > 2]
    results = []
    seen_ids = set()
    for sr in candidates:
        if len(results) >= n:
            break
        # title 关键词用首个强词（短语全 encode 常触发后端超时）
        strong_kw = next((k for k in kws if k not in ("the", "and", "for", "how", "what")), query)
        url = (f"{API}/posts/search?subreddit={sr}&title="
               + urllib.parse.quote(strong_kw)
               + f"&after={after_ts}&before={before_ts}&limit=100&sort=desc")
        d = get(url, retries=2, backoff=15)
        if d.get("error") or not d.get("data"):
            continue
        for p in d["data"]:
            pid = p.get("id")
            if pid in seen_ids:
                continue
            title = (p.get("title") or "").lower()
            selftext = (p.get("selftext") or "").lower()
            # 本地 AND 过滤确保整词命中
            if kws and not all(k in title + " " + selftext for k in kws):
                continue
            seen_ids.add(pid)
            score = p.get("score", 0)
            ncom = p.get("num_comments", 0)
            permalink = p.get("permalink", "")
            author = p.get("author", "")
            ts = p.get("created_utc")
            try:
                date = datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
            except Exception:
                date = ""
            results.append({
                "title": (p.get("title") or "")[:120],
                "url": f"https://reddit.com{permalink}" if permalink else "",
                "snippet": f"{score}分 {ncom}评 | " + (p.get("selftext") or "")[:180],
                "author": f"r/{sr} @{author}" if author else f"r/{sr}",
                "date": date,
            })
        # 按 score 排序（跨板块归并）
        results.sort(key=lambda x: x["snippet"] and 0 or 0, reverse=True)
        time.sleep(1.2)

    # 取分数信息重新精确排序：snippet 中含分数，粗排即可
    import re as _re
    def _score(r):
        m = _re.match(r"(\d+)分", r.get("snippet", ""))
        return int(m.group(1)) if m else 0
    results.sort(key=_score, reverse=True)
    return results[:n]


def fetch_window(subreddit, after_ts, before_ts, max_pages=6):
    posts = []
    cursor = after_ts
    for _ in range(max_pages):
        url = (f"{API}/posts/search?subreddit={subreddit}&after={cursor}"
               f"&before={before_ts}&limit=100&sort=asc")
        d = get(url)
        if d.get("error") or not d.get("data"):
            if d.get("error"):
                log(f"  ! r/{subreddit} 拉取失败: {d['error']}")
            break
        batch = d["data"]
        posts.extend(batch)
        if len(batch) < 100:
            break
        cursor = batch[-1]["created_utc"] + 1
        time.sleep(1.0)
    return posts


def fetch_comments(post_ids, limit_per_post=20):
    out = []
    for pid in post_ids:
        url = (f"{API}/comments/search?link_id=t3_{pid}&limit={limit_per_post}&sort=desc")
        d = get(url)
        if d.get("data"):
            out.extend(d["data"])
        time.sleep(1.0)
    return out


def classify(text):
    t = text.lower()
    intents = []
    for key, kws, label in GENERIC_INTENTS:
        if any(re.search(kw, t) for kw in kws):
            intents.append({"key": key, "label": label})
    return intents


def classify_attitude(text):
    t = text.lower()
    atts = []
    for key, kws, label in ATTITUDES:
        if any(re.search(kw, t) for kw in kws):
            atts.append({"key": key, "label": label})
    return atts


def apply_filter(title, selftext, filter_name):
    if filter_name in (None, "", "none"):
        return True
    regex = {"question": QUESTION_RE, "showcase": SHOWCASE_RE, "problem": PROBLEM_RE}.get(filter_name)
    if regex is None:
        return True
    return bool(regex.search(title + " " + selftext[:200]))


def parse_date(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return ""


def build_trends(posts, after_ts, before_ts, buckets=12, bucket_days=30):
    if not posts or before_ts <= after_ts:
        return None
    span = before_ts - after_ts
    if bucket_days and bucket_days <= span / 86400 / 2:
        n = max(2, int(span / (bucket_days * 86400)) + 1)
    else:
        n = max(2, buckets)
    size = span / n
    bins = []
    for i in range(n):
        lo = after_ts + i * size
        hi = lo + size
        bp = [p for p in posts if lo <= p["_ts"] < hi]
        nq = sum(1 for x in bp if x["_filtered_by"] == "question") if bp else 0
        bins.append({
            "bucket": i + 1,
            "start": parse_date(lo),
            "end": parse_date(hi),
            "posts": len(bp),
            "avg_score": round(sum(x["score"] for x in bp) / len(bp), 1) if bp else 0,
            "question_share": round(100.0 * nq / len(bp), 1) if bp else 0,
        })
    half = n // 2
    first_avg = sum(b["posts"] for b in bins[:half]) / half if half else 0
    last_avg = sum(b["posts"] for b in bins[half:]) / (n - half) if (n - half) else 0
    if last_avg >= first_avg * 1.2 and first_avg > 0:
        direction = "rising"
    elif first_avg > 0 and last_avg <= first_avg * 0.8:
        direction = "falling"
    else:
        direction = "flat"
    return {
        "direction": direction,
        "first_half_avg_per_bucket": round(first_avg, 1),
        "last_half_avg_per_bucket": round(last_avg, 1),
        "buckets": bins,
    }


def extract_patterns(comment_bodies, top_n=20, min_freq=2, max_words=3):
    url_pattern = re.compile(r'https?://|www\.|\.com|\.io|\.org|\.net|\.ai|\.me|\.dev')
    noise_words = {'https', 'http', 'www', 'com', 'io', 'org', 'net', 'ai', 'me', 'dev',
                   'github', 'gitlab', 'reddit', 'imgur', 'youtube', 'youtu',
                   'google', 'twitter', 'discord', 'telegram', 'xcom', 'tco'}
    counter = Counter()
    for body in comment_bodies:
        words = re.findall(r"[a-z0-9']+", body.lower())
        for n in range(2, max_words + 1):
            for i in range(len(words) - n + 1):
                gram = words[i:i + n]
                if gram[0] in STOPWORDS or gram[-1] in STOPWORDS or gram[-1].endswith("'s"):
                    continue
                if all(w in STOPWORDS for w in gram):
                    continue
                if all(w.isdigit() for w in gram):
                    continue
                phrase = " ".join(gram)
                if any(w in noise_words for w in gram):
                    continue
                if url_pattern.search(phrase):
                    continue
                counter[phrase] += 1
    ranked = [{"phrase": k, "count": v} for k, v in counter.most_common()]
    return [r for r in ranked if r["count"] >= min_freq][:top_n]


def render_md(result, comments, patterns):
    lines = []
    m = result["meta"]
    lines.append(f"# Reddit 挖掘报告（filter={m['filter']} | type={m['post_type']} | {m['days']}天 | {','.join(m['subreddits'])}）\n")
    lines.append(f"- 抓取时间: {m['fetched_at']}")
    lines.append(f"- 命中帖子: {len(result['posts'])} 条")
    if comments:
        lines.append(f"- 抓取评论: {len(comments)} 条")
    if result.get("trends"):
        t = result["trends"]
        lines.append(f"- 趋势方向: **{t['direction']}**（前半均 {t['first_half_avg_per_bucket']}/桶 → 后半均 {t['last_half_avg_per_bucket']}/桶）")
    lines.append("")

    if result.get("attitude_stats"):
        lines.append("## 态度分布\n")
        for k, s in sorted(result["attitude_stats"].items(), key=lambda x: -x[1]["count"]):
            lines.append(f"- **{s['label']}** ({k}): {s['count']} 条")
            for ttl in s["samples"][:3]:
                lines.append(f"  - {ttl}")
        lines.append("")

    lines.append("## 意图分布\n")
    for k, s in sorted(result["intent_stats"].items(), key=lambda x: -x[1]["count"]):
        lines.append(f"- **{s['label']}** ({k}): {s['count']} 条")
    lines.append("")

    if result.get("matrix"):
        lines.append("## 意图 × 态度交叉表\n")
        lines.append("| 意图 | 赞赏 | 吐槽 | 警示 | 求助 |")
        lines.append("|------|------|------|------|------|")
        for k, row in sorted(result["matrix"].items(), key=lambda x: -sum(x[1].values())):
            lines.append(f"| {k} | {row.get('praise',0)} | {row.get('complain',0)} | {row.get('warning',0)} | {row.get('asking',0)} |")
        lines.append("")

    if result.get("trends"):
        lines.append("## 时间趋势（分桶）\n")
        lines.append("| 桶 | 区间 | 帖数 | 均分 | 问题占比 |")
        lines.append("|----|------|------|------|----------|")
        for b in result["trends"]["buckets"]:
            lines.append(f"| {b['bucket']} | {b['start']}~{b['end']} | {b['posts']} | {b['avg_score']} | {b['question_share']}% |")
        lines.append("")

    lines.append("## 帖子列表\n")
    for i, p in enumerate(result["posts"], 1):
        ints = " / ".join(it["label"] for it in p["intents"]) or "-"
        atts = " / ".join(a["label"] for a in p.get("attitudes", [])) or "-"
        lines.append(f"### {i}. {p['title']}")
        lines.append(f"- r/{p['subreddit']} | {p['score']}分 | {p['num_comments']}评 | {p['date']} | {p.get('post_type','?')}")
        lines.append(f"- 意图: {ints} | 态度: {atts} | 链接: {p['url']}")
        if p.get("flair"):
            lines.append(f"- flair: {p['flair']}")
        if p["selftext_excerpt"]:
            lines.append(f"- 摘要: {p['selftext_excerpt']}")
        lines.append("")

    if patterns:
        lines.append("## 评论区高频短语（用户原话）\n")
        for r in patterns:
            lines.append(f"- ({r['count']}次) {r['phrase']}")
        lines.append("")

    if comments:
        lines.append("## 评论区亮点\n")
        for c in sorted(comments, key=lambda x: -(x.get("score") or 0))[:30]:
            lines.append(f"- [{c['score']}分] r/{c['subreddit']} @{c['author']}: {c['body'][:150]}")
    return "\n".join(lines)


def build_parser():
    p = argparse.ArgumentParser(description="Reddit 知识挖掘器（基于 arctic-shift 公开历史存档，免 key）",
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--subreddits", default=",".join(DEFAULT_SUBREDDITS),
                   help=f"目标板块，逗号分隔（默认: {','.join(DEFAULT_SUBREDDITS)}）")
    p.add_argument("--mode", choices=["question", "discussion", "all"], default="question",
                   help="挖掘模式: question=问题型标题(默认) discussion=高分讨论 all=全部")
    p.add_argument("--filter", choices=["question", "showcase", "problem", "none", "auto"], default="auto",
                   help="句式滤镜: question=问题 showcase=作品展示 problem=痛点吐槽 none=不过滤 auto=跟随--mode(默认)")
    p.add_argument("--type", dest="post_type", choices=["self", "link", "all"], default="all",
                   help="帖子类型: self=纯文字帖 link=外链帖 all=全部(默认)")
    p.add_argument("--flair", default="", help="按 flair 子串过滤（不区分大小写）")
    p.add_argument("--days", type=int, default=180, help="时间窗（天），默认 180")
    p.add_argument("--query", default="", help="关键词过滤（匹配 title+selftext，空格分隔为 AND）")
    p.add_argument("--title", default="", help="仅标题关键词过滤（空格分隔为 AND）")
    p.add_argument("--exclude", default="", help="排除关键词（空格分隔任一命中即排除）")
    p.add_argument("--min-score", type=int, default=3, help="最小分数，默认 3")
    p.add_argument("--min-comments", type=int, default=0, help="最少评论数，默认 0")
    p.add_argument("--sort", choices=["score", "date"], default="score", help="排序方式，默认按分数")
    p.add_argument("--top", type=int, default=50, help="输出条数，默认 50（0=全部）")
    p.add_argument("--with-comments", action="store_true", help="对 top 帖子拉取评论区")
    p.add_argument("--comments-limit", type=int, default=20, help="每帖最多评论数，默认 20")
    p.add_argument("--max-pages", type=int, default=6, help="每个板块最多分页数（每页100条），默认 6")
    p.add_argument("--trend-buckets", type=int, default=12, help="时间趋势分桶数，默认 12（0=关闭）")
    p.add_argument("--trend-bucket-days", type=int, default=30, help="按每桶天数分桶，默认 30")
    p.add_argument("--extract-patterns", type=int, default=0, help="提取评论高频短语条数（需 --with-comments）")
    p.add_argument("--format", choices=["json", "md"], default="json", help="输出格式")
    p.add_argument("--out", default="", help="输出文件路径")
    return p


def main():
    args = build_parser().parse_args()
    _reject_chinese_query(args.query, "reddit_miner --query")
    _reject_chinese_query(args.title, "reddit_miner --title")
    subreddits = [s.strip() for s in args.subreddits.split(",") if s.strip()]
    now = datetime.now(timezone.utc)
    before = int(now.timestamp())
    after = int((now - timedelta(days=args.days)).timestamp())

    filter_name = args.filter if args.filter != "auto" else ("question" if args.mode == "question" else "none")

    query_kws = [k.lower() for k in args.query.split() if k.strip()]
    title_kws = [k.lower() for k in args.title.split() if k.strip()]
    excl_kws = [k.lower() for k in args.exclude.split() if k.strip()]
    flair_kw = args.flair.lower()

    log(f"filter={filter_name} | type={args.post_type} | flair={args.flair or '-'} | 板块={subreddits} | 时间窗={args.days}天")
    all_posts = []
    for sr in subreddits:
        posts = fetch_window(sr, after, before, max_pages=args.max_pages)
        for p in posts:
            title = (p.get("title") or "").strip()
            selftext = (p.get("selftext") or "")[:400]
            haystack = (title + " " + selftext).lower()
            score = p.get("score", 0)
            ncom = p.get("num_comments", 0)
            is_self = p.get("is_self", True) if "is_self" in p else bool(p.get("selftext"))
            flair = p.get("link_flair_text") or p.get("flair") or ""
            post_type = "self" if is_self else "link"

            if score < args.min_score or ncom < args.min_comments:
                continue
            if query_kws and not all(k in haystack for k in query_kws):
                continue
            if title_kws and not all(k in title.lower() for k in title_kws):
                continue
            if excl_kws and any(k in haystack for k in excl_kws):
                continue
            if args.post_type != "all" and post_type != args.post_type:
                continue
            if flair_kw and flair_kw not in flair.lower():
                continue
            if not apply_filter(title, selftext, filter_name):
                continue

            all_posts.append({
                "_ts": int(p.get("created_utc", 0)),
                "_filtered_by": filter_name,
                "subreddit": sr,
                "id": p.get("id"),
                "title": title[:300],
                "score": score,
                "num_comments": ncom,
                "date": parse_date(p.get("created_utc")),
                "url": f"https://reddit.com{p.get('permalink','')}" if p.get("permalink") else "",
                "selftext_excerpt": selftext[:200],
                "post_type": post_type,
                "flair": flair[:60] or None,
                "intents": classify(title + " " + selftext),
                "attitudes": classify_attitude(title + " " + selftext),
            })
        log(f"  ✓ r/{sr}: 拉取完成，命中 {sum(1 for x in all_posts if x['subreddit']==sr)} 条")
        time.sleep(1.0)

    trends = None
    if args.trend_buckets > 0:
        trends = build_trends(all_posts, after, before,
                              buckets=args.trend_buckets, bucket_days=args.trend_bucket_days)

    if args.sort == "score":
        all_posts.sort(key=lambda x: (x["score"], x["num_comments"]), reverse=True)
    else:
        all_posts.sort(key=lambda x: x["date"], reverse=True)
    if args.top > 0:
        all_posts = all_posts[:args.top]

    intent_stats = {}
    attitude_stats = {}
    matrix = {}
    for p in all_posts:
        for it in p["intents"]:
            k = it["key"]
            intent_stats.setdefault(k, {"count": 0, "label": it["label"], "samples": []})
            intent_stats[k]["count"] += 1
            if len(intent_stats[k]["samples"]) < 5:
                intent_stats[k]["samples"].append(p["title"])
        for at in p.get("attitudes", []):
            k = at["key"]
            attitude_stats.setdefault(k, {"count": 0, "label": at["label"], "samples": []})
            attitude_stats[k]["count"] += 1
            if len(attitude_stats[k]["samples"]) < 5:
                attitude_stats[k]["samples"].append(p["title"])
        att_keys = [a["key"] for a in p.get("attitudes", [])]
        for it in p["intents"]:
            row = matrix.setdefault(it["label"], {"praise": 0, "complain": 0, "warning": 0, "asking": 0})
            for ak in att_keys:
                if ak in row:
                    row[ak] += 1

    comments = []
    if args.with_comments and all_posts:
        log(f"拉取 {len(all_posts)} 帖的评论区（每帖 {args.comments_limit} 条）...")
        comments = fetch_comments([p["id"] for p in all_posts], args.comments_limit)
        log(f"  共 {len(comments)} 条评论")
        comments = [{
            "post_id": c.get("link_id"),
            "subreddit": c.get("subreddit"),
            "author": c.get("author"),
            "score": c.get("score"),
            "date": parse_date(c.get("created_utc")),
            "body": (c.get("body") or "")[:400],
        } for c in comments if c.get("body")]

    patterns = []
    if args.extract_patterns > 0 and comments:
        log(f"提取评论高频短语（top {args.extract_patterns}）...")
        patterns = extract_patterns([c["body"] for c in comments], top_n=args.extract_patterns)
        log(f"  ✓ 提取 {len(patterns)} 条短语")

    result = {
        "meta": {
            "total_posts": len(all_posts),
            "subreddits": subreddits,
            "mode": args.mode,
            "filter": filter_name,
            "post_type": args.post_type,
            "flair": args.flair or None,
            "days": args.days,
            "query": args.query or None,
            "title": args.title or None,
            "exclude": args.exclude or None,
            "min_score": args.min_score,
            "fetched_at": now.isoformat(),
            "api": API,
        },
        "intent_stats": intent_stats,
        "attitude_stats": attitude_stats,
        "matrix": matrix,
        "trends": trends,
        "patterns": patterns,
        "posts": all_posts,
        "comments": comments,
    }

    out_path = args.out or f"reddit-miner-output.{args.format}"
    if args.format == "md":
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(render_md(result, comments, patterns))
    else:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)

    log(f"\n完成: {len(all_posts)} 条帖子" +
        (f" + {len(comments)} 条评论" if comments else "") +
        (f" | {len(patterns)} 条短语" if patterns else "") +
        (f" | 趋势={trends['direction']}" if trends else "") +
        f" -> {out_path}")


if __name__ == "__main__":
    main()
