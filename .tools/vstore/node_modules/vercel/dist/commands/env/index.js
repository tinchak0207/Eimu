import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  CHECKBOX_INSTRUCTIONS,
  getCustomEnvironments,
  readStandardInput,
  require_dist as require_dist3
} from "../../chunks/chunk-VLPLCJZC.js";
import {
  getInvalidSubcommand
} from "../../chunks/chunk-VGIMO3ZK.js";
import {
  ellipsis
} from "../../chunks/chunk-KDYRLN6H.js";
import {
  formatTable
} from "../../chunks/chunk-BBSS3XIW.js";
import "../../chunks/chunk-VDJN4WKH.js";
import {
  suggestNextCommands
} from "../../chunks/chunk-XBN2O34P.js";
import {
  formatEnvironment,
  validateLsArgs
} from "../../chunks/chunk-AAMJ4ZU4.js";
import {
  validateJsonOutput
} from "../../chunks/chunk-KXDWXXJH.js";
import {
  getSubcommand
} from "../../chunks/chunk-YPQSDAEW.js";
import {
  getCommandAliases
} from "../../chunks/chunk-7GE2K2WR.js";
import "../../chunks/chunk-2MF3ZAVW.js";
import "../../chunks/chunk-WC7IINFV.js";
import "../../chunks/chunk-RIB4S2IB.js";
import "../../chunks/chunk-GFCTRJI5.js";
import "../../chunks/chunk-EG5BSAXD.js";
import "../../chunks/chunk-M22O6CYY.js";
import "../../chunks/chunk-GMWRTZVZ.js";
import "../../chunks/chunk-3KNPVXJ3.js";
import "../../chunks/chunk-3L2YLLHC.js";
import "../../chunks/chunk-UMA66MKW.js";
import "../../chunks/chunk-7QVJTI5H.js";
import "../../chunks/chunk-O5GNPPTU.js";
import {
  require_execa
} from "../../chunks/chunk-R6IGDGX3.js";
import {
  autoInstallVercelPlugin
} from "../../chunks/chunk-HT2XWSAJ.js";
import {
  stamp_default
} from "../../chunks/chunk-64IF634X.js";
import "../../chunks/chunk-VXYGCOKL.js";
import "../../chunks/chunk-7PEQVFHI.js";
import {
  help
} from "../../chunks/chunk-XI6NJLI4.js";
import {
  STANDARD_ENVIRONMENTS,
  addSubcommand,
  envCommand,
  envTargetChoices,
  formatProject,
  getEnvRecords,
  getEnvTargetPlaceholder,
  getTeamById,
  isValidEnvTarget,
  listSubcommand,
  param,
  parseEnvTargetArg,
  parseTarget,
  printAlignedLabel,
  pull,
  pullEnvRecords,
  pullSubcommand,
  removeSubcommand,
  require_frameworks,
  resolveProjectContext,
  runSubcommand,
  updateSubcommand
} from "../../chunks/chunk-KDL2L4KL.js";
import {
  TelemetryClient,
  require_dist as require_dist2
} from "../../chunks/chunk-CYNB6LL4.js";
import {
  buildCommandWithYes,
  buildEnvAddCommandWithPreservedArgs,
  buildEnvRmCommandWithPreservedArgs,
  buildEnvUpdateCommandWithPreservedArgs,
  getPreservedArgsForEnvAdd,
  getPreservedArgsForEnvRm,
  getPreservedArgsForEnvUpdate,
  outputActionRequired,
  outputAgentError
} from "../../chunks/chunk-J5ZEHLFM.js";
import {
  require_ms
} from "../../chunks/chunk-GGP5R3FU.js";
import {
  printError
} from "../../chunks/chunk-VAFU7DXZ.js";
import {
  parseArguments
} from "../../chunks/chunk-XLKFJPMT.js";
import {
  getCommandName,
  getCommandNamePlain,
  getFlagsSpecification,
  getGlobalFlagsFromArgs,
  isAPIError,
  require_lib
} from "../../chunks/chunk-SOFC4MLS.js";
import "../../chunks/chunk-P4QNYOFB.js";
import "../../chunks/chunk-52QYYTM5.js";
import {
  emoji,
  output_manager_default,
  prependEmoji,
  require_dist
} from "../../chunks/chunk-OX7KI3LF.js";
import {
  require_source
} from "../../chunks/chunk-S7KYDPEM.js";
import {
  __toESM
} from "../../chunks/chunk-TZ2YI2VH.js";

// src/commands/env/add.ts
var import_chalk = __toESM(require_source(), 1);

// src/util/env/add-env-record.ts
var import_constants = __toESM(require_dist2(), 1);
async function addEnvRecord(client, projectId, upsert, type, key, value, targets, gitBranch, visibility) {
  const actionWord = upsert ? "Overriding" : "Adding";
  output_manager_default.debug(
    `${actionWord} ${type} Environment Variable ${key} to ${targets.length} targets`
  );
  const target = [];
  const customEnvironmentIds = [];
  for (const t of targets) {
    const arr = import_constants.PROJECT_ENV_TARGET.includes(t) ? target : customEnvironmentIds;
    arr.push(t);
  }
  const body = {
    type,
    key,
    value,
    target,
    customEnvironmentIds: customEnvironmentIds.length > 0 ? customEnvironmentIds : void 0,
    gitBranch: gitBranch || void 0,
    ...visibility !== void 0 ? { visibility } : {}
  };
  const args = upsert ? `?upsert=${upsert}` : "";
  const url = `/v10/projects/${projectId}/env${args}`;
  await client.fetch(url, {
    method: "POST",
    body
  });
}

// src/util/env/known-error.ts
var import_error_utils = __toESM(require_dist(), 1);
var knownErrorsCodes = /* @__PURE__ */ new Set([
  "BAD_REQUEST",
  "ENV_ALREADY_EXISTS",
  "ENV_CONFLICT",
  "EXISTING_KEY_AND_TARGET",
  "FORBIDDEN",
  "ID_NOT_FOUND",
  "INVALID_KEY",
  "INVALID_VALUE",
  "KEY_INVALID_CHARACTERS",
  "KEY_INVALID_LENGTH",
  "KEY_RESERVED",
  "RESERVED_ENV_VARIABLE",
  "MAX_ENVS_EXCEEDED",
  "MISSING_ID",
  "MISSING_KEY",
  "MISSING_TARGET",
  "MISSING_VALUE",
  "NOT_AUTHORIZED",
  "NOT_DECRYPTABLE",
  "SYSTEM_ENV_WITH_VALUE",
  "TEAM_NOT_FOUND",
  "TOO_MANY_IDS",
  "TOO_MANY_KEYS",
  "UNKNOWN_ERROR",
  "VALUE_INVALID_LENGTH",
  "VALUE_INVALID_TYPE"
]);
function isKnownError(error) {
  const code = (0, import_error_utils.isErrnoException)(error) ? error.code : null;
  if (!code)
    return false;
  return knownErrorsCodes.has(code.toUpperCase());
}

// src/util/env/validate-env.ts
var import_frameworks = __toESM(require_frameworks(), 1);
function getEnvValueWarnings(value) {
  const warnings = [];
  const normalized = value.replace(/\n$/, "");
  if (/^[ \t]+/.test(normalized)) {
    warnings.push({
      message: "starts with whitespace",
      requiresConfirmation: false
    });
  }
  if (/[ \t]+$/.test(normalized)) {
    warnings.push({
      message: "ends with whitespace",
      requiresConfirmation: false
    });
  }
  if (normalized.includes("\r") || normalized.includes("\n")) {
    warnings.push({
      message: "contains newlines",
      requiresConfirmation: false
    });
  }
  if (value.includes("\0")) {
    warnings.push({
      message: "contains null characters",
      requiresConfirmation: false
    });
  }
  if (value === "") {
    warnings.push({
      message: "is empty",
      requiresConfirmation: true
    });
  }
  if (value.length > 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
    warnings.push({
      message: "includes surrounding quotes (these will be stored literally)",
      requiresConfirmation: false
    });
  }
  return warnings;
}
function formatWarnings(warnings) {
  if (warnings.length === 0)
    return null;
  const messages = warnings.map((w) => w.message);
  const startsIdx = messages.indexOf("starts with whitespace");
  const endsIdx = messages.indexOf("ends with whitespace");
  if (startsIdx !== -1 && endsIdx !== -1) {
    messages.splice(Math.max(startsIdx, endsIdx), 1);
    messages[Math.min(startsIdx, endsIdx)] = "starts and ends with whitespace";
  }
  if (messages.length === 1) {
    return `Value ${messages[0]}`;
  }
  if (messages.length === 2) {
    return `Value ${messages[0]} and ${messages[1]}`;
  }
  const last = messages.pop();
  return `Value ${messages.join(", ")}, and ${last}`;
}
var PUBLIC_PREFIXES = [
  ...new Set(
    import_frameworks.frameworkList.map((f) => f.envPrefix).filter((p) => !!p)
  )
];
var SENSITIVE_PATTERN = /(?:^|_)(password|secret|private|token|key|auth|jwt|signature)(?:_|$)/i;
function hasOnlyWhitespaceWarnings(warnings) {
  return warnings.length > 0 && warnings.every(
    (w) => w.message === "starts with whitespace" || w.message === "ends with whitespace"
  );
}
function trimValue(value) {
  return value.replace(/\n$/, "").trim();
}
function normalizeStdinEnvValue(value) {
  let valueWithoutTrailingNewline = value;
  if (value.endsWith("\r\n")) {
    valueWithoutTrailingNewline = value.slice(0, -2);
  } else if (value.endsWith("\n")) {
    valueWithoutTrailingNewline = value.slice(0, -1);
  } else {
    return {
      value,
      strippedTrailingNewline: false
    };
  }
  if (valueWithoutTrailingNewline.includes("\n") || valueWithoutTrailingNewline.includes("\r")) {
    return {
      value,
      strippedTrailingNewline: false
    };
  }
  return {
    value: valueWithoutTrailingNewline,
    strippedTrailingNewline: true
  };
}
function getPublicPrefix(key) {
  const upperKey = key.toUpperCase();
  return PUBLIC_PREFIXES.find((p) => upperKey.startsWith(p)) || null;
}
function removePublicPrefix(key) {
  const prefix = getPublicPrefix(key);
  if (!prefix)
    return key;
  return key.slice(prefix.length);
}
async function validateEnvValue(opts) {
  let finalValue = opts.initialValue;
  let alreadyConfirmed = false;
  if (!opts.skipConfirm) {
    let valueAccepted = false;
    while (!valueAccepted) {
      const valueWarnings = getEnvValueWarnings(finalValue);
      const warningMessage = formatWarnings(valueWarnings);
      if (!warningMessage) {
        valueAccepted = true;
        break;
      }
      opts.showWarning(warningMessage);
      const canTrim = hasOnlyWhitespaceWarnings(valueWarnings);
      const choices = canTrim ? [
        { name: "Leave as is", value: "c" },
        { name: "Re-enter", value: "r" },
        { name: "Trim whitespace", value: "t" }
      ] : [
        { name: "Leave as is", value: "c" },
        { name: "Re-enter", value: "r" }
      ];
      const action = await opts.selectAction(choices);
      if (action === "c") {
        valueAccepted = true;
        if (valueWarnings.some((w) => w.requiresConfirmation)) {
          alreadyConfirmed = true;
        }
      } else if (action === "t") {
        finalValue = trimValue(finalValue);
        opts.showLog("Trimmed whitespace");
      } else {
        finalValue = await opts.promptForValue();
      }
    }
  } else {
    const valueWarnings = getEnvValueWarnings(finalValue);
    const warningMessage = formatWarnings(valueWarnings);
    if (warningMessage) {
      opts.showWarning(warningMessage);
    }
  }
  return { finalValue, alreadyConfirmed };
}
function getEnvKeyWarnings(key) {
  const warnings = [];
  const matchingPrefix = getPublicPrefix(key);
  if (matchingPrefix) {
    const sensitiveMatch = SENSITIVE_PATTERN.exec(key);
    const nameWithoutPrefix = key.slice(matchingPrefix.length);
    if (sensitiveMatch) {
      warnings.push({
        message: `The ${matchingPrefix} prefix will make ${nameWithoutPrefix} visible to anyone visiting your site`,
        requiresConfirmation: true
      });
    } else {
      warnings.push({
        message: `${matchingPrefix} variables can be seen by anyone visiting your site`,
        requiresConfirmation: false
      });
    }
  }
  return warnings;
}

