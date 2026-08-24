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
var node_entrypoint_exports = {};
__export(node_entrypoint_exports, {
  isNodeEntrypoint: () => isNodeEntrypoint
});
module.exports = __toCommonJS(node_entrypoint_exports);
var import_fs = __toESM(require("fs"));
var import_es_module_lexer = require("es-module-lexer");
var import_cjs_module_lexer = require("cjs-module-lexer");
var import_debug = __toESM(require("./debug"));
var import_strip_comments_and_literals = require("./strip-comments-and-literals");
const HANDLER_EXPORTS = /* @__PURE__ */ new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "fetch",
  "default"
]);
const EXTRA_HANDLER_PATTERNS = [
  /\bmodule\.exports\s*=(?!=)/,
  /\.listen\s*\(/,
  /\bexport\s*=(?!=)/,
  /\bexport\s*\*\s*from\b/
];
async function getHandlerExportNames(content) {
  const names = /* @__PURE__ */ new Set();
  let esmUnparsed = false;
  await import_es_module_lexer.init;
  try {
    const [, exports] = (0, import_es_module_lexer.parse)(content);
    for (const { n } of exports) {
      if (n)
        names.add(n);
    }
  } catch {
    esmUnparsed = true;
  }
  await (0, import_cjs_module_lexer.init)();
  try {
    for (const name of (0, import_cjs_module_lexer.parse)(content).exports) {
      names.add(name);
    }
  } catch {
  }
  return { names, esmUnparsed };
}
async function isNodeEntrypoint(file) {
  try {
    const fsPath = file.fsPath;
    if (!fsPath)
      return true;
    const content = await import_fs.default.promises.readFile(fsPath, "utf-8");
    if (!content.trim())
      return false;
    const { names, esmUnparsed } = await getHandlerExportNames(content);
    for (const name of names) {
      if (HANDLER_EXPORTS.has(name))
        return true;
    }
    if (esmUnparsed)
      return true;
    const code = (0, import_strip_comments_and_literals.stripCommentsAndLiterals)(content);
    return EXTRA_HANDLER_PATTERNS.some((pattern) => pattern.test(code));
  } catch (err) {
    (0, import_debug.default)(`Failed to check Node.js entrypoint: ${err}`);
    return true;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isNodeEntrypoint
});
