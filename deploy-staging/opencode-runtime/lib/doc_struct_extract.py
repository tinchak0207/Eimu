#!/usr/bin/env python3
"""doc_struct_extract.py — 文档结构化原则（open-source PyMuPDF + 纯 python 启发式）。

用法: python3 doc_struct_extract.py '<json>'
json: {"path": "...", "workspace": "...", "max_items": 500}

输出 JSON 到 stdout:
{ok, source_path, text_path, doc_kind, item_count, items:[{level,title,page_start?,txt_line_start,txt_line_end,chars}], reason?}

标题侦测 = 两级通用信号融合：
1. 几何信号（pdf）：行最大字号 ≥1.18× 正文众数字号且行文本 ≤60 字，按字号聚类分 level（最大=1，cap 4）
2. 语义信号（pdf/txt）：单独成行的章题模式（第[零〇一二两三四五六七八九十百千0-9]{1,12}[章回节节卷部幕] 等）短行 → level 1
同一行两信号都命中时取几何 level。目录区去重：同章题 key 取「后随非空正文」的最后一次。
- md: ^#{1,6} 标题；epub: zipfile 读 OPF spine 逐 html 抽 <h1-6> 与文本。
扫描版（零文本）→ ok:false + 用户视角诚实原因。
"""
import sys, os, re, json, glob
from collections import Counter

ARC_RE = re.compile(r"第[零〇一二两两三四五六七八九十百千0-9]{1,12}[章回节节卷部幕]")
CH_DIG = {"零":0,"〇":0,"一":1,"二":2,"两":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9}
NUM_RE = re.compile(r"第([零〇一二两两三四五六七八九十百千0-9]{1,12})[章回节节卷部幕]")

def ch2int(s):
    if s.isdigit():
        return int(s)
    total, cur = 0, 0
    for ch in s:
        if ch in CH_DIG:
            cur = CH_DIG[ch]
        elif ch == "十":
            total += (cur or 1) * 10; cur = 0
        elif ch == "百":
            total += (cur or 1) * 100; cur = 0
        elif ch == "千":
            total += (cur or 1) * 1000; cur = 0
    return total + cur

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))

def resolve_path(path, workspace):
    if os.path.isabs(path):
        return path if os.path.exists(path) else None
    cand = os.path.join(workspace, path)
    if os.path.exists(cand):
        return cand
    hits = glob.glob(os.path.join(workspace, "uploads", "**", os.path.basename(path)), recursive=True)
    return hits[0] if hits else None

def chapter_level(text):
    """语义编号的层级：章/卷/部/回/幕 → 1；节 → 2；非语义标题 → None。"""
    s = text.strip()
    if not s or len(s) > 80 or any(p in s for p in "。！？；!?;"):
        return None
    if re.match(r"^第[零〇一二两两三四五六七八九十百千0-9]{1,12}(章|卷|部|回|幕)", s):
        return 1
    if re.match(r"^第[零〇一二两两三四五六七八九十百千0-9]{1,12}(节|节)", s):
        return 2
    return None

def is_chapter_title(text):
    """章题行（含 节）：行首锚定 + 短行 + 无句读标点。"""
    return chapter_level(text) is not None

def has_body_after(lines, idx, span=25, min_len=25):
    """idx 行之后 span 行内存在「非章题的长行」→ 该处后随真实正文。"""
    for j in range(idx + 1, min(idx + 1 + span, len(lines))):
        s = lines[j].strip()
        if len(s) >= min_len and not is_chapter_title(s):
            return True
    return False

def dedup_toc(entries, lines):
    """entries: [(line_idx0, title)]。同章题 key 取后随正文的最后一次；无章题 key 的原样保留。"""
    best, plain = {}, []
    for idx, title in entries:
        m = NUM_RE.search(title)
        if not m:
            plain.append((idx, title))
            continue
        key = m.group(0)
        if key not in best or has_body_after(lines, idx) or not has_body_after(lines, best[key][0]):
            best[key] = (idx, title)
    return sorted(plain + list(best.values()))