// src/util/telemetry/commands/env/add.ts
var EnvAddTelemetryClient = class extends TelemetryClient {
  trackCliArgumentName(name) {
    if (name) {
      this.trackCliArgument({
        arg: "name",
        value: this.redactedValue
      });
    }
  }
  trackCliArgumentEnvironment(environment) {
    if (environment) {
      const allStandard = environment.split(",").map((t) => t.trim()).every((t) => STANDARD_ENVIRONMENTS.includes(t));
      this.trackCliArgument({
        arg: "environment",
        value: allStandard ? environment : this.redactedValue
      });
    }
  }
  trackCliArgumentGitBranch(gitBranch) {
    if (gitBranch) {
      this.trackCliArgument({
        arg: "git-branch",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionGitBranch(gitBranch) {
    if (gitBranch) {
      this.trackCliOption({
        option: "git-branch",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionValue(value) {
    if (value) {
      this.trackCliOption({
        option: "value",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionVisibility(visibility) {
    if (visibility) {
      const validVisibilities = ["config", "secret"];
      this.trackCliOption({
        option: "visibility",
        value: validVisibilities.includes(visibility) ? visibility : this.redactedValue
      });
    }
  }
  trackCliFlagSensitive(sensitive) {
    if (sensitive) {
      this.trackCliFlag("sensitive");
    }
  }
  trackCliFlagNoSensitive(noSensitive) {
    if (noSensitive) {
      this.trackCliFlag("no-sensitive");
    }
  }
  trackCliFlagForce(force) {
    if (force) {
      this.trackCliFlag("force");
    }
  }
  trackCliFlagGuidance(guidance) {
    if (guidance) {
      this.trackCliFlag("guidance");
    }
  }
  trackCliFlagYes(yes) {
    if (yes) {
      this.trackCliFlag("yes");
    }
  }
};

// src/commands/env/add.ts
import { determineAgent } from "@vercel/detect-agent";

// src/util/env/env-var-config-secret-ui.ts
function isEnvVarConfigSecretUiEnabled() {
  const raw = process.env.VERCEL_ENV_VAR_CONFIG_SECRET_UI;
  return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "on";
}
function shouldEnforceSensitiveEnvVarPolicy(policyOn) {
  return policyOn && !isEnvVarConfigSecretUiEnabled();
}
function formatVisibilityLabel(visibility, type) {
  const resolved = visibility ?? visibilityFromEnvType(type);
  if (resolved === "config") {
    return "Config";
  }
  if (resolved === "secret") {
    return "Secret";
  }
  return void 0;
}
function visibilityFromEnvType(type) {
  if (type === "sensitive") {
    return "secret";
  }
  if (type === "plain" || type === "encrypted") {
    return "config";
  }
  return void 0;
}
function hasNonDevelopmentTarget(envTargets) {
  return envTargets.some((target) => target !== "development");
}
function getPublicPrefixSecretVisibilityError(key, options) {
  const publicPrefix = getPublicPrefix(key);
  if (!publicPrefix) {
    return null;
  }
  const wouldBeSecret = options.visibility === "secret" || options.type === "sensitive";
  if (!wouldBeSecret) {
    return null;
  }
  const prefixLabel = publicPrefix.replace(/_$/, "");
  if (hasNonDevelopmentTarget(options.envTargets)) {
    return `Environment variables with a public framework prefix (${prefixLabel}) cannot use secret visibility on Production or Preview. Target Development only, rename to remove the public prefix, or use \`--visibility config\` with \`--no-sensitive\` on Development.`;
  }
  return `Environment variables with a public framework prefix (${prefixLabel}) cannot use secret visibility. Rename to remove the public prefix or use \`--visibility config\` with \`--no-sensitive\`.`;
}
function getDevelopmentSecretVisibilityError(envTargets, options) {
  if (options.configSecretUiEnabled) {
    return null;
  }
  if (!envTargets.includes("development")) {
    return null;
  }
  const wouldBeSecret = options.type === "sensitive" || options.visibility === "secret";
  if (!wouldBeSecret) {
    return null;
  }
  const hasNonDevelopment = envTargets.some((target) => target !== "development");
  if (hasNonDevelopment) {
    return `Sensitive Environment Variables are not supported on the Development Environment. Add --no-sensitive to store a non-sensitive value for all selected Environments, or run \`vercel env add\` separately for Development.`;
  }
  return `--sensitive is not allowed with the Development Environment. Sensitive Environment Variables are only supported on Production and Preview.`;
}
function shouldOmitInferredVisibility(key, envTargets, teamSensitivePolicyOn) {
  if (!getPublicPrefix(key)) {
    return false;
  }
  if (!hasNonDevelopmentTarget(envTargets)) {
    return false;
  }
  return teamSensitivePolicyOn;
}
function resolveEnvVarVisibility(options) {
  if (!options.configSecretUiEnabled) {
    return {};
  }
  if (options.explicitVisibility !== void 0) {
    if (options.explicitVisibility !== "config" && options.explicitVisibility !== "secret") {
      return {
        error: "The `--visibility` flag must be either `config` or `secret`."
      };
    }
    const publicPrefixError2 = getPublicPrefixSecretVisibilityError(
      options.key,
      {
        visibility: options.explicitVisibility,
        type: options.type,
        envTargets: options.envTargets
      }
    );
    if (publicPrefixError2) {
      return { error: publicPrefixError2 };
    }
    const developmentError2 = getDevelopmentSecretVisibilityError(
      options.envTargets,
      {
        type: options.type,
        visibility: options.explicitVisibility,
        configSecretUiEnabled: options.configSecretUiEnabled
      }
    );
    if (developmentError2) {
      return { error: developmentError2 };
    }
    return { visibility: options.explicitVisibility };
  }
  const inferred = visibilityFromEnvType(options.type);
  if (inferred === void 0) {
    return {};
  }
  const developmentError = getDevelopmentSecretVisibilityError(
    options.envTargets,
    {
      type: options.type,
      visibility: inferred,
      configSecretUiEnabled: options.configSecretUiEnabled
    }
  );
  if (developmentError) {
    return { error: developmentError };
  }
  if (shouldOmitInferredVisibility(
    options.key,
    options.envTargets,
    options.teamSensitivePolicyOn
  )) {
    return {};
  }
  const publicPrefixError = getPublicPrefixSecretVisibilityError(options.key, {
    visibility: inferred,
    type: options.type,
    envTargets: options.envTargets
  });
  if (publicPrefixError) {
    return { error: publicPrefixError };
  }
  return { visibility: inferred };
}

// src/commands/env/add.ts
var SENSITIVE_VALUE_HINT = "Sensitive values cannot be read later";
var SENSITIVE_SECRET_PROMPT = `Store as sensitive? ${import_chalk.default.dim(
  SENSITIVE_VALUE_HINT
)}`;
function filterEnvChoicesForSensitivity(choices, opts) {
  if (opts.isSensitive && !opts.configSecretUiEnabled) {
    return choices.filter((c) => c.value !== "development");
  }
  if (opts.policyOn) {
    return choices.filter((c) => c.value === "development");
  }
  return choices;
}
function getTargetCompatibilityError(envTargets, isSensitive, policyOn, configSecretUiEnabled) {
  const hasDevelopment = envTargets.includes("development");
  const hasSensitiveCapable = envTargets.some((t) => t !== "development");
  if (isSensitive && hasDevelopment && !configSecretUiEnabled) {
    return `Sensitive Environment Variables are not supported on the Development Environment. Add --no-sensitive to store a non-sensitive value for all selected Environments, or run ${getCommandName(
      "env add"
    )} separately for Development.`;
  }
  if (!isSensitive && policyOn && hasSensitiveCapable) {
    return `Your team requires sensitive Environment Variables for Production and Preview. To add a non-sensitive value, target the Development Environment only. Run ${getCommandName(
      "env add"
    )} with the development target instead.`;
  }
  return null;
}
function resolveFinalType(envTargets, isSensitive, opts) {
  const hasDevelopment = envTargets.includes("development");
  if (hasDevelopment && !(opts.configSecretUiEnabled && isSensitive)) {
    return "encrypted";
  }
  if (opts.forceEncrypted && !opts.policyOn) {
    return "encrypted";
  }
  if (isSensitive || opts.forceSensitive || opts.policyOn) {
    return "sensitive";
  }
  return "encrypted";
}
function fillEnvAddTemplate(template, opts) {
  const targetPlaceholder = getEnvTargetPlaceholder();
  const out = template.replace(/<name>/g, opts.envName ?? "<name>").split(targetPlaceholder).join(opts.envTargetArg ?? targetPlaceholder);
  return out.replace(/<value>/g, "<value>");
}
function redactEnvValueArgs(argv) {
  const redacted = [...argv];
  for (let i = 0; i < redacted.length; i++) {
    if (redacted[i] === "--value" && i + 1 < redacted.length) {
      redacted[i + 1] = '"<value>"';
      i++;
    } else if (redacted[i].startsWith("--value=")) {
      redacted[i] = '--value="<value>"';
    }
  }
  return redacted;
}
function multiTargetSuggestion(argv, envName, targets, addNoSensitive) {
  const flag = addNoSensitive ? " --no-sensitive" : "";
  return {
    command: buildEnvAddCommandWithPreservedArgs(
      argv,
      `env add ${envName} ${targets.join(",")} --value "<value>"${flag} --yes`
    ),
    when: addNoSensitive ? "Add one non-sensitive variable to all listed environments" : "Add one variable to multiple environments"
  };
}
function filterSensitiveMultiTargetSuggestionTargets(targets, opts) {
  const excludeDevelopment = opts.forceSensitive || opts.policyOn;
  return excludeDevelopment ? targets.filter((target) => target !== "development") : targets;
}
function projectLabel(link) {
  return `${link.org.slug}/${link.project.name}`;
}
function formatEnvironmentTarget(target, customEnvironments) {
  const standardTarget = envTargetChoices.find(
    (choice) => choice.value === target
  );
  if (standardTarget) {
    return standardTarget.name;
  }
  const customEnvironment = customEnvironments.find(
    (env) => env.id === target || env.slug === target
  );
  return customEnvironment?.slug ?? target;
}
function formatEnvironmentTargets(envTargets, customEnvironments) {
  return envTargets.map((target) => formatEnvironmentTarget(target, customEnvironments)).join(", ");
}
function typeLabel(type) {
  return type === "sensitive" ? "Sensitive" : "Non-sensitive";
}
function printEnvAddResult(link, envName, envTargets, envGitBranch, customEnvironments, finalType, force, visibility) {
  output_manager_default.print("\n");
  printAlignedLabel(force ? "Overrode" : "Added", envName, { gutter: "\u2713" });
  printAlignedLabel("Project", projectLabel(link));
  printAlignedLabel(
    "Environments",
    formatEnvironmentTargets(envTargets, customEnvironments)
  );
  if (envGitBranch) {
    printAlignedLabel("Branch", envGitBranch);
  }
  printAlignedLabel("Type", typeLabel(finalType));
  if (isEnvVarConfigSecretUiEnabled()) {
    const visibilityLabel = formatVisibilityLabel(visibility, finalType);
    if (visibilityLabel) {
      printAlignedLabel("Visibility", visibilityLabel);
    }
  }
}
function printEnvAddWarning(message) {
  output_manager_default.print(`${import_chalk.default.yellow("!")} ${message}
`);
}
function promptEnvValue(client, opts) {
  return client.input.text({
    message: `Value?`,
    ...opts.isSensitive ? { transformer: (value) => "*".repeat(value.length) } : {}
  });
}
async function add(client, argv) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(addSubcommand.options);
  try {
    parsedArgs = parseArguments(argv, flagsSpecification);
  } catch (err) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_arguments",
          message: err instanceof Error ? err.message : String(err)
        },
        1
      );
    }
    printError(err);
    return 1;
  }
  const { args, flags: opts } = parsedArgs;
  const configSecretUiEnabled = isEnvVarConfigSecretUiEnabled();
  const stdInput = await readStandardInput(client.stdin);
  const valueFromFlag = typeof opts["--value"] === "string" ? opts["--value"] : void 0;
  let [envName, envTargetArg] = args;
  const positionalGitBranch = args[2];
  const optionGitBranch = typeof opts["--git-branch"] === "string" ? opts["--git-branch"] : void 0;
  let envGitBranch = optionGitBranch ?? positionalGitBranch;
  const telemetryClient = new EnvAddTelemetryClient({
    opts: {
      store: client.telemetryEventStore
    }
  });
  telemetryClient.trackCliArgumentName(envName);
  telemetryClient.trackCliArgumentEnvironment(envTargetArg);
  telemetryClient.trackCliArgumentGitBranch(positionalGitBranch);
  telemetryClient.trackCliOptionGitBranch(optionGitBranch);
  telemetryClient.trackCliOptionValue(
    valueFromFlag === void 0 ? void 0 : "<redacted>"
  );
  telemetryClient.trackCliFlagSensitive(opts["--sensitive"]);
  telemetryClient.trackCliFlagNoSensitive(opts["--no-sensitive"]);
  telemetryClient.trackCliFlagForce(opts["--force"]);
  telemetryClient.trackCliFlagGuidance(opts["--guidance"]);
  telemetryClient.trackCliFlagYes(opts["--yes"]);
  telemetryClient.trackCliOptionVisibility(
    typeof opts["--visibility"] === "string" ? opts["--visibility"] : void 0
  );
  telemetryClient.trackCliOptionProject(opts["--project"]);
  if (positionalGitBranch && optionGitBranch) {
    output_manager_default.error(
      "Git branch was provided twice. Use either `--git-branch <name>` or the legacy third argument."
    );
    return 1;
  }
  if (args.length > 3) {
    output_manager_default.error(
      `Invalid number of arguments. Usage: ${getCommandName(
        `env add <name> ${getEnvTargetPlaceholder()} --git-branch <name>`
      )}`
    );
    return 1;
  }
  if (stdInput && (!envName || !envTargetArg)) {
    output_manager_default.error(
      `Invalid number of arguments. Usage: ${getCommandName(
        `env add <name> <target> --git-branch <name> < <file>`
      )}`
    );
    return 1;
  }
  let envTargets = envTargetArg ? parseEnvTargetArg(envTargetArg) : [];
  if (client.nonInteractive) {
    const link2 = await resolveProjectContext({
      client,
      projectNameOrId: opts["--project"]
    });
    if (link2.status === "error") {
      return link2.exitCode;
    }
    if (link2.status === "not_linked") {
      const preserved = getPreservedArgsForEnvAdd(client.argv);
      const linkPreserved = preserved.filter((a, i) => {
        if (a === "--value")
          return false;
        if (a.startsWith("--value="))
          return false;
        if (i > 0 && preserved[i - 1] === "--value")
          return false;
        return true;
      });
      const linkArgv = [
        ...client.argv.slice(0, 2),
        "link",
        "--scope",
        "<scope>",
        ...linkPreserved
      ];
      const envAddRetryArgv = redactEnvValueArgs(client.argv);
      outputAgentError(
        client,
        {
          status: "error",
          reason: "not_linked",
          message: `Your codebase isn't linked to a project on Vercel. Run ${getCommandNamePlain(
            "link"
          )} to begin. Use --yes for non-interactive; use --scope or --project to specify team or project. Then run your env add command.`,
          next: [
            { command: buildCommandWithYes(linkArgv) },
            { command: buildCommandWithYes(envAddRetryArgv) }
          ]
        },
        1
      );
    }
    if (link2.status !== "linked")
      return 1;
    const { project: project2 } = link2;
    const org = link2.org;
    client.config.currentTeam = org.type === "team" ? org.id : void 0;
    const [{ envs: envs2 }, customEnvironments2] = await Promise.all([
      getEnvRecords(client, project2.id, "vercel-cli:env:add"),
      getCustomEnvironments(client, project2.id)
    ]);
    const matchingEnvs2 = envs2.filter((r) => r.key === envName);
    const existingTargets2 = /* @__PURE__ */ new Set();
    const existingCustomEnvs2 = /* @__PURE__ */ new Set();
    for (const env of matchingEnvs2) {
      if (typeof env.target === "string") {
        existingTargets2.add(env.target);
      } else if (Array.isArray(env.target)) {
        for (const target of env.target) {
          existingTargets2.add(target);
        }
      }
      if (env.customEnvironmentIds) {
        for (const customEnvId of env.customEnvironmentIds) {
          existingCustomEnvs2.add(customEnvId);
        }
      }
    }
    const choices2 = [
      ...envTargetChoices.filter((c) => !existingTargets2.has(c.value)),
      ...customEnvironments2.filter((c) => !existingCustomEnvs2.has(c.id)).map((c) => ({
        name: c.slug,
        value: c.id
      }))
    ];
    const missing = [];
    if (!envName)
      missing.push("missing_name");
    if (valueFromFlag === void 0 && !stdInput)
      missing.push("missing_value");
    if (!envTargetArg && choices2.length > 0)
      missing.push("missing_environment");
    if (missing.length > 0) {
      const parts = missing.map((m) => {
        if (m === "missing_name")
          return "variable name";
        if (m === "missing_value")
          return "--value or stdin";
        if (m === "missing_environment")
          return "environment (production, preview, development, or a comma-separated list)";
        return m;
      });
      const fullTemplate = `env add <name> ${getEnvTargetPlaceholder()} --value "<value>" --yes`;
      const filledTemplate = fillEnvAddTemplate(fullTemplate, {
        envName,
        envTargetArg
      });
      const next = [];
      next.push({
        command: buildEnvAddCommandWithPreservedArgs(
          client.argv,
          filledTemplate
        )
      });
      if (missing.includes("missing_environment")) {
        const standardAvailable = choices2.map((c) => c.value).filter((v) => isValidEnvTarget(v));
        const multiTargets = filterSensitiveMultiTargetSuggestionTargets(
          standardAvailable,
          {
            forceSensitive: Boolean(opts["--sensitive"]),
            policyOn: false
          }
        );
        if (multiTargets.length > 1) {
          next.push(
            multiTargetSuggestion(
              client.argv,
              envName || "<name>",
              multiTargets,
              multiTargets.includes("development") && !opts["--no-sensitive"]
            )
          );
        }
      }
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "missing_requirements",
          missing,
          message: `Provide all required inputs for non-interactive mode: ${parts.join("; ")}. Example: ${filledTemplate}`,
          next
        },
        1
      );
    }
  }
  if (!envName) {
    envName = await client.input.text({
      message: `Name?`,
      validate: (val) => val ? true : "Name cannot be empty"
    });
  }
  const skipConfirm = opts["--yes"] || !!stdInput || valueFromFlag !== void 0;
  if (!skipConfirm) {
    let keyAccepted = false;
    while (!keyAccepted) {
      const keyWarnings = getEnvKeyWarnings(envName);
      const sensitiveWarning = keyWarnings.find((w) => w.requiresConfirmation);
      if (!sensitiveWarning) {
        for (const w of keyWarnings) {
          printEnvAddWarning(w.message);
        }
        keyAccepted = true;
        break;
      }
      if (client.nonInteractive) {
        const nameWithoutPrefix2 = removePublicPrefix(envName);
        outputActionRequired(client, {
          status: "action_required",
          reason: "env_key_sensitive",
          message: `Key ${envName} may expose sensitive data (public prefix). Use --yes to keep as is, or rename to ${nameWithoutPrefix2}.`,
          choices: [
            { id: "keep", name: "Leave as is (use --yes)" },
            { id: "rename", name: `Rename to ${nameWithoutPrefix2}` }
          ],
          next: [
            {
              command: buildEnvAddCommandWithPreservedArgs(
                client.argv,
                `env add ${envName} ${getEnvTargetPlaceholder()} --value "<value>" --yes`
              ),
              when: "Leave as is"
            },
            {
              command: buildEnvAddCommandWithPreservedArgs(
                client.argv,
                `env add ${nameWithoutPrefix2} ${getEnvTargetPlaceholder()} --value "<value>" --yes`
              ),
              when: "Rename"
            }
          ]
        });
      }
      for (const w of keyWarnings) {
        printEnvAddWarning(w.message);
      }
      const nameWithoutPrefix = removePublicPrefix(envName);
      const choices2 = [
        { name: `Keep ${envName}`, value: "c" },
        { name: `Rename to ${nameWithoutPrefix}`, value: "p" },
        { name: "Re-enter name", value: "r" }
      ];
      const action = await client.input.select({
        message: "Variable name?",
        choices: choices2
      });
      if (action === "c") {
        keyAccepted = true;
      } else if (action === "p") {
        envName = nameWithoutPrefix;
        output_manager_default.log(`Renamed to ${envName}`);
      } else {
        envName = await client.input.text({
          message: `Name?`,
          validate: (val) => val ? true : "Name cannot be empty"
        });
      }
    }
  } else {
    const keyWarnings = getEnvKeyWarnings(envName);
    for (const w of keyWarnings) {
      printEnvAddWarning(w.message);
    }
  }
  const link = await resolveProjectContext({
    client,
    projectNameOrId: opts["--project"]
  });
  if (link.status === "error") {
    return link.exitCode;
  } else if (link.status === "not_linked") {
    if (client.nonInteractive) {
      const preserved = getPreservedArgsForEnvAdd(client.argv);
      const linkPreserved = preserved.filter((a, i) => {
        if (a === "--value")
          return false;
        if (a.startsWith("--value="))
          return false;
        if (i > 0 && preserved[i - 1] === "--value")
          return false;
        return true;
      });
      const linkArgv = [
        ...client.argv.slice(0, 2),
        "link",
        ...link.status === "not_linked" ? ["--scope", "<scope>"] : [],
        ...linkPreserved
      ];
      const envAddRetryArgv = redactEnvValueArgs(client.argv);
      outputAgentError(
        client,
        {
          status: "error",
          reason: "not_linked",
          message: `Your codebase isn't linked to a project on Vercel. Run ${getCommandNamePlain(
            "link"
          )} to begin. Use --yes for non-interactive; use --scope or --project to specify team or project. Then run your env add command.`,
          next: [
            { command: buildCommandWithYes(linkArgv) },
            { command: buildCommandWithYes(envAddRetryArgv) }
          ]
        },
        1
      );
    } else {
      output_manager_default.error(
        `Your codebase isn\u2019t linked to a project on Vercel. Run ${getCommandName(
          "link"
        )} to begin.`
      );
    }
    return 1;
  }
  client.config.currentTeam = link.org.type === "team" ? link.org.id : void 0;
  const { project } = link;
  const [{ envs }, customEnvironments] = await Promise.all([
    getEnvRecords(client, project.id, "vercel-cli:env:add"),
    getCustomEnvironments(client, project.id)
  ]);
  if (envTargets.length > 0) {
    const resolved = [];
    const invalid = [];
    for (const target of envTargets) {
      if (isValidEnvTarget(target)) {
        resolved.push(target);
        continue;
      }
      const custom = customEnvironments.find(
        (c) => c.id === target || c.slug === target
      );
      if (custom) {
        resolved.push(custom.id);
      } else {
        invalid.push(target);
      }
    }
    if (invalid.length > 0) {
      const valid = [
        ...envTargetChoices.map((c) => c.value),
        ...customEnvironments.map((c) => c.slug)
      ];
      const message = `Invalid environment: ${invalid.join(
        ", "
      )}. Valid environments: ${valid.join(
        ", "
      )}. Separate multiple environments with commas.`;
      if (client.nonInteractive) {
        outputAgentError(
          client,
          { status: "error", reason: "invalid_environment", message },
          1
        );
      }
      output_manager_default.error(message);
      return 1;
    }
    envTargets = resolved;
  }
  if (envGitBranch && envTargets.length > 1) {
    const message = "A Git branch can only be set when Preview is the only selected environment.";
    if (client.nonInteractive) {
      outputAgentError(
        client,
        { status: "error", reason: "branch_requires_preview_only", message },
        1
      );
    }
    output_manager_default.error(message);
    return 1;
  }
  const matchingEnvs = envs.filter((r) => r.key === envName);
  const existingTargets = /* @__PURE__ */ new Set();
  const existingCustomEnvs = /* @__PURE__ */ new Set();
  for (const env of matchingEnvs) {
    if (typeof env.target === "string") {
      existingTargets.add(env.target);
    } else if (Array.isArray(env.target)) {
      for (const target of env.target) {
        existingTargets.add(target);
      }
    }
    if (env.customEnvironmentIds) {
      for (const customEnvId of env.customEnvironmentIds) {
        existingCustomEnvs.add(customEnvId);
      }
    }
  }
  const choices = [
    ...envTargetChoices.filter((c) => !existingTargets.has(c.value)).map((c) => ({ name: c.name, value: c.value })),
    ...customEnvironments.filter((c) => !existingCustomEnvs.has(c.id)).map((c) => ({ name: c.slug, value: c.id }))
  ];
  if (!envGitBranch && choices.length === 0 && !opts["--force"]) {
    const projectFlag = opts["--project"] ? ` --project ${opts["--project"]}` : "";
    output_manager_default.error(
      `The variable ${param(
        envName
      )} has already been added to all Environments. To remove, run ${getCommandName(
        `env rm ${envName}${projectFlag}`
      )}.`
    );
    return 1;
  }
  const forceSensitive = Boolean(opts["--sensitive"]);
  const forceEncrypted = Boolean(opts["--no-sensitive"]);
  if (forceSensitive && forceEncrypted) {
    output_manager_default.error(
      `--sensitive and --no-sensitive cannot be used together. Pick one.`
    );
    return 1;
  }
  const explicitVisibility = typeof opts["--visibility"] === "string" ? opts["--visibility"] : void 0;
  if (explicitVisibility === "secret" && forceEncrypted) {
    output_manager_default.error(
      "`--visibility secret` cannot be used with `--no-sensitive`. Pick one."
    );
    return 1;
  }
  if (explicitVisibility === "config" && forceSensitive) {
    output_manager_default.error(
      "`--visibility config` cannot be used with `--sensitive`. Pick one."
    );
    return 1;
  }
  let policyOn = false;
  let teamSensitivePolicyOn = false;
  if (link.org.type === "team") {
    try {
      const team = await getTeamById(client, link.org.id);
      teamSensitivePolicyOn = team?.sensitiveEnvironmentVariablePolicy === "on";
      policyOn = shouldEnforceSensitiveEnvVarPolicy(teamSensitivePolicyOn);
    } catch {
    }
  }
  const isDevelopmentOnlyTarget = envTargets.length === 1 && envTargets[0] === "development";
  const userWasExplicit = forceSensitive || forceEncrypted;
  const skipSensitivePrompt = userWasExplicit || client.nonInteractive || skipConfirm || isDevelopmentOnlyTarget;
  let isSensitive;
  if (forceSensitive) {
    isSensitive = true;
  } else if (forceEncrypted) {
    isSensitive = false;
  } else if (isDevelopmentOnlyTarget) {
    isSensitive = false;
  } else if (skipSensitivePrompt) {
    isSensitive = true;
  } else {
    isSensitive = await client.input.confirm(SENSITIVE_SECRET_PROMPT, true);
    if (policyOn && !isSensitive) {
      output_manager_default.print(
        `  ${import_chalk.default.dim(
          "Team policy limits non-sensitive values to Development."
        )}
`
      );
    }
  }
  if (!client.nonInteractive && skipSensitivePrompt && policyOn && !isSensitive && envTargets.length === 0) {
    output_manager_default.print(
      `  ${import_chalk.default.dim(
        "Team policy limits non-sensitive values to Development."
      )}
`
    );
  }
  if (forceSensitive && envTargets.includes("development") && !configSecretUiEnabled) {
    const msg = `--sensitive is not allowed with the Development Environment. Sensitive Environment Variables are only supported on Production and Preview.`;
    if (client.nonInteractive) {
      const nonDev = envTargets.filter((t) => t !== "development");
      outputAgentError(
        client,
        {
          status: "error",
          reason: "sensitive_not_allowed_on_development",
          message: msg,
          ...nonDev.length > 0 ? {
            next: [
              {
                command: buildEnvAddCommandWithPreservedArgs(
                  client.argv,
                  `env add ${envName} ${nonDev.join(",")} --value "<value>" --yes`
                ),
                when: "Keep sensitive and skip Development"
              }
            ]
          } : {}
        },
        1
      );
    }
    output_manager_default.error(msg);
    return 1;
  }
  if (envTargets.length > 0) {
    const compatibilityError = getTargetCompatibilityError(
      envTargets,
      isSensitive,
      policyOn,
      configSecretUiEnabled
    );
    if (compatibilityError) {
      if (client.nonInteractive) {
        const next = [];
        if (isSensitive) {
          if (!policyOn) {
            next.push(
              multiTargetSuggestion(client.argv, envName, envTargets, true)
            );
          }
          const nonDev = envTargets.filter((t) => t !== "development");
          if (nonDev.length > 0) {
            next.push({
              command: buildEnvAddCommandWithPreservedArgs(
                client.argv,
                `env add ${envName} ${nonDev.join(",")} --value "<value>" --yes`
              ),
              when: "Keep sensitive and skip Development"
            });
          }
        } else {
          next.push({
            command: buildEnvAddCommandWithPreservedArgs(
              client.argv,
              `env add ${envName} development --value "<value>" --yes`
            ),
            when: "Add as non-sensitive to Development only"
          });
        }
        outputAgentError(
          client,
          {
            status: "error",
            reason: isSensitive ? "sensitive_not_allowed_on_development" : "non_sensitive_not_allowed_on_production_preview",
            message: compatibilityError,
            ...next.length > 0 ? { next } : {}
          },
          1
        );
      }
      output_manager_default.error(compatibilityError);
      return 1;
    }
  }
  const envChoices = filterEnvChoicesForSensitivity(choices, {
    isSensitive,
    policyOn,
    configSecretUiEnabled
  });
  if (policyOn && isSensitive) {
    for (const choice of envChoices) {
      if (choice.value === "production" || choice.value === "preview") {
        choice.checked = true;
      }
    }
  } else if (envChoices.length === 1) {
    envChoices[0].checked = true;
  }
  if (!envGitBranch && envChoices.length === 0 && envTargets.length === 0 && !opts["--force"]) {
    output_manager_default.error(
      `No Environments are available for this variable with the selected sensitivity. ${isSensitive ? "Sensitive Environment Variables cannot be added to Development." : "Your team requires sensitive Environment Variables for Production and Preview."}`
    );
    return 1;
  }
  let envValue;
  if (stdInput) {
    const normalizedStdinValue = normalizeStdinEnvValue(stdInput);
    envValue = normalizedStdinValue.value;
    if (normalizedStdinValue.strippedTrailingNewline) {
      output_manager_default.log("Removed trailing newline from stdin input");
    }
  } else if (valueFromFlag !== void 0) {
    envValue = valueFromFlag;
  } else {
    if (client.nonInteractive) {
      outputActionRequired(client, {
        status: "action_required",
        reason: "missing_value",
        message: 'In non-interactive mode provide the value via --value or stdin. Example: vercel env add <name> <environment> --value "<value>" --yes',
        next: [
          {
            command: buildEnvAddCommandWithPreservedArgs(
              client.argv,
              `env add <name> ${getEnvTargetPlaceholder()} --value "<value>" --yes`
            )
          }
        ]
      });
    }
    envValue = await promptEnvValue(client, { isSensitive });
  }
  const { finalValue } = await validateEnvValue({
    envName,
    initialValue: envValue,
    skipConfirm,
    promptForValue: () => promptEnvValue(client, { isSensitive }),
    selectAction: (choices2) => client.input.select({ message: "Value?", choices: choices2 }),
    showWarning: (msg) => printEnvAddWarning(msg),
    showLog: (msg) => output_manager_default.log(msg)
  });
  while (envTargets.length === 0) {
    if (client.nonInteractive && envChoices.length > 0) {
      const standardAvailable = choices.map((c) => c.value).filter((v) => isValidEnvTarget(v));
      const multiTargets = filterSensitiveMultiTargetSuggestionTargets(
        standardAvailable,
        {
          forceSensitive,
          policyOn
        }
      );
      const next = [];
      if (multiTargets.length > 1) {
        next.push(
          multiTargetSuggestion(
            client.argv,
            envName,
            multiTargets,
            multiTargets.includes("development") && !forceEncrypted
          )
        );
      }
      next.push(
        ...envChoices.slice(0, 5).map((c) => ({
          command: buildEnvAddCommandWithPreservedArgs(
            client.argv,
            `env add ${envName} ${c.value} --value "<value>" --yes`
          )
        }))
      );
      outputActionRequired(client, {
        status: "action_required",
        reason: "missing_environment",
        message: `Specify one or more environments (comma-separated). Add as argument or use: ${buildEnvAddCommandWithPreservedArgs(
          client.argv,
          `env add ${envName} <environment>[,<environment>] --value "<value>" --yes`
        )}`,
        choices: envChoices.map((c) => ({
          id: c.value,
          name: typeof c.name === "string" ? c.name : c.value
        })),
        next
      });
    }
    envTargets = await client.input.checkbox({
      message: `Environments?`,
      instructions: CHECKBOX_INSTRUCTIONS,
      choices: envChoices
    });
    if (envTargets.length === 0) {
      output_manager_default.error("Please select at least one Environment");
    }
  }
  const postSelectionError = getTargetCompatibilityError(
    envTargets,
    isSensitive,
    policyOn,
    configSecretUiEnabled
  );
  if (postSelectionError) {
    output_manager_default.error(postSelectionError);
    return 1;
  }
  if (envGitBranch === void 0 && envTargets.length === 1 && envTargets[0] === "preview" && !client.nonInteractive && !opts["--yes"]) {
    output_manager_default.print(
      `  ${import_chalk.default.dim("Leave empty to apply to all Preview branches.")}
`
    );
    envGitBranch = await client.input.text({
      message: `Git branch?`
    });
  }
  const hasDevelopment = envTargets.includes("development");
  let finalType = resolveFinalType(envTargets, isSensitive, {
    forceSensitive,
    forceEncrypted,
    policyOn,
    configSecretUiEnabled
  });
  if (policyOn && !hasDevelopment) {
    if (forceEncrypted) {
      printEnvAddWarning(
        `--no-sensitive is ignored: your team enforces sensitive Environment Variables for Production and Preview.`
      );
      finalType = "sensitive";
    }
  }
  const upsert = opts["--force"] ? "true" : "";
  const { visibility, error: visibilityError } = resolveEnvVarVisibility({
    configSecretUiEnabled,
    explicitVisibility,
    type: finalType,
    key: envName,
    envTargets,
    teamSensitivePolicyOn
  });
  if (visibilityError) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_visibility",
          message: visibilityError
        },
        1
      );
    }
    output_manager_default.error(visibilityError);
    return 1;
  }
  try {
    output_manager_default.spinner("Saving\u2026");
    await addEnvRecord(
      client,
      project.id,
      upsert,
      finalType,
      envName,
      finalValue,
      envTargets,
      envGitBranch,
      visibility
    );
  } catch (err) {
    if (client.nonInteractive && isAPIError(err)) {
      const reason = err.slug || (err.serverMessage?.toLowerCase().includes("branch") ? "branch_not_found" : "api_error");
      outputAgentError(
        client,
        {
          status: "error",
          reason,
          message: err.serverMessage
        },
        1
      );
    }
    if (isAPIError(err) && isKnownError(err)) {
      output_manager_default.error(err.serverMessage);
      return 1;
    }
    throw err;
  }
  printEnvAddResult(
    link,
    envName,
    envTargets,
    envGitBranch,
    customEnvironments,
    finalType,
    Boolean(opts["--force"]),
    visibility
  );
  const { isAgent } = await determineAgent();
  const guidanceMode = parsedArgs.flags["--guidance"] ?? isAgent;
  if (guidanceMode) {
    const projectFlag = opts["--project"] ? ` --project ${opts["--project"]}` : "";
    suggestNextCommands([
      getCommandName(`env ls${projectFlag}`),
      getCommandName(`env pull${projectFlag}`)
    ]);
  }
  return 0;
}

// src/commands/env/ls.ts
var import_chalk2 = __toESM(require_source(), 1);
var import_ms = __toESM(require_ms(), 1);

// src/util/env/format-environments.ts
var import_title = __toESM(require_lib(), 1);
function formatEnvironments(link, env, customEnvironments) {
  const defaultTargets = (Array.isArray(env.target) ? env.target : [env.target || ""]).map((t) => {
    return formatEnvironment(link.org.slug, link.project.name, {
      id: t,
      slug: (0, import_title.default)(t)
    });
  });
  const customTargets = env.customEnvironmentIds ? env.customEnvironmentIds.map((id) => customEnvironments.find((e) => e.id === id)).filter(Boolean).map((e) => formatEnvironment(link.org.slug, link.project.name, e)) : [];
  const targetsString = [...defaultTargets, ...customTargets].join(", ");
  return env.gitBranch ? `${targetsString} (${env.gitBranch})` : targetsString;
}

// src/util/telemetry/commands/env/ls.ts
var EnvLsTelemetryClient = class extends TelemetryClient {
  trackCliArgumentEnvironment(environment) {
    if (environment) {
      this.trackCliArgument({
        arg: "environment",
        value: STANDARD_ENVIRONMENTS.includes(
          environment
        ) ? environment : this.redactedValue
      });
    }
  }
  trackCliArgumentGitBranch(gitBranch) {
    if (gitBranch) {
      this.trackCliArgument({
        arg: "git-branch",
        value: this.redactedValue
      });
    }
  }
  trackCliFlagGuidance(guidance) {
    if (guidance) {
      this.trackCliFlag("guidance");
    }
  }
  trackCliFlagJson(json) {
    if (json) {
      this.trackCliFlag("json");
    }
  }
};

// src/commands/env/ls.ts
import { determineAgent as determineAgent2 } from "@vercel/detect-agent";
async function ls(client, argv) {
  const telemetryClient = new EnvLsTelemetryClient({
    opts: {
      store: client.telemetryEventStore
    }
  });
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(listSubcommand.options);
  try {
    parsedArgs = parseArguments(argv, flagsSpecification);
  } catch (err) {
    printError(err);
    return 1;
  }
  const { args, flags } = parsedArgs;
  const validationResult = validateLsArgs({
    commandName: "env ls",
    args,
    maxArgs: 2,
    exitCode: 1,
    usageString: getCommandName(
      `env ls ${getEnvTargetPlaceholder()} <gitbranch>`
    )
  });
  if (validationResult !== 0) {
    return validationResult;
  }
  const [envTarget, envGitBranch] = args;
  const formatResult = validateJsonOutput(flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const asJson = formatResult.jsonOutput;
  telemetryClient.trackCliArgumentEnvironment(envTarget);
  telemetryClient.trackCliArgumentGitBranch(envGitBranch);
  telemetryClient.trackCliFlagGuidance(flags["--guidance"]);
  telemetryClient.trackCliOptionFormat(flags["--format"]);
  const projectName = flags["--project"];
  telemetryClient.trackCliOptionProject(projectName);
  const link = await resolveProjectContext({
    client,
    projectNameOrId: projectName,
    commandName: "env ls"
  });
  if (link.status === "error") {
    return link.exitCode;
  } else if (link.status === "not_linked") {
    output_manager_default.error(
      `Your codebase isn\u2019t linked to a project on Vercel. Pass --project <name>, or ${client.nonInteractive ? `run ${getCommandName("link --yes --team <team-id> --project <project-id>")} to link non-interactively.` : `run ${getCommandName("link")} to begin.`}`
    );
    return 1;
  }
  client.config.currentTeam = link.org.type === "team" ? link.org.id : void 0;
  const { project, org } = link;
  const lsStamp = stamp_default();
  const [envsResult, customEnvs] = await Promise.all([
    getEnvRecords(client, project.id, "vercel-cli:env:ls", {
      target: envTarget,
      gitBranch: envGitBranch
    }),
    getCustomEnvironments(client, project.id)
  ]);
  const { envs } = envsResult;
  const projectSlugLink = formatProject(org.slug, project.name);
  if (asJson) {
    output_manager_default.stopSpinner();
    const jsonOutput = {
      envs: envs.map((env) => ({
        key: env.key,
        value: isSensitiveEnvironmentVariable(env) ? void 0 : env.value,
        type: env.type,
        visibility: env.visibility,
        target: env.target,
        gitBranch: env.gitBranch,
        configurationId: env.configurationId,
        createdAt: env.createdAt,
        updatedAt: env.updatedAt
      }))
    };
    client.stdout.write(`${JSON.stringify(jsonOutput, null, 2)}
`);
  } else if (envs.length === 0) {
    output_manager_default.log(
      `No Environment Variables found for ${projectSlugLink} ${import_chalk2.default.gray(lsStamp())}`
    );
  } else {
    output_manager_default.log(
      `Environment Variables found for ${projectSlugLink} ${import_chalk2.default.gray(lsStamp())}`
    );
    client.stdout.write(`${getTable(link, envs, customEnvs)}
`);
  }
  if (!asJson) {
    const { isAgent } = await determineAgent2();
    const guidanceMode = parsedArgs.flags["--guidance"] ?? isAgent;
    if (guidanceMode) {
      const projectFlag = projectName ? ` --project ${projectName}` : "";
      suggestNextCommands([
        getCommandName(`env add${projectFlag}`),
        getCommandName(`env rm${projectFlag}`),
        getCommandName(`env pull${projectFlag}`)
      ]);
    }
  }
  return 0;
}
function getTable(link, records, customEnvironments) {
  const label = records.some((env) => env.gitBranch) ? "environments (git branch)" : "environments";
  return formatTable(
    ["name", "value", "type", label, "created"],
    ["l", "l", "l", "l", "l"],
    [
      {
        name: "",
        rows: records.map((row) => getRow(link, row, customEnvironments))
      }
    ]
  );
}
function getRow(link, env, customEnvironments) {
  let value;
  if (isSensitiveEnvironmentVariable(env)) {
    value = import_chalk2.default.gray.italic("Hidden");
  } else if (env.type === "system") {
    value = import_chalk2.default.gray.italic(env.value);
  } else {
    const singleLineValue = env.value.replace(/\s/g, " ");
    value = import_chalk2.default.gray(ellipsis(singleLineValue, 19));
  }
  const now = Date.now();
  return [
    import_chalk2.default.bold(env.key),
    value,
    getEnvironmentVariableTypeLabel(env),
    formatEnvironments(link, env, customEnvironments),
    env.createdAt ? `${(0, import_ms.default)(now - env.createdAt)} ago` : ""
  ];
}
function isSensitiveEnvironmentVariable(env) {
  return env.type === "sensitive" || env.visibility === "secret";
}
function getEnvironmentVariableTypeLabel(env) {
  if (isSensitiveEnvironmentVariable(env)) {
    return "Sensitive";
  }
  return env.type === "system" ? "System" : "Non-sensitive";
}

// src/commands/env/rm.ts
var import_chalk3 = __toESM(require_source(), 1);

// src/util/env/remove-env-record.ts
async function removeEnvRecord(client, projectId, env) {
  output_manager_default.debug(`Removing Environment Variable ${env.key}`);
  const url = `/v10/projects/${projectId}/env/${env.id}`;
  await client.fetch(url, {
    method: "DELETE"
  });
}

// src/util/telemetry/commands/env/rm.ts
var EnvRmTelemetryClient = class extends TelemetryClient {
  trackCliArgumentName(name) {
    if (name) {
      this.trackCliArgument({
        arg: "name",
        value: this.redactedValue
      });
    }
  }
  trackCliArgumentEnvironment(environment) {
    if (environment) {
      this.trackCliArgument({
        arg: "environment",
        value: STANDARD_ENVIRONMENTS.includes(
          environment
        ) ? environment : this.redactedValue
      });
    }
  }
  trackCliArgumentGitBranch(gitBranch) {
    if (gitBranch) {
      this.trackCliArgument({
        arg: "git-branch",
        value: this.redactedValue
      });
    }
  }
  trackCliFlagYes(yes) {
    if (yes) {
      this.trackCliFlag("yes");
    }
  }
};

// src/commands/env/rm.ts
async function rm(client, argv) {
  const telemetryClient = new EnvRmTelemetryClient({
    opts: {
      store: client.telemetryEventStore
    }
  });
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(removeSubcommand.options);
  try {
    parsedArgs = parseArguments(argv, flagsSpecification);
  } catch (err) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_arguments",
          message: err instanceof Error ? err.message : String(err)
        },
        1
      );
    }
    printError(err);
    return 1;
  }
  const { args, flags: opts } = parsedArgs;
  if (args.length > 3) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_arguments",
          message: `Invalid number of arguments. Usage: ${getCommandNamePlain(
            `env rm <name> ${getEnvTargetPlaceholder()} <gitbranch>`
          )}`
        },
        1
      );
    }
    output_manager_default.error(
      `Invalid number of arguments. Usage: ${getCommandName(
        `env rm <name> ${getEnvTargetPlaceholder()} <gitbranch>`
      )}`
    );
    return 1;
  }
  let [envName, envTarget, envGitBranch] = args;
  telemetryClient.trackCliArgumentName(envName);
  telemetryClient.trackCliArgumentEnvironment(envTarget);
  telemetryClient.trackCliArgumentGitBranch(envGitBranch);
  telemetryClient.trackCliFlagYes(opts["--yes"]);
  telemetryClient.trackCliOptionProject(opts["--project"]);
  const link = await resolveProjectContext({
    client,
    projectNameOrId: opts["--project"]
  });
  if (link.status === "error") {
    return link.exitCode;
  } else if (link.status === "not_linked") {
    if (client.nonInteractive) {
      const preserved = getPreservedArgsForEnvRm(client.argv).filter(
        (a) => a !== "--yes" && a !== "-y"
      );
      const linkArgv = [
        ...client.argv.slice(0, 2),
        "link",
        "--scope",
        "<scope>",
        ...preserved
      ];
      outputAgentError(
        client,
        {
          status: "error",
          reason: "not_linked",
          message: `Your codebase isn't linked to a project on Vercel. Run ${getCommandNamePlain(
            "link"
          )} to begin. Use --yes for non-interactive; use --scope or --project to specify team or project.`,
          next: [
            { command: buildCommandWithYes(linkArgv) },
            { command: buildCommandWithYes(client.argv) }
          ]
        },
        1
      );
    } else {
      output_manager_default.error(
        `Your codebase isn\u2019t linked to a project on Vercel. Run ${getCommandName(
          "link"
        )} to begin.`
      );
    }
    return 1;
  }
  client.config.currentTeam = link.org.type === "team" ? link.org.id : void 0;
  const { project } = link;
  if (!envName) {
    if (client.nonInteractive) {
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "missing_name",
          message: "Provide the variable name as an argument. Example: vercel env rm <name> --yes",
          next: [
            {
              command: buildEnvRmCommandWithPreservedArgs(
                client.argv,
                `env rm <name> ${getEnvTargetPlaceholder()} --yes`
              )
            }
          ]
        },
        1
      );
    }
    envName = await client.input.text({
      message: "What's the name of the variable?",
      validate: (val) => val ? true : "Name cannot be empty"
    });
  }
  const [result, customEnvironments] = await Promise.all([
    getEnvRecords(client, project.id, "vercel-cli:env:rm", {
      target: envTarget,
      gitBranch: envGitBranch
    }),
    getCustomEnvironments(client, project.id)
  ]);
  let envs = result.envs.filter((env2) => env2.key === envName);
  if (envs.length === 0) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "env_not_found",
          message: `Environment Variable ${envName} was not found.`
        },
        1
      );
    }
    output_manager_default.error(`Environment Variable was not found.
`);
    return 1;
  }
  while (envs.length > 1) {
    if (client.nonInteractive) {
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "multiple_envs",
          message: `Multiple Environment Variables match ${envName}. Specify target and/or branch to remove one.`,
          next: [
            {
              command: buildEnvRmCommandWithPreservedArgs(
                client.argv,
                `env rm ${envName} ${getEnvTargetPlaceholder()} --yes`
              )
            }
          ]
        },
        1
      );
    }
    const id = await client.input.select({
      message: `Remove ${envName} from which Environments?`,
      choices: envs.map((env2) => ({
        value: env2.id,
        name: formatEnvironments(link, env2, customEnvironments)
      }))
    });
    if (!id) {
      output_manager_default.error("Please select at least one Environment Variable to remove");
    }
    envs = envs.filter((env2) => env2.id === id);
  }
  const env = envs[0];
  const skipConfirmation = opts["--yes"];
  if (!skipConfirmation) {
    if (client.nonInteractive) {
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "confirmation_required",
          message: `Removing Environment Variable ${env.key}. Use --yes to confirm.`,
          next: [{ command: buildCommandWithYes(client.argv) }]
        },
        1
      );
    }
    if (!await client.input.confirm(
      `Removing Environment Variable ${param(env.key)} from ${formatEnvironments(
        link,
        env,
        customEnvironments
      )} in Project ${import_chalk3.default.bold(project.name)}. Are you sure?`,
      false
    )) {
      output_manager_default.log("Canceled");
      return 0;
    }
  }
  const rmStamp = stamp_default();
  try {
    output_manager_default.spinner("Removing");
    await removeEnvRecord(client, project.id, env);
  } catch (err) {
    if (client.nonInteractive && isAPIError(err)) {
      const reason = err.slug || (err.serverMessage?.toLowerCase().includes("branch") ? "branch_not_found" : "api_error");
      outputAgentError(
        client,
        {
          status: "error",
          reason,
          message: err.serverMessage
        },
        1
      );
    }
    if (isAPIError(err) && isKnownError(err)) {
      output_manager_default.error(err.serverMessage);
      return 1;
    }
    throw err;
  }
  output_manager_default.print(
    `${prependEmoji(
      `Removed Environment Variable ${import_chalk3.default.gray(rmStamp())}`,
      emoji("success")
    )}
`
  );
  return 0;
}

