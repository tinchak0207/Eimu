// 野兽模式（beast_mode）web 侧接线守卫测试。
//
// 覆盖三层：
// 1. 存储读取（expert-registry.readBeastMode）：缺字段/脏数据一律 false（默认 OFF，
//    零迁移零破坏）；写 true 读 true 的往返。
// 2. settings route：POST 转交前对 beast_mode 做布尔把关（=== true，否则 false）。
// 3. 设定 UI：四列开关已撤出弹层，野兽模式由输入区思考级别菜单的「极限」档承载。

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

// ── 设定 UI：野兽模式已收拢进思考级别菜单 ──────────────────────

test("设定弹层撤出四列开关；野兽模式改由输入区思考级别菜单「极限」档承载", () => {
  const ui = read("src/components/agent-chat/AgentSettingsPopover.tsx");
  // 断言去注释后的源码——头注释里解释「四列已撤」是合法的，不是渲染出来的 UI。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // 2026-10-03 暴君定案：中途输入 / 模型性格 / 成本需求 / 野兽模式 四列 UI 全撤，
  // 只留「我的技能」与「互动模式」；旧行名与开关组件一律不得回魂。
  assert.doesNotMatch(uiCode, /中途输入/, "中途输入行已撤出设定弹层");
  assert.doesNotMatch(uiCode, /模型性格/, "模型性格行已撤出设定弹层");
  assert.doesNotMatch(uiCode, /成本需求/, "成本需求行已撤出设定弹层");
  assert.doesNotMatch(uiCode, /野兽模式/, "野兽模式行已撤出设定弹层");
  assert.doesNotMatch(uiCode, /IosSwitch/, "开关组件随四列一起退役");
  assert.doesNotMatch(uiCode, /BEAST_MODE_SETTINGS_KEY/, "镜像键随野兽模式行一起退役");
  // 保留行仍在（互动模式那一列不动）。
  assert.match(ui, /互动模式/);
  assert.match(ui, /我的技能/);

  // 新承载点：思考级别菜单经既有唯一写入者 saveAgentSettings 落三栏 patch
  // （extreme → beast_mode:true 由 AGENT_THINKING_LEVEL_SETTINGS 真源定义，
  //  见 agent-chat-client.test.ts 的逐档断言）。
  // <1000 行重构：思考级别菜单在 AgentComposer.menus.tsx。
  const composer = [
    read("src/components/agent-chat/AgentComposer.tsx"),
    read("src/components/agent-chat/AgentComposer.menus.tsx"),
  ].join("\n");
  assert.match(composer, /function ThinkingLevelMenu/, "思考级别菜单必须落在输入区");
  assert.match(composer, /saveAgentSettings\(agentThinkingLevelPatch\(next\)\)/, "改档走既有设置写入链路");
});

test("client 侧 beast_mode 键与 expert-registry 常量同值（镜像守卫）", () => {
  // expert-registry 含 node:child_process 链，client 模块只能镜像字面量；
  // 该守卫防两处字面量漂移，并守 client 不吞 server-only 链。
  const registry = read("src/lib/expert-registry.ts");
  // <1000 行重构：思考级别映射在 agent-chat-client/types.ts。
  const client = [
    "src/lib/agent-chat-client.ts",
    ...["auth", "session", "settings", "transport", "types"].map(
      (m) => `src/lib/agent-chat-client/${m}.ts`,
    ),
  ]
    .map(read)
    .join("\n");
  const registryKey = registry.match(/export const BEAST_MODE_SETTINGS_KEY = "([^"]+)" as const/);
  assert.ok(registryKey, "expert-registry.ts 必须导出 BEAST_MODE_SETTINGS_KEY 字面量");
  assert.equal(registryKey[1], "beast_mode");
  // 思考级别映射真源以 beast_mode 为键（三档 false / 极限 true）。
  assert.match(client, /beast_mode: false/);
  assert.match(client, /beast_mode: true/);
  assert.doesNotMatch(client, /from "@\/lib\/expert-registry"/, "client 严禁 import server-only 链");
});
