import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  repositoryPermissionsClearPath
} from "./chunk-BEQV3X2L.js";
import {
  emitVcrArgParseError,
  handleVcrApiError,
  requireVcrRepository,
  resolveVcrScope,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  permissionsClearSubcommand
} from "./chunk-GFCTRJI5.js";
import "./chunk-R6IGDGX3.js";
import "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import {
  AGENT_REASON,
  buildCommandWithYes,
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

// src/commands/vcr/permissions/clear.ts
async function clear(client, argv, telemetry) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(permissionsClearSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(client, err, "vcr permissions <repository> clear");
    printError(err);
    return 1;
  }
  const fr = validateVcrJsonOutput(client, parsedArgs.flags);
  if (typeof fr === "number") {
    return fr;
  }
  const repository = parsedArgs.args[0];
  const project = parsedArgs.flags["--project"];
  const skipConfirmation = Boolean(parsedArgs.flags["--yes"]);
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliFlagYes(parsedArgs.flags["--yes"]);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  const missingRepository = requireVcrRepository(
    client,
    repository,
    fr.jsonOutput,
    "vcr permissions <repository> clear"
  );
  if (typeof missingRepository === "number") {
    return missingRepository;
  }
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  if (!skipConfirmation) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.CONFIRMATION_REQUIRED,
        message: "Clearing repository permissions removes access for every team. Re-run with --yes.",
        next: [{ command: buildCommandWithYes(client.argv) }]
      },
      1
    );
    if (!await client.input.confirm(
      `Remove access to ${repository} for all teams? They will no longer be able to pull its images.`,
      false
    )) {
      output_manager_default.log("Canceled");
      return 0;
    }
  }
  const path = repositoryPermissionsClearPath(scope, repository);
  output_manager_default.spinner("Clearing repository permissions...");
  try {
    await client.fetch(path, { method: "DELETE" });
    if (fr.jsonOutput) {
      client.stdout.write(
        `${JSON.stringify({ repository, cleared: true }, null, 2)}
`
      );
    } else {
      output_manager_default.success(`Cleared repository permissions for ${repository}`);
    }
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      return handleVcrApiError(client, err, fr.jsonOutput);
    }
    throw err;
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  clear as default
};
