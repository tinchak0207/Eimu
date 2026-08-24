import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  repositoryPath
} from "./chunk-BEQV3X2L.js";
import {
  emitVcrArgParseError,
  handleVcrApiError,
  requireVcrRepository,
  resolveVcrScope,
  validateVcrChoice,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  configSubcommand
} from "./chunk-2MF3ZAVW.js";
import "./chunk-WC7IINFV.js";
import "./chunk-RIB4S2IB.js";
import "./chunk-GFCTRJI5.js";
import "./chunk-R6IGDGX3.js";
import "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import {
  AGENT_REASON,
  buildCommandWithGlobalFlags,
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import "./chunk-GGP5R3FU.js";
import {
  printError
} from "./chunk-VAFU7DXZ.js";
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

// src/commands/vcr/config.ts
var USAGE = "vcr config <repository> --public <true|false>";
async function config(client, argv, telemetry) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(configSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(client, err, USAGE);
    printError(err);
    return 1;
  }
  const fr = validateVcrJsonOutput(client, parsedArgs.flags);
  if (typeof fr === "number") {
    return fr;
  }
  const repository = parsedArgs.args[0];
  const project = parsedArgs.flags["--project"];
  const publicValue = parsedArgs.flags["--public"];
  const invalidChoice = validateVcrChoice(
    client,
    "--public",
    publicValue,
    ["true", "false"],
    fr.jsonOutput
  );
  if (typeof invalidChoice === "number") {
    return invalidChoice;
  }
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  telemetry.trackCliOptionPublic(publicValue);
  const missingRepository = requireVcrRepository(
    client,
    repository,
    fr.jsonOutput,
    USAGE
  );
  if (typeof missingRepository === "number") {
    return missingRepository;
  }
  if (publicValue === void 0) {
    const message = "Missing a setting to change. Pass --public true to make the repository public, or --public false to make it private.";
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message,
        next: [
          {
            command: buildCommandWithGlobalFlags(client.argv, USAGE),
            when: "Re-run with --public true or --public false"
          }
        ]
      },
      1
    );
    return outputError(client, fr.jsonOutput, "MISSING_ARGUMENTS", message);
  }
  const desiredPublic = publicValue === "true";
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const path = repositoryPath(scope, repository);
  output_manager_default.spinner("Updating repository...");
  try {
    const updated = await client.fetch(path, {
      method: "PATCH",
      body: { public: desiredPublic }
    });
    if (fr.jsonOutput) {
      client.stdout.write(`${JSON.stringify(updated, null, 2)}
`);
    } else {
      const isPublic = updated.repository?.public ?? desiredPublic;
      output_manager_default.success(
        `Repository ${updated.repository?.name ?? repository} is now ${isPublic ? "public" : "private"}`
      );
    }
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      return handleVcrApiError(client, err, fr.jsonOutput, {
        retry: {
          command: buildCommandWithGlobalFlags(client.argv, "vcr ls"),
          when: "List repositories to confirm the name or id"
        }
      });
    }
    throw err;
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  config as default
};
