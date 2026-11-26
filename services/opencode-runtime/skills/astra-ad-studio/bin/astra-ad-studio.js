#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Astra Ad Studio

Install the Codex skill that creates finished ad campaigns in your workspace.

Usage:
  npx --yes astra-ad-studio@latest

Options:
  --help, -h   Show this help
`);
  process.exit(0);
}

console.log("Installing Astra Ad Studio...");

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "--yes",
    "skills",
    "add",
    "Kappaemme-git/astra-ad-studio",
    "-g",
    "-y",
    "--skill",
    "astra-ad-studio",
    "--agent",
    "codex"
  ],
  { stdio: "inherit" }
);

if (result.error) {
  console.error(`Could not start the installer: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