def finalize_items(items, total_lines):
    """排序、end=下一项 start、chars 统计、中文序号排序校验。"""
    items.sort(key=lambda x: x["txt_line_start"])
    for k in range(len(items) - 1):
        items[k]["txt_line_end"] = items[k + 1]["txt_line_start"]
        items[k]["chars"] = items[k]["txt_line_end"] - items[k]["txt_line_start"]
    if items:
        items[-1]["txt_line_end"] = total_lines
        items[-1]["chars"] = total_lines - items[-1]["txt_line_start"]
    seqs = []
    for it in items:
        m = NUM_RE.search(it["title"])
        if m:
            seqs.append(ch2int(m.group(1)))
    order_ok = seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    return items, order_ok

def finish(items, total_lines, path, out_path, kind, max_items):
    items, order_ok = finalize_items(items, total_lines)
    total = len(items)
    payload = {"ok": True, "source_path": path, "text_path": out_path, "doc_kind": kind,
               "item_count": total, "items": items[:max_items],
               "total": total, "shown": min(total, max_items)}
    if not order_ok:
        payload["chapter_order_ok"] = False
        payload["reason"] = "章节序号校验未通过（序号跳号或乱序），items 可能不完整，请人工复核。"
    emit(payload)

def do_pdf(path, max_items):
    import pymupdf
    doc = pymupdf.open(path)
    if doc.page_count == 0:
        emit({"ok": False, "source_path": path, "doc_kind": "pdf", "item_count": 0, "items": [],
              "reason": "这份 PDF 没有任何页面，无法解析。"})
        return
    sizes = Counter()
    page_lines = []  # 每页 [(text, max_size)]
    for pno in range(doc.page_count):
        plines = []
        for blk in doc[pno].get_text("dict")["blocks"]:
            if blk.get("type", 0) != 0:
                continue
            for line in blk.get("lines", []):
                spans = [sp for sp in line.get("spans", []) if sp.get("text", "").strip()]
                if not spans:
                    continue
                text = "".join(sp["text"] for sp in spans).strip()
                if not text:
                    continue
                mx = max(round(sp.get("size", 0), 1) for sp in spans)
                sizes[mx] += len(text)
                plines.append((text, mx))
        page_lines.append(plines)
    total_chars = sum(v for k, v in sizes.items() if k > 0)
    if total_chars < 50:
        emit({"ok": False, "source_path": path, "doc_kind": "pdf", "item_count": 0, "items": [],
              "reason": "这份 PDF 抽不出文字内容（大概率是扫描版/图片型 PDF）。请改用 OCR 流程或换文字版文件。"})
        return
    body_size = sizes.most_common(1)[0][0] or 1.0
    # 几何候选字号聚类 → level（降序 1..4）
    font_sizes = sorted({mx for plines in page_lines for _, mx in plines
                         if mx >= body_size * 1.18}, reverse=True)
    level_of = {s: min(i + 1, 4) for i, s in enumerate(font_sizes)}
    # 全局行表（写 txt 用），先收集候选再写盘以对齐行号
    # 候选三类：sem（语义章/节号，level 由 chapter_level 定，权威优先）
    #          font（字号 ≥1.18× 正文且 ≤60 字，按字号聚类 level）
    all_lines = []
    sem_cands, font_only = {}, {}  # line_idx -> (title, level); line_idx -> (title, level)
    for pno, plines in enumerate(page_lines):
        for text, mx in plines:
            idx = len(all_lines)
            all_lines.append(text)
            sl = chapter_level(text)
            if sl is not None:
                sem_cands[idx] = (text, sl, pno + 1)
            elif mx in level_of and len(text) <= 60:
                font_only[idx] = (text, level_of[mx], pno + 1)
    out_path = path + ".struct.txt"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(all_lines) + "\n")
    # 章题两行合并：语义章题紧接的下一行若是同字号大字短行（font-only 候选）→ 并入 title
    used = set()
    for idx in list(sem_cands):
        if idx + 1 in font_only and idx + 1 not in sem_cands:
            t2 = font_only[idx + 1][0]
            if len(t2) <= 30:
                sem_cands[idx] = (sem_cands[idx][0] + " " + t2, sem_cands[idx][1], sem_cands[idx][2])
                used.add(idx + 1)
    # 目录去重：同章题 key 取后随正文的最后一次（正文版优先保留）
    best, plain = {}, []
    for idx, (title, level, page) in sem_cands.items():
        m = NUM_RE.search(title)
        if not m:
            plain.append((idx, title, level, page))
            continue
        key = m.group(0)
        if key not in best or has_body_after(all_lines, idx) or not has_body_after(all_lines, best[key][0]):
            best[key] = (idx, title, level, page)
    for idx, (title, level, page) in font_only.items():
        if idx not in used:
            plain.append((idx, title, level, page))
    merged = sorted(plain + list(best.values()))
    items = [{"title": t, "level": lv, "page_start": pg, "txt_line_start": i + 1, "txt_line_end": 0, "chars": 0}
             for i, t, lv, pg in merged]
    finish(items, len(all_lines), path, out_path, "pdf", max_items)

