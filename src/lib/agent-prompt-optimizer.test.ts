import test from "node:test";
import assert from "node:assert/strict";
import { optimizeVideoPrompt, optimizeVideoPromptWithAgent } from "./agent-prompt-optimizer";
import { directVideoPrompt } from "./invisible-prompt-director";

test("agent optimizer returns unchanged prompt when no key configured", async () => {
  const prev = process.env.AGENT_OPTIMIZE_KEY;
  delete process.env.AGENT_OPTIMIZE_KEY;
  try {
    const r = await optimizeVideoPromptWithAgent("a cat on a windowsill");
    assert.equal(r.ok, false);
    assert.equal(r.prompt, "a cat on a windowsill");
    assert.equal(r.usedAgent, false);
  } finally {
    if (prev !== undefined) process.env.AGENT_OPTIMIZE_KEY = prev;
  }
});

test("agent optimizer returns unchanged on fetch failure (bad origin)", async () => {
  const prev = process.env.AGENT_OPTIMIZE_KEY;
  const prevOrigin = process.env.AGENT_GATEWAY_ORIGIN;
  process.env.AGENT_OPTIMIZE_KEY = "sk-biz-testnotfound";
  process.env.AGENT_GATEWAY_ORIGIN = "https://localhost:1";
  try {
    // 连不上 localhost:1 → 失败回原 prompt，不 throw。
    const r = await optimizeVideoPromptWithAgent("a cat on a windowsill");
    assert.equal(r.ok, false);
    assert.equal(r.usedAgent, false);
    assert.equal(r.prompt, "a cat on a windowsill");
  } finally {
    if (prev !== undefined) process.env.AGENT_OPTIMIZE_KEY = prev;
    else delete process.env.AGENT_OPTIMIZE_KEY;
    if (prevOrigin !== undefined) process.env.AGENT_GATEWAY_ORIGIN = prevOrigin;
    else delete process.env.AGENT_GATEWAY_ORIGIN;
  }
});

test("total optimizer falls back to rule layer when agent unavailable", async () => {
  const prev = process.env.AGENT_OPTIMIZE_KEY;
  const prevOrigin = process.env.AGENT_GATEWAY_ORIGIN;
  process.env.AGENT_OPTIMIZE_KEY = "sk-biz-testnotfound";
  process.env.AGENT_GATEWAY_ORIGIN = "https://localhost:1";
  try {
    const r = await optimizeVideoPrompt("a cat on a windowsill");
    assert.equal(r.usedAgent, false);
    assert.equal(r.ok, true);
    // 规则层补了运动合同尾巴（旧「稳定构图／no flicker」品质尾已由状态变化范式取代）。
    assert.match(r.prompt, /Continuous physical action drives the shot/);
  } finally {
    if (prev !== undefined) process.env.AGENT_OPTIMIZE_KEY = prev;
    else delete process.env.AGENT_OPTIMIZE_KEY;
    if (prevOrigin !== undefined) process.env.AGENT_GATEWAY_ORIGIN = prevOrigin;
    else delete process.env.AGENT_GATEWAY_ORIGIN;
  }
});

test("rule layer output is usable directly when agent disabled", () => {
  const out = directVideoPrompt("a runner crosses a bridge at dusk");
  assert.match(out, /visible physical action beat/i);
  assert.match(out, /Continuous physical action drives the shot/);
});