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
  addMessage,
  handleCommentsParseError,
  resolveCommentsScope,
  threadNotFoundMessage,
  toApiErrorParts,
  updateThread
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
  reopenSubcommand,
  resolveSubcommand
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

// src/commands/comments/resolve.ts
var import_chalk = __toESM(require_source(), 1);
async function resolveThreads(client, telemetry, resolved) {
  const subcommand = resolved ? resolveSubcommand : reopenSubcommand;
  const verb = resolved ? "resolve" : "reopen";
  const pastVerb = resolved ? "resolved" : "reopened";
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(subcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    return handleCommentsParseError(err, subcommand.name);
  }
  const formatResult = validateJsonOutput(parsedArgs.flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  const closingMessage = resolved ? parsedArgs.flags["--message"] : void 0;
  const yes = Boolean(parsedArgs.flags["--yes"]);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  telemetry.trackCliFlagYes(parsedArgs.flags["--yes"]);
  if (resolved) {
    telemetry.trackCliOptionMessage(closingMessage);
  }
  const threadInputs = parsedArgs.args.slice(2);
  telemetry.trackCliArgumentThread(threadInputs[0]);
  if (threadInputs.length === 0) {
    return outputError(
      client,
      jsonOutput,
      "MISSING_THREAD",
      `Pass at least one thread ID or URL: \`vercel comments ${verb} <thread>\`.`
    );
  }
  const threadIds = [];
  let urlTeamSlug;
  for (const input of threadInputs) {
    const ref = parseThreadArg(input);
    if (!ref) {
      return outputError(
        client,
        jsonOutput,
        "INVALID_THREAD",
        `Could not extract a thread ID from "${input}".`
      );
    }
    if (ref.teamSlug) {
      if (urlTeamSlug && urlTeamSlug !== ref.teamSlug) {
        return outputError(
          client,
          jsonOutput,
          "MIXED_TEAMS",
          `The URLs belong to different teams (${urlTeamSlug}, ${ref.teamSlug}). Run once per team.`
        );
      }
      urlTeamSlug = ref.teamSlug;
    }
    threadIds.push(ref.id);
  }
  if (closingMessage !== void 0 && threadIds.length > 1) {
    return outputError(
      client,
      jsonOutput,
      "MESSAGE_WITH_MULTIPLE_THREADS",
      "Cannot use -m with multiple threads. Resolve one thread with a closing message, or resolve multiple threads without -m."
    );
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
  if (threadIds.length > 1 && !yes) {
    if (!canPrompt(client) || jsonOutput) {
      return outputError(
        client,
        jsonOutput,
        "CONFIRMATION_REQUIRED",
        `Pass --yes to ${verb} ${threadIds.length} comments non-interactively.`
      );
    }
    const confirmed = await client.input.confirm(
      `${import_chalk.default.bold(String(threadIds.length))} comments will be ${pastVerb} in team ${scope.teamSlug ?? scope.teamId}. Continue?`,
      false
    );
    if (!confirmed) {
      output_manager_default.log("Canceled.");
      return 0;
    }
  }
  telemetry.trackCliOptionProject(
    parsedArgs.flags["--project"]
  );
  if (threadIds.length === 1) {
    const threadId = threadIds[0];
    let replied = false;
    try {
      if (closingMessage !== void 0) {
        await addMessage(client, scope.teamId, threadId, {
          markdown: closingMessage
        });
        replied = true;
      }
      const thread = await updateThread(
        client,
        scope.teamId,
        threadId,
        resolved
      );
      if (jsonOutput) {
        client.stdout.write(
          `${JSON.stringify({ thread, replied }, null, 2)}
`
        );
        return 0;
      }
      output_manager_default.print(
        `${import_chalk.default.green("\u2713")} ${threadId} ${pastVerb}${replied ? " (with closing reply)" : ""}
`
      );
      return 0;
    } catch (err) {
      if (isAPIError(err)) {
        const { code, message } = toApiErrorParts(err);
        const friendly = err.status === 404 ? threadNotFoundMessage(threadId, scope) : message;
        return outputError(
          client,
          jsonOutput,
          code,
          replied ? `Replied, but ${verb} failed: ${friendly} Run \`vercel comments resolve ${threadId}\` (without -m) to finish without duplicating the reply.` : friendly
        );
      }
      throw err;
    }
  }
  const results = [];
  for (const threadId of threadIds) {
    try {
      await updateThread(client, scope.teamId, threadId, resolved);
      results.push({ id: threadId, ok: true });
    } catch (err) {
      if (isAPIError(err)) {
        const { message } = toApiErrorParts(err);
        results.push({ id: threadId, ok: false, error: message });
      } else {
        throw err;
      }
    }
  }
  const failed = results.filter((result) => !result.ok);
  if (jsonOutput) {
    client.stdout.write(`${JSON.stringify({ results }, null, 2)}
`);
    return failed.length > 0 ? 1 : 0;
  }
  for (const result of results) {
    if (result.ok) {
      output_manager_default.print(`${import_chalk.default.green("\u2713")} ${result.id} ${pastVerb}
`);
    } else {
      output_manager_default.print(`${import_chalk.default.yellow("!")} ${result.id} ${result.error}
`);
    }
  }
  return failed.length > 0 ? 1 : 0;
}
export {
  resolveThreads as default
};
