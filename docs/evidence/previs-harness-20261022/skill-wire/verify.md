# skill-wire verify · previs-director（2026-10-22 Asia/Shanghai UTC+8）

## 目标

把 S2 闭集预演编排接到 agent 可调用面：正式 skill + 路由挂载 + `director_propose_plans` 武侠金样第一候选。

## Skill 路径

| 项 | 路径 |
|---|---|
| 正式 skill | `deploy-staging/opencode-runtime/skills/previs-director/SKILL.md` |
| references | `…/previs-director/references/{closed-set,prompts,acceptance}.md` |
| 草稿来源 | `docs/evidence/previs-harness-20261022/s2-golden/agent-previs-skill-draft.md` |

挂载方式：与 `video-director` / `lens-language` 相同——**技能目录落盘即进索引**。  
`deploy-staging/gateway/context-injection.ts` → `loadSkillIndex` 扫描 `DEFAULT_SKILLS_DIR`（`…/.opencode/skills` 或 `EIMU_SKILLS_DIR`）下各子目录 `SKILL.md` frontmatter；**无需**另建 Expert / `opencode.json` agent 块（那是 video-director 成片 Expert 形态；本 skill 是配方库，非专属席位）。

## 注册点（路由，逐行对照既有 skill 挂法）

| 文件 | 行号（约） | 内容 |
|---|---|---|
| `deploy-staging/opencode-runtime/skills/_prompt-routing/RECIPE.md` | 见下 `rg` | §3D 表新增「实时白模预演／武侠打斗… → skill previs-director」行 |
| `deploy-staging/opencode-runtime/skills/_prompt-routing/creator-guide.md` | 见下 `rg` | 主表新增行；影片动态硬规则改为「实时可播优先 previs-director」 |
| 技能索引 | 自动 | `skills/previs-director/` 目录存在即被 `loadSkillIndex` 枚举 |

```
rg -n "previs-director" deploy-staging/opencode-runtime/skills/_prompt-routing/
```

（本波实测行号写入时固化：）


### 固化行号
deploy-staging/opencode-runtime/skills/_prompt-routing/creator-guide.md:21:| 实时 3D 白模预演／武侠打斗／樱花剑客可播编排 | 先读 `skill previs-director`（闭集 director_* 工具序；金样优先 propose）；不要默认进 `blender-director` 静帧 | —
deploy-staging/opencode-runtime/skills/_prompt-routing/creator-guide.md:42:- **影片动态硬规则（所有模型，与六槽／Blender 同级）**：叙事／动作／短片／电影感任务，先过 3D 预演能力闸门（查真实工具表确认 blender_* 是否可用），按「**实时可播优先**：`skill previs-director`＋director_* 白模闭集编排 → 仅当用户要 `.blend`/成品渲染才进具备 blender_* 的席位（本席关闭则派 Expert；无具备席位则诚实报告断路）→ 否则 bash 自建几何+光栅渲染」定 blocking／机位／动作，再生成影片；不是先出首帧再让模型猜动作。不涉及精确几何的微表情／产品特写才可走首帧 I2V。镜头脚本必须写 `state_change.from/to` 与 `beats[]`（每镜至少一次环境变化），只给静态六槽＝没开拍。模板里的 3D 预演 text 节点同样要填内容（blocking／机位／动作，或写明本镜跳过预演的理由），空着会让 `workflow_start` 报缺少必要内容。不得用二维文生图冒充 3D 预演；`.blend` 缺失必须在交付明确标注（「本席位无 blender，.blend 未交付」），预演帧与 GLB 仍算真预演证据。**违反 = 返工**。细则 → `skill video-director` 的 `references/motion-first.md`。
deploy-staging/opencode-runtime/skills/_prompt-routing/RECIPE.md:82:| 实时白模预演／武侠打斗预演／一句话跟拍编排（可播，非 Blender 静帧） | **先载 `skill previs-director`**：`director_get_state` →（可选 `director_propose_plans`，武侠关键词金样居首）→ `director_manage_shot` / `director_upsert_action` → 播 → `director_capture_previz`。闭集只许 CLOSED_ACTIONS／CLOSED_CAMERA_MOVES＋normalize*；金样 `docs/evidence/previs-harness-20261022/s2-golden/`；验收 A1–A20 双侧。**禁止**改走 blender 静帧冒充实时预演主路径（要 `.blend`/成品渲染才用 `skill blender-director`） | —

## propose 变更行号

| 文件 | 行号 | 说明 |
|---|---|---|
| `src/lib/director-engine/planning-core.ts` | 446–470（compile 多路径）、472–504（prefer helpers） | `compileReferenceWuxiaPlan` / `promptPrefersWuxiaGolden` / `withWuxiaGoldenFirst` |
| `deploy-staging/gateway/director-engine/planning-core.ts` | 367–430 | 同名导出（gateway 运行时真源；含 compile + prefer） |
| `deploy-staging/gateway/director-proposals.ts` | 4, 160–161 | import + `plans = withWuxiaGoldenFirst(plans, trimmed)` |
| `src/vendor-bridges/gateway/director-proposals.ts` | 5, 162–163 | import + withWuxiaGoldenFirst 调用（与 gateway 对称） |

## 探针（非 oracle）

- `promptPrefersWuxiaGolden("做一段武侠打斗樱花剑客")` → true
- `withWuxiaGoldenFirst(fallbackPlans(...), "红衣剑客樱花草原打斗")` → 第一案 name=`樱花草原剑客·参考金样`，shots=15，合计 3 案
- 非武侠 prompt 不插金样，仍 3 条 fallback

## 剩余缺口

1. **禁重启 gateway**：本波代码已落盘，**生产/本机 gateway 进程未加载新 planning-core**；下次正常发版／重启后 `director_propose_plans` 才会真推金样。
2. **生产 prompts-only**：若 VPS 只同步 `opencode-runtime/skills` 而不带 gateway 改动，agent 已能读 skill；propose 金样仍需 gateway 发版。是否另发 prompts-only＝**建议另发 skills 同步**（`previs-director` + `_prompt-routing` 两处），gateway 随下次常规发版。
3. Checklist A10–A14/A16/A19 仍 pending（mixer／截帧／场景资产），与本波无关。
4. 未新建 Expert 席位；若要 `subagent_dispatch(expert:"previs-director")` 需另开 registry 波次。
