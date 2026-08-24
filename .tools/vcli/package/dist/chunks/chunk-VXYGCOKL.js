import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  require_ms
} from "./chunk-GGP5R3FU.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/output/elapsed.ts
var import_ms = __toESM(require_ms(), 1);
var import_chalk = __toESM(require_source(), 1);
function elapsed(time, ago = false) {
  return import_chalk.default.gray(
    `[${time < 1e3 ? `${time}ms` : (0, import_ms.default)(time)}${ago ? " ago" : ""}]`
  );
}

export {
  elapsed
};
