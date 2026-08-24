import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/agent/auto-install-agentic.ts
var import_chalk = __toESM(require_source(), 1);
import { readFile, writeFile } from "fs/promises";
import { access } from "fs/promises";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { KNOWN_AGENTS } from "@vercel/detect-agent";
import { z } from "zod";
var PREFS_FILE = "agent-preferences.json";
var CLAUDE_LEGACY_PLUGIN_ID = "vercel-plugin@vercel";
var CLAUDE_OFFICIAL_PLUGIN_ID = "vercel@claude-plugins-official";
var VERCEL_PLUGIN_VERSION_URL = "https://raw.githubusercontent.com/vercel/vercel-plugin/main/.claude-plugin/plugin.json";
var AGENT_TO_TARGET = {
  [KNOWN_AGENTS.CLAUDE]: "claude-code",
  [KNOWN_AGENTS.COWORK]: "claude-code"
};
function getPluginTargetForAgent(agentName) {
  if (!agentName) {
    return void 0;
  }
  if (agentName === KNOWN_AGENTS.CLAUDE || agentName.startsWith("claude-code") || agentName === KNOWN_AGENTS.COWORK) {
    return "claude-code";
  }
  return AGENT_TO_TARGET[agentName];
}
var promptedAtSchema = z.codec(
  z.union([z.iso.date(), z.iso.datetime()]),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
);
var agentPreferencesSchema = z.object({
  pluginDeclined: z.boolean().optional(),
  pluginAutoUpdate: z.boolean().optional(),
  lastPromptedAt: promptedAtSchema.optional(),
  lastPluginAutoUpdateAttemptedAt: promptedAtSchema.optional(),
  lastPluginAutoUpdateAttemptedKey: z.string().optional()
});
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function readPrefs(client) {
  return await client.maybeReadConfig(PREFS_FILE, agentPreferencesSchema) ?? {};
}
async function writePrefs(client, prefs) {
  try {
    await client.writeConfig(PREFS_FILE, agentPreferencesSchema, prefs);
  } catch {
  }
}
function encodeClaudeProjectDir(projectPath) {
  return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}
