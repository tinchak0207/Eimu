import assert from "node:assert/strict"
import test from "node:test"
import { claimScriptEpisode, scriptBindsParents, storyboardBindsItems } from "./asset-levels"
import { runShortDramaTool } from "./index"
import { sliceAllows } from "./slices"

const parents = [{ id: "hero" }, { id: "room" }]
const items = [
  { id: "hero-coat", assetId: "hero" },
  { id: "room-night", assetId: "room" },
]

test("主编排不能写资产或出图，执行器不能改剧本", () => {
  assert.equal(sliceAllows("orchestrator", "script_scene_parse"), true)
  assert.equal(sliceAllows("orchestrator", "cast_asset_lock"), false)
  assert.equal(sliceAllows("executor", "keyframe_render"), true)
  assert.equal(sliceAllows("executor", "script_scene_parse"), false)
  const denied = runShortDramaTool("cast_asset_lock", { assets: [] }, {}, { actor: "orchestrator" })
  assert.equal(denied.status, "blocked")
  assert.equal(denied.gates.some((gate) => gate.id === "tool_slice" && !gate.passed), true)
})

test("剧本绑主资产，分镜绑子立绘", () => {
  assert.equal(scriptBindsParents(["hero"], parents, items).ok, true)
  assert.equal(scriptBindsParents(["hero-coat"], parents, items).ok, false)
  assert.equal(storyboardBindsItems([
    { characterCardIds: ["hero"], assetItemIds: ["hero-coat"] },
  ], items).ok, true)
  assert.equal(storyboardBindsItems([
    { characterCardIds: ["hero"], assetItemIds: ["room-night"] },
  ], items).ok, false)
})

test("一个剧本集只能钉一个分镜集", () => {
  const taken = { sb1: "ep-1" }
  assert.equal(claimScriptEpisode(taken, "sb1", "ep-1").ok, true)
  assert.equal(claimScriptEpisode(taken, "sb2", "ep-1").ok, false)
})

test("分镜质检在给出资产目录时要求绑子立绘，没给目录时不新增门", () => {
  const shot = {
    shotId: "s1",
    sceneId: "sc1",
    order: 1,
    prompt: "近景",
    characterCardIds: ["hero"],
    sceneCardIds: ["room"],
    durationSeconds: 6,
    keyframeId: "k",
    lastFrameId: "f",
    audioAnchorId: "a",
    aspectRatio: "9:16",
  }
  const base = {
    shots: [shot],
    lockedCharacterCardIds: ["hero"],
    lockedSceneCardIds: ["room"],
    segmentDurationSeconds: 6,
  }
  const withoutCatalog = runShortDramaTool("storyboard_qc_17", base)
  assert.equal(withoutCatalog.gates.some((gate) => gate.id === "storyboard_binds_item"), false)
  const withCatalog = runShortDramaTool("storyboard_qc_17", {
    ...base,
    assetItems: items,
    shots: [{ ...shot, assetItemIds: ["hero-coat"] }],
    storyboardEpisodeId: "sb2",
    scriptEpisodeId: "ep-1",
    episodeBindings: { sb1: "ep-1" },
  })
  assert.equal(withCatalog.gates.find((gate) => gate.id === "storyboard_binds_item")?.passed, true)
  assert.equal(withCatalog.gates.find((gate) => gate.id === "script_episode_unique")?.passed, false)
})

test("资产锁定在给出子立绘目录时拒绝把子 id 当主资产", () => {
  const locked = runShortDramaTool("cast_asset_lock", {
    assets: [{ id: "hero-coat", kind: "character", name: "大衣", appearancePrompt: "黑大衣" }],
    items,
    parents,
  })
  assert.equal(locked.gates.find((gate) => gate.id === "script_binds_parent")?.passed, false)
})
