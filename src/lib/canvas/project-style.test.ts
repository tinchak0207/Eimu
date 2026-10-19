// 专案级风格绑定（P1-8／对称差 D34「风格是可引用 id ＋专案级绑定」）——真实行为断言。
//
// 全部走真函式、真注册表（`STYLE_LIBRARY`，106 条 MIT 模板）：
//   1. id 进、全文出：素材化后 prompt 含该风格的实际模板文字，且 `{prompt}` 占位符不留
//   2. 负面词合并走既有轮子语义（一方已包含另一方时不重复堆叠）
//   3. 未知 id：清洗回 null、素材化不套用且 prompt **逐位不变**（不半形套用、不回退第一个风格）
//   4. 优先序 request > project
//   5. 落盘白名单：合法的 styleId 保留，未知的**省略栏位**（不写空字串冒充用户设定）
//
// 真执行器：`npx tsx --test src/lib/canvas/project-style.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProjectStyle,
  normalizeProjectStyleId,
  resolveProjectStyle,
} from "./project-style";
import { getStyleById, STYLE_LIBRARY } from "../style-library";
import { normalizeProject } from "./project-store";
import { canvasProjectMeta, normalizeProjectMetaPatch } from "./layout";

/** 真实注册表条目（不造假的风格物件；id 抄自 STYLE_LIBRARY 首条）。 */
const STYLE_ID = STYLE_LIBRARY[0].id;
const STYLE = getStyleById(STYLE_ID)!;
/** 模板去掉占位符后仍存在的固定片段——用来证明「风格全文真的进了 prompt」。 */
const STYLE_FIXTURE_TEXT = STYLE.prompt.split("{prompt}")[0].trim();
const STYLE_NEGATIVE = STYLE.negativePrompt.trim();

test("id 进、全文出：素材化后 prompt 含风格模板实文，且不留 {prompt} 占位符", () => {
  const resolved = resolveProjectStyle({ requestStyleId: STYLE_ID });
  assert.ok(resolved, "合法 id 应解析成功");
  assert.equal(resolved.styleId, STYLE_ID);
  assert.equal(resolved.name, STYLE.name);
  assert.equal(resolved.source, "request");

  const applied = applyProjectStyle({ style: resolved, prompt: "一台跑车", negativePrompt: "" });
  assert.equal(applied.styleId, STYLE_ID);
  assert.equal(applied.styleSource, "request");
  assert.equal(applied.prompt.includes("{prompt}"), false, "占位符必须被消耗掉");
  assert.equal(applied.prompt.includes("一台跑车"), true, "用户提示词必须留在成品里");
  assert.equal(
    applied.prompt.includes(STYLE_FIXTURE_TEXT),
    true,
    "风格的固定片段（模板实文）必须逐字进 prompt——这才是「全文素材化」",
  );
  // 负面词：风格自己的 negative 进场（用户没给）。
  assert.equal(applied.negativePrompt, STYLE_NEGATIVE);
});

test("负面词合并走既有轮子：一方已包含另一方时不重复堆叠", () => {
  const resolved = resolveProjectStyle({ requestStyleId: STYLE_ID })!;
  // 用户负面词是风格 negative 的子字串片段（取风格 negative 的第一个词）→ 应收敛成风格那份。
  const firstWord = STYLE_NEGATIVE.split(",")[0].trim();
  const contained = applyProjectStyle({
    style: resolved,
    prompt: "x",
    negativePrompt: firstWord,
  });
  assert.equal(contained.negativePrompt, STYLE_NEGATIVE, "已包含 ⇒ 不重复堆叠");
  assert.equal((contained.negativePrompt ?? "").split(firstWord).length - 1, 1, "该片段只出现一次");

  // 用户负面词不在风格 negative 里 ⇒ 两者都保留（合并，不丢）。
  const merged = applyProjectStyle({
    style: resolved,
    prompt: "x",
    negativePrompt: "绝对不会出现的词zzz",
  });
  assert.equal((merged.negativePrompt ?? "").includes("绝对不会出现的词zzz"), true);
  assert.equal((merged.negativePrompt ?? "").includes(STYLE_NEGATIVE), true);
});

