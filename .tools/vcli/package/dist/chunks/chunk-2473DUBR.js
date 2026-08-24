import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/util/can-prompt.ts
function canPrompt(client) {
  return Boolean(client.stdin.isTTY) && !client.nonInteractive;
}

export {
  canPrompt
};