// src/commands/env/run.ts
var import_env = __toESM(require_dist3(), 1);
var import_execa = __toESM(require_execa(), 1);
function parseRunArgs(argv) {
  const argvIndex = argv.indexOf("--");
  const hasDoubleDash = argvIndex !== -1;
  const vercelArgs = hasDoubleDash ? argv.slice(2, argvIndex) : argv.slice(2);
  const userCommand = hasDoubleDash ? argv.slice(argvIndex + 1) : [];
  return { vercelArgs, userCommand };
}
function needsHelpForRun(client) {
  const { vercelArgs } = parseRunArgs(client.argv);
  const flagsSpecification = getFlagsSpecification(runSubcommand.options);
  try {
    const parsedArgs = parseArguments(vercelArgs, flagsSpecification);
    return Boolean(parsedArgs.flags["--help"]);
  } catch {
    return false;
  }
}
async function run(client, telemetry) {
  const { vercelArgs, userCommand } = parseRunArgs(client.argv);
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(runSubcommand.options);
  try {
    parsedArgs = parseArguments(vercelArgs, flagsSpecification);
  } catch (error) {
    printError(error);
    return 1;
  }
  if (userCommand.length === 0) {
    output_manager_default.error(
      `No command provided. Use \`--\` to separate vercel flags from your command.`
    );
    return 1;
  }
  const projectName = parsedArgs.flags["--project"];
  telemetry.trackCliOptionProject(projectName);
  const link = await resolveProjectContext({
    client,
    projectNameOrId: projectName
  });
  if (link.status === "error") {
    return link.exitCode;
  } else if (link.status === "not_linked") {
    output_manager_default.error(
      `Your codebase isn't linked to a project on Vercel. Run ${getCommandName(
        "link"
      )} to begin.`
    );
    return 1;
  }
  client.config.currentTeam = link.org.type === "team" ? link.org.id : void 0;
  const environment = parseTarget({
    flagName: "environment",
    flags: parsedArgs.flags
  }) || "development";
  const gitBranch = parsedArgs.flags["--git-branch"];
  output_manager_default.spinner(`Downloading \`${environment}\` environment variables`);
  const records = await pullEnvRecords(
    client,
    link.project.id,
    "vercel-cli:env:run",
    {
      target: environment,
      gitBranch
    }
  );
  output_manager_default.stopSpinner();
  output_manager_default.debug(
    `Running command with ${Object.keys(records.env).length} environment variables`
  );
  let localEnv = {};
  try {
    localEnv = (0, import_env.loadEnvConfig)(client.cwd, true).combinedEnv;
  } catch (err) {
    output_manager_default.debug(`Failed to load local env files: ${err}`);
  }
  try {
    const result = await (0, import_execa.default)(userCommand[0], userCommand.slice(1), {
      cwd: client.cwd,
      stdio: "inherit",
      reject: false,
      env: {
        ...records.env,
        ...localEnv,
        ...process.env
      }
    });
    if (result instanceof Error && typeof result.exitCode !== "number") {
      output_manager_default.prettyError(result);
      return 1;
    }
    return result.exitCode;
  } catch (err) {
    output_manager_default.prettyError(err);
    return 1;
  }
}

