// 野兽模式（beast_mode）web 侧接线守卫测试。
//
// 覆盖三层：
// 1. 存储读取（expert-registry.readBeastMode）：缺字段/脏数据一律 false（默认 OFF，
//    零迁移零破坏）；写 true 读 true 的往返。
// 2. settings route：POST 转交前对 beast_mode 做布尔把关（=== true，否则 false）。
// 3. 设定 UI：野兽模式行存在、复用 IosSwitch、副文案锁定。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEAST_MODE_SETTINGS_KEY, readBeastMode } from "../../../../lib/expert-registry.ts";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

// ── 存储读取：默认 OFF ───────────────────────────────────────

test("readBeastMode：缺字段/非布林/非物件一律 false（默认 OFF，零迁移）", () => {
  assert.equal(readBeastMode(undefined), false);
  assert.equal(readBeastMode(null), false);
  assert.equal(readBeastMode("settings"), false);
  assert.equal(readBeastMode({}), false, "缺 beast_mode 字段 = OFF");
  assert.equal(readBeastMode({ [BEAST_MODE_SETTINGS_KEY]: false }), false);
  assert.equal(readBeastMode({ [BEAST_MODE_SETTINGS_KEY]: "true" }), false, "字符串脏数据 = OFF");
  assert.equal(readBeastMode({ [BEAST_MODE_SETTINGS_KEY]: 1 }), false, "数字脏数据 = OFF");
  assert.equal(readBeastMode({ [BEAST_MODE_SETTINGS_KEY]: null }), false);
});

test("readBeastMode：写入 true → 读出 true（写入读取往返）", () => {
  const on = { [BEAST_MODE_SETTINGS_KEY]: true };
  assert.equal(readBeastMode(on), true);
  // 往返第二拍：关回 false 后读到 false（toggle 可逆）。
  const off = { ...on, [BEAST_MODE_SETTINGS_KEY]: false };
  assert.equal(readBeastMode(off), false);
  assert.equal(BEAST_MODE_SETTINGS_KEY, "beast_mode");
});

// ── settings route：布尔把关 ─────────────────────────────────

test("settings route 在转交网关前把 beast_mode 规整为布尔（非 true 一律 false）", () => {
  const route = read("src/app/api/agent/settings/route.ts");
  assert.match(route, /import \{ BEAST_MODE_SETTINGS_KEY \} from "@\/lib\/expert-registry"/);
  assert.match(route, /BEAST_MODE_SETTINGS_KEY in body/);
  assert.match(route, /\[BEAST_MODE_SETTINGS_KEY\] === true/);
});

// ── 设定 UI：野兽模式行 ──────────────────────────────────────

test("设定弹层新增野兽模式开关（默认关 + 复用 IosSwitch + 状态字与双态副文案）", () => {
  const ui = read("src/components/agent-chat/AgentSettingsPopover.tsx");
  assert.match(ui, /野兽模式/);
  // 关闭态：状态字「常规」+ 副文案（留给硬核点子）。
  assert.match(ui, /beastMode \? "极限" : "常规"/);
  assert.match(ui, /大部分场合不需要开启，留给真正硬核的点子/);
  // 开启态：状态字「极限」（紫色）+ 副文案（拼尽全力）。
  assert.match(ui, /模型使用所有工具协助，拼尽全力达到最完美的效果，满足追求极限的你/);
  // 开启态：状态字「极限」转紫并加粗（关闭态与其他行状态字同款灰、同字号）。
  assert.match(ui, /beastMode && "font-medium text-purple-600"/);
  assert.match(ui, /<IosSwitch checked=\{beastMode\} onChange=\{updateBeastMode\}/);
  assert.match(ui, /useState<boolean>\(false\)/, "野兽模式默认 OFF");
  // Wave1-C 后半起 beast_mode 已转正进 sanitize 白名单：开关改走
  // saveAgentSettings 标准链路（裸 fetch 透传退役）。
  assert.match(ui, /saveAgentSettings\(\{ \[BEAST_MODE_SETTINGS_KEY\]: next \}\)/, "开关走标准链路持久化");
});

test("client 弹层的 beast_mode 键与 expert-registry 常量同值（镜像守卫）", () => {
  // expert-registry 含 node:child_process 链，client 组件只能镜像字面量；
  // 该守卫防两处字面量漂移。
  const registry = read("src/lib/expert-registry.ts");
  const ui = read("src/components/agent-chat/AgentSettingsPopover.tsx");
  const registryKey = registry.match(/export const BEAST_MODE_SETTINGS_KEY = "([^"]+)" as const/);
  const uiKey = ui.match(/const BEAST_MODE_SETTINGS_KEY = "([^"]+)" as const/);
  assert.ok(registryKey, "expert-registry.ts 必须导出 BEAST_MODE_SETTINGS_KEY 字面量");
  assert.ok(uiKey, "弹层必须定义镜像常量");
  assert.equal(uiKey[1], registryKey[1]);
  assert.equal(uiKey[1], "beast_mode");
  assert.doesNotMatch(ui, /from "@\/lib\/expert-registry"/, "client 严禁 import server-only 链");
});
