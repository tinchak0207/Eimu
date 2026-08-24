import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  require_lib
} from "./chunk-KDL2L4KL.js";
import {
  isNativeBinaryInstall
} from "./chunk-CYNB6LL4.js";
import {
  packageName
} from "./chunk-SOFC4MLS.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/get-update-command.ts
var import_fs_extra = __toESM(require_lib(), 1);
import { sep, dirname, join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { scanParentDirs } from "@vercel/build-utils";
var nativePackageName = "@vercel/vc-native";
var execFileAsync = promisify(execFile);
var globalRootQueries = {
  npm: { args: ["root", "-g"], packageDir: (root, pkg) => join(root, pkg) },
  pnpm: { args: ["root", "-g"], packageDir: (root, pkg) => join(root, pkg) },
  yarn: {
    args: ["global", "dir"],
    packageDir: (root, pkg) => join(root, "node_modules", pkg)
  }
};
async function getPackageManagerGlobalRoot(cliType) {
  try {
    const { stdout } = await execFileAsync(
      cliType,
      globalRootQueries[cliType].args,
      {
        encoding: "utf8",
        windowsHide: true
      }
    );
    const root = stdout.trim();
    return root || null;
  } catch (_) {
    return null;
  }
}
async function detectGlobalCliType(installPath, pkg) {
  for (const cliType of Object.keys(globalRootQueries)) {
    const root = await getPackageManagerGlobalRoot(cliType);
    if (!root) {
      continue;
    }
    let resolvedPackageDir;
    try {
      resolvedPackageDir = await (0, import_fs_extra.realpath)(
        globalRootQueries[cliType].packageDir(root, pkg)
      );
    } catch (_) {
      continue;
    }
    if (installPath === resolvedPackageDir || installPath.startsWith(resolvedPackageDir + sep)) {
      return cliType;
    }
  }
  return null;
}
async function getConfigPrefix() {
  const paths = [
    process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG,
    join(process.env.HOME || "/", ".npmrc"),
    process.env.npm_config_globalconfig || process.env.NPM_CONFIG_GLOBALCONFIG
  ].filter(Boolean);
  for (const configPath of paths) {
    if (!configPath) {
      continue;
    }
    const content = await (0, import_fs_extra.readFile)(configPath).then((buffer) => buffer.toString()).catch(() => null);
    if (content) {
      const [prefix] = content.split("\n").map((line) => line && line.trim()).filter((line) => line && line.startsWith("prefix")).map((line) => line.slice(line.indexOf("=") + 1).trim());
      if (prefix) {
        return prefix;
      }
    }
  }
  return null;
}
async function isPnpmHomeInstall(installPath) {
  const pnpmHome = process.env.PNPM_HOME;
  if (!pnpmHome) {
    return false;
  }
  const candidates = [pnpmHome];
  try {
    candidates.push(await (0, import_fs_extra.realpath)(pnpmHome));
  } catch (_) {
  }
  const entrypoint = process.argv[1];
  for (const home of candidates) {
    const prefix = home.endsWith(sep) ? home : home + sep;
    if (entrypoint?.startsWith(prefix) || installPath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
function isGlobalByPath(installPath) {
  if (dirname(process.argv[0]) === dirname(process.argv[1])) {
    return true;
  }
  if (installPath.includes(["", "yarn", "global", "node_modules", ""].join(sep))) {
    return true;
  }
  if (installPath.includes(["", "pnpm", "global", ""].join(sep))) {
    return true;
  }
  if (installPath.includes(["", "pnpm", "store", ""].join(sep)) && installPath.includes(sep + "links" + sep)) {
    return true;
  }
  if (installPath.includes(["", "fnm", "node-versions", ""].join(sep))) {
    return true;
  }
  return false;
}
async function isGlobalByPrefix(installPath) {
  const isWindows = process.platform === "win32";
  const defaultPath = isWindows ? process.env.APPDATA : "/usr/local/lib";
  const prefixPath = process.env.PREFIX || process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX || await getConfigPrefix() || defaultPath;
  if (!prefixPath) {
    return true;
  }
  try {
    return installPath.startsWith(await (0, import_fs_extra.realpath)(prefixPath));
  } catch (_) {
    return true;
  }
}
async function resolveInstall() {
  const pkg = isNativeBinaryInstall() ? nativePackageName : packageName;
  const installPath = await (0, import_fs_extra.realpath)(resolve(__dirname));
  if (await isPnpmHomeInstall(installPath)) {
    return { cliType: "pnpm", global: true };
  }
  const globalCliType = await detectGlobalCliType(installPath, pkg);
  if (globalCliType) {
    return { cliType: globalCliType, global: true };
  }
  let lockfileCliType;
  try {
    const entrypoint = await (0, import_fs_extra.realpath)(process.argv[1]);
    const { cliType, lockfilePath } = await scanParentDirs(
      dirname(dirname(entrypoint))
    );
    if (lockfilePath) {
      lockfileCliType = cliType;
    }
  } catch (_) {
  }
  if (!lockfileCliType) {
    return { cliType: "npm", global: true };
  }
  return {
    cliType: lockfileCliType,
    global: isGlobalByPath(installPath) || await isGlobalByPrefix(installPath)
  };
}
async function isGlobal() {
  try {
    return (await resolveInstall()).global;
  } catch (_) {
    return true;
  }
}
async function getUpdateCommandInfo() {
  const nativeInstall = isNativeBinaryInstall();
  const pkgAndVersion = `${nativeInstall ? nativePackageName : packageName}@latest`;
  if (nativeInstall) {
    const segments = process.execPath.split(sep);
    let cliType2 = "npm";
    if (segments.includes("pnpm") || segments.includes(".pnpm")) {
      cliType2 = "pnpm";
    } else if (segments.includes("yarn") || segments.includes(".yarn")) {
      cliType2 = "yarn";
    }
    const install2 = cliType2 === "yarn" ? "global add" : "i -g";
    const force = cliType2 === "npm" ? " --force" : "";
    const allowBuild2 = pnpmAllowBuildFlag(cliType2, nativePackageName);
    return {
      command: `${cliType2} ${install2} ${pkgAndVersion}${force}${allowBuild2}`,
      global: true
    };
  }
  const { cliType, global } = await resolveInstall();
  const yarn = cliType === "yarn";
  let install = yarn ? "add" : "i";
  if (global) {
    install = yarn ? "global add" : "i -g";
  }
  const allowBuild = global ? pnpmAllowBuildFlag(cliType, "esbuild") : "";
  return {
    command: `${cliType} ${install} ${pkgAndVersion}${allowBuild}`,
    global
  };
}
function pnpmAllowBuildFlag(cliType, pkg) {
  return cliType === "pnpm" ? ` --allow-build=${pkg}` : "";
}
async function getUpdateCommand() {
  return (await getUpdateCommandInfo()).command;
}

export {
  isGlobal,
  getUpdateCommandInfo,
  getUpdateCommand
};
