import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  resolveMessageContent
} from "./chunk-PIMIKY4X.js";
import {
  parseThreadArg
} from "./chunk-E336ZXPP.js";
import {
  handleCommentsParseError,
  resolveCommentsScope,
  threadNotFoundMessage,
  toApiErrorParts,
  updateMessage
} from "./chunk-DAA5RXUK.js";
import "./chunk-2473DUBR.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  editSubcommand
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

// src/commands/comments/edit.ts
var import_chalk = __toESM(require_source(), 1);
async function edit(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(editSubcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    return handleCommentsParseError(err, "edit");
  }
  const formatResult = validateJsonOutput(parsedArgs.flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  telemetry.trackCliOptionMessage(parsedArgs.flags["--message"]);
  telemetry.trackCliOptionFile(parsedArgs.flags["--file"]);
  const [threadInput, messageId] = parsedArgs.args.slice(2);
  telemetry.trackCliArgumentThread(threadInput);
  telemetry.trackCliArgumentMessageId(messageId);
  if (!threadInput || !messageId) {
    return outputError(
      client,
      jsonOutput,
      "MISSING_ARGUMENT",
      "Usage: `vercel comments edit <thread> <message-id> -m <text>` \u2014 message IDs are shown in `vercel comments inspect`."
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
  const content = await resolveMessageContent(
    client,
    {
      message: parsedArgs.flags["--message"],
      file: parsedArgs.flags["--file"]
    },
    jsonOutput
  );
  if (typeof content === "number") {
    return content;
  }
  if (content === void 0) {
    return outputError(
      client,
      jsonOutput,
      "MISSING_CONTENT",
      "Pass the new content with -m <text> or --file <path>."
    );
  }
  telemetry.trackCliOptionProject(parsedArgs.flags["--project"]);
  const scope = await resolveCommentsScope(client, {
    project: parsedArgs.flags["--project"],
    requireProject: false,
    jsonOutput,
    urlTeamSlug: threadRef.teamSlug
  });
  if (typeof scope === "number") {
    return scope;
  }
  try {
    const message = await updateMessage(
      client,
      scope.teamId,
      threadId,
      messageId,
      { markdown: content }
    );
    if (jsonOutput) {
      client.stdout.write(`${JSON.stringify(message, null, 2)}
`);
      return 0;
    }
    output_manager_default.print(`${import_chalk.default.green("\u2713")} Edited message ${messageId}
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
  edit as default
};