test("未知 id：清洗回 null、素材化不套用、prompt 逐位不变（不半形套用、不回退预设风格）", () => {
  assert.equal(normalizeProjectStyleId("不存在的风格"), null);
  assert.equal(normalizeProjectStyleId(""), null);
  assert.equal(normalizeProjectStyleId(undefined), null);
  assert.equal(normalizeProjectStyleId(123), null);
  // 前后空白 / 大小写：以注册表的字面为唯一值域（trim 后查得到才算合法）。
  assert.equal(normalizeProjectStyleId(`  ${STYLE_ID}  `), STYLE_ID, "trim 后回注册表字面");

  const resolved = resolveProjectStyle({ requestStyleId: "不存在的风格" });
  assert.equal(resolved, null);
  const applied = applyProjectStyle({ style: resolved, prompt: "一台跑车", negativePrompt: "模糊" });
  assert.equal(applied.prompt, "一台跑车", "prompt 必须逐位不变");
  assert.equal(applied.negativePrompt, "模糊", "负面词必须逐位不变");
  assert.equal(applied.styleId, null);
  assert.equal(applied.styleSource, "none", "明示没套风格（不静默）");
});

test("零风格＝逐位不变（含空负面词 → null 的既有语义）", () => {
  const applied = applyProjectStyle({ style: null, prompt: "原始提示词", negativePrompt: "" });
  assert.deepEqual(applied, { prompt: "原始提示词", negativePrompt: null, styleId: null, styleSource: "none" });
});

test("优先序 request > project：呼叫端自带的明确意图盖过专案绑定", () => {
  const other = STYLE_LIBRARY[1].id;
  const byRequest = resolveProjectStyle({ requestStyleId: other, projectStyleId: STYLE_ID });
  assert.equal(byRequest?.styleId, other);
  assert.equal(byRequest?.source, "request");
  const byProject = resolveProjectStyle({ requestStyleId: "", projectStyleId: STYLE_ID });
  assert.equal(byProject?.styleId, STYLE_ID);
  assert.equal(byProject?.source, "project");
  // 专案绑定的 id 已被删除（旧资料）⇒ 解析回 null，不猜近似值。
  assert.equal(resolveProjectStyle({ requestStyleId: "", projectStyleId: "已下架的风格" }), null);
});

test("落盘白名单：合法 styleId 保留（存成注册表字面），未知 id 省略栏位", () => {
  const base = { id: "p1", title: "t", nodes: [] };
  const kept = normalizeProject({ ...base, styleId: `  ${STYLE_ID} ` });
  assert.equal(kept?.styleId, STYLE_ID, "合法 id 应保留并正规化");
  const dropped = normalizeProject({ ...base, styleId: "不存在的风格" });
  assert.equal(dropped?.styleId, undefined, "未知 id 一律省略栏位（不写空字串冒充）");
  assert.equal("styleId" in (dropped ?? {}), false);
  const missing = normalizeProject(base);
  assert.equal("styleId" in (missing ?? {}), false, "没带＝旧专案零改动");
});

test("读取端与 agent op 清洗：canvasProjectMeta 带出合法值，normalizeProjectMetaPatch 非法即省略该键", () => {
  assert.equal(canvasProjectMeta({ styleId: STYLE_ID }).styleId, STYLE_ID);
  assert.equal(canvasProjectMeta({ styleId: "不存在的风格" }).styleId, undefined);
  assert.equal("styleId" in canvasProjectMeta({}), false);

  const patch = normalizeProjectMetaPatch({ styleId: STYLE_ID, currentStep: 3 });
  assert.equal(patch.styleId, STYLE_ID);
  assert.equal(patch.currentStep, 3, "非法/缺省以外的栏位照既有语义");
  const badPatch = normalizeProjectMetaPatch({ styleId: "不存在的风格" });
  assert.equal("styleId" in badPatch, false, "非法值省略该键＝不动该栏，不整包作废");
  assert.equal(Object.keys(badPatch).length, 0);
});