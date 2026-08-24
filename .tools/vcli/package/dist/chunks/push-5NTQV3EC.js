import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  DEFAULT_TAG,
  buildRepositoryReference,
  parseNameArg,
  validateImageParts
} from "./chunk-RBIFXFZX.js";
import {
  VCR_ENGINES,
  emitVcrArgParseError,
  isEngineInstalled,
  pushCompressionArgs,
  reportEnginePushFailure,
  resolveRegistry,
  resolveVcrScope,
  runEngine,
  splitPassthrough,
  validateVcrChoice
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  pushSubcommand
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
  getFlagsSpecification
} from "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import "./chunk-52QYYTM5.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import "./chunk-TZ2YI2VH.js";

// src/commands/vcr/push.ts
async function push(client, telemetry) {
  const { own, passthrough } = splitPassthrough(client.argv);
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      own,
      getFlagsSpecification(pushSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(client, err, "vcr push <engine> [name[:tag]]");
    printError(err);
    return 1;
  }
  const [engineArg, nameArg] = parsedArgs.args.slice(2);
  const project = parsedArgs.flags["--project"];
  telemetry.trackCliArgumentEngine(engineArg);
  telemetry.trackCliArgumentName(nameArg);
  telemetry.trackCliOptionProject(project);
  if (!engineArg) {
    const message = `Missing engine. Choose one of: ${VCR_ENGINES.join(", ")}.`;
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "vcr push docker"
            ),
            when: "Replace docker with the container tool you use"
          }
        ]
      },
      1
    );
    return outputError(client, false, "MISSING_ARGUMENTS", message);
  }
  const choiceError = validateVcrChoice(
    client,
    "engine",
    engineArg,
    VCR_ENGINES,
    false
  );
  if (typeof choiceError === "number") {
    return choiceError;
  }
  const engine = engineArg;
  if (!isEngineInstalled(engine)) {
    const message = `\`${engine}\` is not installed or not on your PATH. Install it and try again.`;
    outputAgentError(
      client,
      {
        status: "error",
        reason: "engine_not_found",
        message
      },
      1
    );
    return outputError(client, false, "ENGINE_NOT_FOUND", message);
  }
  const scope = await resolveVcrScope(client, { project, jsonOutput: false });
  if (typeof scope === "number") {
    return scope;
  }
  const parsed = parseNameArg(nameArg, scope.projectName);
  if ("error" in parsed) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: parsed.error
      },
      1
    );
    return outputError(client, false, "INVALID_ARGUMENTS", parsed.error);
  }
  const validationError = validateImageParts(parsed);
  if (validationError) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: validationError
      },
      1
    );
    return outputError(client, false, "INVALID_ARGUMENTS", validationError);
  }
  const base = buildRepositoryReference({
    registry: resolveRegistry(),
    teamSlug: scope.teamSlug,
    projectName: scope.projectName,
    repository: parsed.repository
  });
  const ref = `${base}:${parsed.tag ?? DEFAULT_TAG}`;
  const engineArgs = [
    "push",
    ...pushCompressionArgs(engine),
    ...passthrough,
    ref
  ];
  output_manager_default.log(`Running: ${engine} ${engineArgs.join(" ")}`);
  const result = await runEngine(engine, engineArgs, {
    cwd: client.cwd,
    captureStderr: true
  });
  if (result.exitCode !== 0) {
    return reportEnginePushFailure(client, engine, "push", result);
  }
  output_manager_default.success(`Pushed ${ref}`);
  return 0;
}
export {
  push as default
};
