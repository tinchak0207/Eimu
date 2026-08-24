import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  actorLabel,
  displayPath,
  renderThreadDetail,
  threadAge,
  truncate
} from "./chunk-WNS53IOA.js";
import {
  parseThreadArg
} from "./chunk-E336ZXPP.js";
import {
  getThread,
  handleCommentsParseError,
  inferBranch,
  listMessages,
  listThreads,
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
import "./chunk-KDYRLN6H.js";
import "./chunk-VDJN4WKH.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  inspectSubcommand
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
import "./chunk-S7KYDPEM.js";
import "./chunk-TZ2YI2VH.js";

// src/commands/comments/inspect.ts
async function pickThread(client, jsonOutput) {
  if (!canPrompt(client) || jsonOutput) {
    return outputError(
      client,
      jsonOutput,
      "MISSING_THREAD",
      "Pass a thread ID or URL: `vercel comments inspect <thread>`."
    );
  }
  const scope = await resolveCommentsScope(client, {
    requireProject: true,
    jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const focus = scope.linked ? inferBranch(client.cwd) : void 0;
  output_manager_default.spinner("Fetching comments\u2026");
  let response;
  try {
    response = await listThreads(client, scope.teamId, {
      projectId: scope.projectId,
      status: "unresolved",
      branch: focus ? [focus.value] : void 0,
      limit: 20
    });
  } finally {
    output_manager_default.stopSpinner();
  }
  if (response.threads.length === 0) {
    return outputError(
      client,
      jsonOutput,
      "NO_COMMENTS",
      `No unresolved comments${focus ? ` on ${focus.value}` : ""} to pick from.`
    );
  }
  return client.input.select({
    message: "Select a comment",
    choices: response.threads.map((thread) => ({
      name: `${threadAge(thread)}  ${actorLabel(thread.messages[0]?.author)}  ${displayPath(thread)}  \u201C${truncate(thread.messages[0]?.text ?? "", 48)}\u201D`,
      value: thread.id
    }))
  });
}
async function fetchAllMessages(client, teamId, thread) {
  if (thread.messageCount <= thread.messages.length) {
    return thread.messages;
  }
  const all = [];
  let cursor;
  do {
    const page = await listMessages(client, teamId, thread.id, {
      limit: 100,
      cursor
    });
    all.push(...page.messages);
    cursor = page.pagination?.nextCursor;
  } while (cursor && all.length < thread.messageCount);
  return all;
}
async function inspect(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(inspectSubcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    return handleCommentsParseError(err, "inspect");
  }
  const formatResult = validateJsonOutput(parsedArgs.flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  const showContext = Boolean(parsedArgs.flags["--context"]);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  telemetry.trackCliFlagContext(parsedArgs.flags["--context"]);
  telemetry.trackCliOptionProject(parsedArgs.flags["--project"]);
  const threadInput = parsedArgs.args[2];
  telemetry.trackCliArgumentThread(threadInput);
  let threadId;
  let urlTeamSlug;
  if (threadInput) {
    const parsed = parseThreadArg(threadInput);
    if (!parsed) {
      return outputError(
        client,
        jsonOutput,
        "INVALID_THREAD",
        `Could not extract a thread ID from "${threadInput}". Pass the thread ID or its vercel.com URL.`
      );
    }
    threadId = parsed.id;
    urlTeamSlug = parsed.teamSlug;
  } else {
    const picked = await pickThread(client, jsonOutput);
    if (typeof picked === "number") {
      return picked;
    }
    threadId = picked;
  }
  const scope = await resolveCommentsScope(client, {
    project: parsedArgs.flags["--project"],
    requireProject: false,
    jsonOutput,
    urlTeamSlug
  });
  if (typeof scope === "number") {
    return scope;
  }
  if (!jsonOutput) {
    output_manager_default.spinner("Fetching comment\u2026");
  }
  let thread;
  let messages;
  try {
    thread = await getThread(client, scope.teamId, threadId);
    messages = await fetchAllMessages(client, scope.teamId, thread);
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
  if (jsonOutput) {
    client.stdout.write(
      `${JSON.stringify({ ...thread, messages }, null, 2)}
`
    );
    return 0;
  }
  output_manager_default.print(`${renderThreadDetail(thread, messages, { showContext })}
`);
  return 0;
}
export {
  inspect as default
};
