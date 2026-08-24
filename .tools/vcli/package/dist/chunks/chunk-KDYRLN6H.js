import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  truncateEnd
} from "./chunk-VDJN4WKH.js";

// src/util/output/ellipsis.ts
function ellipsis(str, length) {
  return truncateEnd(str, length, { omission: "\u2026" });
}

export {
  ellipsis
};
