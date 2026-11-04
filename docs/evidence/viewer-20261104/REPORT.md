# 赏阅（Viewer）独立验收报告 — 2026-11-04

验收者：独立 subagent（非作者），真浏览器（Playwright chromium，dsr=2，桌面 1440×900 / 手机 390×844），本机 next dev:3999 + 暂存路由 `zz-tmp-viewer`（已删）。截图 163 张同目录。

## 结果
A–M：PASS 10（A B C D E H I J K L），FAIL 2（F 3D、G 文档），M 已归类。无 P0。

## P1
1. DocumentSurface 的 PDF iframe 无 sandbox、种类只按扩展名：同源 HTML 改名 .pdf 后可读 cookie/localStorage/parent.document；`/view?u=外站.pdf` 可把外站页面嵌入壳（`DocumentSurface.tsx:62、141-170`）。
2. `/view?k=scene3d` 匿名访客不可用（`Scene3dGltfViewport.tsx:33` 要求登录头），与 /view「无需登录」矛盾。

## P2
- 下层 Radix 弹层抢 Esc，第一次 Esc 关不掉壳（`ViewerHost.tsx:573-576`）。
- `![x](a.mp4)` 渲染成破图（`agent-markdown.ts:133`）。
- 历史灯箱删除无二次确认（`HistoryLightbox.tsx:222`）。
- OpenInViewerButton 触控目标 28px（`OpenInViewerButton.tsx:36`）。
- 3D「跳到」已存视角落点漂移（`engine.ts:773-779`）。
- store 域音频必请求硬编码 tracks.json，CORS 报错（`AudioSurface.tsx:34、851`）。
- 无 url 的音频资产显示成正常播放器，无错误态。

## 未验
画布真节点、/p 分享页、真实 /history 页（需登录）、PDF 真渲染（headless 无 PDF 插件）、安全区、真浏览器全屏 Esc。

## 处置
上述 P1/P2 已派两路修复（文档/3D 侧；壳/音频/历史/Markdown 侧），修复后需复验。

## 复验（修复后，独立复验者，真浏览器 chromium dsr=2；暂存路由与 public/zz-tmp 已删，dev server 已停）

截图目录：`docs/evidence/viewer-20261104/regress/`（37 张，关键图均已逐张 Read 审看）。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | PDF 安全 | PASS | 同源 HTML 改名 evil.pdf：fetch+魔数校验不过 → 诚实卡片「不是有效 PDF，已拒绝嵌入」，无 iframe、`window.__pwn` 未定义，只有「下载」无「新标签打开」（pdf-evil-shell / pdf-view-same-evil / pdf-view-ext-notpdf）。真 PDF：iframe src=`blob:…#page=1`、无 sandbox；headless_shell 无 PDF 插件故画面空白（pdf-view-ext-realpdf）。html 分支 `sandbox="allow-scripts"`，脚本执行但 cookie/localStorage/parent 均 SecurityError（pdf-html-sandbox）。 |
| 2 | 3D 匿名 | PASS | 无 token 访问 `/view?k=scene3d` 正常加载（scene3d-anon-loaded）；存视角 (5.0,3.2,6.5) → 拖到 (-8.4,1.1,1.2) → 点「跳到」，相机回 (5.0,3.2,6.5)，+300ms/+1s/+3s 均一致，截图与初始一致（scene3d-anon-after-jump）。 |
| 3 | Esc | PASS | Radix Dialog 之上开赏阅：1 次 Esc 关赏阅（Radix 保留），第 2 次关 Radix（esc-radix-*）。「再来N组」菜单开时 Esc#1 只关菜单、Esc#2 关壳（esc-rerun-menu-*）。 |
| 4 | Markdown | PASS | `![x](a.mp4)` → 赏阅 inline 视频，可放大进视频赏阅；`![x](a.mp3)` 与 `[链接](x.mp3)` 均 → inline 音频，放大进音乐赏阅；javascript:/data: 仍走图片通道（破图占位），`window.__data` 未定义、无 window.open（markdown-media / markdown-expand-0..5）。 |
| 5 | 历史灯箱删除 | PASS | 点删除 → window.confirm「确定删除这条作品？删除后无法恢复。」，stub 取消 → onDelete 未调用；stub 确认 → 调用（history-delete-cancelled）。 |
| 6 | 手机 OpenInViewerButton | PASS | 390×844，按钮 28px，::after 44×44；elementFromPoint 中心±21px 命中按钮、±23px 不命中；在右下角 (+20,+20)（视觉框外 6px）真实 tap 打开赏阅（mobile-oivb-tap-outside-390）。 |
| 7 | 音频 | PASS | 无 url / ftp: / javascript: → 「没有可播放的音频」、播放键 disabled、无 audio src（audio-audio-nourl/ftp/js）；store 域非 ba-deng-liu-zhao → 全程 0 次 tracks.json 请求（仅请求音频本身）。 |
| 8 | 回归 | PASS | 图/视频/音频(有url)/文本/分镜/集合(含 PageDown 切成员)各开一次，过滤预期项后无控制台错误（regress-*）。 |
| 9 | /p/[shareId]、真浏览器全屏 Esc | 未验 | 本机无可用公开 shareId（/p/abc123=404，存储在远端）；/p 页新增「在赏阅中打开」仅是 `/view?u=…&k=image` 链接，该落点已由 /view 图片通路覆盖。全屏 Esc：headed chromium 可启动，但 CDP 注入的 Esc 不会触发浏览器级退出全屏，系统级按键注入（ydotool）会干扰用户桌面，未做。 |

