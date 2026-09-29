// 專案級風格綁定（P1-8／對稱差 D34「風格是可引用 id ＋專案級綁定」）——真實行為斷言。
//
// 全部走真函式、真註冊表（`STYLE_LIBRARY`，106 條 MIT 模板）：
//   1. id 進、全文出：素材化後 prompt 含該風格的實際模板文字，且 `{prompt}` 佔位符不留
//   2. 負面詞合併走既有輪子語義（一方已包含另一方時不重複堆疊）
//   3. 未知 id：清洗回 null、素材化不套用且 prompt **逐位不變**（不半形套用、不回退第一個風格）
//   4. 優先序 request > project
//   5. 落盤白名單：合法的 styleId 保留，未知的**省略欄位**（不寫空字串冒充用戶設定）
//
// 真執行器：`npx tsx --test src/lib/canvas/project-style.test.ts`

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

/** 真實註冊表條目（不造假的風格物件；id 抄自 STYLE_LIBRARY 首條）。 */
const STYLE_ID = STYLE_LIBRARY[0].id;
const STYLE = getStyleById(STYLE_ID)!;
/** 模板去掉佔位符後仍存在的固定片段——用來證明「風格全文真的進了 prompt」。 */
const STYLE_FIXTURE_TEXT = STYLE.prompt.split("{prompt}")[0].trim();
const STYLE_NEGATIVE = STYLE.negativePrompt.trim();

test("id 進、全文出：素材化後 prompt 含風格模板實文，且不留 {prompt} 佔位符", () => {
  const resolved = resolveProjectStyle({ requestStyleId: STYLE_ID });
  assert.ok(resolved, "合法 id 應解析成功");
  assert.equal(resolved.styleId, STYLE_ID);
  assert.equal(resolved.name, STYLE.name);
  assert.equal(resolved.source, "request");

  const applied = applyProjectStyle({ style: resolved, prompt: "一台跑车", negativePrompt: "" });
  assert.equal(applied.styleId, STYLE_ID);
  assert.equal(applied.styleSource, "request");
  assert.equal(applied.prompt.includes("{prompt}"), false, "佔位符必須被消耗掉");
  assert.equal(applied.prompt.includes("一台跑车"), true, "用戶提示詞必須留在成品裡");
  assert.equal(
    applied.prompt.includes(STYLE_FIXTURE_TEXT),
    true,
    "風格的固定片段（模板實文）必須逐字進 prompt——這才是「全文素材化」",
  );
  // 負面詞：風格自己的 negative 進場（用戶沒給）。
  assert.equal(applied.negativePrompt, STYLE_NEGATIVE);
});

test("負面詞合併走既有輪子：一方已包含另一方時不重複堆疊", () => {
  const resolved = resolveProjectStyle({ requestStyleId: STYLE_ID })!;
  // 用戶負面詞是風格 negative 的子字串片段（取風格 negative 的第一個詞）→ 應收斂成風格那份。
  const firstWord = STYLE_NEGATIVE.split(",")[0].trim();
  const contained = applyProjectStyle({
    style: resolved,
    prompt: "x",
    negativePrompt: firstWord,
  });
  assert.equal(contained.negativePrompt, STYLE_NEGATIVE, "已包含 ⇒ 不重複堆疊");
  assert.equal((contained.negativePrompt ?? "").split(firstWord).length - 1, 1, "該片段只出現一次");

  // 用戶負面詞不在風格 negative 裡 ⇒ 兩者都保留（合併，不丟）。
  const merged = applyProjectStyle({
    style: resolved,
    prompt: "x",
    negativePrompt: "絕對不會出現的詞zzz",
  });
  assert.equal((merged.negativePrompt ?? "").includes("絕對不會出現的詞zzz"), true);
  assert.equal((merged.negativePrompt ?? "").includes(STYLE_NEGATIVE), true);
});

