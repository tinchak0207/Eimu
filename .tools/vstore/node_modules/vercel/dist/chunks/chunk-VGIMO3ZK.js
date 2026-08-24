import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/util/get-invalid-subcommand.ts
function getInvalidSubcommand(config) {
  return `Please specify a valid subcommand: ${Object.keys(config).join(
    " | "
  )}`;
}

export {
  getInvalidSubcommand
};
