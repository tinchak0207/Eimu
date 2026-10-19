---
name: read-image
description: 读一张图片并客观描述内容（主体/场景/风格/色彩/文字）。用户上传图片、问「这张图里有什么」「描述这张图片」「这张图是什么风格」等看图/读图需求时使用。
license: internal
metadata:
  audience: coding-agent
---

## 用法（唯一正确方式）

用原生 `read_image` 工具，一步完成：

- 本地附件：`read_image({ image_path: "uploads/<session_id>/<file>.png" })`
- 公网图片：`read_image({ image_url: "https://…" })`
- 想问具体问题：加 `question` 字段（如「背景是什么建筑风格」）。

要对图片打分/审美点评 → 改用 `vision_analyze`；要反推可直接生图的提示词 → 走反推 skill。

## 规则（硬性）
1. 用 `read_image` 工具，**不要走 bash**：bash 沙箱无网络、无密钥，`python3 read_image.py` 一定失败。
2. 一次一个文件；成功即把描述总结给用户，失败如实说「读图失败」并停，不反复试。
3. 只能读本会话的附件与产物（工具已内建路径校验，跨会话文件会被拒）。
