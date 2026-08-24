import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  require_strip_ansi
} from "./chunk-VAFU7DXZ.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/output/truncate.ts
var import_strip_ansi = __toESM(require_strip_ansi(), 1);
function truncateEnd(value, maxLength, opts = {}) {
  const omission = opts.omission ?? "...";
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= omission.length) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - omission.length)}${omission}`;
}
function truncateMiddle(value, maxLength, opts = {}) {
  const omission = opts.omission ?? "...";
  const comparable = opts.useVisibleLength ? (0, import_strip_ansi.default)(value) : value;
  if (comparable.length <= maxLength) {
    return value;
  }
  if (maxLength <= omission.length) {
    return comparable.slice(0, maxLength);
  }
  const available = maxLength - omission.length;
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  return `${comparable.slice(0, start)}${omission}${comparable.slice(
    comparable.length - end
  )}`;
}
function ellipsizeMiddle(value, maxLength, useVisibleLength = false) {
  return truncateMiddle(value, maxLength, {
    omission: "\u2026",
    useVisibleLength
  });
}

export {
  truncateEnd,
  truncateMiddle,
  ellipsizeMiddle
};
