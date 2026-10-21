# context-budget baseline 2026-10-11

- 测量时间：2026-10-11 23:40 (UTC+8 / CST)
- 定性：能力建设基线（beast ON 新会话首轮常驻上下文）
- 活本：VPS `/opt/agent-harness`；本地镜像 `deploy-staging/opencode-runtime` + `deploy-staging/gateway`
- 方法：活会话 sqlite tokens + journalctl beast-frame accounting + 可复算脚本量各块字节（非瞎估）

## 1. 活会话首轮 tokens（真路径）

| 样本 | agent | 首条 assistant `tokens.input` | cache.read | 说明 |
|---|---|---:|---:|---|
| `ses_ed653f1e…` 邓紫棋风格歌（14:35 CST） | orchestrator | **61888** | **0** | 冷启动，无 cache |
| `ses_ed4ae230…` 等 5 条工程 workflow_write | orchestrator | ≈45390 | ≈9728 | 有 cache 命中 |
| gateway journal beast-frame full stages | — | — | — | `total_chars=7370`（见下） |

冷启动 61.9k input ≈ 常驻基座（AGENTS+tools schema+skills+agent.prompt+env）+ 本轮 user/beast 帧。

## 2. 分块字节（可复算）

| 块 | bytes | 估 token（÷3.4 CJK 粗算） | 来源 |
|---|---:|---:|---|
| AGENTS.md（runtime 真源 staging） | **47321** | ~13918 | `deploy-staging/opencode-runtime/AGENTS.md` md5=11a43e811c21 |
| agent.orchestrator.prompt | 1621 | ~477 | opencode.json |
| `<available_skills>`（22 条 project skill） | **9370** | ~2756 | 按 opencode SkillGuidance 模板拼 |
| beast 帧 v2 全阶段（live journal） | **7370** chars | gateway tokens≈5367（其计法偏激进） | `journalctl -u agent-gateway`：core1767+research456+creation913+critique790+dispatch775+registry2451 |
| custom tools 仍对 orch 开放（n=87）schema 代理 | **≈91932** | ~27000 | 各 tools/*.ts description+args 源码代理（非 JSON schema 精算，量级可信） |
| custom tools 已断路（n=33） | — | — | 见下表 |

### 2.1 事故注记：VPS workspace/AGENTS.md 错位

- 2026-10-11 21:54 CST：`/opt/agent-harness/workspace/AGENTS.md` = **22184 B**（repo 根**开发者** AGENTS.md，工匠定位那份）
- 同刻 `.opencode/AGENTS.md` = **47321 B**（runtime 创作助理主指令）
- `opencode-release.sh` 规定 runtime AGENTS 必须装到 **workspace 根**；当前根档被开发者规则覆盖 ⇒ **生产 orchestrator 可能在吃错 AGENTS**（冷启动样本 14:35 早于这次覆盖，仍吃到旧 runtime）
- 本轮修复：瘦身后的 runtime AGENTS 经 `opencode-release.sh` 写回 workspace 根

### 2.2 Orchestrator 工具断路基线

- 真源宣告：`gateway/expert/opencode-agents.json`（environment-facts 读此档）
- 物理闸：`opencode-runtime/opencode.json` → `agent.orchestrator.tools`
- 当前 explicit false = 33：asset_provenance_archive, audio_first_timeline, blender_exec, blender_export_gltf, blender_render, canvas_apply_ops, doc_struct, editing_manifest, image_quote, keyframe_render, last_frame_video_chain, music_gen, script_scene_parse, search_web, story_sequence_consistency, storyboard_qc_17, style_aligned_batch, style_dna_extract, task, timeline_lint, timeline_master, timeline_mix, timeline_ops, timeline_query, timeline_restore, timeline_rhythm, timeline_style, video_quote, video_upload, workflow_start, workflow_status, workflow_update_node, world_bible_extract
- 当前 explicit true = 4：local_files, local_files_authorize, question, subagent_stop
- **未列出＝默认开**：custom 工具共 119，仍对 orch 开放 **87**（含 image_generate / video_* / director_* / timeline 外的大量域工具）
- 历史审计（mem beast-harness-architecture-audit-r8）：断路密度曾仅 4/25；现况 33 off / 87 still-on，仍远未到「只留派遣+画布」

### 2.3 Skill 注入面

- top-level SKILL.md = 22（期望不再有 nested 升格）
- nested SKILL.md（depth≥1 under skills/）= 0 []
- RECIPE.md 不进扫描：`_prompt-routing/` 仅 RECIPE/attachments/storyboard-gate

## 3. 优化目标（本轮）

1. 工具断路：orch 只留派遣 + 画布读写 + 余额预检（quote_bundle）+ 必要读档
2. AGENTS.md 拆薄：总导演短规 + 安全红线保留；配方外移 skill/RECIPE
3. skill 面确认无再升格
4. 质量闸：同 brief 干跑到派遣+workflow_write，禁付费生成；作者≠Hacker

## 4. 复算命令

```bash
# 活 tokens
node .dsh-ssh/exec-443.js 'sudo -u agentsvc sqlite3 /opt/agent-harness/workspace/.local/share/opencode/opencode.db "SELECT id,title,tokens_input,tokens_cache_read FROM session WHERE agent=\"orchestrator\" ORDER BY time_created DESC LIMIT 10"'
# beast 帧
node .dsh-ssh/exec-443.js 'journalctl -u agent-gateway --since "1 hour ago" | grep "beast-frame] v2" | tail -3'
# AGENTS / skills
wc -c deploy-staging/opencode-runtime/AGENTS.md
find deploy-staging/opencode-runtime/skills -name SKILL.md | wc -l
```

## 5. 优化后指针

见 `docs/arch/context-budget-after-20261011.md` 与 `eval-context-slim-20261011/QUALITY-GATE.md`。
