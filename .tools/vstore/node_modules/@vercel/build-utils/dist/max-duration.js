"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var max_duration_exports = {};
__export(max_duration_exports, {
  DEFAULT_MAX_DURATION_LIMIT: () => DEFAULT_MAX_DURATION_LIMIT,
  SKIP_MAX_DURATION_LIMIT_ENV: () => SKIP_MAX_DURATION_LIMIT_ENV,
  getMaxDurationLimit: () => getMaxDurationLimit,
  getMaxDurationSchema: () => getMaxDurationSchema
});
module.exports = __toCommonJS(max_duration_exports);
const DEFAULT_MAX_DURATION_LIMIT = 1800;
const SKIP_MAX_DURATION_LIMIT_ENV = "VERCEL_CLI_SKIP_MAX_DURATION_LIMIT";
function getMaxDurationLimit() {
  if (process.env[SKIP_MAX_DURATION_LIMIT_ENV] === "1") {
    return void 0;
  }
  return DEFAULT_MAX_DURATION_LIMIT;
}
function getMaxDurationSchema() {
  const limit = getMaxDurationLimit();
  return {
    oneOf: [
      {
        type: "integer",
        minimum: 1,
        ...limit !== void 0 ? { maximum: limit } : {}
      },
      { type: "string", enum: ["max"] }
    ]
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_MAX_DURATION_LIMIT,
  SKIP_MAX_DURATION_LIMIT_ENV,
  getMaxDurationLimit,
  getMaxDurationSchema
});