### 仍存在的缺陷
- P3（新发现）：AgentMarkdown 内嵌影片/音频把 `<div>`（Viewer）渲染进 `<p>`，Viewer 内部还有 `<p>`，React 报 `<div> cannot be a descendant of <p>` / `<p> cannot contain a nested <p>`，SSR 场景会触发 hydration error。位置：`src/components/agent-chat/AgentMarkdown.tsx:110-126`（MdVideo/MdAudio）由 `:194` 的 `<p>` 段落包裹。复现：渲染含 `![x](a.mp4)` 或 `[链接](x.mp3)` 的 markdown，开 dev 控制台。聊天内纯客户端渲染下仅 dev 警告，用户无感。
- 视觉瑕疵（未定位）：390px 宽手机图片赏阅底部「适应 / 100% / 框选」胶囊内文字竖排折行（mobile-oivb-tap-outside-390）。
- 复验用的假 store 音频 URL 404 触发的 CORS/404 日志属夹具所致，非产品缺陷。

## 生产交付闸

时间 2026-11-04 20:09–20:50（+08）。生产 https://www.eimu.dev（revision e8c5d3bc2）。截图目录 `docs/evidence/viewer-20261104/prod/`，下列截图均已逐张 Read 审看。

总判：赏阅本体（/view 图片、音乐、手机视口、框选标记、复制给助理）PASS；agent 卡 → 赏阅壳 → 「发给助理」预填 未验（登录硬闸）；真会话路径 FAIL（出图未交付、10 秒要求未达成，非赏阅缺陷）。

### 1. 真会话（tools/human-conversation-e2e.mjs，场景 `viewer-gate-image-then-music`，已补进 corpus，runner 为 sceneViewerGate）
- sid：`16b511d6-ceac-4d58-863c-4c2424078335`（opencode `ses_e598955cbffewPVAVsEx0PJaMd`），证据 `/tmp/human-e2e-2026-11-04T12-09-16-544Z/`（含完整 .sse）。
- 原话 1「给我一张极简风的咖啡馆海报」：助理先弹「三个方向共 18 币」问题卡（用户只要一张，属多余确认），选一张后确认卡 6 币已批准，扣费 6 币、1 条回执；SSE 全程无 `image.done`，图经子代理落到 task `fcc59ada-33c8-4ec5-a19f-c0611ea074fc`，会话里查不到可公开 URL（`uploads/fcc59ada…_0.png` 404），截至 20:50 仍未把图交到聊天。FAIL。
- 原话 2「给这张图配一段 10 秒的轻音乐」：收到 `audio.done` ×2（m4a 公开可取、带 CORS），但实测时长 180.59s／160.02s／180.97s／173.91s，没有一段是 10 秒；子代理交付闸报「契约 6 栏实到 0 栏」并撞「daily usage limit for Chat」；另有一次 `session.error`「只能访问创作工作区（workspace）内的文件」（glob）。10 秒要求 FAIL，音频本身可播。
- 夹具侧：回合在子代理仍跑时因 25 秒安静就判 turn 结束，需更长的安静窗口才能等到子代理回执；本轮会话到 20:50 仍在自行续跑（又派了「音频裁10秒+循环」「海报独立评审」两路）。
- 花费：约 6 币图 + 1 币音乐 + 其余音乐 take（cost 0），远低于上限（图 8／音乐 30）。

### 2. 真浏览器（chrome-stable headless，生产，非第三方登录）
- 登录硬闸：`/api/agent/sessions` 回 401 `agent_not_signed_in`，首页只有交互式「登录」；本机无可用生产用户 token，不 headless 登录、不读用户 Chrome 档案。故「打开该会话、截 agent 图卡/音频卡、点放大进赏阅壳、发给助理预填」未验。biz key 会话不属任何站点用户，浏览器看不到。
- `/view?u=<公开图>&k=image` 桌面 1440×900：PASS，1200×1200 渲染、顶栏「图片」、缩放「66%」、适应/100%/框选胶囊、存图库/下载/再来N组/微调（`view-image-desktop.png`）。
- 手机 390×844（dsr3）：PASS，图居中、胶囊内文字单行、无折行（`view-image-mobile.png`；复验里的「竖排折行」瑕疵在生产版已不复现）。
- 框选+标签+备注：PASS，拖出选区 → 面板「画面 (25%,15%) 起 30%×15%」→ 点「文字错」+ 备注 → 保存标记 → 框上出现序号 1，列表「已标 1 处」（`view-image-select-desktop.png`、`view-image-mark-saved-desktop.png`、`view-image-copy-desktop.png`）。匿名 /view 里按钮是「复制给助理」（无会话可预填），剪贴板文本：「《未命名》观感反馈（共 1 处）：1. 画面 (25%,15%) 起 30%×15%：画面里的文字错误或乱码；标题字间距太松，改成紧凑一点 / 请只针对以上标记的位置调整，没提到的部分保持不变。」
- 音频赏阅 `/view?u=<本会话 m4a>&k=audio`：PASS（`view-audio-desktop.png`、`view-audio-mobile.png`）。时长 03:00 与真实 180.59s 一致；波形是真解码峰值（源码 `AudioSurface.tsx:298-330`，解码失败退化为朴素条，不造假波形；该存储域对 www.eimu.dev 带 CORS）；无歌词诚实标「本曲暂无歌词」；A-B 循环、倍速、标记、音量齐全；不冒充歌词、不假造 LRC。
- 控制台：赏阅页面零报错；唯一错误是整站级 `/_vercel/insights/script.js` 404（返回 text/html 被 MIME 拒绝），非赏阅代码，另有 2 条 CSS preload 未使用警告。

### 未达成的一件事
以真实登录用户打开会话，验证 agent 图卡/音频卡 → 放大进赏阅 → 「发给助理」只预填不自动发送（需暴君本人登录一次生产站，或给出可用于浏览器的 napi_token 文件，`AUTH_TOKEN_FILE` 即 agent-intent-map.mjs 的现成接口）。
