import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  parseThreadArg
} from "./chunk-E336ZXPP.js";
import {
  getThread,
  handleCommentsParseError,
  resolveCommentsScope,
  threadNotFoundMessage,
  toApiErrorParts
} from "./chunk-DAA5RXUK.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import {
  openSubcommand
} from "./chunk-GMWRTZVZ.js";
import {
  require_open
} from "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import "./chunk-J5ZEHLFM.js";
import "./chunk-GGP5R3FU.js";
import "./chunk-VAFU7DXZ.js";
import {
  parseArguments
} from "./chunk-XLKFJPMT.js";
import {
  getFlagsSpecification,
  isAPIError
} from "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import "./chunk-52QYYTM5.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/comments/open.ts
var import_open = __toESM(require_open(), 1);
async function openThread(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(openSubcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    return handleCommentsParseError(err, "open");
  }
  const threadInput = parsedArgs.args[2];
  telemetry.trackCliArgumentThread(threadInput);
  if (!threadInput) {
    output_manager_default.error("Pass a thread ID or URL: `vercel comments open <thread>`.");
    return 1;
  }
  const threadRef = parseThreadArg(threadInput);
  if (!threadRef) {
    output_manager_default.error(
      `Could not extract a thread ID from "${threadInput}". Pass the thread ID or its vercel.com URL.`
    );
    return 1;
  }
  const threadId = threadRef.id;
  telemetry.trackCliOptionProject(parsedArgs.flags["--project"]);
  const scope = await resolveCommentsScope(client, {
    project: parsedArgs.flags["--project"],
    requireProject: false,
    jsonOutput: false,
    urlTeamSlug: threadRef.teamSlug
  });
  if (typeof scope === "number") {
    return scope;
  }
  let webUrl;
  try {
    const thread = await getThread(client, scope.teamId, threadId);
    webUrl = thread.webUrl;
  } catch (err) {
    if (isAPIError(err)) {
      const { code, message } = toApiErrorParts(err);
      return outputError(
        client,
        false,
        code,
        err.status === 404 ? threadNotFoundMessage(threadId, scope) : message
      );
    }
    throw err;
  }
  if (!webUrl) {
    output_manager_default.error(`The API returned no web URL for ${threadId}.`);
    return 1;
  }
  output_manager_default.log(`Opening ${webUrl}`);
  await (0, import_open.default)(webUrl);
  return 0;
}
export {
  openThread as default
};
