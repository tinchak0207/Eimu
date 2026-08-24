"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var lookup_exports = {};
__export(lookup_exports, {
  clearCachedCliInvocation: () => clearCachedCliInvocation,
  clearVercelCliLookupCache: () => clearVercelCliLookupCache,
  findVercelCli: () => findVercelCli,
  getLocalBinSearch: () => getLocalBinSearch,
  resolveCachedCliInvocation: () => resolveCachedCliInvocation,
  toVercelCliInvocation: () => toVercelCliInvocation
});
module.exports = __toCommonJS(lookup_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_envpath = require("./envpath");
var import_errutils = require("./errutils");
var import_fsutils = require("./fsutils");
var import_safety = require("./safety");
const cliInvocationCache = /* @__PURE__ */ new Map();
async function findVercelCli(options = {}) {
  const cwd = import_node_path.default.resolve(options.cwd ?? process.cwd());
  const pathValue = options.path ?? (0, import_envpath.getEnvPath)(process.env);
  const resolution = await resolveCachedCliInvocation(cwd, pathValue);
  return resolution.found ? toVercelCliInvocation(resolution) : null;
}
function resolveCachedCliInvocation(cwd, pathValue) {
  const cacheKey = getCliInvocationCacheKey(cwd, pathValue);
  if (cliInvocationCache.has(cacheKey)) {
    return cliInvocationCache.get(cacheKey);
  }
  const resolution = resolveCliInvocation(cwd, pathValue).catch((error) => {
    cliInvocationCache.delete(cacheKey);
    throw error;
  });
  cliInvocationCache.set(cacheKey, resolution);
  return resolution;
}
function toVercelCliInvocation(resolution) {
  return {
    command: resolution.command,
    commandArgs: resolution.commandArgs,
    source: resolution.source
  };
}
function clearVercelCliLookupCache() {
  cliInvocationCache.clear();
}
function clearCachedCliInvocation(cwd, pathValue) {
  cliInvocationCache.delete(getCliInvocationCacheKey(cwd, pathValue));
}
async function resolveCliInvocation(cwd, pathValue) {
  const localBinSearch = await getLocalBinSearch(cwd);
  const diagnostics = {
    localBinSearch: localBinSearch.diagnostics,
    skippedLocalBins: []
  };
  const resolvedPath = (0, import_envpath.prependPathEntries)(
    pathValue,
    localBinSearch.directories
  );
  for (const command of getVercelCommandNames()) {
    const resolvedCommand = await findCommandInPath(
      command,
      resolvedPath,
      cwd,
      localBinSearch,
      diagnostics
    );
    if (!resolvedCommand) {
      continue;
    }
    if ((0, import_fsutils.isNodeScript)(resolvedCommand.realPath)) {
      return {
        found: true,
        command: process.execPath,
        commandArgs: [resolvedCommand.realPath],
        source: resolvedCommand.source,
        diagnostics
      };
    }
    return {
      found: true,
      command: resolvedCommand.realPath,
      commandArgs: [],
      source: resolvedCommand.source,
      diagnostics
    };
  }
  return { found: false, diagnostics };
}
async function findCommandInPath(command, pathValue, cwd, localBinSearch, diagnostics) {
  for (const directory of (0, import_envpath.splitPath)(pathValue)) {
    const candidate = getPathCommandCandidate(directory, command, cwd);
    try {
      const canAccess = await canAccessCommandCandidate(
        candidate,
        localBinSearch,
        diagnostics
      );
      if (canAccess) {
        const resolvedCommand = await resolveCommandCandidate(
          command,
          candidate,
          localBinSearch,
          diagnostics
        );
        if (resolvedCommand) {
          return resolvedCommand;
        }
      }
    } catch {
    }
  }
  return null;
}
function getPathCommandCandidate(directory, command, cwd) {
  const candidateDirectory = import_node_path.default.isAbsolute(directory) ? directory : import_node_path.default.resolve(cwd, directory);
  return import_node_path.default.join(candidateDirectory, command);
}
async function canAccessCommandCandidate(candidate, localBinSearch, diagnostics) {
  try {
    await (0, import_promises.access)(
      candidate,
      process.platform === "win32" ? import_promises.constants.F_OK : import_promises.constants.F_OK | import_promises.constants.X_OK
    );
    return true;
  } catch (error) {
    if (!(0, import_errutils.isMissingPathError)(error)) {
      await recordInaccessibleLocalBinCandidate(
        candidate,
        error,
        localBinSearch,
        diagnostics
      );
    }
    return false;
  }
}
async function recordInaccessibleLocalBinCandidate(candidate, error, localBinSearch, diagnostics) {
  const localBinCandidate = await classifyPathLocalBinCandidate(
    candidate,
    localBinSearch.directories
  );
  if (!localBinCandidate) {
    return;
  }
  recordSkippedLocalBin(
    diagnostics,
    candidate,
    "reason" in localBinCandidate ? localBinCandidate.reason : `local bin is not accessible: ${(0, import_errutils.getErrorMessage)(error)}`
  );
}
async function resolveCommandCandidate(command, candidate, localBinSearch, diagnostics) {
  if (!(await (0, import_promises.stat)(candidate)).isFile()) {
    return null;
  }
  const realPath = await (0, import_promises.realpath)(candidate);
  const localBinCandidate = await classifyPathLocalBinCandidate(
    candidate,
    localBinSearch.directories
  );
  if (!localBinCandidate) {
    return { realPath, source: "path" };
  }
  if ("reason" in localBinCandidate) {
    recordSkippedLocalBin(diagnostics, candidate, localBinCandidate.reason);
    return null;
  }
  const localPackageBinResult = await getLocalVercelPackageBin(
    command,
    localBinCandidate.directory
  );
  if ("reason" in localPackageBinResult) {
    recordSkippedLocalBin(diagnostics, candidate, localPackageBinResult.reason);
    return null;
  }
  return { realPath: localPackageBinResult.binPath, source: "local-bin" };
}
function recordSkippedLocalBin(diagnostics, candidate, reason) {
  diagnostics.skippedLocalBins.push({ candidate, reason });
}
function getVercelCommandNames() {
  const commandBases = ["vercel"];
  if (process.platform !== "win32") {
    return commandBases;
  }
  const extensions = [".cmd", ".exe", ""];
  return commandBases.flatMap(
    (command) => extensions.map((extension) => `${command}${extension}`)
  );
}
async function getLocalBinSearch(cwd) {
  const searchRoot = await (0, import_fsutils.getCanonicalPath)(import_node_path.default.resolve(cwd));
  const ancestorSearch = await getAncestorDirectorySearch(searchRoot);
  const skippedNodeModules = [];
  const directories = [];
  for (const directory of ancestorSearch.directories) {
    const nodeModulesDirectory = import_node_path.default.join(directory, "node_modules");
    const parentDirectories = ancestorSearch.stopReason === "project-root-marker" ? (0, import_fsutils.getDirectoriesBetween)(ancestorSearch.stoppedAt, directory) : (0, import_fsutils.getDirectoriesBetween)(directory, searchRoot);
    const skippedReason = await (0, import_safety.getSkippedNodeModulesReason)(
      nodeModulesDirectory,
      parentDirectories
    );
    if (skippedReason) {
      skippedNodeModules.push({
        directory: nodeModulesDirectory,
        reason: skippedReason
      });
      continue;
    }
    directories.push(import_node_path.default.join(nodeModulesDirectory, ".bin"));
  }
  return {
    directories,
    diagnostics: {
      searchRoot,
      stoppedAt: ancestorSearch.stoppedAt,
      stopReason: ancestorSearch.stopReason,
      markerPath: ancestorSearch.markerPath,
      skippedNodeModules
    }
  };
}
async function getAncestorDirectorySearch(cwd) {
  const directories = [];
  let current = import_node_path.default.resolve(cwd);
  while (true) {
    directories.push(current);
    const marker = await getProjectRootMarker(current);
    if (marker) {
      return {
        directories,
        stoppedAt: current,
        stopReason: "project-root-marker",
        markerPath: marker.path
      };
    }
    const parent = import_node_path.default.dirname(current);
    if (parent === current) {
      return {
        directories,
        stoppedAt: current,
        stopReason: "filesystem-root"
      };
    }
    current = parent;
  }
}
async function getProjectRootMarker(directory) {
  const gitPath = import_node_path.default.join(directory, ".git");
  try {
    await (0, import_promises.stat)(gitPath);
    return { path: gitPath };
  } catch {
  }
  return null;
}
async function getLocalBinDirectory(filePath, localBinDirectories) {
  const resolvedFilePath = import_node_path.default.resolve(filePath);
  let canonicalFilePath = resolvedFilePath;
  try {
    canonicalFilePath = import_node_path.default.join(
      await (0, import_promises.realpath)(import_node_path.default.dirname(resolvedFilePath)),
      import_node_path.default.basename(resolvedFilePath)
    );
  } catch {
  }
  for (let localBinDirectory of localBinDirectories) {
    try {
      localBinDirectory = await (0, import_promises.realpath)(localBinDirectory);
    } catch {
    }
    if (canonicalFilePath.startsWith(`${localBinDirectory}${import_node_path.default.sep}`)) {
      return localBinDirectory;
    }
  }
  return null;
}
async function getNodeModulesBinDirectory(filePath) {
  const candidateDirectory = import_node_path.default.resolve(import_node_path.default.dirname(filePath));
  const directories = [candidateDirectory];
  try {
    const canonicalDirectory = await (0, import_promises.realpath)(candidateDirectory);
    if (!directories.includes(canonicalDirectory)) {
      directories.push(canonicalDirectory);
    }
  } catch {
  }
  for (const directory of directories) {
    if (import_node_path.default.basename(directory) === ".bin" && import_node_path.default.basename(import_node_path.default.dirname(directory)) === "node_modules") {
      return directory;
    }
  }
  return null;
}
async function classifyPathLocalBinCandidate(filePath, localBinDirectories) {
  const localBinDirectory = await getLocalBinDirectory(
    filePath,
    localBinDirectories
  );
  if (localBinDirectory) {
    return { directory: localBinDirectory };
  }
  const nodeModulesBinDirectory = await getNodeModulesBinDirectory(filePath);
  if (!nodeModulesBinDirectory) {
    return null;
  }
  const nodeModulesDirectory = import_node_path.default.dirname(nodeModulesBinDirectory);
  const skippedReason = await (0, import_safety.getSkippedNodeModulesReason)(nodeModulesDirectory);
  if (skippedReason) {
    return { reason: `local node_modules is ${skippedReason}` };
  }
  return { reason: "local bin is outside project lookup boundary" };
}
async function getLocalVercelPackageBin(command, localBinDirectory) {
  const commandBase = (0, import_fsutils.getCommandBase)(command);
  const nodeModulesDirectory = import_node_path.default.dirname(localBinDirectory);
  if (commandBase !== "vercel" || import_node_path.default.basename(nodeModulesDirectory) !== "node_modules") {
    return { reason: "not a local vercel bin" };
  }
  try {
    const localPackage = await getLocalVercelPackage(nodeModulesDirectory);
    if ("reason" in localPackage) {
      return localPackage;
    }
    const packageJsonResult = await readLocalVercelPackageJson(
      localPackage.realPackageDirectory
    );
    if ("reason" in packageJsonResult) {
      return packageJsonResult;
    }
    localPackage.packageJson = packageJsonResult.packageJson;
    return await getDeclaredLocalVercelPackageBin(localPackage, commandBase);
  } catch (error) {
    return {
      reason: `could not validate local vercel package: ${(0, import_errutils.getErrorMessage)(error)}`
    };
  }
}
async function getLocalVercelPackage(nodeModulesDirectory) {
  const packageDirectory = import_node_path.default.join(nodeModulesDirectory, "vercel");
  const realNodeModulesDirectory = await (0, import_promises.realpath)(nodeModulesDirectory);
  const realPackageDirectory = await (0, import_promises.realpath)(packageDirectory);
  if (!(0, import_fsutils.isSubpath)(realNodeModulesDirectory, realPackageDirectory)) {
    return {
      reason: "local vercel package resolves outside local node_modules"
    };
  }
  const unsafePackageDirectoryReason = await (0, import_safety.getUnsafePackageDirectoryReason)(
    realNodeModulesDirectory,
    realPackageDirectory
  );
  if (unsafePackageDirectoryReason) {
    return {
      reason: `local vercel package is unsafe: ${unsafePackageDirectoryReason}`
    };
  }
  return {
    realNodeModulesDirectory,
    realPackageDirectory,
    packageJson: {}
  };
}
async function readLocalVercelPackageJson(realPackageDirectory) {
  const packageJsonPath = import_node_path.default.join(realPackageDirectory, "package.json");
  const realPackageJsonPath = await (0, import_promises.realpath)(packageJsonPath);
  if (!(0, import_fsutils.isSubpath)(realPackageDirectory, realPackageJsonPath)) {
    return { reason: "local vercel package.json resolves outside package" };
  }
  const unsafePackageJsonReason = await (0, import_safety.getUnsafePackageFileReason)(
    realPackageDirectory,
    realPackageJsonPath
  );
  if (unsafePackageJsonReason) {
    return {
      reason: `local vercel package.json is unsafe: ${unsafePackageJsonReason}`
    };
  }
  const packageJson = JSON.parse(
    await (0, import_promises.readFile)(realPackageJsonPath, "utf8")
  );
  if (packageJson.name !== "vercel") {
    return {
      reason: 'local vercel package.json does not have name "vercel"'
    };
  }
  return { packageJson };
}
async function getDeclaredLocalVercelPackageBin(localPackage, commandBase) {
  const { packageJson, realNodeModulesDirectory, realPackageDirectory } = localPackage;
  const binTarget = getPackageBinTarget(packageJson, commandBase);
  if (!binTarget) {
    return { reason: "local vercel package does not declare bin.vercel" };
  }
  const declaredBinPath = import_node_path.default.resolve(realPackageDirectory, binTarget);
  const realDeclaredBinPath = await (0, import_promises.realpath)(declaredBinPath);
  if (!(0, import_fsutils.isSubpath)(realPackageDirectory, realDeclaredBinPath)) {
    return { reason: "local vercel package bin resolves outside package" };
  }
  const unsafePackageBinReason = await (0, import_safety.getUnsafePackageBinReason)(
    realNodeModulesDirectory,
    realPackageDirectory,
    realDeclaredBinPath
  );
  if (unsafePackageBinReason) {
    return {
      reason: `local vercel package bin is unsafe: ${unsafePackageBinReason}`
    };
  }
  if (process.platform !== "win32" && !(0, import_fsutils.isNodeScript)(realDeclaredBinPath)) {
    try {
      await (0, import_promises.access)(realDeclaredBinPath, import_promises.constants.F_OK | import_promises.constants.X_OK);
    } catch (error) {
      return {
        reason: `local vercel package bin is not executable: ${(0, import_errutils.getErrorMessage)(error)}`
      };
    }
  }
  return { binPath: realDeclaredBinPath };
}
function getPackageBinTarget(packageJson, command) {
  const bin = packageJson.bin;
  if (typeof bin === "string") {
    return command === "vercel" ? bin : null;
  }
  if (bin && typeof bin === "object") {
    const target = bin[command];
    if (typeof target === "string") {
      return target;
    }
  }
  return null;
}
function getCliInvocationCacheKey(cwd, pathValue) {
  return `${cwd}\0${pathValue}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clearCachedCliInvocation,
  clearVercelCliLookupCache,
  findVercelCli,
  getLocalBinSearch,
  resolveCachedCliInvocation,
  toVercelCliInvocation
});
//# sourceMappingURL=lookup.js.map
