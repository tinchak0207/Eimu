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
var envpath_exports = {};
__export(envpath_exports, {
  getEnvPath: () => getEnvPath,
  prependPathEntries: () => prependPathEntries,
  setEnvPath: () => setEnvPath,
  splitPath: () => splitPath
});
module.exports = __toCommonJS(envpath_exports);
var import_node_path = __toESM(require("node:path"));
function prependPathEntries(pathValue, directories) {
  const pathParts = pathValue.split(import_node_path.default.delimiter).filter(Boolean);
  const prepended = [];
  for (const directory of directories) {
    if (!pathParts.includes(directory) && !prepended.includes(directory)) {
      prepended.push(directory);
    }
  }
  if (prepended.length === 0) {
    return pathValue;
  }
  return pathValue === "" || pathValue === import_node_path.default.delimiter ? `${prepended.join(import_node_path.default.delimiter)}${pathValue}` : [...prepended, pathValue].join(import_node_path.default.delimiter);
}
function splitPath(pathValue) {
  return pathValue.split(import_node_path.default.delimiter).filter(Boolean);
}
function getEnvPath(env = process.env) {
  if (process.platform !== "win32") {
    return env.PATH ?? "";
  }
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  for (let index = pathKeys.length - 1; index >= 0; index--) {
    const value = env[pathKeys[index]];
    if (value !== void 0) {
      return value;
    }
  }
  return "";
}
function setEnvPath(env = process.env, pathValue) {
  if (process.platform !== "win32") {
    return {
      ...env,
      PATH: pathValue
    };
  }
  const normalizedEnv = { ...env };
  for (const key of Object.keys(normalizedEnv)) {
    if (key !== "PATH" && key.toLowerCase() === "path") {
      delete normalizedEnv[key];
    }
  }
  normalizedEnv.PATH = pathValue;
  return normalizedEnv;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getEnvPath,
  prependPathEntries,
  setEnvPath,
  splitPath
});
//# sourceMappingURL=envpath.js.map
