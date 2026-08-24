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
var safety_exports = {};
__export(safety_exports, {
  getSkippedNodeModulesReason: () => getSkippedNodeModulesReason,
  getUnsafeDirectoryReason: () => getUnsafeDirectoryReason,
  getUnsafePackageBinReason: () => getUnsafePackageBinReason,
  getUnsafePackageDirectoryReason: () => getUnsafePackageDirectoryReason,
  getUnsafePackageFileReason: () => getUnsafePackageFileReason,
  getUnsafeStatsReason: () => getUnsafeStatsReason
});
module.exports = __toCommonJS(safety_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_errutils = require("./errutils");
var import_fsutils = require("./fsutils");
async function getSkippedNodeModulesReason(nodeModulesDirectory, parentDirectories) {
  const parentDirectory = import_node_path.default.dirname(nodeModulesDirectory);
  parentDirectories ??= [parentDirectory];
  for (const directory of parentDirectories) {
    let unsafeParentReason;
    try {
      unsafeParentReason = await getUnsafeDirectoryReason(directory);
    } catch (error) {
      unsafeParentReason = `could not inspect: ${(0, import_errutils.getErrorMessage)(error)}`;
    }
    if (unsafeParentReason) {
      return `${directory} is ${unsafeParentReason}`;
    }
  }
  const result = await (0, import_fsutils.statIfExists)(nodeModulesDirectory);
  if ("missing" in result) {
    return null;
  }
  if ("reason" in result) {
    return result.reason;
  }
  if (!result.stats.isDirectory()) {
    return "not a directory";
  }
  const unsafeNodeModulesReason = getUnsafeStatsReason(result.stats);
  if (unsafeNodeModulesReason) {
    return unsafeNodeModulesReason;
  }
  return await getSkippedLocalBinDirectoryReason(
    import_node_path.default.join(nodeModulesDirectory, ".bin")
  );
}
async function getSkippedLocalBinDirectoryReason(localBinDirectory) {
  const result = await (0, import_fsutils.statIfExists)(localBinDirectory);
  if ("missing" in result) {
    return null;
  }
  if ("reason" in result) {
    return `${localBinDirectory} ${result.reason}`;
  }
  if (!result.stats.isDirectory()) {
    return `${localBinDirectory} is not a directory`;
  }
  const unsafeLocalBinReason = getUnsafeStatsReason(result.stats);
  return unsafeLocalBinReason ? `${localBinDirectory} is ${unsafeLocalBinReason}` : null;
}
async function getUnsafePackageBinReason(nodeModulesDirectory, packageDirectory, binPath) {
  const unsafePackageDirectoryReason = await getUnsafePackageDirectoryReason(
    nodeModulesDirectory,
    packageDirectory
  );
  if (unsafePackageDirectoryReason) {
    return unsafePackageDirectoryReason;
  }
  return await getUnsafePackageFileReason(packageDirectory, binPath);
}
async function getUnsafePackageDirectoryReason(nodeModulesDirectory, packageDirectory) {
  const directoriesToCheck = (0, import_fsutils.getDirectoriesBetween)(
    nodeModulesDirectory,
    packageDirectory
  );
  if (directoriesToCheck.length === 0) {
    return `${packageDirectory} resolves outside local node_modules`;
  }
  for (const directory of directoriesToCheck) {
    const reason = await getUnsafeDirectoryReason(directory);
    if (reason) {
      return `${directory} is ${reason}`;
    }
  }
  return null;
}
async function getUnsafePackageFileReason(packageDirectory, filePath) {
  const directoriesToCheck = (0, import_fsutils.getDirectoriesBetween)(
    packageDirectory,
    import_node_path.default.dirname(filePath)
  );
  if (directoriesToCheck.length === 0) {
    return `${filePath} resolves outside package`;
  }
  for (const directory of directoriesToCheck) {
    const reason2 = await getUnsafeDirectoryReason(directory);
    if (reason2) {
      return `${directory} is ${reason2}`;
    }
  }
  const reason = await getUnsafeFileReason(filePath);
  return reason ? `${filePath} is ${reason}` : null;
}
async function getUnsafeDirectoryReason(directory) {
  const stats = await (0, import_promises.stat)(directory);
  if (!stats.isDirectory()) {
    return "not a directory";
  }
  return getUnsafeStatsReason(stats);
}
async function getUnsafeFileReason(filePath) {
  const stats = await (0, import_promises.stat)(filePath);
  if (!stats.isFile()) {
    return "not a file";
  }
  return getUnsafeStatsReason(stats);
}
function getUnsafeStatsReason(stats) {
  const getuid = process.geteuid ?? process.getuid;
  if (typeof getuid !== "function") {
    return null;
  }
  const uid = getuid();
  if ((stats.mode & 18) !== 0) {
    if ((stats.mode & 2) !== 0) {
      return "world-writable";
    }
    return "group-writable";
  }
  if (stats.uid !== uid) {
    return `owned by uid ${stats.uid}, current uid is ${uid}`;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getSkippedNodeModulesReason,
  getUnsafeDirectoryReason,
  getUnsafePackageBinReason,
  getUnsafePackageDirectoryReason,
  getUnsafePackageFileReason,
  getUnsafeStatsReason
});
//# sourceMappingURL=safety.js.map