def do_md(path, max_items):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip() for l in f]
    items = []
    for i, l in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.*)$", l)
        if m and m.group(2).strip():
            items.append({"title": m.group(2).strip(), "level": len(m.group(1)), "page_start": None,
                          "txt_line_start": i + 1, "txt_line_end": i + 2, "chars": 1})
    items, _ = finalize_items(items, len(lines))
    emit({"ok": True, "source_path": path, "text_path": path, "doc_kind": "md",
          "item_count": len(items), "items": items[:max_items],
          "total": len(items), "shown": min(len(items), max_items)})

def do_txt(path, max_items):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip() for l in f]
    entries = [(i, l.strip()) for i, l in enumerate(lines) if is_chapter_title(l)]
    merged = dedup_toc(entries, lines)
    items = [{"title": t, "level": 1, "page_start": None, "txt_line_start": i + 1, "txt_line_end": 0, "chars": 0}
             for i, t in merged]
    finish(items, len(lines), path, path, "txt", max_items)

def do_epub(path, max_items):
    import zipfile, html
    from xml.etree import ElementTree as ET
    z = zipfile.ZipFile(path)
    opf = next(n for n in z.namelist() if n.endswith(".opf"))
    base = os.path.dirname(opf)
    root = ET.fromstring(z.read(opf))
    ns = {"opf": "http://www.idpf.org/2007/opf"}
    manifest = {m.get("id"): m.get("href") for m in root.findall(".//opf:manifest/opf:item", ns)}
    spine = [manifest[i.get("idref")] for i in root.findall(".//opf:spine/opf:itemref", ns)
             if i.get("idref") in manifest]
    out_path = path + ".struct.txt"
    all_lines, items = [], []
    for href in spine:
        full = os.path.normpath(os.path.join(base, href)).replace("\\", "/")
        if full not in z.namelist():
            continue
        raw = z.read(full).decode("utf-8", "replace")
        for m in re.finditer(r"<h([1-6])[^>]*>(.*?)</h\1>", raw, re.S | re.I):
            title = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
            if title:
                all_lines.append(title)
                items.append({"title": title, "level": int(m.group(1)), "page_start": None,
                              "txt_line_start": len(all_lines), "txt_line_end": 0, "chars": 0})
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw, flags=re.S | re.I)
        text = html.unescape(re.sub(r"<[^>]+>", "\n", text))
        for ln in text.splitlines():
            ln = ln.strip()
            if ln:
                all_lines.append(ln)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(all_lines) + "\n")
    finish(items, len(all_lines), path, out_path, "epub", max_items)

def main():
    req = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    workspace = req.get("workspace", os.getcwd())
    max_items = int(req.get("max_items", 500))
    raw = req.get("path", "")
    path = resolve_path(raw, workspace) if raw else None
    if not path:
        emit({"ok": False, "source_path": raw, "doc_kind": "unknown", "item_count": 0, "items": [],
              "reason": "找不到档案 %r（已尝试绝对路径与 workspace/uploads/** 同名递回解析）。" % raw})
        return
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".pdf":
            do_pdf(path, max_items)
        elif ext in (".md", ".markdown"):
            do_md(path, max_items)
        elif ext in (".txt", ".text"):
            do_txt(path, max_items)
        elif ext == ".epub":
            do_epub(path, max_items)
        else:
            emit({"ok": False, "source_path": path, "doc_kind": ext, "item_count": 0, "items": [],
                  "reason": "暂不支援的副档名 %r（支援 pdf/epub/txt/md）。" % ext})
    except Exception as e:
        emit({"ok": False, "source_path": path, "doc_kind": ext, "item_count": 0, "items": [],
              "reason": "解析失败：%s" % e})

if __name__ == "__main__":
    main()
