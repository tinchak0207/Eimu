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
  deleteMessage,
  handleCommentsParseError,
  resolveCommentsScope,
  threadNotFoundMessage,
  toApiErrorParts
} from "./chunk-DAA5RXUK.js";
import {
  canPrompt
} from "./chunk-2473DUBR.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  deleteSubcommand
} from "./chunk-GMWRTZVZ.js";
import "./chunk-KDL2L4KL.js";
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
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/comments/delete.ts
var import_chalk = __toESM(require_source(), 1);
async function deleteCommentMessage(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(deleteSubcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    return handleCommentsParseError(err, "delete");
  }
  const formatResult = validateJsonOutput(parsedArgs.flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  const yes = Boolean(parsedArgs.flags["--yes"]);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  telemetry.trackCliFlagYes(parsedArgs.flags["--yes"]);
  const [threadInput, messageId] = parsedArgs.args.slice(2);
  telemetry.trackCliArgumentThread(threadInput);
  telemetry.trackCliArgumentMessageId(messageId);
  if (!threadInput || !messageId) {
    return outputError(
      client,
      jsonOutput,
      "MISSING_ARGUMENT",
      "Usage: `vercel comments delete <thread> <message-id>` \u2014 message IDs are shown in `vercel comments inspect`."
    );
  }
  const threadRef = parseThreadArg(threadInput);
  if (!threadRef) {
    return outputError(
      client,
      jsonOutput,
      "INVALID_THREAD",
      `Could not extract a thread ID from "${threadInput}".`
    );
  }
  const threadId = threadRef.id;
  const scope = await resolveCommentsScope(client, {
    project: parsedArgs.flags["--project"],
    requireProject: false,
    jsonOutput,
    urlTeamSlug: threadRef.teamSlug
  });
  if (typeof scope === "number") {
    return scope;
  }
  if (!yes) {
    if (!canPrompt(client) || jsonOutput) {
      return outputError(
        client,
        jsonOutput,
        "CONFIRMATION_REQUIRED",
        "Pass --yes to delete the message non-interactively."
      );
    }
    const confirmed = await client.input.confirm(
      `${import_chalk.default.red("Delete")} message ${messageId} from ${threadId} in team ${scope.teamSlug ?? scope.teamId}? This cannot be undone.`,
      false
    );
    if (!confirmed) {
      output_manager_default.log("Canceled.");
      return 0;
    }
  }
  telemetry.trackCliOptionProject(parsedArgs.flags["--project"]);
  try {
    const result = await deleteMessage(
      client,
      scope.teamId,
      threadId,
      messageId
    );
    if (jsonOutput) {
      client.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      return 0;
    }
    output_manager_default.print(`${import_chalk.default.green("\u2713")} Deleted message ${messageId}
`);
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      const { code, message } = toApiErrorParts(err);
      return outputError(
        client,
        jsonOutput,
        code,
        err.status === 404 ? threadNotFoundMessage(threadId, scope) : message
      );
    }
    throw err;
  }
}
export {
  deleteCommentMessage as default
};
