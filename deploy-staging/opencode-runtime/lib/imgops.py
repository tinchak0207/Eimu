# 圖像編排確定性演算法共用模組（2026-08-31 片3）。
# 由 runPIL 沙箱 import（sys.path 已含本檔所在 lib 目錄）。
# 零網路、零 LLM：純 PIL/numpy 幾何與像素操作。所有函式回傳 PIL.Image。
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import numpy as np


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _resize_cap(img, max_side):
    """等比縮放（無拉伸）：長邊超過 max_side 才縮，小於則保留原生像素。"""
    w, h = img.size
    m = max(w, h)
    if max_side and m > max_side:
        s = max_side / m
        img = img.resize((max(1, int(round(w * s))), max(1, int(round(h * s)))), Image.LANCZOS)
    return img


def _pad_blur(img, tw, th, ox, oy):
    """補邊：以自身高斯模糊放大版作背景，原圖貼於 (ox,oy)，保原像素不拉伸。"""
    bg = img.convert("RGB").resize((tw, th)).filter(ImageFilter.GaussianBlur(40))
    bg.paste(img.convert("RGB"), (int(ox), int(oy)))
    return bg


def reflow(img, ratio, bbox=None, max_side=1600):
    """VLM 引導重排：以主體為錨，裁切（保像素）或補邊到目標畫幅 ratio=w/h。
    bbox=(x1,y1,x2,y2) 像素座標（主體框），None=置中。回傳精確目標畫幅的 PIL.Image。
    誠實：裁切=主體置中保像素不拉伸；僅當裁切窗無法容納主體框時才補邊。"""
    img = img.convert("RGB")
    W, H = img.size
    src_r = W / H
    if bbox:
        x1, y1, x2, y2 = bbox
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        bw = max(1.0, x2 - x1)
        bh = max(1.0, y2 - y1)
    else:
        cx, cy, bw, bh = W / 2.0, H / 2.0, float(W), float(H)

    # 目標畫幅下、能容納主體的最大裁切窗
    if src_r > ratio:      # 源較寬：裁寬
        cw = int(round(H * ratio)); ch = H
    elif src_r < ratio:    # 源較窄：裁高
        cw = W; ch = int(round(W / ratio))
    else:
        cw = W; ch = H
    cw = clamp(cw, 1, W); ch = clamp(ch, 1, H)

    # 裁切窗能否容納主體框？不能 → 補邊保主體
    if bbox and (cw < bw or ch < bh):
        need_w = max(W, int(round(bw)))
        need_h = int(round(need_w / ratio))
        if need_h < H:
            need_h = H; need_w = int(round(need_h * ratio))
        ox = need_w / 2.0 - cx
        oy = need_h / 2.0 - cy
        canvas = _pad_blur(img, need_w, need_h, ox, oy)
        return _resize_cap(canvas, max_side)

    x = clamp(int(round(cx - cw / 2)), 0, W - cw)
    y = clamp(int(round(cy - ch / 2)), 0, H - ch)
    out = img.crop((x, y, x + cw, y + ch))
    # 保像素：僅在超過 max_side 時等比降採樣，絕不上採樣拉伸
    return _resize_cap(out, max_side)


def grid(images, cols=3, cell=512, spacing=16, bg="#ffffff", title=None,
         font_path=None, title_area=0):
    """網格拼貼：images=PIL.Image 清單。每格 contain 置中（保比例補背景）。
    title_area>0 時頂部留安全區繪製劇名/標題文字。回傳拼貼 Image。"""
    n = len(images)
    if n == 0:
        raise ValueError("empty grid")
    cols = max(1, min(cols, n))
    rows = int(np.ceil(n / cols))
    pad_top = int(title_area)
    W = cols * cell + (cols + 1) * spacing
    H = rows * cell + (rows + 1) * spacing + pad_top
    canvas = Image.new("RGB", (W, H), bg)
    for i, im in enumerate(images):
        r, c = divmod(i, cols)
        x = spacing + c * (cell + spacing)
        y = pad_top + spacing + r * (cell + spacing)
        thumb = im.convert("RGB")
        s = min(cell / thumb.width, cell / thumb.height)
        tw = max(1, int(round(thumb.width * s))); th = max(1, int(round(thumb.height * s)))
        thumb = thumb.resize((tw, th), Image.LANCZOS)
        canvas.paste(thumb, (x + (cell - tw) // 2, y + (cell - th) // 2))
    if title and pad_top > 0:
        d = ImageDraw.Draw(canvas)
        size = max(18, int(pad_top * 0.5))
        try:
            font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()
        tb = d.textbbox((0, 0), title, font=font)
        d.text(((W - (tb[2] - tb[0])) // 2, (pad_top - (tb[3] - tb[1])) // 2 - tb[1]),
               title, fill="#111111", font=font)
    return canvas


def line_art(img, low=64, high=160, invert=True):
    """黑白線稿鎖定：灰度 → 邊緣（FIND_EDGES + 自動閾值）→ 反轉成黑線白底。"""
    g = img.convert("L")
    edges = g.filter(ImageFilter.FIND_EDGES)
    arr = np.asarray(edges).astype(np.uint8)
    # 自動閾值：以 95 百分位為強邊界，保底對比
    thr = max(low, int(np.percentile(arr, 95)))
    binz = np.where(arr >= thr, 255, 0).astype(np.uint8)
    if invert:
        binz = 255 - binz
    return Image.fromarray(binz, "L").convert("RGB")


def composition_stats(img):
    """構圖元數據（純 PIL/numpy 統計，零 LLM）：主體重心、留白比例、三分線偏差。"""
    g = np.asarray(img.convert("L")).astype(np.float32)
    H, W = g.shape
    # 邊緣能量圖定位主體重心
    gx = np.abs(np.gradient(g, axis=1)); gy = np.abs(np.gradient(g, axis=0))
    energy = gx + gy
    total = float(energy.sum()) or 1.0
    ys, xs = np.mgrid[0:H, 0:W]
    cx = float((energy * xs).sum() / total) / W
    cy = float((energy * ys).sum() / total) / H
    # 留白：接近純白/純黑的低能量像素比例
    flat = np.asarray(img.convert("L"))
    white = float((flat > 245).mean())
    black = float((flat < 12).mean())
    whitespace = round(max(white, black), 4)
    third_off = round(min(abs(cx - 1/3), abs(cx - 2/3), abs(cx - 0.5)), 4)
    return {
        "subject_center": [round(cx, 4), round(cy, 4)],
        "whitespace_ratio": whitespace,
        "rule_of_thirds_offset": third_off,
        "edge_energy": round(total / (W * H), 4),
    }


def hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
