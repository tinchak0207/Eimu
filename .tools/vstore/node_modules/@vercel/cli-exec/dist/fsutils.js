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
var fsutils_exports = {};
__export(fsutils_exports, {
  getCanonicalPath: () => getCanonicalPath,
  getCommandBase: () => getCommandBase,
  getDirectoriesBetween: () => getDirectoriesBetween,
  isNodeScript: () => isNodeScript,
  isSubpath: () => isSubpath,
  statIfExists: () => statIfExists
});
module.exports = __toCommonJS(fsutils_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_errutils = require("./errutils");
async function getCanonicalPath(filePath) {
  try {
    return await (0, import_promises.realpath)(filePath);
  } catch {
    return filePath;
  }
}
function getDirectoriesBetween(parent, child) {
  const directories = [];
  let current = import_node_path.default.resolve(child);
  const resolvedParent = import_node_path.default.resolve(parent);
  while (true) {
    directories.push(current);
    if (current === resolvedParent) {
      return directories.reverse();
    }
    const next = import_node_path.default.dirname(current);
    if (next === current) {
      return [];
    }
    current = next;
  }
}
async function statIfExists(filePath) {
  try {
    return { stats: await (0, import_promises.stat)(filePath) };
  } catch (error) {
    if ((0, import_errutils.isMissingPathError)(error)) {
      return { missing: true };
    }
    return { reason: `could not inspect: ${(0, import_errutils.getErrorMessage)(error)}` };
  }
}
function isNodeScript(filePath) {
  return [".js", ".cjs", ".mjs"].includes(import_node_path.default.extname(filePath));
}
function isSubpath(parent, child) {
  const relativePath = import_node_path.default.relative(parent, child);
  return relativePath === "" || relativePath !== "" && !relativePath.startsWith("..") && !import_node_path.default.isAbsolute(relativePath);
}
function getCommandBase(command) {
  const extension = import_node_path.default.extname(command).toLowerCase();
  if (process.platform === "win32" && [".cmd", ".exe"].includes(extension)) {
    return import_node_path.default.basename(command, extension);
  }
  return import_node_path.default.basename(command);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getCanonicalPath,
  getCommandBase,
  getDirectoriesBetween,
  isNodeScript,
  isSubpath,
  statIfExists
});
//# sourceMappingURL=fsutils.js.map