// src/commands/env/update.ts
var import_chalk4 = __toESM(require_source(), 1);

// src/util/env/update-env-record.ts
var import_constants2 = __toESM(require_dist2(), 1);
async function updateEnvRecord(client, projectId, envId, type, key, value, targets, gitBranch, visibility) {
  output_manager_default.debug(
    `Updating ${type} Environment Variable ${key} in ${targets.length} targets`
  );
  const target = [];
  const customEnvironmentIds = [];
  for (const t of targets) {
    const arr = import_constants2.PROJECT_ENV_TARGET.includes(t) ? target : customEnvironmentIds;
    arr.push(t);
  }
  const body = {
    type,
    value,
    target,
    customEnvironmentIds: customEnvironmentIds.length > 0 ? customEnvironmentIds : void 0,
    gitBranch: gitBranch || void 0,
    ...visibility !== void 0 ? { visibility } : {}
  };
  if (key) {
    body.key = key;
  }
  const url = `/v10/projects/${projectId}/env/${envId}`;
  await client.fetch(url, {
    method: "PATCH",
    body
  });
}

// src/util/telemetry/commands/env/update.ts
var EnvUpdateTelemetryClient = class extends TelemetryClient {
  trackCliArgumentName(name) {
    if (name) {
      this.trackCliArgument({
        arg: "name",
        value: this.redactedValue
      });
    }
  }
  trackCliArgumentEnvironment(environment) {
    if (environment) {
      this.trackCliArgument({
        arg: "environment",
        value: STANDARD_ENVIRONMENTS.includes(
          environment
        ) ? environment : this.redactedValue
      });
    }
  }
  trackCliArgumentGitBranch(gitBranch) {
    if (gitBranch) {
      this.trackCliArgument({
        arg: "git-branch",
        value: this.redactedValue
      });
    }
  }
  trackCliFlagSensitive(sensitive) {
    if (sensitive) {
      this.trackCliFlag("sensitive");
    }
  }
  trackCliFlagYes(yes) {
    if (yes) {
      this.trackCliFlag("yes");
    }
  }
  trackCliOptionValue(value) {
    if (value) {
      this.trackCliOption({
        option: "value",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionVisibility(visibility) {
    if (visibility) {
      const validVisibilities = ["config", "secret"];
      this.trackCliOption({
        option: "visibility",
        value: validVisibilities.includes(visibility) ? visibility : this.redactedValue
      });
    }
  }
};

// src/commands/env/update.ts
function selectedEnvTargetsDevelopment(env) {
  if (typeof env.target === "string")
    return env.target === "development";
  if (Array.isArray(env.target))
    return env.target.includes("development");
  return false;
}
async function update(client, argv) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(updateSubcommand.options);
  try {
    parsedArgs = parseArguments(argv, flagsSpecification);
  } catch (err) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_arguments",
          message: err instanceof Error ? err.message : String(err)
        },
        1
      );
    }
    printError(err);
    return 1;
  }
  const { args, flags: opts } = parsedArgs;
  const valueFromFlag = typeof opts["--value"] === "string" ? opts["--value"] : void 0;
  const stdInput = await readStandardInput(client.stdin);
  let [envName, envTargetArg, envGitBranch] = args;
  const telemetryClient = new EnvUpdateTelemetryClient({
    opts: {
      store: client.telemetryEventStore
    }
  });
  telemetryClient.trackCliArgumentName(envName);
  telemetryClient.trackCliArgumentEnvironment(envTargetArg);
  telemetryClient.trackCliArgumentGitBranch(envGitBranch);
  telemetryClient.trackCliFlagSensitive(opts["--sensitive"]);
  telemetryClient.trackCliFlagYes(opts["--yes"]);
  telemetryClient.trackCliOptionValue(valueFromFlag);
  telemetryClient.trackCliOptionVisibility(
    typeof opts["--visibility"] === "string" ? opts["--visibility"] : void 0
  );
  if (args.length > 3) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_arguments",
          message: `Invalid number of arguments. Usage: ${getCommandNamePlain(
            `env update <name> ${getEnvTargetPlaceholder()} <gitbranch>`
          )}`
        },
        1
      );
    }
    output_manager_default.error(
      `Invalid number of arguments. Usage: ${getCommandName(
        `env update <name> ${getEnvTargetPlaceholder()} <gitbranch>`
      )}`
    );
    return 1;
  }
  if (stdInput && (!envName || !envTargetArg)) {
    output_manager_default.error(
      `Invalid number of arguments. Usage: ${getCommandName(
        `env update <name> <target> <gitbranch> < <file>`
      )}`
    );
    return 1;
  }
  if (client.nonInteractive) {
    const missing = [];
    if (!envName)
      missing.push("missing_name");
    if (!stdInput && valueFromFlag === void 0)
      missing.push("missing_value");
    if (missing.length > 0) {
      const parts = missing.map(
        (m) => m === "missing_name" ? "name" : "--value or stdin"
      );
      const targetPart = envTargetArg || getEnvTargetPlaceholder();
      const branchPart = envTargetArg === "preview" || envTargetArg === "development" ? " <gitbranch>" : "";
      const template = `env update ${envName || "<name>"} ${targetPart}${branchPart} --value <value> --yes`;
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "missing_requirements",
          missing,
          message: `Provide all required inputs for non-interactive mode: ${parts.join("; ")}. Example: ${getCommandNamePlain(template)}`,
          next: [
            {
              command: buildEnvUpdateCommandWithPreservedArgs(
                client.argv,
                template
              )
            }
          ]
        },
        1
      );
    }
  }
  const envTargets = [];
  if (envTargetArg) {
    envTargets.push(envTargetArg);
  }
  if (!envName) {
    if (client.nonInteractive) {
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "missing_name",
          message: "Provide the variable name as an argument. Example: vercel env update <name>",
          next: [
            {
              command: buildEnvUpdateCommandWithPreservedArgs(
                client.argv,
                `env update <name> ${getEnvTargetPlaceholder()} --value <value> --yes`
              )
            }
          ]
        },
        1
      );
    } else {
      envName = await client.input.text({
        message: `What's the name of the variable to update?`,
        validate: (val) => val ? true : "Name cannot be empty"
      });
    }
  }
  telemetryClient.trackCliOptionProject(opts["--project"]);
  const link = await resolveProjectContext({
    client,
    projectNameOrId: opts["--project"]
  });
  if (link.status === "error") {
    return link.exitCode;
  } else if (link.status === "not_linked") {
    if (client.nonInteractive) {
      const preserved = getPreservedArgsForEnvUpdate(client.argv).filter(
        (a) => a !== "--yes" && a !== "-y"
      );
      const linkArgv = [
        ...client.argv.slice(0, 2),
        "link",
        "--scope",
        "<scope>",
        ...preserved
      ];
      outputAgentError(
        client,
        {
          status: "error",
          reason: "not_linked",
          message: `Your codebase isn't linked to a project on Vercel. Run ${getCommandNamePlain(
            "link"
          )} to begin. Use --yes for non-interactive; use --scope or --project to specify team or project.`,
          next: [
            { command: buildCommandWithYes(linkArgv) },
            { command: buildCommandWithYes(client.argv) }
          ]
        },
        1
      );
    }
    output_manager_default.error(
      `Your codebase isn't linked to a project on Vercel. Run ${getCommandName(
        "link"
      )} to begin.`
    );
    return 1;
  }
  client.config.currentTeam = link.org.type === "team" ? link.org.id : void 0;
  const { project } = link;
  const [{ envs }, customEnvironments] = await Promise.all([
    getEnvRecords(client, project.id, "vercel-cli:env:update"),
    getCustomEnvironments(client, project.id)
  ]);
  const customEnvironment = customEnvironments.find(
    ({ slug, id }) => slug === envTargetArg || id === envTargetArg
  );
  const normalizedEnvTargetArg = customEnvironment?.id || envTargetArg;
  const matchingEnvs = envs.filter((r) => r.key === envName);
  if (matchingEnvs.length === 0) {
    const listFlags = getGlobalFlagsFromArgs(client.argv.slice(2), {
      preserveProject: true
    });
    const listArgs = `env ls ${listFlags.join(" ")}`.trim();
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "env_not_found",
          message: `The variable ${envName} was not found. Run ${getCommandNamePlain(listArgs)} to see all available Environment Variables.`
        },
        1
      );
    }
    output_manager_default.error(
      `The variable ${param(envName)} was not found. Run ${getCommandName(listArgs)} to see all available Environment Variables.`
    );
    return 1;
  }
  let selectedEnv;
  if (envTargetArg || envGitBranch) {
    const filteredEnvs = matchingEnvs.filter((env) => {
      const matchesTarget = !normalizedEnvTargetArg || (Array.isArray(env.target) ? env.target.includes(normalizedEnvTargetArg) : env.target === normalizedEnvTargetArg) || env.customEnvironmentIds && env.customEnvironmentIds.includes(normalizedEnvTargetArg);
      const matchesGitBranch = !envGitBranch || env.gitBranch === envGitBranch;
      return matchesTarget && matchesGitBranch;
    });
    if (filteredEnvs.length === 0) {
      if (client.nonInteractive) {
        outputAgentError(
          client,
          {
            status: "error",
            reason: "env_not_found",
            message: `No Environment Variable ${envName} found matching the specified target/branch.`
          },
          1
        );
      }
      output_manager_default.error(
        `No Environment Variable ${param(envName)} found matching the specified criteria.`
      );
      return 1;
    }
    if (filteredEnvs.length === 1) {
      selectedEnv = filteredEnvs[0];
    } else {
      if (client.nonInteractive) {
        outputActionRequired(
          client,
          {
            status: "action_required",
            reason: "multiple_envs",
            message: `Multiple Environment Variables match ${envName}. Specify target and/or branch to update one.`,
            next: [
              {
                command: buildEnvUpdateCommandWithPreservedArgs(
                  client.argv,
                  `env update ${envName} ${getEnvTargetPlaceholder()} <gitbranch>`
                )
              }
            ]
          },
          1
        );
      }
      const choices = filteredEnvs.map((env, index) => {
        const targets2 = formatEnvironments(link, env, customEnvironments);
        return {
          name: targets2,
          value: index
        };
      });
      const selectedIndex = await client.input.select({
        message: `Multiple Environment Variables found for ${param(envName)}. Which one do you want to update?`,
        choices
      });
      selectedEnv = filteredEnvs[selectedIndex];
    }
  } else if (matchingEnvs.length === 1) {
    selectedEnv = matchingEnvs[0];
  } else {
    if (client.nonInteractive) {
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "multiple_envs",
          message: `Multiple Environment Variables match ${envName}. Specify target and/or branch to update one.`,
          next: [
            {
              command: buildEnvUpdateCommandWithPreservedArgs(
                client.argv,
                `env update ${envName} ${getEnvTargetPlaceholder()} <gitbranch>`
              )
            }
          ]
        },
        1
      );
    }
    const choices = matchingEnvs.map((env, index) => {
      const targets2 = formatEnvironments(link, env, customEnvironments);
      return {
        name: targets2,
        value: index
      };
    });
    const selectedIndex = await client.input.select({
      message: `Multiple Environment Variables found for ${param(envName)}. Which one do you want to update?`,
      choices
    });
    selectedEnv = matchingEnvs[selectedIndex];
  }
  const configSecretUiEnabled = isEnvVarConfigSecretUiEnabled();
  let policyOn = false;
  let teamSensitivePolicyOn = false;
  if (link.org.type === "team") {
    try {
      const team = await getTeamById(client, link.org.id);
      teamSensitivePolicyOn = team?.sensitiveEnvironmentVariablePolicy === "on";
      policyOn = shouldEnforceSensitiveEnvVarPolicy(teamSensitivePolicyOn);
    } catch {
    }
  }
  const selectedIsDevelopment = selectedEnvTargetsDevelopment(selectedEnv);
  if (policyOn && selectedIsDevelopment && !configSecretUiEnabled) {
    const msg = `Your team has enabled the Sensitive Environment Variables Policy and the Development Environment does not support sensitive values. https://vercel.com/docs/environment-variables/sensitive-environment-variables#environment-variables-policy`;
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "development_disallowed_by_team_policy",
          message: msg
        },
        1
      );
    }
    output_manager_default.error(msg);
    return 1;
  }
  if (opts["--sensitive"] && selectedIsDevelopment && !configSecretUiEnabled) {
    const msg = `--sensitive is not allowed with the Development Environment. Sensitive Environment Variables are only supported on Production and Preview.`;
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "sensitive_not_allowed_on_development",
          message: msg
        },
        1
      );
    }
    output_manager_default.error(msg);
    return 1;
  }
  let envValue;
  if (stdInput) {
    const normalizedStdinValue = normalizeStdinEnvValue(stdInput);
    envValue = normalizedStdinValue.value;
    if (normalizedStdinValue.strippedTrailingNewline) {
      output_manager_default.log("Removed trailing newline from stdin input");
    }
  } else if (valueFromFlag !== void 0) {
    envValue = valueFromFlag;
  } else {
    if (client.nonInteractive) {
      const branchPart = envTargetArg === "preview" || envTargetArg === "development" ? " <gitbranch>" : "";
      const targetPart = envTargetArg || getEnvTargetPlaceholder();
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "missing_value",
          message: "In non-interactive mode provide the new value via --value or stdin. Example: vercel env update <name> <environment> --value 'value' --yes",
          next: [
            {
              command: buildEnvUpdateCommandWithPreservedArgs(
                client.argv,
                `env update ${envName} ${targetPart}${branchPart} --value <value> --yes`
              )
            }
          ]
        },
        1
      );
    }
    envValue = await client.input.text({
      message: `What's the new value of ${envName}?`
    });
  }
  const skipConfirm = opts["--yes"] || !!stdInput || valueFromFlag !== void 0;
  const { finalValue, alreadyConfirmed } = await validateEnvValue({
    envName,
    initialValue: envValue,
    skipConfirm,
    promptForValue: () => client.input.text({ message: `What's the new value of ${envName}?` }),
    selectAction: (choices) => client.input.select({ message: "How to proceed?", choices }),
    showWarning: (msg) => output_manager_default.warn(msg),
    showLog: (msg) => output_manager_default.log(msg)
  });
  if (!opts["--yes"] && !alreadyConfirmed) {
    if (client.nonInteractive) {
      outputActionRequired(
        client,
        {
          status: "action_required",
          reason: "confirmation_required",
          message: `Updating Environment Variable ${envName}. Use --yes to confirm.`,
          next: [{ command: buildCommandWithYes(client.argv) }]
        },
        1
      );
    }
    const currentTargets = formatEnvironments(
      link,
      selectedEnv,
      customEnvironments
    );
    const confirmed = await client.input.confirm(
      `Updating Environment Variable ${param(envName)} in ${currentTargets} in Project ${import_chalk4.default.bold(project.name)}. Are you sure?`,
      false
    );
    if (!confirmed) {
      output_manager_default.log("Canceled");
      return 0;
    }
  }
  const type = opts["--sensitive"] ? "sensitive" : selectedEnv.type;
  const explicitVisibility = typeof opts["--visibility"] === "string" ? opts["--visibility"] : void 0;
  if (explicitVisibility === "config" && opts["--sensitive"]) {
    output_manager_default.error(
      "`--visibility config` cannot be used with `--sensitive`. Pick one."
    );
    return 1;
  }
  const targets = Array.isArray(selectedEnv.target) ? selectedEnv.target : [selectedEnv.target].filter(
    (r) => Boolean(r)
  );
  const allTargets = [...targets, ...selectedEnv.customEnvironmentIds || []];
  const { visibility, error: visibilityError } = resolveEnvVarVisibility({
    configSecretUiEnabled,
    explicitVisibility,
    type,
    key: envName,
    envTargets: allTargets,
    teamSensitivePolicyOn
  });
  if (visibilityError) {
    if (client.nonInteractive) {
      outputAgentError(
        client,
        {
          status: "error",
          reason: "invalid_visibility",
          message: visibilityError
        },
        1
      );
    }
    output_manager_default.error(visibilityError);
    return 1;
  }
  const updateStamp = stamp_default();
  try {
    output_manager_default.spinner("Updating");
    const keyToUpdate = type === "sensitive" ? void 0 : envName;
    await updateEnvRecord(
      client,
      project.id,
      selectedEnv.id,
      type,
      keyToUpdate,
      finalValue,
      allTargets,
      selectedEnv.gitBranch || "",
      visibility
    );
  } catch (err) {
    if (client.nonInteractive && isAPIError(err)) {
      const reason = err.slug || (err.serverMessage?.toLowerCase().includes("branch") ? "branch_not_found" : "api_error");
      outputAgentError(
        client,
        {
          status: "error",
          reason,
          message: err.serverMessage
        },
        1
      );
    }
    if (isAPIError(err) && isKnownError(err)) {
      output_manager_default.error(err.serverMessage);
      return 1;
    }
    throw err;
  }
  output_manager_default.print(
    `${prependEmoji(
      `Updated Environment Variable ${import_chalk4.default.bold(envName)} in Project ${import_chalk4.default.bold(
        project.name
      )} ${import_chalk4.default.gray(updateStamp())}`,
      emoji("success")
    )}
`
  );
  if (configSecretUiEnabled) {
    const visibilityLabel = formatVisibilityLabel(visibility, type);
    if (visibilityLabel) {
      printAlignedLabel("Visibility", visibilityLabel);
    }
  }
  return 0;
}

