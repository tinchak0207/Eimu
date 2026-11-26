import test from "node:test";
import assert from "node:assert/strict";
import { parseToolParams } from "./agent-tool-params";

test("没有参数时回 null，不造空卡片", () => {
  assert.equal(parseToolParams(undefined), null);
  assert.equal(parseToolParams(""), null);
  assert.equal(parseToolParams("   "), null);
});

test("完整 JSON 分成常用层与进阶层，常用层排在前面", () => {
  const parsed = parseToolParams(
    JSON.stringify({ seed: 42, model: "gpt-image", n: 3, steps: 28, size: "1024x1024" }),
  );
  assert.ok(parsed);
  const tiers = parsed.params.map((p) => p.tier);
  // 常用层必须整块排在进阶层之前
  assert.ok(tiers.indexOf("advanced") > tiers.lastIndexOf("common"));
  const common = parsed.params.filter((p) => p.tier === "common").map((p) => p.label);
  assert.deepEqual(common, ["模型", "尺寸", "张数"]);
  const advanced = parsed.params.filter((p) => p.tier === "advanced").map((p) => p.label);
  assert.deepEqual(advanced, ["步数", "随机种子"]);
});

test("布尔与数字转成人看得懂的值", () => {
  const parsed = parseToolParams(JSON.stringify({ model: "m", generate_audio: true, steps: 20 }));
  assert.ok(parsed);
  const byLabel = new Map(parsed.params.map((p) => [p.label, p.value]));
  assert.equal(byLabel.get("步数"), "20");
  // 未知键落进阶层但保留原名，不会凭空消失
  assert.equal(byLabel.get("generate_audio"), "开");
});

test("空值不占位", () => {
  const parsed = parseToolParams(JSON.stringify({ model: "m", negative_prompt: "", seed: null }));
  assert.ok(parsed);
  assert.deepEqual(parsed.params.map((p) => p.label), ["模型"]);
});

test("同义键只留一个，张数不出现两行", () => {
  const parsed = parseToolParams(JSON.stringify({ n: 2, count: 5 }));
  assert.ok(parsed);
  assert.equal(parsed.params.filter((p) => p.label === "张数").length, 1);
  assert.equal(parsed.params[0].value, "2");
});

test("长文本标记 wide，独占一行", () => {
  const long = "一只帅气的猫坐在窗台上，暗调光影，电影感，浅景深，35mm 胶片质感";
  const parsed = parseToolParams(JSON.stringify({ prompt: long, model: "m" }));
  assert.ok(parsed);
  assert.equal(parsed.params.find((p) => p.label === "画面描述")?.wide, true);
  assert.equal(parsed.params.find((p) => p.label === "模型")?.wide, false);
});

test("网关省略号视为截断，UI 才能说出参数可能不全", () => {
  const parsed = parseToolParams('{"model":"gpt-image","prompt":"a very long promp...');
  assert.ok(parsed);
  assert.equal(parsed.truncated, true);
});

test("被截断的 JSON 仍捞得出前面几个参数", () => {
  const parsed = parseToolParams('{"model":"gpt-image","n":3,"prompt":"一只帅气的猫，暗调光影');
  assert.ok(parsed);
  const byLabel = new Map(parsed.params.map((p) => [p.label, p.value]));
  assert.equal(byLabel.get("模型"), "gpt-image");
  assert.equal(byLabel.get("张数"), "3");
  // 尾部引号被截掉也要拿到内容，不能整条丢
  assert.ok(byLabel.get("画面描述")?.includes("帅气的猫"));
  assert.equal(parsed.truncated, true);
});

test("key=value 的人话摘要也能捞", () => {
  const parsed = parseToolParams("model=gpt-image, n=2, steps=30");
  assert.ok(parsed);
  const byLabel = new Map(parsed.params.map((p) => [p.label, p.value]));
  assert.equal(byLabel.get("模型"), "gpt-image");
  assert.equal(byLabel.get("步数"), "30");
});

test("完全捞不出参数时交回原文，不硬凑参数表", () => {
  const raw = "正在为你挑选模型";
  const parsed = parseToolParams(raw);
  assert.ok(parsed);
  assert.equal(parsed.params.length, 0);
  assert.equal(parsed.raw, raw);
});

test("坏输入不抛异常", () => {
  for (const bad of ["{{{{", "]]]", '{"a":', "null", "[1,2,3]", '"just a string"']) {
    assert.doesNotThrow(() => parseToolParams(bad));
  }
});
