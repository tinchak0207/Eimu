# 执行环境注意事项（blender-bridge / Blender 5.2，2026-09-06 实弹）

> 主文档 SKILL.md「执行环境铁律」节的细节附件。数据源：2026-09-06 渲染崩溃存活配方、全链 E2E（片L）、stdout 分道与轮转（片N）三份实弹记录。

## 崩溃与重试纪律

- 崩溃形态：桥内 `blender connection lost`，Blender 进程无 Python traceback 无声死（native 层），桥 500 后自动重启、health 立即绿。场景内容无罪（同 blend 直连 CLI 任意渲染 exit 0）。
- 渲染负载越高崩率越高：samples=16@1280 全崩，samples=1+RT off 全过；同进程第 2+ 次 render 开始有风险，多帧循环第 8-12 帧稳定死。
- 重试纪律：429（queue_full）与 connection lost 都是瞬态，让路/重试；**同类错误连续 2 次未过 → 停止回报，禁止无限试错**。
- 保险动作：进程死 = 场景丢，渲染前先存 .blend。
- cooldown 15-20s 无明确效果，存活配方才是关键。

## 诊断与 stdout

- 脚本 print 常被引擎日志挤出 stdout_tail（桥已预算制修复 code_out 保窗口、launch 时 blender.log 轮转留一代），但证据链仍以 artifact 落盘为硬（out/ 下 .json/.txt）。
- 桥 scan_artifacts 有 0.5s mtime 容差：紧邻 job 会误捡上一 job 刚写的文件，客户端合并时按 path 去重。
- launcher 不注入 `BLENDER_WORK_OUT`：桥接配方类脚本开头必 shim `os.environ.setdefault("BLENDER_WORK_OUT", "out")`。

## Blender 5.2 API 雷区明细

- **fcurves**：5.2 slotted action 无 `action.fcurves`，走 `action.layers[*].strips[*].channelbags[*].fcurves`。
- **视频输出**：`file_format="FFMPEG"` 已死（enum 只剩图片格式）；新路 `image_settings.media_type="VIDEO"`，或更稳的 PNG 序列（`media_type="IMAGE"`）+ host ffmpeg（`-framerate N -f image2 -i seq_%04d.png -c:v libx264 -pix_fmt yuv420p`）。桥内 in-process mp4 muxer 必崩（48 字节 stub）；ffmpeg9 对 PNG 帧序列必须 image2 demuxer，concat 会丢帧；文件大小不是完整性信号，nb_frames 才是。
- **Eevee enum**：只有 `BLENDER_EEVEE`（`BLENDER_EEVEE_NEXT` 在 5.2 抛 TypeError，是死代码）。
- `.blend` 用 `file()` 报 "Zstandard compressed data" 是正常的（3.0+ 默认压缩），不是格式错。
- AgX 是 5.2 默认色彩管理。

## 产物落盘约定

- 一切输出写 `$BLENDER_WORK/out/`，文件名带语义前缀（分镜号_内容，如 `sh02_still_front.png`、`sh03_anim_f0001.png`）。
- scan_artifacts 按该目录扫描回报，写目录外=桥收不到=假丢失。
