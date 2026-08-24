import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  __commonJS,
  __require,
  __toESM
} from "./chunk-TZ2YI2VH.js";

// ../../internals/get-package-json/dist/index.js
var require_dist = __commonJS({
  "../../internals/get-package-json/dist/index.js"(exports, module) {
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
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    var src_exports = {};
    __export(src_exports, {
      getPackageJSON: () => getPackageJSON2
    });
    module.exports = __toCommonJS(src_exports);
    var import_fs = __toESM2(__require("fs"));
    var import_path = __toESM2(__require("path"));
    var import_url = __require("url");
    var cache = /* @__PURE__ */ new Map();
    function getPackageJSONPath(dir) {
      return import_path.default.join(dir, "package.json");
    }
    function captureCallerCallSite() {
      const _prepareStackTrace = Error.prepareStackTrace;
      let callSite;
      try {
        Error.prepareStackTrace = (_, stack) => stack;
        const callSites = new Error().stack;
        callSite = callSites[2];
      } finally {
        Error.prepareStackTrace = _prepareStackTrace;
      }
      return callSite;
    }
    function getPackageJSON2() {
      const callSite = captureCallerCallSite();
      let filePath = callSite.getFileName() || callSite.getEvalOrigin();
      if (filePath.startsWith("file://")) {
        filePath = (0, import_url.fileURLToPath)(filePath);
      }
      let rootDir = import_path.default.dirname(filePath);
      let packageJSONPath = getPackageJSONPath(rootDir);
      while (!import_fs.default.existsSync(packageJSONPath)) {
        rootDir = import_path.default.join(rootDir, "..");
        packageJSONPath = getPackageJSONPath(rootDir);
      }
      let packageJSON = cache.get(packageJSONPath);
      if (!packageJSON) {
        packageJSON = JSON.parse(import_fs.default.readFileSync(packageJSONPath, "utf-8"));
        cache.set(packageJSONPath, packageJSON);
      }
      return packageJSON;
    }
  }
});

// src/util/pkg.ts
var import_get_package_json = __toESM(require_dist(), 1);
var pkg_default = (0, import_get_package_json.getPackageJSON)();

export {
  pkg_default
};
