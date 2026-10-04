# 图像编排确定性演算法共用模组（2026-08-31 片3）。
# 由 runPIL 沙箱 import（sys.path 已含本档所在 lib 目录）。
# 零网路、零 LLM：纯 PIL/numpy 几何与像素操作。所有函式回传 PIL.Image。
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import numpy as np


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _resize_cap(img, max_side):
    """等比缩放（无拉伸）：长边超过 max_side 才缩，小于则保留原生像素。"""
    w, h = img.size
    m = max(w, h)
    if max_side and m > max_side:
        s = max_side / m
        img = img.resize((max(1, int(round(w * s))), max(1, int(round(h * s)))), Image.LANCZOS)
    return img


def _pad_blur(img, tw, th, ox, oy):
    """补边：以自身高斯模糊放大版作背景，原图贴于 (ox,oy)，保原像素不拉伸。"""
    bg = img.convert("RGB").resize((tw, th)).filter(ImageFilter.GaussianBlur(40))
    bg.paste(img.convert("RGB"), (int(ox), int(oy)))
    return bg


def reflow(img, ratio, bbox=None, max_side=1600):
    """VLM 引导重排：以主体为锚，裁切（保像素）或补边到目标画幅 ratio=w/h。
    bbox=(x1,y1,x2,y2) 像素座标（主体框），None=置中。回传精确目标画幅的 PIL.Image。
    诚实：裁切=主体置中保像素不拉伸；仅当裁切窗无法容纳主体框时才补边。"""
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

    # 目标画幅下、能容纳主体的最大裁切窗
    if src_r > ratio:      # 源较宽：裁宽
        cw = int(round(H * ratio)); ch = H
    elif src_r < ratio:    # 源较窄：裁高
        cw = W; ch = int(round(W / ratio))
    else:
        cw = W; ch = H
    cw = clamp(cw, 1, W); ch = clamp(ch, 1, H)

    # 裁切窗能否容纳主体框？不能 → 补边保主体
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
    # 保像素：仅在超过 max_side 时等比降采样，绝不上采样拉伸
    return _resize_cap(out, max_side)


def grid(images, cols=3, cell=512, spacing=16, bg="#ffffff", title=None,
         font_path=None, title_area=0):
    """网格拼贴：images=PIL.Image 清单。每格 contain 置中（保比例补背景）。
    title_area>0 时顶部留安全区绘制剧名/标题文字。回传拼贴 Image。"""
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
    """黑白线稿锁定：灰度 → 边缘（FIND_EDGES + 自动阈值）→ 反转成黑线白底。"""
    g = img.convert("L")
    edges = g.filter(ImageFilter.FIND_EDGES)
    arr = np.asarray(edges).astype(np.uint8)
    # 自动阈值：以 95 百分位为强边界，保底对比
    thr = max(low, int(np.percentile(arr, 95)))
    binz = np.where(arr >= thr, 255, 0).astype(np.uint8)
    if invert:
        binz = 255 - binz
    return Image.fromarray(binz, "L").convert("RGB")


def composition_stats(img):
    """构图元数据（纯 PIL/numpy 统计，零 LLM）：主体重心、留白比例、三分线偏差。"""
    g = np.asarray(img.convert("L")).astype(np.float32)
    H, W = g.shape
    # 边缘能量图定位主体重心
    gx = np.abs(np.gradient(g, axis=1)); gy = np.abs(np.gradient(g, axis=0))
    energy = gx + gy
    total = float(energy.sum()) or 1.0
    ys, xs = np.mgrid[0:H, 0:W]
    cx = float((energy * xs).sum() / total) / W
    cy = float((energy * ys).sum() / total) / H
    # 留白：接近纯白/纯黑的低能量像素比例
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