// src/util/telemetry/commands/env/index.ts
var EnvTelemetryClient = class extends TelemetryClient {
  trackCliSubcommandList(actual) {
    this.trackCliSubcommand({
      subcommand: "ls",
      value: actual
    });
  }
  trackCliSubcommandAdd(actual) {
    this.trackCliSubcommand({
      subcommand: "add",
      value: actual
    });
  }
  trackCliSubcommandRemove(actual) {
    this.trackCliSubcommand({
      subcommand: "rm",
      value: actual
    });
  }
  trackCliSubcommandPull(actual) {
    this.trackCliSubcommand({
      subcommand: "pull",
      value: actual
    });
  }
  trackCliSubcommandRun(actual) {
    this.trackCliSubcommand({
      subcommand: "run",
      value: actual
    });
  }
  trackCliSubcommandUpdate(actual) {
    this.trackCliSubcommand({
      subcommand: "update",
      value: actual
    });
  }
};

// src/commands/env/index.ts
var COMMAND_CONFIG = {
  ls: getCommandAliases(listSubcommand),
  add: getCommandAliases(addSubcommand),
  rm: getCommandAliases(removeSubcommand),
  pull: getCommandAliases(pullSubcommand),
  run: getCommandAliases(runSubcommand),
  update: getCommandAliases(updateSubcommand)
};
async function main(client) {
  const telemetry = new EnvTelemetryClient({
    opts: {
      store: client.telemetryEventStore
    }
  });
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(envCommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification, {
      permissive: true
    });
  } catch (err) {
    printError(err);
    return 1;
  }
  const subArgs = parsedArgs.args.slice(1);
  const { subcommand, args, subcommandOriginal } = getSubcommand(
    subArgs,
    COMMAND_CONFIG
  );
  const needHelp = parsedArgs.flags["--help"];
  if (!subcommand && needHelp) {
    telemetry.trackCliFlagHelp("env", subcommand);
    output_manager_default.print(help(envCommand, { columns: client.stderr.columns }));
    return 2;
  }
  function printHelp(command) {
    output_manager_default.print(
      help(command, { parent: envCommand, columns: client.stderr.columns })
    );
  }
  let exitCode;
  switch (subcommand) {
    case "ls":
      if (needHelp) {
        telemetry.trackCliFlagHelp("env", subcommandOriginal);
        printHelp(listSubcommand);
        return 2;
      }
      telemetry.trackCliSubcommandList(subcommandOriginal);
      exitCode = await ls(client, args);
      break;
    case "add":
      if (needHelp) {
        telemetry.trackCliFlagHelp("env", subcommandOriginal);
        printHelp(addSubcommand);
        return 2;
      }
      telemetry.trackCliSubcommandAdd(subcommandOriginal);
      exitCode = await add(client, args);
      break;
    case "rm":
      if (needHelp) {
        telemetry.trackCliFlagHelp("env", subcommandOriginal);
        printHelp(removeSubcommand);
        return 2;
      }
      telemetry.trackCliSubcommandRemove(subcommandOriginal);
      exitCode = await rm(client, args);
      break;
    case "pull":
      if (needHelp) {
        telemetry.trackCliFlagHelp("env", subcommandOriginal);
        printHelp(pullSubcommand);
        return 2;
      }
      telemetry.trackCliSubcommandPull(subcommandOriginal);
      exitCode = await pull(client, args);
      break;
    case "run":
      if (needsHelpForRun(client)) {
        telemetry.trackCliFlagHelp("env", subcommandOriginal);
        printHelp(runSubcommand);
        return 2;
      }
      telemetry.trackCliSubcommandRun(subcommandOriginal);
      exitCode = await run(client, telemetry);
      break;
    case "update":
      if (needHelp) {
        telemetry.trackCliFlagHelp("env", subcommandOriginal);
        printHelp(updateSubcommand);
        return 2;
      }
      telemetry.trackCliSubcommandUpdate(subcommandOriginal);
      exitCode = await update(client, args);
      break;
    default:
      output_manager_default.error(getInvalidSubcommand(COMMAND_CONFIG));
      output_manager_default.print(help(envCommand, { columns: client.stderr.columns }));
      return 2;
  }
  if (exitCode === 0) {
    await autoInstallVercelPlugin(client);
  }
  return exitCode;
}
export {
  main as default
};
