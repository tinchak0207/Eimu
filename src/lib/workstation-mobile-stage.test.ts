import assert from "node:assert/strict";
import test from "node:test";
import { mobilePanelForTaskStage, workstationTaskStage } from "./workstation-mobile-stage";

test("mobile workstation follows the active task stage", () => {
  assert.equal(mobilePanelForTaskStage("prepare"), "create");
  assert.equal(mobilePanelForTaskStage("queued"), "output");
  assert.equal(mobilePanelForTaskStage("running"), "output");
  assert.equal(mobilePanelForTaskStage("succeeded"), "canvas");
  assert.equal(mobilePanelForTaskStage("failed"), "output");
});

test("task stage prefers explicit server status over stale local output", () => {
  assert.equal(workstationTaskStage({ status: "running", hasResult: true }), "running");
  assert.equal(workstationTaskStage({ status: "failed", hasResult: true }), "failed");
  assert.equal(workstationTaskStage({ status: "succeeded", hasResult: true }), "succeeded");
  assert.equal(workstationTaskStage({ submitting: true }), "queued");
  assert.equal(workstationTaskStage({}), "prepare");
});
