import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  require_format
} from "./chunk-PRWJUY5U.js";
import {
  require_ms
} from "./chunk-GGP5R3FU.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/format-date.ts
var import_ms = __toESM(require_ms(), 1);
var import_chalk = __toESM(require_source(), 1);
var import_format = __toESM(require_format(), 1);
function formatDate(dateStrOrNumber) {
  if (!dateStrOrNumber) {
    return import_chalk.default.gray("-");
  }
  const date = new Date(dateStrOrNumber);
  const diff = date.getTime() - Date.now();
  return diff < 0 ? `${(0, import_format.default)(date, "DD MMMM YYYY HH:mm:ss")} ${import_chalk.default.gray(
    `[${(0, import_ms.default)(-diff)} ago]`
  )}` : `${(0, import_format.default)(date, "DD MMMM YYYY HH:mm:ss")} ${import_chalk.default.gray(
    `[in ${(0, import_ms.default)(diff)}]`
  )}`;
}
function formatDateWithoutTime(dateStrOrNumber) {
  if (!dateStrOrNumber) {
    return import_chalk.default.gray("-");
  }
  const date = new Date(dateStrOrNumber);
  const diff = date.getTime() - Date.now();
  return diff < 0 ? `${(0, import_format.default)(date, "MMM DD YYYY")} ${import_chalk.default.gray(`[${(0, import_ms.default)(-diff)} ago]`)}` : `${(0, import_format.default)(date, "MMM DD YYYY")} ${import_chalk.default.gray(`[in ${(0, import_ms.default)(diff)}]`)}`;
}

export {
  formatDate,
  formatDateWithoutTime
};