test("未知 id：清洗回 null、素材化不套用、prompt 逐位不變（不半形套用、不回退預設風格）", () => {
  assert.equal(normalizeProjectStyleId("不存在的風格"), null);
  assert.equal(normalizeProjectStyleId(""), null);
  assert.equal(normalizeProjectStyleId(undefined), null);
  assert.equal(normalizeProjectStyleId(123), null);
  // 前後空白 / 大小寫：以註冊表的字面為唯一值域（trim 後查得到才算合法）。
  assert.equal(normalizeProjectStyleId(`  ${STYLE_ID}  `), STYLE_ID, "trim 後回註冊表字面");

  const resolved = resolveProjectStyle({ requestStyleId: "不存在的風格" });
  assert.equal(resolved, null);
  const applied = applyProjectStyle({ style: resolved, prompt: "一台跑车", negativePrompt: "模糊" });
  assert.equal(applied.prompt, "一台跑车", "prompt 必須逐位不變");
  assert.equal(applied.negativePrompt, "模糊", "負面詞必須逐位不變");
  assert.equal(applied.styleId, null);
  assert.equal(applied.styleSource, "none", "明示沒套風格（不靜默）");
});

test("零風格＝逐位不變（含空負面詞 → null 的既有語義）", () => {
  const applied = applyProjectStyle({ style: null, prompt: "原始提示詞", negativePrompt: "" });
  assert.deepEqual(applied, { prompt: "原始提示詞", negativePrompt: null, styleId: null, styleSource: "none" });
});

test("優先序 request > project：呼叫端自帶的明確意圖蓋過專案綁定", () => {
  const other = STYLE_LIBRARY[1].id;
  const byRequest = resolveProjectStyle({ requestStyleId: other, projectStyleId: STYLE_ID });
  assert.equal(byRequest?.styleId, other);
  assert.equal(byRequest?.source, "request");
  const byProject = resolveProjectStyle({ requestStyleId: "", projectStyleId: STYLE_ID });
  assert.equal(byProject?.styleId, STYLE_ID);
  assert.equal(byProject?.source, "project");
  // 專案綁定的 id 已被刪除（舊資料）⇒ 解析回 null，不猜近似值。
  assert.equal(resolveProjectStyle({ requestStyleId: "", projectStyleId: "已下架的風格" }), null);
});

test("落盤白名單：合法 styleId 保留（存成註冊表字面），未知 id 省略欄位", () => {
  const base = { id: "p1", title: "t", nodes: [] };
  const kept = normalizeProject({ ...base, styleId: `  ${STYLE_ID} ` });
  assert.equal(kept?.styleId, STYLE_ID, "合法 id 應保留並正規化");
  const dropped = normalizeProject({ ...base, styleId: "不存在的風格" });
  assert.equal(dropped?.styleId, undefined, "未知 id 一律省略欄位（不寫空字串冒充）");
  assert.equal("styleId" in (dropped ?? {}), false);
  const missing = normalizeProject(base);
  assert.equal("styleId" in (missing ?? {}), false, "沒帶＝舊專案零改動");
});

test("讀取端與 agent op 清洗：canvasProjectMeta 帶出合法值，normalizeProjectMetaPatch 非法即省略該鍵", () => {
  assert.equal(canvasProjectMeta({ styleId: STYLE_ID }).styleId, STYLE_ID);
  assert.equal(canvasProjectMeta({ styleId: "不存在的風格" }).styleId, undefined);
  assert.equal("styleId" in canvasProjectMeta({}), false);

  const patch = normalizeProjectMetaPatch({ styleId: STYLE_ID, currentStep: 3 });
  assert.equal(patch.styleId, STYLE_ID);
  assert.equal(patch.currentStep, 3, "非法/缺省以外的欄位照既有語義");
  const badPatch = normalizeProjectMetaPatch({ styleId: "不存在的風格" });
  assert.equal("styleId" in badPatch, false, "非法值省略該鍵＝不動該欄，不整包作廢");
  assert.equal(Object.keys(badPatch).length, 0);
});