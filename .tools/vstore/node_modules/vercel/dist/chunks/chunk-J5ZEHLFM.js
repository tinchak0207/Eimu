import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  LinkRequiredError,
  ProjectNotFound,
  getGlobalFlagsFromArgs,
  isAPIError,
  packageName,
  stripSensitiveAuthArgs,
  suggestionFlagTakesSeparateValue
} from "./chunk-SOFC4MLS.js";
import {
  require_dist
} from "./chunk-OX7KI3LF.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/util/agent-output.ts
var import_error_utils = __toESM(require_dist(), 1);
function buildCommandWithYes(argv, pkgName = packageName) {
  const args = stripSensitiveAuthArgs(argv.slice(2));
  const hasYes = args.some((a) => a === "--yes" || a === "-y");
  const out = hasYes ? args : [...args, "--yes"];
  return `${pkgName} ${out.join(" ")}`.trim();
}
var GLOBAL_FLAG_NAMES = /* @__PURE__ */ new Set([
  "--cwd",
  "--config",
  "--yes",
  "-y",
  "--non-interactive",
  "--scope",
  "--team",
  "-S",
  "-T"
  // --token/-t are intentionally excluded and stripped via stripSensitiveAuthArgs.
]);
var GLOBAL_FLAG_SHORTHANDS = {
  "-y": "--yes",
  "-S": "--scope",
  "-T": "--team"
};
function canonicalGlobalFlagName(name) {
  return GLOBAL_FLAG_SHORTHANDS[name] ?? name;
}
function getGlobalFlagsFromArgv(argv) {
  const args = getGlobalFlagsFromArgs(argv.slice(2), {
    preserveConfig: true,
    preserveYes: true
  });
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.startsWith("--") ? arg.split("=")[0] : arg;
    if (GLOBAL_FLAG_NAMES.has(name)) {
      out.push(arg);
      const takesSeparateValue = suggestionFlagTakesSeparateValue(name) && !arg.includes("=") && i + 1 < args.length && !args[i + 1].startsWith("-");
      if (takesSeparateValue) {
        out.push(args[i + 1]);
        i++;
      }
    }
  }
  return out;
}
function omitGlobalFlagsFromArgs(args) {
  const safeArgs = stripSensitiveAuthArgs(args);
  const out = [];
  for (let i = 0; i < safeArgs.length; i++) {
    const arg = safeArgs[i];
    const name = arg.startsWith("--") ? arg.split("=")[0] : arg;
    if (GLOBAL_FLAG_NAMES.has(name)) {
      const skipSeparateValue = suggestionFlagTakesSeparateValue(name) && !arg.includes("=") && i + 1 < safeArgs.length && !safeArgs[i + 1].startsWith("-");
      if (skipSeparateValue) {
        i++;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}
function buildIntegrationCommandTailFromArgv(argv) {
  const args = argv.slice(2);
  const idx = args.indexOf("integration");
  if (idx === -1) {
    return "integration";
  }
  return omitGlobalFlagsFromArgs(args.slice(idx)).join(" ");
}
function buildCommandWithGlobalFlags(argv, commandTemplate, pkgName = packageName, options) {
  let preserved = options?.globalFlags === "all" ? getGlobalFlagsFromArgs(argv.slice(2), {
    preserveProject: options.preserveProject
  }) : getGlobalFlagsFromArgv(argv);
  if (options?.globalFlags !== "all" && options?.preserveProject) {
    const globalArgs = getGlobalFlagsFromArgs(argv.slice(2));
    const contextArgs = getGlobalFlagsFromArgs(argv.slice(2), {
      preserveProject: true
    });
    preserved.push(...contextArgs.slice(globalArgs.length));
  }
  const exclude = new Set(
    commandTemplate.split(/\s+/).filter((token) => token.startsWith("-")).map((token) => canonicalGlobalFlagName(token.split("=")[0]))
  );
  for (const flag of options?.excludeFlags ?? []) {
    exclude.add(canonicalGlobalFlagName(flag));
  }
  if (exclude.size) {
    const out = [];
    for (let i = 0; i < preserved.length; i++) {
      const arg = preserved[i];
      const name = arg.startsWith("--") ? arg.split("=")[0] : arg;
      if (exclude.has(canonicalGlobalFlagName(name))) {
        if (!arg.includes("=") && i + 1 < preserved.length && !preserved[i + 1].startsWith("-")) {
          i++;
        }
        continue;
      }
      out.push(arg);
    }
    preserved = out;
  }
  const base = `${pkgName} ${commandTemplate}`;
  if (preserved.length === 0) {
    return base;
  }
  if (options?.prependGlobalFlags) {
    return `${pkgName} ${preserved.join(" ")} ${commandTemplate}`;
  }
  return `${base} ${preserved.join(" ")}`;
}
function withGlobalFlags(client, commandTemplate, options = {}) {
  return buildCommandWithGlobalFlags(
    client.argv,
    commandTemplate,
    packageName,
    {
      globalFlags: "all",
      preserveProject: options.preserveProject
    }
  );
}
function getPreservedArgsAfterEnvSubcommand(argv, subcommands, positionalCount) {
  const args = stripSensitiveAuthArgs(argv.slice(2));
  const envIdx = args.findIndex(
    (arg, index) => arg === "env" && subcommands.includes(args[index + 1])
  );
  const subcommandIdx = envIdx + 1;
  if (envIdx === -1) {
    return args;
  }
  const preserved = [];
  let positionals = 0;
  let optionsEnded = false;
  for (let i = subcommandIdx + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" && !optionsEnded) {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      preserved.push(arg);
      if (!arg.includes("=") && suggestionFlagTakesSeparateValue(arg) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
        preserved.push(args[++i]);
      }
      continue;
    }
    if (positionals < positionalCount) {
      positionals++;
      continue;
    }
    if (optionsEnded && !preserved.includes("--")) {
      preserved.push("--");
    }
    preserved.push(arg);
  }
  return preserved;
}
function omitPreservedFlagsAlreadyInTemplate(args, commandTemplate) {
  const templateFlags = new Set(
    commandTemplate.split(/\s+/).filter((token) => token.startsWith("-")).map((token) => canonicalGlobalFlagName(token.split("=")[0]))
  );
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.startsWith("-") ? arg.split("=")[0] : arg;
    if (!templateFlags.has(canonicalGlobalFlagName(name))) {
      out.push(arg);
      continue;
    }
    if (!arg.includes("=") && suggestionFlagTakesSeparateValue(name) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
      i++;
    }
  }
  return out;
}
function getPreservedArgsForEnvAdd(argv) {
  return getPreservedArgsAfterEnvSubcommand(argv, ["add"], 3);
}
function buildEnvAddCommandWithPreservedArgs(argv, commandTemplate, pkgName = packageName) {
  const preserved = omitPreservedFlagsAlreadyInTemplate(
    getPreservedArgsForEnvAdd(argv),
    commandTemplate
  );
  const base = `${pkgName} ${commandTemplate}`;
  if (preserved.length === 0)
    return base;
  return `${base} ${preserved.join(" ")}`;
}
function getPreservedArgsForEnvPull(argv) {
  return getPreservedArgsAfterEnvSubcommand(argv, ["pull"], 1);
}
function getPreservedArgsForEnvRm(argv) {
  return getPreservedArgsAfterEnvSubcommand(argv, ["rm", "remove"], 3);
}
function buildEnvRmCommandWithPreservedArgs(argv, commandTemplate, pkgName = packageName) {
  const preserved = omitPreservedFlagsAlreadyInTemplate(
    getPreservedArgsForEnvRm(argv),
    commandTemplate
  );
  const base = `${pkgName} ${commandTemplate}`;
  if (preserved.length === 0)
    return base;
  return `${base} ${preserved.join(" ")}`;
}
function getPreservedArgsForEnvUpdate(argv) {
  return getPreservedArgsAfterEnvSubcommand(argv, ["update"], 3);
}
function buildEnvUpdateCommandWithPreservedArgs(argv, commandTemplate, pkgName = packageName) {
  const preserved = omitPreservedFlagsAlreadyInTemplate(
    getPreservedArgsForEnvUpdate(argv),
    commandTemplate
  );
  const base = `${pkgName} ${commandTemplate}`;
  if (preserved.length === 0)
    return base;
  return `${base} ${preserved.join(" ")}`;
}
function buildCommandWithScope(argv, scopeSlug, pkgName = packageName) {
  const args = stripSensitiveAuthArgs(argv.slice(2));
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope" || args[i] === "--team" || args[i] === "-S" || args[i] === "-T") {
      i++;
      continue;
    }
    if (args[i].startsWith("--scope=") || args[i].startsWith("--team=")) {
      continue;
    }
    out.push(args[i]);
  }
  out.push("--scope", scopeSlug);
  return `${pkgName} ${out.join(" ")}`;
}
function enrichActionRequiredWithInvokingCommand(payload, argv) {
  if (!payload.choices?.length) {
    return payload;
  }
  const next = [];
  const linkArgv = [...argv.slice(0, 2), "link", ...argv.slice(3)];
  for (const choice of payload.choices) {
    const slug = choice.name;
    next.push({
      command: buildCommandWithScope(linkArgv, slug),
      when: "Link first (then run any command without --scope)"
    });
    next.push({
      command: buildCommandWithScope(argv, slug),
      when: "Run this command with scope (no link)"
    });
  }
  return { ...payload, next };
}
function outputActionRequired(client, payload, exitCode = 1) {
  if (!shouldEmitNonInteractiveCommandError(client)) {
    return;
  }
  const enriched = enrichActionRequiredWithInvokingCommand(
    payload,
    client.argv
  );
  if (!enriched.hint && enriched.next?.length) {
    enriched.hint = "Run one of the commands in next[] to complete without prompting.";
  }
  client.stdout.write(`${JSON.stringify(enriched, null, 2)}
`);
  process.exit(exitCode);
}
function argvHasNonInteractive(argv) {
  if (!argv?.length) {
    return false;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--non-interactive") {
      return argv[i + 1] !== "false";
    }
    if (a.startsWith("--non-interactive=")) {
      return a.slice("--non-interactive=".length) !== "false";
    }
  }
  return false;
}
function shouldEmitNonInteractiveCommandError(client) {
  return client.nonInteractive || argvHasNonInteractive(client.argv ?? []);
}
function outputAgentError(client, payload, exitCode = 1) {
  if (!shouldEmitNonInteractiveCommandError(client)) {
    return;
  }
  client.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
  process.exit(exitCode);
}
function outputAgentSuccess(client, payload, exitCode = 0) {
  if (!shouldEmitNonInteractiveCommandError(client)) {
    return;
  }
  if (!payload.hint && payload.next?.length) {
    payload.hint = "Follow up with one of the commands in next[].";
  }
  client.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
  process.exit(exitCode);
}
function buildNextStepsForGlobalConfig(client) {
  return [
    {
      command: buildCommandWithGlobalFlags(client.argv, "global-config list"),
      when: "List Global Config stores in the current team scope"
    },
    {
      command: buildCommandWithGlobalFlags(client.argv, "teams switch"),
      when: "Switch to the team that owns the Global Config"
    },
    {
      command: buildCommandWithGlobalFlags(client.argv, "whoami"),
      when: "Verify the current team or user scope"
    }
  ];
}
var GLOBAL_CONFIG_NON_INTERACTIVE_HINT = "Global Config commands use your current team scope. Pass --scope or run `vercel teams switch` if the store is missing.";
var LIST_ERROR_HINT = "Project names are team-scoped. Use --scope when the project belongs to another team, or `list --all` to list deployments across all projects.";
function buildNextStepsForList(client, projectName) {
  return [
    projectName ? {
      command: buildCommandWithGlobalFlags(
        client.argv,
        `project ls --filter ${projectName}`
      ),
      when: "Search projects matching the attempted name to find the right one"
    } : {
      command: buildCommandWithGlobalFlags(
        client.argv,
        "project ls --filter <name>"
      ),
      when: "Search projects by name substring to find the right one (replace <name>)"
    },
    {
      command: buildCommandWithGlobalFlags(client.argv, "list --all"),
      when: "List deployments across all projects in the current scope"
    },
    {
      command: buildCommandWithGlobalFlags(client.argv, "link"),
      when: "Re-link this directory to the correct Vercel project"
    }
  ];
}
function buildNextStepsForProjectSubcommands(client, variant) {
  const byName = variant === "access-groups" ? {
    template: "project access-groups <name>",
    when: "List access groups by project name (replace <name>)"
  } : variant === "access-summary" ? {
    template: "project access-summary <name>",
    when: "Show role counts by project name (replace <name>)"
  } : variant === "protection" ? {
    template: "project protection <name>",
    when: "Show deployment protection by project name (replace <name>)"
  } : variant === "update" ? {
    template: "project update <name> --framework <slug>",
    when: "Update a framework preset by project name (replace <name> and <slug>)"
  } : variant === "speed-insights" ? {
    template: "project speed-insights <name>",
    when: "Enable Speed Insights by project name (replace <name>)"
  } : variant === "web-analytics" ? {
    template: "project web-analytics <name>",
    when: "Enable Web Analytics by project name (replace <name>)"
  } : variant === "checks" ? {
    template: "project checks add <name>",
    when: "Create a deployment check by project name (replace <name>)"
  } : variant === "inspect" ? {
    template: "project inspect <name>",
    when: "Inspect a project by name (replace <name>)"
  } : {
    template: "project members <name>",
    when: "List members by project name (replace <name>)"
  };
  return [
    {
      command: buildCommandWithGlobalFlags(client.argv, "link"),
      when: "Re-link this directory to the correct Vercel project"
    },
    {
      command: buildCommandWithGlobalFlags(client.argv, byName.template),
      when: byName.when
    },
    {
      command: buildCommandWithGlobalFlags(client.argv, "project ls"),
      when: "List projects in the current team to pick a name"
    }
  ];
}
var PROJECT_SUBCOMMAND_ERROR_HINT = "If you use --cwd, ensure that folder is linked to the right project, or pass an explicit project name. Use --scope when the project belongs to another team.";
function resolveNonInteractiveDefaults(client, variant) {
  if (variant === "global-config") {
    return {
      next: buildNextStepsForGlobalConfig(client),
      hint: GLOBAL_CONFIG_NON_INTERACTIVE_HINT
    };
  }
  if (variant === "list") {
    return {
      next: buildNextStepsForList(client),
      hint: LIST_ERROR_HINT
    };
  }
  return {
    next: buildNextStepsForProjectSubcommands(client, variant),
    hint: PROJECT_SUBCOMMAND_ERROR_HINT
  };
}
function writeAgentErrorPayloadAndExit(client, payload, exitCode, variant) {
  const defaults = resolveNonInteractiveDefaults(client, variant);
  const out = {
    ...payload,
    next: payload.next ?? defaults.next,
    hint: payload.hint ?? defaults.hint
  };
  client.stdout.write(`${JSON.stringify(out, null, 2)}
`);
  process.exit(exitCode);
}
function isProjectNotFoundLike(err) {
  if (err instanceof ProjectNotFound) {
    return true;
  }
  if ((0, import_error_utils.isError)(err) && "code" in err && err.code === "PROJECT_NOT_FOUND") {
    return true;
  }
  return false;
}
function isLinkRequiredLike(err) {
  return err instanceof LinkRequiredError;
}
function normalizeApiErrorText(message) {
  return message.replace(/\s*\(\d{3}\)\s*$/, "").trim();
}
function exitWithNonInteractiveError(client, err, exitCode = 1, options = {
  variant: "members"
}) {
  if (!shouldEmitNonInteractiveCommandError(client)) {
    return;
  }
  const { variant } = options;
  if (isLinkRequiredLike(err)) {
    if (variant === "global-config") {
      writeAgentErrorPayloadAndExit(
        client,
        {
          status: "error",
          reason: "link_required",
          message: err instanceof Error ? err.message : String(err),
          next: buildNextStepsForGlobalConfig(client),
          hint: GLOBAL_CONFIG_NON_INTERACTIVE_HINT
        },
        exitCode,
        "global-config"
      );
      return;
    }
    writeAgentErrorPayloadAndExit(
      client,
      {
        status: "error",
        reason: "link_required",
        message: err instanceof Error ? err.message : String(err)
      },
      exitCode,
      variant
    );
    return;
  }
  if (isProjectNotFoundLike(err)) {
    writeAgentErrorPayloadAndExit(
      client,
      {
        status: "error",
        reason: "project_not_found",
        message: err instanceof Error ? err.message : String(err),
        ...variant === "list" && options.projectName ? { next: buildNextStepsForList(client, options.projectName) } : {}
      },
      exitCode,
      variant
    );
    return;
  }
  if (isAPIError(err)) {
    const rawMessage = err.serverMessage || err.message;
    const message = normalizeApiErrorText(rawMessage);
    const reason = err.status === 403 ? "forbidden" : err.status === 401 ? "not_authorized" : err.status === 404 ? variant === "global-config" ? "not_found" : "project_not_found" : err.status === 429 ? "rate_limited" : "api_error";
    writeAgentErrorPayloadAndExit(
      client,
      {
        status: "error",
        reason,
        message,
        ...err.action && { action: err.action },
        ...err.resource && { resource: err.resource }
      },
      exitCode,
      variant
    );
  }
  writeAgentErrorPayloadAndExit(
    client,
    {
      status: "error",
      reason: "unexpected_error",
      message: err instanceof Error ? err.message : String(err)
    },
    exitCode,
    variant
  );
}
function openUrlInBrowserCommand(url) {
  if (process.platform === "win32")
    return `start ${url}`;
  if (process.platform === "darwin")
    return `open '${url}'`;
  return `xdg-open '${url}'`;
}