async function projectHasUsedClaudeCode(cwd) {
  const home = homedir();
  const projectsDir = join(home, ".claude", "projects");
  let dir = resolve(cwd);
  while (dir !== home) {
    if (await fileExists(join(projectsDir, encodeClaudeProjectDir(dir)))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return false;
}
async function getPluginTargets(agentName, cwd) {
  const targetForAgent = getPluginTargetForAgent(agentName);
  if (targetForAgent) {
    return [targetForAgent];
  }
  if (agentName) {
    return [];
  }
  if (cwd && await projectHasUsedClaudeCode(cwd)) {
    return ["claude-code"];
  }
  return [];
}
async function readClaudeInstalledPluginsFromRegistry() {
  try {
    const raw = await readFile(
      getClaudeInstalledPluginsRegistryPath(),
      "utf-8"
    );
    const data = JSON.parse(raw);
    const plugins = data?.plugins ?? {};
    const entries = [];
    for (const [id, installs] of Object.entries(plugins)) {
      if (!Array.isArray(installs))
        continue;
      for (const install of installs) {
        if (!install || typeof install !== "object")
          continue;
        entries.push({
          id,
          ...install,
          enabled: true
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}
function getClaudeInstalledPluginsRegistryPath() {
  return join(homedir(), ".claude", "plugins", "installed_plugins.json");
}
async function markStaleClaudePluginInstalls(plugins) {
  return Promise.all(
    plugins.map(async (plugin) => {
      if (plugin.installPath && !await fileExists(plugin.installPath)) {
        return { ...plugin, stale: true };
      }
      return plugin;
    })
  );
}
async function removeClaudePluginFromRegistry(pluginId) {
  try {
    const registryPath = getClaudeInstalledPluginsRegistryPath();
    const raw = await readFile(registryPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data.plugins || !(pluginId in data.plugins)) {
      return false;
    }
    delete data.plugins[pluginId];
    await writeFile(
      registryPath,
      `${JSON.stringify(data, null, 2)}
`,
      "utf-8"
    );
    return true;
  } catch (err) {
    output_manager_default.debug(`Failed to remove Claude plugin registry entry: ${err}`);
    return false;
  }
}
async function isPluginInstalledForTarget(target) {
  if (target === "claude-code") {
    const status = await getClaudePluginStatus();
    return status.state === "official-only";
  }
  return false;
}
async function confirm(client, message) {
  if (client.nonInteractive || !client.stdin.isTTY) {
    return false;
  }
  return client.input.confirm(message, true);
}
function isSameDay(left, right) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}
function wasPromptedToday(prefs) {
  return prefs.lastPromptedAt ? isSameDay(prefs.lastPromptedAt, /* @__PURE__ */ new Date()) : false;
}
function wasPluginAutoUpdateAttemptedToday(prefs, attemptKey) {
  return prefs.lastPluginAutoUpdateAttemptedKey === attemptKey && !!prefs.lastPluginAutoUpdateAttemptedAt && isSameDay(prefs.lastPluginAutoUpdateAttemptedAt, /* @__PURE__ */ new Date());
}
async function markPromptedToday(client, prefs) {
  prefs.lastPromptedAt = /* @__PURE__ */ new Date();
  await writePrefs(client, prefs);
}
function markPluginAutoUpdateAttempted(prefs, attemptKey) {
  if (!attemptKey)
    return;
  prefs.lastPluginAutoUpdateAttemptedAt = /* @__PURE__ */ new Date();
  prefs.lastPluginAutoUpdateAttemptedKey = attemptKey;
}
async function runCommand(command, args) {
  return await new Promise((resolve2) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve2({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve2({ exitCode: 1, stdout, stderr: `${stderr}${String(err)}` });
    });
  });
}
async function getClaudeInstalledPlugins() {
  const result = await runCommand("claude", ["plugins", "list", "--json"]);
  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) {
        return markStaleClaudePluginInstalls(parsed);
      }
    } catch (err) {
      output_manager_default.debug(`Failed to parse Claude plugin list JSON: ${err}`);
    }
  } else if (result.stderr.trim().length > 0) {
    output_manager_default.debug(
      `Failed to run 'claude plugins list --json': ${result.stderr}`
    );
  }
  return markStaleClaudePluginInstalls(
    await readClaudeInstalledPluginsFromRegistry()
  );
}
async function fetchLatestVercelPluginVersion() {
  try {
    const response = await fetch(VERCEL_PLUGIN_VERSION_URL);
    if (!response.ok) {
      output_manager_default.debug(
        `Failed to fetch latest Vercel plugin version: ${response.status}`
      );
      return void 0;
    }
    const manifest = await response.json();
    return typeof manifest.version === "string" ? manifest.version : void 0;
  } catch (err) {
    output_manager_default.debug(`Failed to fetch latest Vercel plugin version: ${err}`);
    return void 0;
  }
}
function comparePluginVersions(a, b) {
  if (!a && !b)
    return 0;
  if (!a)
    return -1;
  if (!b)
    return 1;
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const maxLength = Math.max(left.length, right.length);
  for (let i = 0; i < maxLength; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r)
      return 1;
    if (l < r)
      return -1;
  }
  return 0;
}
function buildClaudePluginStatus(installedPlugins, latestVersion) {
  const legacy = installedPlugins.find(
    (plugin) => plugin.id === CLAUDE_LEGACY_PLUGIN_ID
  );
  const official = installedPlugins.find(
    (plugin) => plugin.id === CLAUDE_OFFICIAL_PLUGIN_ID
  );
  let state = "none";
  if (legacy && official)
    state = "both";
  else if (legacy)
    state = "legacy-only";
  else if (official)
    state = "official-only";
  return {
    state,
    legacy,
    official,
    latestVersion
  };
}
function buildClaudePluginMigrationPlan(status) {
  const plan = {
    installOfficial: false,
    updateOfficial: false,
    removeLegacy: false,
    removeLegacyMarketplace: false
  };
  switch (status.state) {
    case "none":
      plan.installOfficial = true;
      break;
    case "legacy-only":
      plan.installOfficial = true;
      plan.removeLegacy = true;
      plan.removeLegacyMarketplace = true;
      break;
    case "both":
      plan.removeLegacy = true;
      plan.removeLegacyMarketplace = true;
      break;
    case "official-only":
      break;
  }
  if (status.official?.version && status.latestVersion && comparePluginVersions(status.official.version, status.latestVersion) < 0) {
    plan.updateOfficial = true;
  }
  return plan;
}
function hasClaudeMigrationActions(plan) {
  return plan.installOfficial || plan.updateOfficial || plan.removeLegacy || plan.removeLegacyMarketplace;
}
function getClaudeAutoUpdateAttemptKey(status, plan) {
  return [
    status.state,
    status.legacy?.version ?? "none",
    status.official?.version ?? "none",
    status.latestVersion ?? "unknown",
    plan.installOfficial ? "install" : "",
    plan.updateOfficial ? "update" : "",
    plan.removeLegacy ? "remove-legacy" : "",
    plan.removeLegacyMarketplace ? "remove-marketplace" : ""
  ].join(":");
}
function buildClaudePromptCopy(status, plan) {
  if (plan.installOfficial && status.state === "none") {
    return {
      message: "Vercel Plugin for Claude Code is not installed.",
      confirm: "Would you like to install it now?"
    };
  }
  if (plan.installOfficial && status.state === "legacy-only") {
    return {
      message: "Update available for Vercel Plugin for Claude Code (legacy -> official).",
      confirm: "Would you like to update now?"
    };
  }
  if (status.state === "both" && plan.removeLegacy) {
    return {
      message: "Vercel Plugin for Claude Code has a legacy install to clean up.",
      confirm: "Would you like to update now?"
    };
  }
  if (plan.updateOfficial) {
    const fromVersion = status.official?.version;
    const toVersion = status.latestVersion;
    const versionRange = fromVersion && toVersion ? ` (v${fromVersion} -> v${toVersion})` : "";
    return {
      message: `Update available for Vercel Plugin for Claude Code${versionRange}.`,
      confirm: "Would you like to update now?"
    };
  }
  return {
    message: "The Vercel plugin needs attention in Claude Code before your agent harness is fully up to date.",
    confirm: "Apply the Vercel plugin changes for Claude Code?"
  };
}
async function runClaudeCommand(spinnerMessage, successMessage, failureMessage, args, options) {
  output_manager_default.spinner(spinnerMessage);
  const result = await runCommand("claude", args);
  output_manager_default.stopSpinner();
  if (result.exitCode === 0) {
    if (!options?.quietSuccess) {
      output_manager_default.success(successMessage);
    }
    return true;
  }
  output_manager_default.warn(failureMessage);
  output_manager_default.debug(
    `Claude command failed: claude ${args.join(" ")}
${result.stderr || result.stdout}`
  );
  return false;
}
async function removeStaleLegacyClaudePlugin(removeMarketplace) {
  output_manager_default.spinner("Removing the stale legacy Vercel Claude plugin...");
  const removedRegistryEntry = await removeClaudePluginFromRegistry(
    CLAUDE_LEGACY_PLUGIN_ID
  );
  output_manager_default.stopSpinner();
  if (!removedRegistryEntry) {
    output_manager_default.warn(
      "Could not remove the stale legacy Vercel Claude plugin registry entry."
    );
    return false;
  }
  output_manager_default.success("Removed the stale legacy Vercel Claude plugin");
  if (removeMarketplace) {
    const removedMarketplace = await runClaudeCommand(
      "Removing the legacy Vercel marketplace...",
      "Removed the legacy Vercel marketplace",
      "Removed the stale legacy Vercel plugin, but could not remove the legacy marketplace.",
      ["plugins", "marketplace", "remove", "vercel"],
      { quietSuccess: true }
    );
    if (!removedMarketplace) {
      output_manager_default.log("Cleanup command: claude plugins marketplace remove vercel");
    }
  }
  return true;
}
async function runClaudeMigration(plan) {
  let removedStaleLegacy = false;
  if (plan.removeLegacy) {
    const statusBeforeInstall = await getClaudePluginStatus();
    if (statusBeforeInstall.legacy?.stale) {
      removedStaleLegacy = await removeStaleLegacyClaudePlugin(
        plan.removeLegacyMarketplace
      );
    }
  }
  if (plan.installOfficial) {
    const installed = await runClaudeCommand(
      "Installing the official Vercel Claude plugin...",
      "Updated the Vercel plugin",
      "Failed to install the official Vercel Claude plugin.",
      ["plugins", "install", CLAUDE_OFFICIAL_PLUGIN_ID]
    );
    if (!installed) {
      return;
    }
  } else if (plan.updateOfficial) {
    await runClaudeCommand(
      "Updating the official Vercel Claude plugin...",
      "Updated the Vercel plugin",
      "Failed to update the official Vercel Claude plugin.",
      ["plugins", "update", CLAUDE_OFFICIAL_PLUGIN_ID]
    );
  }
  const statusAfterInstall = await getClaudePluginStatus();
  if (!statusAfterInstall.official) {
    output_manager_default.warn(
      "Skipping Claude cleanup because the official Vercel plugin is not installed."
    );
    return;
  }
  if (plan.removeLegacy && statusAfterInstall.legacy) {
    const removedLegacy = await runClaudeCommand(
      "Removing the legacy Vercel Claude plugin...",
      "Removed the legacy Vercel Claude plugin",
      "Installed the official Vercel Claude plugin, but could not remove the legacy install.",
      ["plugins", "uninstall", CLAUDE_LEGACY_PLUGIN_ID],
      { quietSuccess: true }
    );
    if (!removedLegacy) {
      output_manager_default.log(
        `Cleanup command: claude plugins uninstall ${CLAUDE_LEGACY_PLUGIN_ID}`
      );
      return;
    }
  }
  if (plan.removeLegacyMarketplace && !removedStaleLegacy) {
    const finalStatus = await getClaudePluginStatus();
    if (!finalStatus.legacy) {
      const removedMarketplace = await runClaudeCommand(
        "Removing the legacy Vercel marketplace...",
        "Removed the legacy Vercel marketplace",
        "Removed the legacy Vercel plugin, but could not remove the legacy marketplace.",
        ["plugins", "marketplace", "remove", "vercel"],
        { quietSuccess: true }
      );
      if (!removedMarketplace) {
        output_manager_default.log("Cleanup command: claude plugins marketplace remove vercel");
      }
    }
  }
}
async function getClaudePluginStatus() {
  const [installedPlugins, latestVersion] = await Promise.all([
    getClaudeInstalledPlugins(),
    fetchLatestVercelPluginVersion()
  ]);
  return buildClaudePluginStatus(installedPlugins, latestVersion);
}
async function applyPluginActions(targets, claudePlan) {
  for (const target of targets) {
    if (target === "claude-code" && claudePlan) {
      await runClaudeMigration(claudePlan);
    } else {
      output_manager_default.debug(`Skipping unsupported plugin target: ${target}`);
    }
  }
}
async function autoInstallVercelPlugin(client, options) {
  try {
    const prefs = await readPrefs(client);
    const applyMode = options?.mode === "apply";
    if (!prefs.pluginDeclined || prefs.pluginAutoUpdate || applyMode) {
      const targets = await getPluginTargets(client.agentName, client.cwd);
      const uninstalledTargets = [];
      const claudeStatus = targets.includes("claude-code") ? await getClaudePluginStatus() : void 0;
      const claudePlan = claudeStatus ? buildClaudePluginMigrationPlan(claudeStatus) : void 0;
      const claudeAutoUpdateAttemptKey = claudeStatus && claudePlan ? getClaudeAutoUpdateAttemptKey(claudeStatus, claudePlan) : void 0;
      for (const target of targets) {
        if (target === "claude-code") {
          if (claudePlan && hasClaudeMigrationActions(claudePlan)) {
            uninstalledTargets.push(target);
          }
          continue;
        }
        if (!await isPluginInstalledForTarget(target)) {
          uninstalledTargets.push(target);
        }
      }
      if (uninstalledTargets.length > 0) {
        if (prefs.pluginAutoUpdate) {
          if (claudeAutoUpdateAttemptKey && wasPluginAutoUpdateAttemptedToday(prefs, claudeAutoUpdateAttemptKey)) {
            return;
          }
          prefs.pluginDeclined = false;
          markPluginAutoUpdateAttempted(prefs, claudeAutoUpdateAttemptKey);
          await writePrefs(client, prefs);
          await applyPluginActions(uninstalledTargets, claudePlan);
          return;
        }
        if (!applyMode && wasPromptedToday(prefs)) {
          return;
        }
        if (applyMode) {
          prefs.pluginDeclined = false;
          prefs.pluginAutoUpdate = true;
          await writePrefs(client, prefs);
          await applyPluginActions(uninstalledTargets, claudePlan);
          return;
        }
        const promptMessages = [];
        let confirmMessage = "Install the Vercel plugin?";
        if (uninstalledTargets.includes("claude-code") && claudeStatus && claudePlan) {
          const claudePrompt = buildClaudePromptCopy(claudeStatus, claudePlan);
          promptMessages.push(claudePrompt.message);
          confirmMessage = claudePrompt.confirm;
        }
        const promptMessage = promptMessages.join(" ").trim();
        if (promptMessage) {
          output_manager_default.log(promptMessage);
        }
        const accepted = await confirm(client, confirmMessage);
        await markPromptedToday(client, prefs);
        if (accepted) {
          prefs.pluginDeclined = false;
          prefs.pluginAutoUpdate = true;
          await writePrefs(client, prefs);
          await applyPluginActions(uninstalledTargets, claudePlan);
        } else {
          prefs.pluginDeclined = true;
          prefs.pluginAutoUpdate = false;
          await writePrefs(client, prefs);
        }
      }
    }
  } catch (err) {
    output_manager_default.debug(`Auto-install agent tooling failed: ${err}`);
  }
}
async function showPluginTipIfNeeded(client) {
  try {
    const prefs = await readPrefs(client);
    if (prefs.pluginDeclined)
      return;
    const targets = await getPluginTargets(client.agentName, client.cwd);
    for (const target of targets) {
      if (!await isPluginInstalledForTarget(target)) {
        output_manager_default.log(
          import_chalk.default.dim(
            "Tip: Run `npx plugins add vercel/vercel-plugin` to enhance your agent experience"
          )
        );
        return;
      }
    }
  } catch {
  }
}

export {
  autoInstallVercelPlugin,
  showPluginTipIfNeeded
};
