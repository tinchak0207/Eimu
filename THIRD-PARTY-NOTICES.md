# Third-Party Notices

本仓库引入的第三方开源组件及其许可信息。

## kunpeng

- 来源：https://github.com/pengfeiqiao/kunpeng
- 版本 / commit：`872a58b`
- 许可证：MIT License，Copyright (c) 2026 Kunpeng Contributors
- 引入方式：源码逐行复制（白名单仅 import 路径改写），副本位于 `src/vendor-bridges/editor/`，随附的许可证副本见 `src/vendor-bridges/editor/LICENSE`。
- 改动记录：`vendor/kunpeng/PATCHES.md`。
- 完整许可证文本（摘自随附副本）：

```
MIT License

Copyright (c) 2026 Kunpeng Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## AID (aid-server)

- 来源：https://github.com/gzxx-2025/aid-server
- 版本：`main` @ 2026-09-15 取证（v2.1.4，2026-09-14 发布）
- 许可证：MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司（另含 RuoYi-Vue 部分，MIT）
- 引入方式：数据逐字复制（原 `sql/aid-init.sql` 的 `aid_prompt_lib` 初始资料，142 条词条），
  白名单改写见副本档头注释；副本位于 `src/lib/lens-language-library.ts`。
- 改动记录：副本档头「白名单改写」段（仅三处：剔除 `cover_url`、同型同名去重一笔、新增展示层分组 label）。
- 追加引入（2026-09-15，刀 1 作品/剧集实体链）：流程步骤枚举与剧集表语义，
  来源 `CreationStepEnum.java`（`aid-interface/.../enums/`）、`createFlowStepMeta.ts`、
  `sql/aid-init.sql` 的 `aid_comic_episode` / `aid_comic_script`；
  改写见 `src/lib/creation-flow-steps.ts` 与 `src/lib/canvas/types.ts` 的 `CanvasEpisode` 档头
  （砍 AID 审核三态与 `pending_*` 字段，本站无审核队列）。
- 追加引入（2026-09-15，刀 2 分镜实体 + 21 栏位契约）：分镜 21 栏位契约（栏名与顺序逐字保留）
  与 `aid_storyboard` 表栏位语义，来源 `doc/提示词开发指南.md` §「分鏡脚本与画师链路」输出栏位表、
  `sql/aid-init.sql` 的 `aid_storyboard`（21 栏 + `final_image_id`/`final_video_id`/`final_audio_id`）；
  改写见 `src/lib/storyboard-contract.ts` 档头（**剔除已废的第 22 栏 `sceneCode`**——AID v2.1.4
  同档 §开发要点 5 已明令禁输出 sceneCode，场景归属只认外层 sceneName；本站不建 shot 表，
  改挂 `CanvasNode.metadata`，即 `CanvasNodeMetadata.storyboardShot` / `.storyboardScene`）。
- 追加引入（2026-09-15，刀 3 配音音色库）：音色库初始资料 63 笔（`voice_code` / `voice_name` /
  `character_types` / `voice_styles` / `tone_tags` / `emotion_tags` 逐字保留），来源
  `sql/aid-init.sql` 的 `aid_ai_voice_library`（行 426-428 起）；另借 `aid_role_voice_binding` /
  `aid_audio_asset` 的栏位语义（本站**不建表**：音色 metadata 挂资产包 `AssetPackItem
  kind:"voice"`，角色绑定用 `CharacterCard.voiceCode`）。
  改写见 `src/lib/voice-library.ts` 档头与 `src/lib/generation-core/tts-upstream.ts`。
  **剔除项**：AID 的 `sample_url` / `avatar_url` 指向 AID 自建 OSS（`/aid/voice/sample/...`），
  本站不可达，仅以 `sourceSampleUrl` 原值保留供溯源，**不宣称可直连播放**。
  **实测边界（2026-09-15 探针）**：AID 的 63 个火山 bigtts 音色码在本站网关上被
  `tts-proxy.js` 的 `if (!voice.includes(':')) voice = \`${model}:alex\`` 改写成同一音色
  （63 笔全部塌缩），故本仓库另立实测白名单 `GATEWAY_VERIFIED_VOICES`（8 条
  SiliconFlow preset，实弹验证走 SF 主路 32kHz）作为可试听集合；AID 63 笔仅作
  策展元资料（标签/试听文案/排序）。
- 完整许可证文本：

```
MIT License

Copyright (c) 2026 光子讯息(杭州)科技有限公司
Portions Copyright (c) 2018 RuoYi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
