import assert from "node:assert/strict";
import test from "node:test";
import { WORKSTATION_COMMANDS, workstationCommandForKey } from "./workstation-commands";

test("workstation command registry has unique actions and visible shortcuts", () => {
  assert.equal(new Set(WORKSTATION_COMMANDS.map((command) => command.id)).size, WORKSTATION_COMMANDS.length);
  assert.ok(WORKSTATION_COMMANDS.every((command) => command.label && command.shortcut && command.description));
});

test("workstation shortcuts respect editable, IME and modal boundaries", () => {
  assert.equal(workstationCommandForKey({ key: "Enter", ctrlKey: true, editable: true }), "run");
  assert.equal(workstationCommandForKey({ key: "l", editable: true }), null);
  assert.equal(workstationCommandForKey({ key: "q", composing: true }), null);
  assert.equal(workstationCommandForKey({ key: "g", modalOpen: true }), null);
  assert.equal(workstationCommandForKey({ key: "Escape", modalOpen: true }), "close_overlay");
  assert.equal(workstationCommandForKey({ key: "r" }), "reuse_result");
});
