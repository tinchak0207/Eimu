import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  elapsed
} from "./chunk-VXYGCOKL.js";

// src/util/output/stamp.ts
var stamp_default = (start = Date.now()) => {
  return () => elapsed(Date.now() - start);
};

export {
  stamp_default
};
