import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  login,
  require_ci_info
} from "./chunk-NN2W7WFC.js";
import {
  getGlobalPathConfig
} from "./chunk-JKQWQA2T.js";
import {
  humanizePath,
  param
} from "./chunk-KDL2L4KL.js";
import {
  printError
} from "./chunk-VAFU7DXZ.js";
import {
  getCommandName
} from "./chunk-SOFC4MLS.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/login/prompt-missing-credentials.ts
var import_ci_info = __toESM(require_ci_info(), 1);
async function promptMissingCredentials(client, onLoginError) {
  const isTTY = process.stdout.isTTY;
  if (!import_ci_info.default.isCI && (isTTY || client.isAgent)) {
    output_manager_default.log(
      isTTY ? "No existing credentials found. Please log in:" : "No existing credentials found. Starting login flow..."
    );
    try {
      const result = await login(client, { shouldParseArgs: false });
      if (result !== 0) {
        return result;
      }
    } catch (error) {
      printError(error);
      onLoginError?.(error);
      return 1;
    }
    output_manager_default.debug(`Saved credentials in "${humanizePath(getGlobalPathConfig())}"`);
    return 0;
  }
  output_manager_default.prettyError({
    message: `No existing credentials found. Please run ${getCommandName("login")} or pass ${param("--token")}`,
    link: "https://err.sh/vercel/no-credentials-found"
  });
  return 1;
}

export {
  promptMissingCredentials
};
