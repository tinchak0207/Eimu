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
  addMessage,
  handleCommentsParseError,
  resolveCommentsScope,
  threadNotFoundMessage,
  toApiErrorParts
} from "./chunk-DAA5RXUK.js";
import "./chunk-2473DUBR.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  replySubcommand
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

// src/commands/comments/reply.ts
var import_chalk = __toESM(require_source(), 1);
function validateAttachments(attach) {
  if (!attach || attach.length === 0) {
    return void 0;
  }
  if (attach.length > 10) {
    return "A message can have at most 10 attachments.";
  }
  for (const url of attach) {
    if (!/^https:\/\//i.test(url)) {
      return `Attachments must be https URLs (the API fetches them); got "${url}". Local file upload is not supported by the API.`;
    }
  }
  return void 0;
}
async function reply(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(replySubcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    return handleCommentsParseError(err, "reply");
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
  telemetry.trackCliOptionAttach(parsedArgs.flags["--attach"]);
  const threadInput = parsedArgs.args[2];
  telemetry.trackCliArgumentThread(threadInput);
  if (!threadInput) {
    return outputError(
      client,
      jsonOutput,
      "MISSING_THREAD",
      "Pass a thread ID or URL: `vercel comments reply <thread> -m <text>`."
    );
  }
  const threadRef = parseThreadArg(threadInput);
  if (!threadRef) {
    return outputError(
      client,
      jsonOutput,
      "INVALID_THREAD",
      `Could not extract a thread ID from "${threadInput}". Pass the thread ID or its vercel.com URL.`
    );
  }
  const threadId = threadRef.id;
  const attach = parsedArgs.flags["--attach"];
  const attachError = validateAttachments(attach);
  if (attachError) {
    return outputError(client, jsonOutput, "INVALID_ATTACHMENT", attachError);
  }
  const content = await resolveMessageContent(
    client,
    {
      message: parsedArgs.flags["--message"],
      file: parsedArgs.flags["--file"],
      hasAttachments: Boolean(attach && attach.length > 0)
    },
    jsonOutput
  );
  if (typeof content === "number") {
    return content;
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
  if (!jsonOutput) {
    output_manager_default.spinner("Posting reply\u2026");
  }
  try {
    const message = await addMessage(client, scope.teamId, threadId, {
      ...content !== void 0 && { markdown: content },
      ...attach && attach.length > 0 && { attachments: attach.map((url) => ({ url })) }
    });
    if (jsonOutput) {
      client.stdout.write(`${JSON.stringify(message, null, 2)}
`);
      return 0;
    }
    output_manager_default.print(`${import_chalk.default.green("\u2713")} Replied to ${threadId}
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
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  reply as default
};