// src/util/agent-output-constants.ts
var AGENT_STATUS = {
  ERROR: "error",
  ACTION_REQUIRED: "action_required",
  OK: "ok"
};
var AGENT_REASON = {
  // Common (use across dns, flags, routes, env, domains, link)
  MISSING_ARGUMENTS: "missing_arguments",
  INVALID_ARGUMENTS: "invalid_arguments",
  CONFIRMATION_REQUIRED: "confirmation_required",
  INTERACTIVE_CONFIRMATION_REQUIRED: "interactive_confirmation_required",
  LOGIN_REQUIRED: "login_required",
  PROJECT_SETTINGS_REQUIRED: "project_settings_required",
  NOT_LINKED: "not_linked",
  NOT_FOUND: "not_found",
  PROJECT_NOT_FOUND: "project_not_found",
  MISSING_SCOPE: "missing_scope",
  SCOPE_NOT_ACCESSIBLE: "scope_not_accessible",
  API_ERROR: "api_error",
  // Flags
  SEGMENT_IN_USE: "segment_in_use",
  // Env
  MISSING_REQUIREMENTS: "missing_requirements",
  MISSING_NAME: "missing_name",
  MISSING_VALUE: "missing_value",
  MISSING_ENVIRONMENT: "missing_environment",
  ENV_NOT_FOUND: "env_not_found",
  MULTIPLE_ENVS: "multiple_envs",
  ENV_FILE_EXISTS: "env_file_exists",
  GIT_BRANCH_REQUIRED: "git_branch_required",
  ENV_KEY_SENSITIVE: "env_key_sensitive",
  // Routes
  AMBIGUOUS_ROUTE: "ambiguous_route",
  ROUTE_CREATE_FAILED: "route_create_failed",
  ROUTE_GENERATION_FAILED: "route_generation_failed",
  // DNS
  DOMAIN_NOT_FOUND: "domain_not_found",
  DNS_RECORD_NOT_FOUND: "dns_record_not_found",
  INCOMPLETE_RECORD: "incomplete_record",
  PERMISSION_DENIED: "permission_denied",
  INVALID_PORT: "invalid_port",
  INVALID_DNS_TYPE: "invalid_dns_type",
  DNS_ADD_FAILED: "dns_add_failed",
  INVALID_DOMAIN: "invalid_domain",
  CONFIGURED_CORRECTLY: "configured_correctly",
  VERIFICATION_NEEDED: "verification_needed",
  INVALID_CONFIGURATION: "invalid_configuration",
  DNS_CHANGE_REQUIRED: "dns_change_required",
  DNS_CHANGE_RECOMMENDED: "dns_change_recommended",
  DNSSEC_NEEDS_TO_BE_DISABLED: "dnssec_needs_to_be_disabled",
  PROJECT_ATTACHMENT_RECOMMENDED: "project_attachment_recommended",
  PROJECT_DOMAIN_MISSING: "project_domain_missing",
  /** User must accept marketplace integration terms in the browser before install can continue. */
  INTEGRATION_TERMS_ACCEPTANCE_REQUIRED: "integration_terms_acceptance_required",
  /** Integration uninstall blocked because team-scoped resources still exist. */
  HAS_RESOURCES: "has_resources",
  /** User must claim a sandbox marketplace resource (e.g. Stripe, Shopify) in the browser. */
  INTEGRATION_SANDBOX_CLAIM_REQUIRED: "integration_sandbox_claim_required",
  // Tokens
  CLASSIC_TOKEN_REQUIRED: "classic_token_required",
  /** Classic token lacks full user/account scope (e.g. team- or product-scoped token). */
  TOKEN_USER_SCOPE_REQUIRED: "token_user_scope_required",
  // Webhooks
  MISSING_URL: "missing_url",
  MISSING_EVENTS: "missing_events",
  INVALID_URL: "invalid_url",
  INVALID_EVENT: "invalid_event",
  // AI Gateway
  INVALID_BUDGET: "invalid_budget",
  INVALID_REFRESH_PERIOD: "invalid_refresh_period",
  INVALID_EXPIRATION: "invalid_expiration",
  INVALID_ALERT_THRESHOLDS: "invalid_alert_thresholds",
  /**
   * Every selected agent needs explicit `--agent`/`--all` consent (see the
   * payload's skipped[]). `--yes` does not grant it, so this is deliberately
   * not `confirmation_required` — re-running with --yes would loop forever.
   */
  REQUIRES_CONSENT: "requires_consent",
  // KMS
  MISSING_ISSUER_ID: "missing_issuer_id",
  MISSING_KEY: "missing_key",
  MISSING_KEY_ID: "missing_key_id",
  MISSING_PROJECT: "missing_project",
  ISSUER_NOT_FOUND: "issuer_not_found",
  /** The issuer is provisioned by another Vercel service and is read-only here. */
  ISSUER_MANAGED: "issuer_managed",
  /** Keys for an imported issuer must be imported too, so `add-key` cannot serve it. */
  ISSUER_REQUIRES_IMPORTED_KEY: "issuer_requires_imported_key",
  /** Vercel generates the keys for this issuer, so `import-key` cannot serve it. */
  ISSUER_REQUIRES_GENERATED_KEY: "issuer_requires_generated_key",
  /** Immediate revocation only applies to a key already scheduled for revocation. */
  KEY_NOT_REVOKING: "key_not_revoking",
  NO_CHANGES_REQUESTED: "no_changes_requested",
  // Redirects
  REDIRECT_NOT_FOUND: "redirect_not_found",
  VERSION_NOT_FOUND: "version_not_found",
  VERSION_ALREADY_LIVE: "version_already_live",
  VERSION_IS_STAGING: "version_is_staging"
};
var AGENT_ACTION = {
  MISSING_ARGUMENTS: "missing_arguments",
  CONFIRMATION_REQUIRED: "confirmation_required",
  LOGIN_REQUIRED: "login_required"
};

export {
  buildCommandWithYes,
  omitGlobalFlagsFromArgs,
  buildIntegrationCommandTailFromArgv,
  buildCommandWithGlobalFlags,
  withGlobalFlags,
  getPreservedArgsForEnvAdd,
  buildEnvAddCommandWithPreservedArgs,
  getPreservedArgsForEnvPull,
  getPreservedArgsForEnvRm,
  buildEnvRmCommandWithPreservedArgs,
  getPreservedArgsForEnvUpdate,
  buildEnvUpdateCommandWithPreservedArgs,
  outputActionRequired,
  argvHasNonInteractive,
  shouldEmitNonInteractiveCommandError,
  outputAgentError,
  outputAgentSuccess,
  exitWithNonInteractiveError,
  openUrlInBrowserCommand,
  AGENT_STATUS,
  AGENT_REASON,
  AGENT_ACTION
};
