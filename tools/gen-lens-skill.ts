/**
 * 生成 lens-language skill 的 SKILL.md（單一真源：src/lib/lens-language-library.ts）。
 *
 * 用途：VPS `/opt/agent-harness/workspace/.opencode/skills/lens-language/SKILL.md`
 * 鐵律：SKILL.md 內詞條逐字等於 library（本腳本為唯一生成路徑，禁止手改兩份）。
 *
 * 用法：npx tsx tools/gen-lens-skill.ts > /tmp/lens-language-SKILL.md
 */
import { LENS_LANGUAGE_LIBRARY, LENS_LANGUAGE_GROUP_LABELS, LENS_LANGUAGE_SOURCE } from "../src/lib/lens-language-library";

const GROUP_ORDER = [
  "composition",
  "shot_size",
  "camera_angle",
  "focal_length",
  "lens_type",
  "color_tone",
  "lighting",
  "exposure_blur",
  "camera_movement",
  "shooting_technique",
  "quality_base",
  "negative_base",
] as const;

function main(): void {
  const out: string[] = [];

  out.push("---");
  out.push("name: lens-language");
  out.push(
    "description: 镜头语言词库（景别/机位/焦段/镜头类型/色调/光线/曝光虚化/运镜/摄法/画质保底/负向词，142 条）。用户要指定「景别」「机位」「光怎么打」「怎么运镜」「什么色调」「什么构图」时，或你需要为分镜补全镜头语言时使用。取词条原文注入 §2 六槽 prompt。",
  );
  out.push("license: internal");
  out.push("metadata:");
  out.push("  audience: coding-agent");
  out.push("---");
  out.push("");
  out.push("# 镜头语言词库（Lens Language）");
  out.push("");
  out.push(
    `词条来源：${LENS_LANGUAGE_SOURCE.repo}（${LENS_LANGUAGE_SOURCE.license}），` +
      `逐字取自 ${LENS_LANGUAGE_SOURCE.file}，共 ${LENS_LANGUAGE_SOURCE.totalEntries} 条 / ${GROUP_ORDER.length} 类。`,
  );
  out.push("");
  out.push("## 我负责什么");
  out.push("");
  out.push(
    "把「用户脑子里想要的画面感觉」翻译成**专业镜头语言**。我是**词条提供者**，不是 prompt 作者：我从下表取出词条原文，交给主流程按 AGENTS.md §2 六槽拼进 prompt。",
  );
  out.push("");
  out.push("**取词纪律**：");
  out.push("");
  out.push("1. 用户点名了（如「要逆光」「用长焦」「低角度」）→ 命中即取原文，**不要改写**。");
  out.push("2. 用户只说感觉（如「高级感」）→ 你选 2-4 条最贴合的词条，取原文。");
  out.push("3. **未命中一律不取**，不许编造近似词、不许自创镜头术语。");
  out.push("4. 单次注入 ≤6 条（prompt 会爆炸）；光线类与构图类优先。");
  out.push("5. 原文含中文详解（如「逆光，主光自主體正後方射入…」），**照抄**即可，它本身就是完整描述。");
  out.push("");
  out.push("## 与 §2 六槽的对应");
  out.push("");
  out.push("| 六槽 | 从哪类取 |");
  out.push("|---|---|");
  out.push("| Format/Aspect Ratio | （比例，不属本库）|");
  out.push("| Setting/Environment | （场景，不属本库）|");
  out.push("| Lighting/Color | `lighting` + `color_tone` + `exposure_blur` |");
  out.push("| Action/Composition | `composition` + `shot_size` + `camera_angle` |");
  out.push("| Style/Art Direction | `shooting_technique` + `focal_length` + `lens_type` |");
  out.push("| Subject/Scene | （主体，不属本库）|");
  out.push("");
  out.push("运镜（`camera_movement`）用于**视频** prompt 的运镜槽；`quality_base` / `negative_base` 按需附在末尾。");
  out.push("");

  const byGroup = new Map<string, typeof LENS_LANGUAGE_LIBRARY>();
  for (const e of LENS_LANGUAGE_LIBRARY) {
    const arr = byGroup.get(e.group) ?? [];
    (arr as unknown as (typeof LENS_LANGUAGE_LIBRARY)[number][]).push(e);
    byGroup.set(e.group, arr as unknown as typeof LENS_LANGUAGE_LIBRARY);
  }

  out.push("## 词条表");
  out.push("");
  for (const g of GROUP_ORDER) {
    const entries = byGroup.get(g) ?? [];
    const label = LENS_LANGUAGE_GROUP_LABELS[g] ?? g;
    out.push(`### ${label}（\`${g}\`，${entries.length} 条）`);
    out.push("");
    out.push("| 词条 | 原文（照抄注入） |");
    out.push("|---|---|");
    for (const e of entries) {
      out.push(`| ${e.name} | ${e.text} |`);
    }
    out.push("");
  }

  out.push("## 边界（诚实声明）");
  out.push("");
  out.push("- 本库是**镜头语言描述词**，不含具体生成模型参数、不含尺寸/比例、不含模型选型。");
  out.push("- 词条原文来自 AID 开源项目，是**中文详解**；送模型前由主流程按 §0 规则转英文 prompt。");
  out.push("- 本库不保证某条词在某个模型上有效；按 AGENTS.md §3.7 能力宣称对帐，不承诺具体出图效果。");

  process.stdout.write(out.join("\n") + "\n");
}

main();
