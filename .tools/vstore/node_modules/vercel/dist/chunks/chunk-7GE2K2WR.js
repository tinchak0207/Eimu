import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  vcrCommand
} from "./chunk-2MF3ZAVW.js";
import {
  metricsCommand
} from "./chunk-EG5BSAXD.js";
import {
  routesCommand
} from "./chunk-M22O6CYY.js";
import {
  commentsCommand
} from "./chunk-GMWRTZVZ.js";
import {
  activityCommand
} from "./chunk-3KNPVXJ3.js";
import {
  alertsCommand
} from "./chunk-3L2YLLHC.js";
import {
  devCommand
} from "./chunk-7QVJTI5H.js";
import {
  listCommand
} from "./chunk-O5GNPPTU.js";
import {
  buildCommand,
  pullCommand
} from "./chunk-7PEQVFHI.js";
import {
  envCommand
} from "./chunk-KDL2L4KL.js";
import {
  confirmOption,
  deploymentOption,
  forceOption,
  formatOption,
  jsonOption,
  limitOption,
  nextOption,
  packageName,
  projectOption,
  protectionBypassOption,
  yesOption
} from "./chunk-SOFC4MLS.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";

// src/commands/deploy/command.ts
var deprecatedArchiveSplitTgz = "split-tgz";
var initSubcommand = {
  name: "init",
  aliases: [],
  description: "Create a manual deployment that can be continued later",
  hidden: true,
  arguments: [],
  options: [
    {
      ...forceOption,
      description: "Force a new deployment even if nothing has changed"
    },
    {
      name: "with-cache",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: 'Retain build cache when using "--force"'
    },
    {
      name: "env",
      shorthand: "e",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Specify environment variables during run-time (e.g. `-e KEY1=value1 -e KEY2=value2`)"
    },
    {
      name: "build-env",
      shorthand: "b",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Specify environment variables during build-time (e.g. `-b KEY1=value1 -b KEY2=value2`)"
    },
    {
      name: "meta",
      shorthand: "m",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Specify metadata for the deployment (e.g. `-m KEY1=value1 -m KEY2=value2`)"
    },
    {
      name: "regions",
      shorthand: null,
      type: String,
      argument: "REGION",
      deprecated: false,
      description: "Set default regions to enable the deployment on"
    },
    {
      name: "prod",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Create a production deployment (shorthand for `--target=production`)"
    },
    {
      name: "archive",
      shorthand: null,
      type: String,
      argument: "FORMAT",
      deprecated: false,
      description: "Compress the deployment code into an archive before uploading it"
    },
    {
      name: "skip-domain",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Disable the automatic promotion (aliasing) of the relevant domains to a new production deployment. You can use `vc promote` to complete the domain-assignment process later"
    },
    {
      ...yesOption,
      description: "Use default options to skip all prompts"
    },
    {
      name: "target",
      shorthand: null,
      type: String,
      argument: "TARGET",
      deprecated: false,
      description: "Specify the target deployment environment"
    },
    formatOption,
    jsonOption,
    confirmOption,
    projectOption
  ],
  examples: [
    {
      name: "Create a manual deployment",
      value: "vercel deploy init"
    },
    {
      name: "Create a manual production deployment",
      value: "vercel deploy init --prod"
    }
  ]
};
var continueSubcommand = {
  name: "continue",
  aliases: [],
  description: "Continue a manual deployment by uploading build outputs",
  hidden: true,
  arguments: [],
  options: [
    {
      name: "id",
      shorthand: null,
      type: String,
      argument: "ID",
      deprecated: false,
      description: "The deployment ID to continue (e.g. dpl_xxx)"
    },
    {
      name: "archive",
      shorthand: null,
      type: String,
      argument: "FORMAT",
      deprecated: false,
      description: "Compress the deployment code into an archive before uploading it"
    },
    {
      name: "error",
      shorthand: null,
      type: String,
      argument: "MESSAGE",
      deprecated: false,
      description: "Mark the deployment as errored with a message"
    }
  ],
  examples: [
    {
      name: "Continue a deployment by ID",
      value: "vercel deploy continue --id dpl_xxx"
    }
  ]
};
var deployCommand = {
  name: "deploy",
  aliases: [],
  description: "Deploy your project to Vercel. Use `--temporary` to create a temporary deployment without logging in. The `deploy` command is the default command for the Vercel CLI, and can be omitted (`vc deploy my-app` equals `vc my-app`). Use `--dry` to inspect the detected framework preset and source files without deploying.",
  arguments: [
    {
      name: "project-path",
      required: false
    }
  ],
  subcommands: [initSubcommand, continueSubcommand],
  options: [
    {
      ...forceOption,
      description: "Force a new deployment even if nothing has changed"
    },
    {
      name: "with-cache",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: 'Retain build cache when using "--force"'
    },
    {
      name: "env",
      shorthand: "e",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Specify environment variables during run-time (e.g. `-e KEY1=value1 -e KEY2=value2`)"
    },
    {
      name: "build-env",
      shorthand: "b",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Specify environment variables during build-time (e.g. `-b KEY1=value1 -b KEY2=value2`)"
    },
    {
      name: "meta",
      shorthand: "m",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Specify metadata for the deployment (e.g. `-m KEY1=value1 -m KEY2=value2`)"
    },
    {
      name: "regions",
      shorthand: null,
      type: String,
      argument: "REGION",
      deprecated: false,
      description: "Set default regions to enable the deployment on"
    },
    {
      name: "prebuilt",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Use in combination with `vc build`. Deploy an existing build"
    },
    {
      name: "prod",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Create a production deployment (shorthand for `--target=production`)"
    },
    {
      name: "temporary",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Create a temporary deployment without logging in"
    },
    {
      name: "archive",
      shorthand: null,
      type: String,
      argument: "FORMAT",
      deprecated: false,
      description: "Compress the deployment code into an archive before uploading it"
    },
    {
      name: "no-wait",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Don't wait for the deployment to finish"
    },
    {
      name: "dry",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Inspect the detected framework preset and source files without uploading or creating a deployment. Non-TTY output includes every file as JSON"
    },
    {
      name: "skip-domain",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Disable the automatic promotion (aliasing) of the relevant domains to a new production deployment. You can use `vc promote` to complete the domain-assignment process later"
    },
    {
      ...yesOption,
      description: "Use default options to skip all prompts"
    },
    {
      name: "logs",
      shorthand: "l",
      type: Boolean,
      deprecated: false,
      description: "Print the build logs"
    },
    {
      name: "guidance",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Receive command suggestions once deployment is complete"
    },
    {
      name: "no-logs",
      shorthand: null,
      type: Boolean,
      deprecated: true,
      description: "Do not print the build logs"
    },
    {
      name: "name",
      shorthand: "n",
      type: String,
      deprecated: true
    },
    {
      name: "no-clipboard",
      shorthand: null,
      type: Boolean,
      deprecated: true
    },
    {
      name: "target",
      shorthand: null,
      type: String,
      argument: "TARGET",
      deprecated: false,
      description: "Specify the target deployment environment"
    },
    formatOption,
    jsonOption,
    confirmOption,
    projectOption
  ],
  examples: [
    {
      name: "Deploy the current directory",
      value: "vercel"
    },
    {
      name: "Deploy a custom path",
      value: "vercel /usr/src/project"
    },
    {
      name: "Deploy with run-time Environment Variables",
      value: "vercel -e NODE_ENV=production"
    },
    {
      name: "Deploy with prebuilt outputs",
      value: ["vercel build", "vercel deploy --prebuilt"]
    },
    {
      name: "Inspect deployment inputs without deploying",
      value: "vercel deploy --dry"
    },
    {
      name: "Get every deployment file as JSON",
      value: "vercel deploy --dry --json"
    },
    {
      name: "Write Deployment URL to a file",
      value: "vercel > deployment-url.txt"
    }
  ]
};

// src/commands/link/command.ts
var addSubcommand = {
  name: "add",
  aliases: [],
  description: "Add projects to an existing repository link created by link --repo",
  arguments: [],
  options: [
    {
      ...yesOption,
      description: "Skip questions when adding projects with default team and settings"
    }
  ],
  examples: [
    {
      name: "Add projects to an existing repository link",
      value: `${packageName} link add`
    }
  ]
};
var linkCommand = {
  name: "link",
  aliases: [],
  description: "Link a local directory to a Vercel project",
  arguments: [],
  subcommands: [addSubcommand],
  options: [
    {
      name: "repo",
      description: "Link multiple projects from the Git repository (alpha)",
      shorthand: "r",
      type: Boolean,
      deprecated: false
    },
    {
      ...projectOption,
      shorthand: "p",
      description: "Set the project name or ID to link; required for non-interactive existing-project links"
    },
    {
      name: "team",
      description: "Set the team ID or slug; use with --project for non-interactive links",
      shorthand: null,
      argument: "TEAM_ID_OR_SLUG",
      type: String,
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip questions when setting up with default team and settings"
    },
    confirmOption
  ],
  examples: [
    {
      name: "Link current directory to a Vercel project",
      value: `${packageName} link`
    },
    {
      name: "Link current directory with default options and skip questions",
      value: `${packageName} link --yes`
    },
    {
      name: "Link to an existing project in CI or agent mode",
      value: `${packageName} link --yes --team <team-id> --project <project-name-or-id>`
    },
    {
      name: "Link a specific directory to a Vercel project",
      value: `${packageName} link --cwd /path/to/project`
    },
    {
      name: "Link multiple projects from the current Git repository",
      value: `${packageName} link --repo`
    },
    {
      name: "Add additional projects to an existing repository link",
      value: `${packageName} link add`
    }
  ]
};

// src/commands/agent/command.ts
var agentCommand = {
  name: "agent",
  aliases: [],
  description: "Generate an AGENTS.md file with Vercel deployment best practices",
  arguments: [
    {
      name: "init",
      required: false
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip confirmation prompt"
    }
  ],
  examples: [
    {
      name: "Generate AGENTS.md with Vercel best practices",
      value: `${packageName} agent init`
    },
    {
      name: "Skip confirmation prompt (useful for CI)",
      value: `${packageName} agent init --yes`
    }
  ]
};

// src/commands/agent-runs/command.ts
var projectOption2 = {
  name: "project",
  shorthand: null,
  type: String,
  argument: "NAME|ID",
  deprecated: false,
  description: "Project name or id to query (overrides the linked project)"
};
var environmentOption = {
  name: "environment",
  shorthand: null,
  type: String,
  argument: "production|preview",
  deprecated: false,
  description: "Environment to query Agent Runs from (default: production)"
};
var sinceOption = {
  name: "since",
  shorthand: null,
  type: String,
  argument: "TIME",
  deprecated: false,
  description: "Only include Agent Runs after this time (ISO 8601 or relative: 1h, 30m, 7d)"
};
var untilOption = {
  name: "until",
  shorthand: null,
  type: String,
  argument: "TIME",
  deprecated: false,
  description: "Only include Agent Runs before this time (requires --since; default: now)"
};
var jsonOption2 = {
  name: "json",
  shorthand: null,
  type: Boolean,
  deprecated: false,
  description: "Print the raw API response as JSON to stdout"
};
var listSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List Agent Runs for a project",
  arguments: [],
  options: [
    projectOption2,
    environmentOption,
    sinceOption,
    untilOption,
    {
      name: "search",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Search Agent Runs by title"
    },
    {
      name: "next",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      deprecated: false,
      description: "Continue from a previous response"
    },
    {
      name: "page",
      shorthand: null,
      type: Number,
      argument: "N",
      deprecated: true,
      description: "1-based page number (default: 1)"
    },
    {
      name: "limit",
      shorthand: "n",
      type: Number,
      argument: "N",
      deprecated: false,
      description: "Number of Agent Runs per page (max: 100)"
    },
    jsonOption2
  ],
  examples: [
    {
      name: "List recent production Agent Runs for the linked project",
      value: `${packageName} agent-runs list`
    },
    {
      name: "List preview Agent Runs from the last day",
      value: `${packageName} agent-runs list --environment preview --since 1d`
    },
    {
      name: "Search Agent Runs by title",
      value: `${packageName} agent-runs list --search "checkout"`
    },
    {
      name: "List Agent Runs for a specific team and project",
      value: `${packageName} agent-runs list --scope my-team --project my-app`
    },
    {
      name: "Print the raw list as JSON",
      value: `${packageName} agent-runs list --json`
    }
  ]
};
var inspectSubcommand = {
  name: "inspect",
  aliases: [],
  description: "Show metadata, lifecycle events, usage, and subagent data for an Agent Run",
  arguments: [
    {
      name: "runId",
      required: true
    }
  ],
  options: [
    projectOption2,
    environmentOption,
    sinceOption,
    untilOption,
    jsonOption2
  ],
  examples: [
    {
      name: "Inspect an Agent Run",
      value: `${packageName} agent-runs inspect run_1234567890`
    },
    {
      name: "Print the raw Agent Run as JSON",
      value: `${packageName} agent-runs inspect run_1234567890 --json`
    }
  ]
};
var traceSubcommand = {
  name: "trace",
  aliases: [],
  description: "Show the trace for an Agent Run (turns, messages, reasoning, and tool calls)",
  arguments: [
    {
      name: "runId",
      required: true
    }
  ],
  options: [
    projectOption2,
    environmentOption,
    sinceOption,
    untilOption,
    {
      name: "max-field-length",
      shorthand: null,
      type: Number,
      argument: "N",
      deprecated: false,
      description: "Maximum length for individual string fields in the trace (default: 8000; 0 disables truncation)"
    },
    jsonOption2
  ],
  examples: [
    {
      name: "Show the trace for an Agent Run",
      value: `${packageName} agent-runs trace run_1234567890`
    },
    {
      name: "Print the raw trace as JSON without truncation",
      value: `${packageName} agent-runs trace run_1234567890 --json --max-field-length 0`
    }
  ]
};
var projectsSubcommand = {
  name: "projects",
  aliases: [],
  description: "List projects in the current team with Agent Runs activity",
  arguments: [],
  options: [environmentOption, sinceOption, untilOption, jsonOption2],
  examples: [
    {
      name: "List projects with Agent Runs activity",
      value: `${packageName} agent-runs projects`
    },
    {
      name: "List projects with Agent Runs activity in another team",
      value: `${packageName} agent-runs projects --scope my-team`
    }
  ]
};
var agentRunsCommand = {
  name: "agent-runs",
  aliases: [],
  description: "Inspect Agent Runs observability data",
  arguments: [],
  subcommands: [
    listSubcommand,
    inspectSubcommand,
    traceSubcommand,
    projectsSubcommand
  ],
  options: [],
  examples: [
    {
      name: "List recent production Agent Runs for the linked project",
      value: `${packageName} agent-runs list`
    },
    {
      name: "List projects with Agent Runs activity",
      value: `${packageName} agent-runs projects`
    },
    {
      name: "Inspect an Agent Run",
      value: `${packageName} agent-runs inspect run_1234567890`
    },
    {
      name: "Show the trace for an Agent Run",
      value: `${packageName} agent-runs trace run_1234567890`
    }
  ]
};

// src/commands/ai-gateway/command.ts
var createSubcommand = {
  name: "create",
  aliases: [],
  description: "Create a new AI Gateway API key",
  arguments: [],
  options: [
    {
      name: "name",
      shorthand: null,
      type: String,
      argument: "NAME",
      deprecated: false,
      description: "Human-readable name for the API key"
    },
    {
      name: "budget",
      shorthand: null,
      type: Number,
      argument: "AMOUNT",
      deprecated: false,
      description: "Quota budget amount in dollars (minimum 1)"
    },
    {
      name: "refresh-period",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      deprecated: false,
      description: "Quota refresh cadence: daily, weekly, monthly, or none (default: none)"
    },
    {
      name: "include-byok",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Include BYOK usage in quota (default: false)"
    },
    {
      name: "alert-thresholds",
      shorthand: null,
      type: String,
      argument: "LIST",
      deprecated: false,
      description: "Comma-separated spend percentages to alert at, a subset of 50,75,100 (e.g. 75,100)"
    },
    {
      name: "expiration",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      deprecated: false,
      description: "Expiry for the key: 7d, 30d, 60d, 90d, 1y, or none (default: none)"
    },
    {
      name: "zdr-exempt",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Exempt the key from the team's ZDR-only model restriction (team owners only)"
    },
    {
      name: "bypass-all-settings",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Exempt the key from all of the team's restrictions: ZDR-only models, the provider/model allowlist, and the HIPAA and prompt-training filters (team owners only)"
    }
  ],
  examples: [
    {
      name: "Create an API key with defaults",
      value: `${packageName} ai-gateway api-keys create`
    },
    {
      name: "Create an API key with a budget",
      value: `${packageName} ai-gateway api-keys create --name my-key --budget 500 --refresh-period monthly`
    },
    {
      name: "Create a key that expires and alerts on spend",
      value: `${packageName} ai-gateway api-keys create --budget 500 --alert-thresholds 75,100 --expiration 90d`
    },
    {
      name: "Create a ZDR-exempt key (team owners only)",
      value: `${packageName} ai-gateway api-keys create --name escape-hatch --zdr-exempt --expiration 7d`
    },
    {
      name: "Create a key that bypasses all team restrictions (team owners only)",
      value: `${packageName} ai-gateway api-keys create --name escape-hatch --bypass-all-settings --expiration 7d`
    }
  ]
};
var listSubcommand2 = {
  name: "list",
  aliases: ["ls"],
  description: "List AI Gateway API keys",
  arguments: [],
  options: [formatOption],
  examples: [
    {
      name: "List API keys",
      value: `${packageName} ai-gateway api-keys ls`
    }
  ]
};
var inspectSubcommand2 = {
  name: "inspect",
  aliases: [],
  description: "Show details about an AI Gateway API key",
  arguments: [{ name: "id", required: true }],
  options: [formatOption],
  examples: [
    {
      name: "Inspect an API key",
      value: `${packageName} ai-gateway api-keys inspect key_123`
    }
  ]
};
var removeSubcommand = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove an AI Gateway API key",
  arguments: [{ name: "id", required: true }],
  options: [yesOption, formatOption],
  examples: [
    {
      name: "Remove an API key",
      value: `${packageName} ai-gateway api-keys rm key_123`
    }
  ]
};
var apiKeysSubcommand = {
  name: "api-keys",
  aliases: [],
  description: "Manage AI Gateway API keys",
  arguments: [],
  subcommands: [
    createSubcommand,
    listSubcommand2,
    inspectSubcommand2,
    removeSubcommand
  ],
  options: [],
  examples: []
};
var rulesAddSubcommand = {
  name: "add",
  aliases: [],
  description: "Add an AI Gateway routing rule",
  arguments: [],
  options: [
    {
      name: "type",
      shorthand: null,
      type: String,
      argument: "TYPE",
      deprecated: false,
      description: "Rule type: rewrite or deny"
    },
    {
      name: "source",
      shorthand: null,
      type: String,
      argument: "MODEL",
      deprecated: false,
      description: "Model the rule matches (e.g. anthropic/claude-sonnet-4.5)"
    },
    {
      name: "destination",
      shorthand: null,
      type: String,
      argument: "MODEL",
      deprecated: false,
      description: "Target model a rewrite rule routes to"
    },
    {
      name: "reason",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Reason surfaced when the rule applies"
    },
    {
      name: "description",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Human-readable description of the rule"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Rewrite one model to another",
      value: `${packageName} ai-gateway rules add --type rewrite --source anthropic/claude-fable-5 --destination anthropic/claude-opus-4.8`
    },
    {
      name: "Deny a model",
      value: `${packageName} ai-gateway rules add --type deny --source openai/gpt-4o`
    }
  ]
};
var rulesListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List AI Gateway routing rules",
  arguments: [],
  options: [
    {
      name: "include-disabled",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Include disabled rules"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List routing rules",
      value: `${packageName} ai-gateway rules ls`
    }
  ]
};
var rulesEditSubcommand = {
  name: "edit",
  aliases: [],
  description: "Edit an AI Gateway routing rule",
  arguments: [{ name: "ruleId", required: true }],
  options: [
    {
      name: "enable",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Enable the rule"
    },
    {
      name: "disable",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Disable the rule"
    },
    {
      name: "destination",
      shorthand: null,
      type: String,
      argument: "MODEL",
      deprecated: false,
      description: "Target model a rewrite rule routes to"
    },
    {
      name: "reason",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Reason surfaced when the rule applies"
    },
    {
      name: "description",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Human-readable description of the rule"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Disable a rule",
      value: `${packageName} ai-gateway rules edit rule_123 --disable`
    }
  ]
};
var rulesRemoveSubcommand = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove an AI Gateway routing rule",
  arguments: [{ name: "ruleId", required: true }],
  options: [yesOption, formatOption, jsonOption],
  examples: [
    {
      name: "Remove a rule",
      value: `${packageName} ai-gateway rules rm rule_123`
    }
  ]
};
var rulesSubcommand = {
  name: "rules",
  aliases: [],
  description: "Manage AI Gateway routing rules (Beta).\n\nAI Gateway routing rules are in beta and may change before general availability. Avoid relying on them in production.",
  arguments: [],
  subcommands: [
    rulesAddSubcommand,
    rulesListSubcommand,
    rulesEditSubcommand,
    rulesRemoveSubcommand
  ],
  options: [],
  examples: []
};
var setupSubcommand = {
  name: "setup",
  aliases: [],
  description: "Connect local coding agents (Claude Code, Codex, OpenCode, Pi) to the AI Gateway",
  arguments: [],
  options: [
    {
      name: "agent",
      shorthand: null,
      type: [String],
      argument: "NAME",
      deprecated: false,
      description: "Coding agent to configure, repeatable (claude-code, codex, opencode, pi)"
    },
    {
      name: "all",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Configure every supported coding agent"
    },
    {
      name: "key",
      shorthand: null,
      type: String,
      argument: "KEY",
      deprecated: false,
      description: "Use an existing AI Gateway API key instead of creating one"
    },
    {
      name: "budget",
      shorthand: null,
      type: Number,
      argument: "AMOUNT",
      deprecated: false,
      description: "Quota budget in dollars for a newly created key (minimum 1)"
    },
    {
      name: "refresh-period",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      deprecated: false,
      description: "Quota refresh cadence for a new key: daily, weekly, monthly, or none"
    },
    {
      name: "include-byok",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Include BYOK usage in the new key quota"
    },
    {
      name: "expiration",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      deprecated: false,
      description: "Expiry for a new key: 7d, 30d, 60d, 90d, 1y, or none (default: none)"
    },
    {
      name: "name",
      shorthand: null,
      type: String,
      argument: "NAME",
      deprecated: false,
      description: "Name for a newly created API key"
    },
    {
      name: "reconfigure",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Re-run even if already configured, to rotate the key or switch team"
    },
    {
      name: "dry-run",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Show what would change without writing any files"
    },
    {
      name: "no-backup",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Do not write .bak backups of changed files"
    },
    {
      name: "no-session-migration",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Do not copy existing Codex Desktop sessions for use with the Vercel AI Gateway provider."
    },
    {
      name: "no-keychain",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Always write the key into config files instead of the macOS Keychain"
    },
    {
      name: "agent-config",
      shorthand: null,
      type: [String],
      argument: "AGENT=PATH",
      deprecated: false,
      description: "Override an agent's config file path, e.g. claude-code=/path/settings.json (repeatable)"
    },
    {
      name: "shell-rc",
      shorthand: null,
      type: String,
      argument: "PATH",
      deprecated: false,
      description: "Shell rc file to write the env exports into"
    },
    {
      name: "apply",
      shorthand: null,
      type: String,
      argument: "MODE",
      deprecated: false,
      description: "How to apply non-interactively: edit (write files, default) or prompt (emit an agent prompt on stdout; requires the macOS Keychain)"
    },
    {
      name: "base-url",
      shorthand: null,
      type: String,
      argument: "URL",
      deprecated: false,
      description: "Override the AI Gateway base URL written into agent configs (advanced; e.g. a preview deployment). Written verbatim."
    },
    yesOption
  ],
  examples: [
    {
      name: "Connect all detected coding agents (creates a key)",
      value: `${packageName} ai-gateway coding-agents setup`
    },
    {
      name: "Emit a prompt to hand to a coding agent instead of writing files",
      value: `${packageName} ai-gateway coding-agents setup --apply prompt --yes`
    },
    {
      name: "Connect specific agents with a budgeted key",
      value: `${packageName} ai-gateway coding-agents setup --agent claude-code --budget 500 --refresh-period monthly`
    },
    {
      name: "Rotate the key on an already-configured setup",
      value: `${packageName} ai-gateway coding-agents setup --reconfigure`
    },
    {
      name: "Reuse an existing key and preview changes only",
      value: `${packageName} ai-gateway coding-agents setup --key <key> --dry-run`
    },
    {
      name: "Point an agent at a different gateway base URL",
      value: `${packageName} ai-gateway coding-agents setup --agent codex --base-url https://preview.ai-gateway.vercel.sh/v1`
    }
  ]
};
var codingAgentsSubcommand = {
  name: "coding-agents",
  aliases: [],
  description: "Connect local coding agents to the AI Gateway",
  arguments: [],
  subcommands: [setupSubcommand],
  options: [],
  examples: []
};
var modelsListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List AI Gateway models",
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List available models",
      value: `${packageName} ai-gateway models ls`
    }
  ]
};
var modelsEndpointsSubcommand = {
  name: "endpoints",
  aliases: [],
  description: "List provider endpoints for an AI Gateway model",
  arguments: [{ name: "model", required: true }],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List provider endpoints for a model",
      value: `${packageName} ai-gateway models endpoints anthropic/claude-opus-4.8`
    }
  ]
};
var modelsSubcommand = {
  name: "models",
  aliases: [],
  description: "Manage AI Gateway models",
  arguments: [],
  subcommands: [modelsListSubcommand, modelsEndpointsSubcommand],
  options: [],
  examples: []
};
var budgetsSetSubcommand = {
  name: "set",
  aliases: [],
  description: "Create or update an AI Gateway budget for a scope (team or project <name>)",
  arguments: [
    { name: "scope", required: true },
    { name: "name", required: false }
  ],
  options: [
    {
      name: "limit",
      shorthand: null,
      type: Number,
      argument: "AMOUNT",
      deprecated: false,
      description: "Budget limit in dollars (minimum 1)"
    },
    {
      name: "refresh-period",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      deprecated: false,
      description: "Budget refresh cadence: daily, weekly, monthly, or none (default: monthly)"
    },
    {
      name: "include-byok",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Include BYOK usage in the budget (default: false)"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Set a team budget",
      value: `${packageName} ai-gateway budgets set team --limit 500 --refresh-period monthly`
    },
    {
      name: "Set a project budget",
      value: `${packageName} ai-gateway budgets set project my-project --limit 200`
    }
  ]
};
var budgetsListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List AI Gateway budgets",
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List budgets",
      value: `${packageName} ai-gateway budgets ls`
    }
  ]
};
var budgetsRemoveSubcommand = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove an AI Gateway budget for a scope (team or project <name>)",
  arguments: [
    { name: "scope", required: true },
    { name: "name", required: false }
  ],
  options: [yesOption, formatOption, jsonOption],
  examples: [
    {
      name: "Remove the team budget",
      value: `${packageName} ai-gateway budgets rm team`
    },
    {
      name: "Remove a project budget",
      value: `${packageName} ai-gateway budgets rm project my-project`
    }
  ]
};
var leaderboardFormatOption = {
  name: "format",
  shorthand: "F",
  type: String,
  argument: "FORMAT",
  deprecated: false,
  description: "Output format: table, json, or csv (default: table in a terminal, json otherwise)"
};
var leaderboardOutOption = {
  name: "out",
  shorthand: "o",
  type: String,
  argument: "FILE",
  deprecated: false,
  description: "Write the payload to a file instead of stdout (defaults to json; use --format csv for CSV)"
};
var leaderboardModalityOption = {
  name: "modality",
  shorthand: null,
  type: String,
  argument: "MODALITY",
  deprecated: false,
  description: "Filter by modality: all, text, image, or video (default: all)"
};
var leaderboardMetricOption = {
  name: "metric",
  shorthand: null,
  type: String,
  argument: "METRIC",
  deprecated: false,
  description: "Metric for the table view: requests, tokens, spend, imageCount, or videoCount (default: requests)"
};
var leaderboardDateOption = {
  name: "date",
  shorthand: null,
  type: String,
  argument: "YYYY-MM-DD",
  deprecated: false,
  description: "Day to show in the table view (default: most recent)"
};
var leaderboardModelsSubcommand = {
  name: "models",
  aliases: [],
  description: "Show the most-used models on AI Gateway",
  arguments: [],
  options: [
    leaderboardModalityOption,
    leaderboardMetricOption,
    leaderboardDateOption,
    leaderboardFormatOption,
    leaderboardOutOption
  ],
  examples: [
    {
      name: "Show the top text models",
      value: `${packageName} ai-gateway leaderboard models --modality text`
    },
    {
      name: "Export the full model data as CSV",
      value: `${packageName} ai-gateway leaderboard models --format csv --out models.csv`
    }
  ]
};
var budgetsDefaultsListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List the team's AI Gateway budget defaults",
  arguments: [],
  options: [formatOption],
  examples: [
    {
      name: "List budget defaults",
      value: `${packageName} ai-gateway budgets defaults ls`
    }
  ]
};
var budgetsDefaultsSetSubcommand = {
  name: "set",
  aliases: [],
  description: "Create or update the AI Gateway budget default for a scope (project or api-key), applied to resources of that scope without an explicit budget",
  arguments: [{ name: "scope", required: true }],
  options: [
    {
      name: "limit",
      shorthand: null,
      type: Number,
      argument: "AMOUNT",
      deprecated: false,
      description: "Default budget limit in dollars (minimum 1)"
    },
    {
      name: "refresh-period",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      deprecated: false,
      description: "Budget refresh cadence: daily, weekly, monthly, or none (default: monthly)"
    },
    formatOption
  ],
  examples: [
    {
      name: "Set the per-project default",
      value: `${packageName} ai-gateway budgets defaults set project --limit 200 --refresh-period monthly`
    },
    {
      name: "Set the per-api-key default",
      value: `${packageName} ai-gateway budgets defaults set api-key --limit 50`
    }
  ]
};
var budgetsDefaultsRemoveSubcommand = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove the AI Gateway budget default for a scope (project or api-key)",
  arguments: [{ name: "scope", required: true }],
  options: [yesOption, formatOption],
  examples: [
    {
      name: "Remove the per-project default",
      value: `${packageName} ai-gateway budgets defaults rm project`
    }
  ]
};
var budgetsDefaultsSubcommand = {
  name: "defaults",
  aliases: [],
  description: "Manage AI Gateway budget defaults (per-project and per-api-key spend limits applied by default)",
  arguments: [],
  subcommands: [
    budgetsDefaultsListSubcommand,
    budgetsDefaultsSetSubcommand,
    budgetsDefaultsRemoveSubcommand
  ],
  options: [],
  examples: []
};
var budgetsSubcommand = {
  name: "budgets",
  aliases: [],
  description: "Manage AI Gateway budgets (metered spend limits per scope)",
  arguments: [],
  subcommands: [
    budgetsSetSubcommand,
    budgetsListSubcommand,
    budgetsRemoveSubcommand,
    budgetsDefaultsSubcommand
  ],
  options: [],
  examples: []
};
var leaderboardLabsSubcommand = {
  name: "labs",
  aliases: [],
  description: "Show the most-used model creators (labs) on AI Gateway",
  arguments: [],
  options: [
    leaderboardModalityOption,
    leaderboardMetricOption,
    leaderboardDateOption,
    leaderboardFormatOption,
    leaderboardOutOption
  ],
  examples: [
    {
      name: "Show the top labs by spend",
      value: `${packageName} ai-gateway leaderboard labs --metric spend`
    }
  ]
};
var leaderboardAppsSubcommand = {
  name: "apps",
  aliases: [],
  description: "Show the top apps built on AI Gateway",
  arguments: [],
  options: [leaderboardFormatOption, leaderboardOutOption],
  examples: [
    {
      name: "Show the top apps",
      value: `${packageName} ai-gateway leaderboard apps`
    }
  ]
};
var leaderboardProvidersSubcommand = {
  name: "providers",
  aliases: [],
  description: "Show the top inference providers on AI Gateway",
  arguments: [],
  options: [leaderboardFormatOption, leaderboardOutOption],
  examples: [
    {
      name: "Show the top providers as JSON",
      value: `${packageName} ai-gateway leaderboard providers --format json`
    }
  ]
};
var leaderboardSubcommand = {
  name: "leaderboard",
  aliases: ["leaderboards"],
  description: "Explore AI Gateway usage leaderboards (open, anonymized data under CC BY 4.0)",
  arguments: [],
  subcommands: [
    leaderboardModelsSubcommand,
    leaderboardLabsSubcommand,
    leaderboardAppsSubcommand,
    leaderboardProvidersSubcommand
  ],
  options: [],
  examples: []
};
var aiGatewayCommand = {
  name: "ai-gateway",
  aliases: [],
  description: "Manage AI Gateway resources",
  arguments: [],
  subcommands: [
    apiKeysSubcommand,
    budgetsSubcommand,
    rulesSubcommand,
    codingAgentsSubcommand,
    modelsSubcommand,
    leaderboardSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/alias/command.ts
var setSubcommand = {
  name: "set",
  aliases: [],
  description: "Create a new alias",
  default: true,
  arguments: [
    {
      name: "id-or-url",
      required: true
    },
    {
      name: "alias",
      required: true
    }
  ],
  options: [],
  examples: []
};
var listSubcommand3 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all aliases",
  arguments: [],
  options: [limitOption, nextOption, formatOption, jsonOption],
  examples: []
};
var removeSubcommand2 = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove an alias using its hostname",
  arguments: [
    {
      name: "alias",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing an alias"
    }
  ],
  examples: []
};
var aliasCommand = {
  name: "alias",
  aliases: ["aliases", "ln"],
  description: "Interact with deployment aliases",
  arguments: [],
  subcommands: [listSubcommand3, removeSubcommand2, setSubcommand],
  options: [],
  examples: [
    {
      name: "Add a new alias to `my-api.vercel.app`",
      value: `${packageName} alias set api-ownv3nc9f8.vercel.app my-api.vercel.app`
    },
    {
      name: "Custom domains work as alias targets",
      value: `${packageName} alias set api-ownv3nc9f8.vercel.app my-api.com`
    },
    {
      name: "The subcommand `set` is the default and can be skipped. Protocols in the URLs are unneeded and ignored",
      value: `${packageName} alias api-ownv3nc9f8.vercel.app my-api.com`
    }
  ]
};

// src/commands/api/command.ts
var specUrlOption = {
  name: "spec-url",
  shorthand: null,
  type: String,
  argument: "URL",
  deprecated: false,
  description: "Fetch endpoints from a custom OpenAPI spec URL instead of the public Vercel spec"
};
var listSubcommand4 = {
  name: "list",
  aliases: ["ls"],
  description: "List all available API endpoints",
  arguments: [],
  options: [
    formatOption,
    jsonOption,
    specUrlOption,
    {
      name: "refresh",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Force refresh the cached OpenAPI spec"
    }
  ],
  examples: [
    {
      name: "List all endpoints in table format",
      value: `${packageName} api ls`
    },
    {
      name: "List all endpoints as JSON",
      value: `${packageName} api ls --json`
    },
    {
      name: "List endpoints from a custom OpenAPI spec",
      value: `${packageName} api ls --spec-url https://openapi-internal.vercel.sh --refresh`
    }
  ]
};
var apiCommand = {
  name: "api",
  aliases: [],
  description: "Make authenticated HTTP requests to the Vercel API",
  arguments: [
    {
      name: "endpoint",
      required: false
    }
  ],
  subcommands: [listSubcommand4],
  options: [
    {
      name: "method",
      shorthand: "X",
      type: String,
      argument: "METHOD",
      deprecated: false,
      description: "HTTP method (GET, POST, PUT, PATCH, DELETE). Defaults to GET, or POST if body is provided"
    },
    {
      name: "field",
      shorthand: "F",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Add a typed parameter (numbers, booleans parsed). Use @file for file contents"
    },
    {
      name: "raw-field",
      shorthand: "f",
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Add a string option (no type parsing)"
    },
    {
      name: "header",
      shorthand: "H",
      type: [String],
      argument: "KEY:VALUE",
      deprecated: false,
      description: "Add a custom HTTP header"
    },
    {
      name: "input",
      shorthand: null,
      type: String,
      argument: "FILE",
      deprecated: false,
      description: "Read request body from file (use - for stdin)"
    },
    {
      name: "paginate",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Fetch all pages of results"
    },
    {
      name: "include",
      shorthand: "i",
      type: Boolean,
      deprecated: false,
      description: "Include response headers in output"
    },
    {
      name: "silent",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Suppress response output"
    },
    {
      name: "verbose",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Show debug information including full request/response"
    },
    {
      name: "raw",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output raw JSON without pretty-printing"
    },
    {
      name: "refresh",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Force refresh the cached OpenAPI spec"
    },
    specUrlOption,
    {
      name: "generate",
      shorthand: null,
      type: String,
      argument: "FORMAT",
      deprecated: false,
      description: "Generate output instead of executing (e.g., --generate=curl)"
    },
    {
      name: "dangerously-skip-permissions",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Skip confirmation prompts for DELETE operations (use with caution)"
    }
  ],
  examples: [
    {
      name: "Get current user information",
      value: `${packageName} api /v2/user`
    },
    {
      name: "List projects with team scope",
      value: `${packageName} api /v9/projects --scope my-team`
    },
    {
      name: "Create a new project",
      value: `${packageName} api /v10/projects -X POST -F name=my-project`
    },
    {
      name: "Delete a deployment",
      value: `${packageName} api /v13/deployments/dpl_abc123 -X DELETE`
    },
    {
      name: "Paginate through all deployments",
      value: `${packageName} api /v6/deployments --paginate`
    },
    {
      name: "Post JSON from file",
      value: `${packageName} api /v10/projects -X POST --input config.json`
    },
    {
      name: "Add custom header",
      value: `${packageName} api /v2/user -H "X-Custom-Header: value"`
    },
    {
      name: "Interactive mode (select endpoint)",
      value: `${packageName} api`
    },
    {
      name: "Interactive mode with a custom OpenAPI spec",
      value: `${packageName} api --spec-url https://openapi-internal.vercel.sh --refresh`
    }
  ]
};

// src/commands/bisect/command.ts
var bisectCommand = {
  name: "bisect",
  aliases: [],
  description: "Bisect the current project interactively or via an automated test script.",
  arguments: [],
  options: [
    {
      name: "bad",
      description: "Known bad URL",
      argument: "URL",
      shorthand: "b",
      type: String,
      deprecated: false
    },
    {
      name: "good",
      description: "Known good URL",
      argument: "URL",
      shorthand: "g",
      type: String,
      deprecated: false
    },
    {
      name: "open",
      description: "Automatically open each URL in the browser",
      argument: "URL",
      shorthand: "o",
      type: Boolean,
      deprecated: false
    },
    {
      name: "path",
      description: "Subpath of the deployment URL to test",
      argument: "PATH",
      shorthand: "p",
      type: String,
      deprecated: false
    },
    {
      name: "run",
      description: "Test script to run for each deployment",
      argument: "SCRIPT",
      shorthand: "r",
      type: String,
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Bisect the current project interactively",
      value: `${packageName} bisect`
    },
    {
      name: "Bisect with a known bad deployment",
      value: `${packageName} bisect --bad example-310pce9i0.vercel.app`
    },
    {
      name: "Automated bisect with a run script",
      value: `${packageName} bisect --run ./test.sh`
    }
  ]
};

// src/util/buy/custom-environment-addon.ts
var CUSTOM_ENVIRONMENTS_PER_PACK = 5;
var CUSTOM_ENVIRONMENT_EXAMPLE_PACK_COUNT = 2;
var CUSTOM_ENVIRONMENT_ADDON_ALIASES = /* @__PURE__ */ new Set([
  "customenvironment",
  "custom-environment",
  "custom-environments",
  "custom_environment",
  "custom_environments"
]);
function isCustomEnvironmentAddonAlias(name) {
  return CUSTOM_ENVIRONMENT_ADDON_ALIASES.has(name.toLowerCase());
}
function customEnvironmentPackEnvironments(packs) {
  return packs * CUSTOM_ENVIRONMENTS_PER_PACK;
}

// src/commands/buy/command.ts
var EXAMPLE_CUSTOM_ENVIRONMENT_COUNT = customEnvironmentPackEnvironments(
  CUSTOM_ENVIRONMENT_EXAMPLE_PACK_COUNT
);
var SUPPORTED_CREDIT_TYPES = ["v0", "gateway", "agent"];
var CREDIT_TYPE_LABELS = {
  v0: "v0",
  gateway: "AI Gateway",
  agent: "Vercel Agent"
};
var creditsSubcommand = {
  name: "credits",
  aliases: [],
  description: "Purchase Vercel credits for your team",
  arguments: [
    {
      name: "credit-type",
      required: true
    },
    {
      name: "amount",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Purchase $100 of v0 credits",
      value: `${packageName} buy credits v0 100`
    },
    {
      name: "Purchase $250 of AI Gateway credits",
      value: `${packageName} buy credits gateway 250`
    },
    {
      name: "Purchase $50 of Vercel Agent credits",
      value: `${packageName} buy credits agent 50`
    }
  ]
};
var SUPPORTED_ADDON_NAMES = [
  "custom-environment",
  "observability-plus"
];
var addonSubcommand = {
  name: "addon",
  aliases: ["addons", "add-on"],
  description: `Purchase a Vercel addon for your team. Supported addons: ${SUPPORTED_ADDON_NAMES.join(", ")}. Observability Plus does not accept a quantity. Custom environment purchases are per project and use packs (each pack adds ${CUSTOM_ENVIRONMENTS_PER_PACK} environments).`,
  arguments: [
    {
      name: "addon-name",
      required: true
    },
    {
      name: "quantity",
      required: false
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt"
    },
    jsonOption,
    projectOption
  ],
  examples: [
    {
      name: "Purchase Observability Plus",
      value: `${packageName} buy addon observability-plus`
    },
    {
      name: `Purchase ${CUSTOM_ENVIRONMENT_EXAMPLE_PACK_COUNT} custom environment packs (${EXAMPLE_CUSTOM_ENVIRONMENT_COUNT} environments) for a project`,
      value: `${packageName} buy addon custom-environment ${CUSTOM_ENVIRONMENT_EXAMPLE_PACK_COUNT} --project my-app`
    },
    {
      name: "Remove purchased custom environment capacity",
      value: `${packageName} buy addon custom-environment 0 --project my-app --yes`
    }
  ]
};
var proSubcommand = {
  name: "pro",
  aliases: [],
  description: "Purchase a Vercel Pro subscription for your team",
  arguments: [],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Upgrade your team to Vercel Pro",
      value: `${packageName} buy pro`
    },
    {
      name: "Upgrade without confirmation prompt",
      value: `${packageName} buy pro --yes`
    }
  ]
};
var domainSubcommand = {
  name: "domain",
  aliases: [],
  description: "Purchase a domain name",
  arguments: [
    {
      name: "domain",
      required: true
    }
  ],
  options: [],
  examples: [
    {
      name: "Purchase a domain",
      value: `${packageName} buy domain example.com`
    }
  ]
};
var buyCommand = {
  name: "buy",
  aliases: [],
  description: "Purchase Vercel products for your team",
  arguments: [],
  subcommands: [
    creditsSubcommand,
    addonSubcommand,
    proSubcommand,
    domainSubcommand
  ],
  options: [],
  examples: [
    {
      name: "Purchase $100 of v0 credits",
      value: `${packageName} buy credits v0 100`
    },
    {
      name: "Purchase Observability Plus",
      value: `${packageName} buy addon observability-plus`
    },
    {
      name: "Upgrade to Pro",
      value: `${packageName} buy pro`
    },
    {
      name: "Purchase a domain",
      value: `${packageName} buy domain example.com`
    }
  ]
};

// src/commands/cache/command.ts
var purgeSubcommand = {
  name: "purge",
  aliases: [],
  description: "Purge cache for the current project",
  arguments: [],
  options: [
    yesOption,
    projectOption,
    {
      name: "type",
      description: "Type of cache to purge",
      shorthand: null,
      type: String,
      argument: "TYPE",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Purge all caches for the current project",
      value: `${packageName} cache purge`
    },
    {
      name: "Purge only the CDN cache",
      value: `${packageName} cache purge --type cdn`
    },
    {
      name: "Purge only the data cache",
      value: `${packageName} cache purge --type data`
    }
  ]
};
var invalidateSubcommand = {
  name: "invalidate",
  aliases: [],
  description: "Invalidate all cached content by tag",
  arguments: [],
  options: [
    yesOption,
    projectOption,
    {
      name: "tag",
      description: "Tags to invalidate (comma-separated)",
      shorthand: null,
      type: String,
      argument: "TAGS",
      deprecated: false
    },
    {
      name: "srcimg",
      description: "Source Image to invalidate",
      shorthand: null,
      type: String,
      argument: "SRCIMG",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Invalidate all cached content associated with a tag",
      value: `${packageName} cache invalidate --tag foo`
    },
    {
      name: "Invalidate all cached content associated with any one of multiple tags",
      value: `${packageName} cache invalidate --tag foo,bar,baz`
    },
    {
      name: "Invalidate all cached content associated with a source image",
      value: `${packageName} cache invalidate --srcimg /api/avatar/1`
    }
  ]
};
var dangerouslyDeleteSubcommand = {
  name: "dangerously-delete",
  aliases: [],
  description: "Dangerously delete all cached content by tag",
  arguments: [],
  options: [
    yesOption,
    projectOption,
    {
      name: "tag",
      description: "Tags to delete (comma-separated)",
      shorthand: null,
      type: String,
      argument: "TAGS",
      deprecated: false
    },
    {
      name: "srcimg",
      description: "Source Image to delete",
      shorthand: null,
      type: String,
      argument: "SRCIMG",
      deprecated: false
    },
    {
      name: "revalidation-deadline-seconds",
      description: "Revalidation deadline in seconds",
      shorthand: null,
      type: Number,
      argument: "REVALIDATION-DEADLINE-SECONDS",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Dangerously delete all cached content associated with a tag",
      value: `${packageName} cache dangerously-delete --tag foo`
    },
    {
      name: "Dangerously delete all cached content associated with a tag if not accessed in the next hour",
      value: `${packageName} cache dangerously-delete --tag foo --revalidation-deadline-seconds 3600`
    },
    {
      name: "Dangerously delete all cached content associated with a source image",
      value: `${packageName} cache dangerously-delete --srcimg /api/avatar/1`
    },
    {
      name: "Dangerously delete all cached content associated with a source image if not accessed in the next hour",
      value: `${packageName} cache dangerously-delete --srcimg /api/avatar/1 --revalidation-deadline-seconds 3600`
    }
  ]
};
var cacheCommand = {
  name: "cache",
  aliases: [],
  description: "Manage cache for a Project",
  arguments: [],
  subcommands: [
    purgeSubcommand,
    invalidateSubcommand,
    dangerouslyDeleteSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/certs/command.ts
var removeSubcommand3 = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove a certificate by id",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [],
  examples: [
    {
      name: "Remove a certificate",
      value: `${packageName} certs rm id`
    }
  ]
};
var issueSubcommand = {
  name: "issue",
  aliases: [],
  description: "Issue a new certificate for a domain",
  arguments: [
    {
      name: "cn",
      required: true
    }
  ],
  options: [
    {
      name: "challenge-only",
      description: "Only show challenges needed to issue a certificate",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "crt",
      description: "Certificate file",
      argument: "FILE",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "key",
      description: "Certificate key file",
      argument: "FILE",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "ca",
      description: "CA certificate chain file",
      argument: "FILE",
      shorthand: null,
      type: String,
      deprecated: false
    },
    { name: "overwrite", shorthand: null, type: Boolean, deprecated: false }
  ],
  examples: [
    {
      name: 'Generate a certificate with the cnames "acme.com" and "www.acme.com"`',
      value: `${packageName} certs issue acme.com www.acme.com`
    }
  ]
};
var listSubcommand5 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all available certificates",
  arguments: [],
  options: [limitOption, nextOption],
  examples: [
    {
      name: "Paginate results, where `1584722256178` is the time in milliseconds since the UNIX epoch.",
      value: `${packageName} certs ls --next 1584722256178`
    }
  ]
};
var addSubcommand2 = {
  name: "add",
  aliases: [],
  description: "Add a new certificate",
  arguments: [],
  options: [
    {
      name: "crt",
      description: "Certificate file",
      argument: "FILE",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "key",
      description: "Certificate key file",
      argument: "FILE",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "ca",
      description: "CA certificate chain file",
      argument: "FILE",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "overwrite",
      description: "",
      shorthand: null,
      type: Boolean,
      deprecated: true
    }
  ],
  examples: []
};
var certsCommand = {
  name: "certs",
  aliases: ["cert"],
  description: "Interact with SSL certificates. This command is intended for advanced use only. By default, Vercel manages your certificates automatically.",
  arguments: [],
  subcommands: [
    addSubcommand2,
    issueSubcommand,
    listSubcommand5,
    removeSubcommand3
  ],
  options: [],
  examples: [
    ...issueSubcommand.examples,
    ...removeSubcommand3.examples,
    ...listSubcommand5.examples
  ]
};

// src/commands/changelog/command.ts
var changelogOptions = [
  {
    name: "limit",
    shorthand: null,
    type: Number,
    argument: "NUMBER",
    deprecated: false,
    description: "Number of updates to show (default: 5, max: 20)"
  },
  formatOption,
  jsonOption
];
var searchSubcommand = {
  name: "search",
  aliases: [],
  description: "Search Vercel product updates by keyword",
  arguments: [
    {
      name: "query",
      required: true,
      multiple: true
    }
  ],
  options: changelogOptions,
  examples: [
    {
      name: "Search Vercel product updates",
      value: `${packageName} changelog search "Fluid compute"`
    }
  ]
};
var changelogCommand = {
  name: "changelog",
  aliases: [],
  description: "Show the latest Vercel product updates",
  arguments: [],
  subcommands: [searchSubcommand],
  options: changelogOptions,
  examples: [
    {
      name: "Show the 5 latest Vercel product updates",
      value: `${packageName} --changelog`
    },
    {
      name: "Show more Vercel product updates",
      value: `${packageName} changelog --limit 10`
    },
    {
      name: "Search Vercel product updates",
      value: `${packageName} changelog search "AI SDK"`
    }
  ]
};

// src/commands/connex/command.ts
var createSubcommand2 = {
  name: "create",
  aliases: [],
  description: "Create a new connector\n\nAccepts a known service (slack, notion, okta) or the URL of an OAuth or MCP server (mcp.notion.com/mcp). Run `create <service> --help` to see how a specific service can be connected to.",
  arguments: [
    {
      name: "service",
      required: true
    }
  ],
  options: [
    {
      name: "name",
      shorthand: "n",
      type: String,
      argument: "NAME",
      deprecated: false,
      description: "Name of the connector"
    },
    {
      name: "triggers",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Enable webhook triggers for this connector"
    },
    {
      name: "trigger-event",
      shorthand: null,
      type: [String],
      argument: "EVENT",
      deprecated: false,
      description: "Webhook event to receive. Repeatable. Requires --triggers and replaces the provider's default events."
    },
    {
      name: "trigger-project",
      shorthand: null,
      type: String,
      argument: "PROJECT",
      deprecated: false,
      description: "Target a project by name or ID instead of the linked project. Requires --triggers."
    },
    {
      name: "trigger-path",
      shorthand: null,
      type: String,
      argument: "PATH",
      deprecated: false,
      description: "Set the path on the destination project that receives forwarded webhooks. Requires --triggers."
    },
    {
      name: "trigger-branch",
      shorthand: null,
      type: String,
      argument: "BRANCH",
      deprecated: false,
      description: "Target a specific git branch for the trigger destination. Requires --triggers."
    },
    {
      name: "trigger-environment",
      shorthand: null,
      type: String,
      argument: "ENV",
      deprecated: false,
      description: "Target a custom environment by slug or stable ID. Mutually exclusive with --trigger-branch and requires --triggers."
    },
    {
      name: "connection-method",
      shorthand: null,
      type: String,
      argument: "METHOD",
      deprecated: false,
      description: "How to connect to the service (e.g. oauth, mcp, api-key). Run without it to choose interactively; the error lists the valid values for a service."
    },
    {
      name: "target",
      shorthand: null,
      type: String,
      argument: "TARGET",
      deprecated: false,
      description: "Which of the service's products to connect to (e.g. api, mcp). Only needed when a service exposes more than one."
    },
    {
      name: "param",
      shorthand: null,
      type: [String],
      argument: "KEY=VALUE",
      deprecated: false,
      description: "Value for a connection method template field (e.g. domain=acme.okta.com). Repeatable."
    },
    {
      ...yesOption,
      description: "Skip the single-connection-method confirmation prompt"
    },
    {
      name: "data",
      shorthand: null,
      type: String,
      argument: "JSON",
      deprecated: false,
      description: "JSON object for non-managed connector creation. When set, posts directly to the connector create API. Pass `@<path>` to read from a file or `@-` to read from stdin \u2014 recommended for secrets (e.g. client secrets), which leak into shell history when passed inline."
    },
    {
      name: "connector-type",
      shorthand: null,
      type: String,
      argument: "TYPE",
      deprecated: false,
      description: "Connector type for non-managed creation. By default, the type is resolved from the service."
    },
    {
      name: "icon",
      shorthand: null,
      type: String,
      argument: "PATH",
      deprecated: false,
      description: "Path to a PNG or JPEG image to use as the connector icon (uploaded to Vercel)"
    },
    {
      name: "background-color",
      shorthand: null,
      type: String,
      argument: "HEX",
      deprecated: false,
      description: "Background color for the connector icon (e.g. #1A2B3C)"
    },
    {
      name: "accent-color",
      shorthand: null,
      type: String,
      argument: "HEX",
      deprecated: false,
      description: "Accent color for the connector icon (e.g. #1A2B3C)"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Create a Slack app",
      value: `${packageName} connect create slack`
    },
    {
      name: "Create with a custom name",
      value: `${packageName} connect create slack --name my-bot`
    },
    {
      name: "Create with webhook triggers enabled",
      value: `${packageName} connect create slack --name my-bot --triggers`
    },
    {
      name: "Create with selected webhook events",
      value: `${packageName} connect create linear --name linear --triggers --trigger-event Issue --trigger-event Comment --trigger-event Project`
    },
    {
      name: "Create with a custom trigger path",
      value: `${packageName} connect create github --name github --triggers --trigger-path /eve/v1/github`
    },
    {
      name: "Create with branch-specific trigger routing",
      value: `${packageName} connect create github --name github --triggers --trigger-path /api/webhooks --trigger-branch main`
    },
    {
      name: "Create with trigger routing on another project",
      value: `${packageName} connect create github --name github --triggers --trigger-project my-api --trigger-path /api/webhooks`
    },
    {
      name: "Create with branding (icon and colors)",
      value: `${packageName} connect create slack --name my-bot --icon ./logo.png --background-color '#1A2B3C' --accent-color '#FF0066'`
    },
    {
      name: "Create with a specific connection method",
      value: `${packageName} connect create notion --connection-method mcp --name notion-mcp`
    },
    {
      name: "Create with an API key, reading it from a file",
      value: `${packageName} connect create notion --connection-method api-key --name notion --data @key.json`
    },
    {
      name: "Create from a connection method that needs template values",
      value: `${packageName} connect create okta --connection-method custom-server --param domain=acme.okta.com --param auth_server_id=default --name okta --data @creds.json`
    },
    {
      name: "Target a specific product of a service",
      value: `${packageName} connect create notion --target api --connection-method oauth --name notion --data @creds.json`
    },
    {
      name: "Create a non-managed connector from explicit data",
      value: `${packageName} connect create mcp.linear.app --name linear --data '{"clientId":"abc123"}'`
    },
    {
      name: "Create a non-managed connector, reading credentials from a file (keeps secrets out of shell history)",
      value: `${packageName} connect create slack --name my-bot --connector-type slack --data @slack-app.json`
    },
    {
      name: "Create a non-managed connector, reading credentials from stdin",
      value: `cat slack-app.json | ${packageName} connect create slack --name my-bot --connector-type slack --data @-`
    },
    {
      name: "Output as JSON",
      value: `${packageName} connect create slack --json`
    }
  ]
};
var updateSubcommand = {
  name: "update",
  aliases: [],
  description: "Update connector branding (icon and colors)",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [
    {
      name: "icon",
      shorthand: null,
      type: String,
      argument: "PATH",
      deprecated: false,
      description: "Path to a PNG or JPEG image to use as the connector icon (uploaded to Vercel)"
    },
    {
      name: "background-color",
      shorthand: null,
      type: String,
      argument: "HEX",
      deprecated: false,
      description: "Background color for the connector icon (e.g. #1A2B3C)"
    },
    {
      name: "accent-color",
      shorthand: null,
      type: String,
      argument: "HEX",
      deprecated: false,
      description: "Accent color for the connector icon (e.g. #1A2B3C)"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Update the connector icon",
      value: `${packageName} connect update scl_abc123 --icon ./logo.png`
    },
    {
      name: "Update the connector colors",
      value: `${packageName} connect update scl_abc123 --background-color '#1A2B3C' --accent-color '#FF0066'`
    },
    {
      name: "Output as JSON",
      value: `${packageName} connect update scl_abc123 --icon ./logo.png --json`
    }
  ]
};
var listSubcommand6 = {
  name: "list",
  aliases: ["ls"],
  description: "List connectors linked to the current project (falls back to every connector in the team when no project is linked or when --all-projects is set)",
  arguments: [],
  options: [
    {
      name: "all-projects",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "List every connector in the team, regardless of project link"
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      argument: "COUNT",
      deprecated: false,
      description: "Number of connectors to return per page"
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      argument: "CURSOR",
      deprecated: false,
      description: "Cursor for the next page of results"
    },
    {
      name: "search",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Search connectors by name or UID"
    },
    {
      name: "service",
      shorthand: null,
      type: [String],
      argument: "NAME",
      deprecated: false,
      description: "Filter by service name (e.g. slack, mcp.linear.app). Repeatable."
    },
    {
      name: "type",
      shorthand: null,
      type: [String],
      argument: "TYPE",
      deprecated: false,
      description: "Filter by connector type (slack, github, oauth, custom). Repeatable."
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List connectors linked to the current project",
      value: `${packageName} connect list`
    },
    {
      name: "List every connector in the team",
      value: `${packageName} connect list --all-projects`
    },
    {
      name: "Filter by connector type",
      value: `${packageName} connect list --type slack`
    },
    {
      name: "Filter by multiple types",
      value: `${packageName} connect list --type oauth --type github`
    },
    {
      name: "Filter by service name",
      value: `${packageName} connect list --service mcp.linear.app`
    },
    {
      name: "Search by text",
      value: `${packageName} connect list --search linear`
    },
    {
      name: "Combine filters",
      value: `${packageName} connect list --type oauth --search prod`
    },
    {
      name: "Limit the number of results",
      value: `${packageName} connect list --limit 10`
    },
    {
      name: "Fetch the next page of results",
      value: `${packageName} connect list --next <cursor>`
    },
    {
      name: "Output as JSON",
      value: `${packageName} connect list --json`
    }
  ]
};
var removeSubcommand4 = {
  name: "remove",
  aliases: ["rm"],
  description: "Delete a connector",
  arguments: [
    {
      name: "connector",
      required: true
    }
  ],
  options: [
    {
      name: "disconnect-all",
      description: "Disconnects all projects from the connector before deletion",
      shorthand: "a",
      type: Boolean,
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt when deleting a connector"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Delete a connector by ID",
      value: `${packageName} connect remove scl_abc123`
    },
    {
      name: "Delete a connector by UID",
      value: `${packageName} connect remove slack/my-bot`
    },
    {
      name: "Disconnect all projects from a connector, then delete it",
      value: [
        `${packageName} connect remove scl_abc123 --disconnect-all`,
        `${packageName} connect remove slack/my-bot -a`
      ]
    },
    {
      name: "Skip the confirmation prompt",
      value: `${packageName} connect remove scl_abc123 --yes`
    },
    {
      name: "Output as JSON",
      value: `${packageName} connect remove scl_abc123 --json --yes`
    }
  ]
};
var tokenSubcommand = {
  name: "token",
  aliases: [],
  description: "Get a token for a connector (accepts a connector ID like scl_abc or a UID like slack/my-bot)",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [
    {
      name: "subject",
      shorthand: "s",
      type: String,
      argument: "TYPE",
      deprecated: false,
      description: `Subject type: "user" (default, acts on behalf of you) or "app" (uses the connector's default installation)`
    },
    {
      name: "installation-id",
      shorthand: null,
      type: String,
      argument: "ID",
      deprecated: false,
      description: "Target a specific installation (only useful with --subject app; defaults to the connector's default installation)"
    },
    {
      name: "scopes",
      shorthand: null,
      type: String,
      argument: "SCOPES",
      deprecated: false,
      description: "Scopes (comma- or space-separated)"
    },
    yesOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Get a user token by connector ID",
      value: `${packageName} connect token scl_abc123`
    },
    {
      name: "Get a token by connector UID",
      value: `${packageName} connect token slack/my-bot`
    },
    {
      name: "Get an app token (default installation)",
      value: `${packageName} connect token scl_abc123 --subject app`
    },
    {
      name: "Get an app token for a specific installation",
      value: `${packageName} connect token scl_abc123 --subject app --installation-id inst_1`
    },
    {
      name: "Open the browser automatically if authorization/installation is required",
      value: `${packageName} connect token scl_abc123 --yes`
    },
    {
      name: "Output as JSON (includes expiresAt, installationId, etc.)",
      value: `${packageName} connect token scl_abc123 --json`
    }
  ]
};
var revokeTokensSubcommand = {
  name: "revoke-tokens",
  aliases: [],
  description: "Revoke tokens issued from a connector",
  arguments: [
    {
      name: "connector",
      required: true
    }
  ],
  options: [
    {
      name: "my-tokens",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Revoke only your own tokens for this connector"
    },
    {
      name: "all-tokens",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Revoke every token for all users and installations. Requires team owner or member permissions."
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Interactively select which tokens to revoke",
      value: `${packageName} connect revoke-tokens scl_abc123`
    },
    {
      name: "Revoke only your own tokens",
      value: `${packageName} connect revoke-tokens scl_abc123 --my-tokens`
    },
    {
      name: "Revoke all tokens for all users",
      value: `${packageName} connect revoke-tokens scl_abc123 --all-tokens`
    },
    {
      name: "Skip the confirmation prompt",
      value: `${packageName} connect revoke-tokens scl_abc123 --my-tokens --yes`
    },
    {
      name: "Output as JSON",
      value: `${packageName} connect revoke-tokens scl_abc123 --my-tokens --yes --json`
    }
  ]
};
var openSubcommand = {
  name: "open",
  aliases: [],
  description: "Open a connector in the Vercel dashboard",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Open a connector by ID",
      value: `${packageName} connect open scl_abc123`
    },
    {
      name: "Open a connector by UID",
      value: `${packageName} connect open slack/my-bot`
    },
    {
      name: "Print the dashboard URL as JSON",
      value: `${packageName} connect open scl_abc123 --json`
    }
  ]
};
var attachSubcommand = {
  name: "attach",
  aliases: [],
  description: "Attach a Vercel project to a connector for one or more environments",
  arguments: [
    {
      name: "connector",
      required: true
    }
  ],
  options: [
    {
      name: "environment",
      shorthand: "e",
      type: [String],
      argument: "ENV",
      deprecated: false,
      description: "Environments to enable by system name, custom slug, or custom ID. Repeatable and comma-separated. Defaults to production, preview, and development."
    },
    {
      ...projectOption,
      shorthand: "p",
      description: "Project name or ID (default: current linked project)"
    },
    {
      name: "triggers",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Also register this project as a trigger destination so the connector forwards verified webhooks to it (max 3 destinations per connector)"
    },
    {
      name: "trigger-branch",
      shorthand: null,
      type: String,
      argument: "BRANCH",
      deprecated: false,
      description: "Target a specific git branch for the trigger destination (default: production). Only valid with --triggers."
    },
    {
      name: "trigger-environment",
      shorthand: null,
      type: String,
      argument: "ENV",
      deprecated: false,
      description: "Target a custom environment by slug or stable ID. Mutually exclusive with --trigger-branch and only valid with --triggers."
    },
    {
      name: "trigger-path",
      shorthand: null,
      type: String,
      argument: "PATH",
      deprecated: false,
      description: "Path on the destination project that receives the forwarded webhook (default: /{service}). Only valid with --triggers."
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Attach the current project for all system environments",
      value: `${packageName} connect attach scl_abc123`
    },
    {
      name: "Restrict to specific environments",
      value: `${packageName} connect attach scl_abc123 -e production -e preview`
    },
    {
      name: "Attach to a custom environment by slug",
      value: `${packageName} connect attach scl_abc123 -e qa`
    },
    {
      name: "Attach to a custom environment by stable ID",
      value: `${packageName} connect attach scl_abc123 -e env_qa123`
    },
    {
      name: "Attach a different project by name",
      value: `${packageName} connect attach slack/my-bot --project my-app`
    },
    {
      name: "Attach and register the project as a trigger destination",
      value: `${packageName} connect attach scl_abc123 --triggers`
    },
    {
      name: "Attach and register a preview-branch trigger destination",
      value: `${packageName} connect attach scl_abc123 --triggers --trigger-branch staging --trigger-path /slack`
    },
    {
      name: "Attach and register a custom-environment trigger destination",
      value: `${packageName} connect attach scl_abc123 --triggers --trigger-environment qa --trigger-path /slack`
    },
    {
      name: "Non-interactive output as JSON",
      value: `${packageName} connect attach scl_abc123 --yes --json`
    }
  ]
};
var detachSubcommand = {
  name: "detach",
  aliases: [],
  description: "Detach a Vercel project from a connector",
  arguments: [
    {
      name: "connector",
      required: true
    }
  ],
  options: [
    {
      ...projectOption,
      shorthand: "p",
      description: "Project name or ID (default: current linked project)"
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Detach the current project from a connector",
      value: `${packageName} connect detach scl_abc123`
    },
    {
      name: "Detach a different project by name",
      value: `${packageName} connect detach slack/my-bot --project my-app`
    },
    {
      name: "Non-interactive output as JSON",
      value: `${packageName} connect detach scl_abc123 --yes --json`
    }
  ]
};
var connexCommand = {
  name: "connect",
  aliases: [],
  description: "Manage connectors (Beta).\n\nVercel Connect is currently in beta. Behavior, commands, and output may change before general availability.",
  arguments: [],
  options: [],
  subcommands: [
    createSubcommand2,
    updateSubcommand,
    listSubcommand6,
    tokenSubcommand,
    attachSubcommand,
    detachSubcommand,
    removeSubcommand4,
    revokeTokensSubcommand,
    openSubcommand
  ],
  examples: [
    {
      name: "Create a Slack app",
      value: `${packageName} connect create slack`
    },
    {
      name: "List connectors on the current team",
      value: `${packageName} connect list`
    },
    {
      name: "Get a token",
      value: `${packageName} connect token scl_abc123`
    },
    {
      name: "Attach the current project to a connector",
      value: `${packageName} connect attach scl_abc123`
    },
    {
      name: "Open a connector in the dashboard",
      value: `${packageName} connect open scl_abc123`
    }
  ]
};

// src/commands/contract/command.ts
var contractCommand = {
  name: "contract",
  aliases: [],
  description: "Show contract information for all billing periods",
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Show contract information for all billing periods",
      value: `${packageName} contract`
    },
    {
      name: "Show contract information for all billing periods as JSON",
      value: `${packageName} contract --json`
    }
  ]
};

// src/commands/crons/command.ts
var addSubcommand3 = {
  name: "add",
  aliases: [],
  description: "Add a cron job to vercel.json",
  arguments: [],
  options: [
    {
      name: "path",
      shorthand: null,
      type: String,
      argument: "PATH",
      deprecated: false,
      description: "The API route path for the cron job (must start with /)"
    },
    {
      name: "schedule",
      shorthand: null,
      type: String,
      argument: "EXPRESSION",
      deprecated: false,
      description: 'The cron schedule expression (e.g. "0 10 * * *")'
    }
  ],
  examples: [
    {
      name: "Add a cron job interactively",
      value: `${packageName} crons add`
    },
    {
      name: "Add a cron job with flags",
      value: `${packageName} crons add --path /api/cron --schedule "0 10 * * *"`
    }
  ]
};
var listSubcommand7 = {
  name: "list",
  aliases: ["ls"],
  description: "List all cron jobs for a project",
  default: true,
  arguments: [],
  options: [formatOption, jsonOption, projectOption],
  examples: [
    {
      name: "List all cron jobs",
      value: `${packageName} crons ls`
    },
    {
      name: "List all cron jobs as JSON",
      value: `${packageName} crons ls --json`
    }
  ]
};
var runSubcommand = {
  name: "run",
  aliases: [],
  description: "Trigger a cron job to run immediately",
  arguments: [
    {
      name: "path",
      required: false
    }
  ],
  options: [projectOption],
  examples: [
    {
      name: "Trigger a specific cron job",
      value: `${packageName} crons run /api/cron`
    }
  ]
};
var cronsCommand = {
  name: "crons",
  aliases: ["cron"],
  description: "Manage cron jobs for a project",
  arguments: [],
  subcommands: [addSubcommand3, listSubcommand7, runSubcommand],
  options: [],
  examples: []
};

// src/commands/curl/command.ts
var curlCommand = {
  name: "curl",
  aliases: [],
  description: "Make curl requests to Vercel deployments with automatic protection bypass.",
  arguments: [
    {
      name: "path",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip confirmation when linking is required (e.g. in non-interactive mode)"
    },
    deploymentOption,
    protectionBypassOption,
    {
      name: "trace",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Capture a session trace for the request and print the trace request id"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "With --trace, emit { response, requestId } as JSON on stdout"
    }
  ],
  examples: [
    {
      name: "Access a protected deployment URL",
      value: `${packageName} curl https://your-project-abc123.vercel.app/api/hello`
    },
    {
      name: "Make a GET request to an API endpoint",
      value: `${packageName} curl /api/hello`
    },
    {
      name: "Make a POST request with data",
      value: `${packageName} curl /api/users -- --request POST --data '{"name": "John"}'`
    },
    {
      name: "Target a specific deployment by ID",
      value: `${packageName} curl /api/status --deployment ERiL45NJvP8ghWxgbvCM447bmxwV`
    },
    {
      name: "Target a specific deployment by URL",
      value: `${packageName} curl /api/status --deployment https://your-project-abc123.vercel.app`
    },
    {
      name: "Use curl flags after the separator",
      value: `${packageName} curl /api/test -- --header "Content-Type: application/json" --request PUT`
    },
    {
      name: "Use with protection bypass secret",
      value: `${packageName} curl /api/protected --protection-bypass <secret> -- --request GET`
    },
    {
      name: "Capture a session trace for the request",
      value: `${packageName} curl --trace /api/hello`
    }
  ]
};

// src/commands/deploy-hooks/command.ts
var projectOption3 = {
  ...projectOption,
  shorthand: "p"
};
var listSubcommand8 = {
  name: "list",
  aliases: ["ls"],
  description: "List deploy hooks for a project",
  arguments: [],
  options: [formatOption, jsonOption, projectOption3],
  examples: [
    {
      name: "List deploy hooks as JSON",
      value: `${packageName} deploy-hooks ls --json`
    }
  ]
};
var createSubcommand3 = {
  name: "create",
  aliases: ["add"],
  description: "Create a deploy hook for a Git branch",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [
    {
      name: "ref",
      shorthand: "r",
      type: String,
      argument: "BRANCH",
      deprecated: false,
      description: "Git branch ref to deploy when the hook URL is triggered"
    },
    projectOption3
  ],
  examples: [
    {
      name: "Create a hook that deploys `main`",
      value: `${packageName} deploy-hooks create cms-rebuild --ref main`
    }
  ]
};
var removeSubcommand5 = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove a deploy hook by id",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [
    projectOption3,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing a deploy hook"
    }
  ],
  examples: []
};
var deployHooksCommand = {
  name: "deploy-hooks",
  aliases: ["deploy-hook"],
  description: "Manage deploy hooks for Git-triggered builds",
  arguments: [],
  subcommands: [listSubcommand8, createSubcommand3, removeSubcommand5],
  options: [],
  examples: []
};

// src/commands/dns/command.ts
var importSubcommand = {
  name: "import",
  aliases: [],
  description: "Import a DNS zone file (see below for examples)",
  arguments: [
    {
      name: "domain",
      required: true
    },
    {
      name: "zonefile",
      required: true
    }
  ],
  options: [],
  examples: []
};
var listSubcommand9 = {
  name: "list",
  aliases: ["ls"],
  description: "List DNS entries. Pass a domain to list its records, or omit the argument to list records across every domain on the scope",
  default: true,
  arguments: [
    {
      name: "domain",
      required: false
    }
  ],
  options: [limitOption, nextOption],
  examples: []
};
var addSubcommand4 = {
  name: "add",
  aliases: [],
  description: "Add a new DNS entry (see below for examples)",
  arguments: [
    {
      name: "domain",
      required: true
    },
    {
      name: "details",
      required: true
    }
  ],
  options: [],
  examples: []
};
var inspectSubcommand3 = {
  name: "inspect",
  aliases: [],
  description: "Show a DNS record in full using its ID",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Show a DNS record in full",
      value: `${packageName} dns inspect rec_1a2b3c4d5e6f`
    },
    {
      name: "Show a DNS record as JSON",
      value: `${packageName} dns inspect rec_1a2b3c4d5e6f --json`
    }
  ]
};
var removeSubcommand6 = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove a DNS entry using its ID",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing a DNS record"
    }
  ],
  examples: []
};
var updateSubcommand2 = {
  name: "update",
  aliases: [],
  description: "Update an existing DNS record using its ID",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [
    {
      name: "name",
      shorthand: null,
      type: String,
      argument: "NAME",
      deprecated: false,
      description: "New name of the DNS record ('@' refers to the domain)"
    },
    {
      name: "type",
      shorthand: null,
      type: String,
      argument: "TYPE",
      deprecated: false,
      description: "New type of the DNS record (A, AAAA, ALIAS, CAA, CNAME, MX, SRV, TXT)"
    },
    {
      name: "value",
      shorthand: null,
      type: String,
      argument: "VALUE",
      deprecated: false,
      description: "New value of the DNS record"
    },
    {
      name: "ttl",
      shorthand: null,
      type: Number,
      argument: "SECONDS",
      deprecated: false,
      description: "New Time to live (TTL) of the DNS record, in seconds"
    },
    {
      name: "mx-priority",
      shorthand: null,
      type: Number,
      argument: "PRIORITY",
      deprecated: false,
      description: "New priority of the MX record"
    },
    {
      name: "comment",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "A comment to add context on what this DNS record is for"
    }
  ],
  examples: [
    {
      name: "Update the value of an A record",
      value: `${packageName} dns update rec_1a2b3c4d5e6f --value 198.51.100.100`
    },
    {
      name: "Update the name and TTL of a record",
      value: `${packageName} dns update rec_1a2b3c4d5e6f --name api --ttl 300`
    },
    {
      name: "Update an MX record priority",
      value: `${packageName} dns update rec_1a2b3c4d5e6f --mx-priority 10`
    }
  ]
};
var dnsCommand = {
  name: "dns",
  aliases: [],
  description: "Interact with DNS entries for a project",
  arguments: [],
  subcommands: [
    addSubcommand4,
    importSubcommand,
    inspectSubcommand3,
    listSubcommand9,
    removeSubcommand6,
    updateSubcommand2
  ],
  options: [],
  examples: [
    {
      name: "Add an A record for a subdomain",
      value: [
        `${packageName} dns add <DOMAIN> <SUBDOMAIN> <A | AAAA | ALIAS | CNAME | TXT>  <VALUE>`,
        `${packageName} dns add zeit.rocks api A 198.51.100.100`
      ]
    },
    {
      name: "Add an MX record (@ as a name refers to the domain)",
      value: [
        `${packageName} dns add <DOMAIN> '@' MX <RECORD VALUE> <PRIORITY>`,
        `${packageName} dns add zeit.rocks '@' MX mail.zeit.rocks 10`
      ]
    },
    {
      name: "Add an SRV record",
      value: [
        `${packageName} dns add <DOMAIN> <NAME> SRV <PRIORITY> <WEIGHT> <PORT> <TARGET>`,
        `${packageName} dns add zeit.rocks '@' SRV 10 0 389 zeit.party`
      ]
    },
    {
      name: "Add a CAA record",
      value: [
        `${packageName} dns add <DOMAIN> <NAME> CAA '<FLAGS> <TAG> "<VALUE>"'`,
        `${packageName} dns add zeit.rocks '@' CAA '0 issue "example.com"'`
      ]
    },
    {
      name: "Import a Zone file",
      value: [
        `${packageName} dns import <DOMAIN> <FILE>`,
        `${packageName} dns import zeit.rocks ./zonefile.txt`
      ]
    },
    {
      name: "Paginate results, where `1584722256178` is the time in milliseconds since the UNIX epoch",
      value: [
        `${packageName} dns ls --next 1584722256178`,
        `${packageName} dns ls zeit.rocks --next 1584722256178`
      ]
    }
  ]
};

// src/commands/domains/command.ts
var listSubcommand10 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all domains in a list",
  default: true,
  arguments: [],
  options: [limitOption, nextOption, formatOption, jsonOption],
  examples: [
    {
      name: "Paginate results, where `1584722256178` is the time in milliseconds since the UNIX epoch",
      value: `${packageName} domains ls --next 1584722256178`
    }
  ]
};
var inspectSubcommand4 = {
  name: "inspect",
  aliases: [],
  description: "Displays information related to a domain",
  arguments: [
    {
      name: "domain",
      required: true
    }
  ],
  options: [],
  examples: []
};
var addSubcommand5 = {
  name: "add",
  aliases: [],
  description: "Add a domain name that you already own to a Vercel Team",
  arguments: [
    {
      name: "domain",
      required: true
    },
    {
      name: "project",
      required: false
    }
  ],
  options: [
    {
      ...forceOption,
      shorthand: null,
      description: "Force a domain name for a project and remove it from an existing one"
    }
  ],
  examples: [
    {
      name: "Add a domain that you already own",
      value: [
        `${packageName} domains add domain-name.com`,
        "Make sure the domain's DNS nameservers are at least 2 of the ones listed on https://vercel.com/edge-network",
        `NOTE: Running ${packageName} alias will automatically register your domain if it's configured with these nameservers (no need to 'domains add')`
      ]
    }
  ]
};
var removeSubcommand7 = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove ownership of a domain name from a Vercel Team",
  arguments: [
    {
      name: "domain",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing a domain"
    }
  ],
  examples: []
};
var priceSubcommand = {
  name: "price",
  aliases: [],
  description: "Show registrar price quotes for one or more domains",
  arguments: [
    {
      name: "domain",
      required: true,
      multiple: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Price quote for a domain",
      value: `${packageName} domains price example.com`
    },
    {
      name: "Price quotes for multiple domains",
      value: `${packageName} domains price one.com two.com three.com`
    },
    {
      name: "JSON output",
      value: `${packageName} domains price example.com --json`
    }
  ]
};
var searchSubcommand2 = {
  name: "search",
  aliases: [],
  description: "Discover domain-name candidates from a keyword or fragment",
  arguments: [
    {
      name: "query",
      required: true
    }
  ],
  options: [
    {
      name: "available",
      shorthand: null,
      type: Boolean,
      description: "Show only candidates available to register",
      deprecated: false
    },
    {
      name: "order",
      shorthand: null,
      type: String,
      argument: "ORDER",
      description: "Order candidates by relevance, alphabetical order, or length (default: relevance)",
      deprecated: false
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      description: "Number of candidates to check per page (default: 20, max: 200)",
      deprecated: false
    },
    {
      name: "tld",
      shorthand: null,
      type: [String],
      argument: "TLD",
      description: "Filter candidates by exact TLD. Repeatable.",
      deprecated: false
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      argument: "CURSOR",
      description: "Show the next page of candidates",
      deprecated: false
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Discover domain-name candidates",
      value: `${packageName} domains search acme`
    },
    {
      name: "Narrow candidates with a TLD fragment",
      value: `${packageName} domains search acme.d`
    },
    {
      name: "Filter candidates by TLD",
      value: `${packageName} domains search acme --tld com --tld dev`
    },
    {
      name: "Show only available candidates",
      value: `${packageName} domains search acme --available`
    },
    {
      name: "JSON output",
      value: `${packageName} domains search acme --json`
    }
  ]
};
var buySubcommand = {
  name: "buy",
  aliases: [],
  description: "Purchase a new domain name",
  arguments: [
    {
      name: "domain",
      required: true
    }
  ],
  options: [],
  examples: []
};
var checkSubcommand = {
  name: "check",
  aliases: [],
  description: "Check if a domain is available to buy",
  arguments: [
    {
      name: "domain",
      required: true,
      multiple: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Check if a domain is available",
      value: `${packageName} domains check example.com`
    },
    {
      name: "Check availability for multiple domains",
      value: `${packageName} domains check one.com two.com three.com`
    },
    {
      name: "JSON output",
      value: `${packageName} domains check example.com --json`
    }
  ]
};
var moveSubcommand = {
  name: "move",
  aliases: [],
  description: "Move ownership of a domain name to another Vercel Team",
  arguments: [
    {
      name: "domain",
      required: true
    },
    {
      name: "destination",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when moving a domain"
    }
  ],
  examples: []
};
var transferInSubcommand = {
  name: "transfer-in",
  aliases: [],
  description: "Transfer in a domain name to Vercel",
  arguments: [
    {
      name: "domain",
      required: true
    }
  ],
  options: [
    {
      name: "code",
      argument: "CODE",
      shorthand: null,
      type: String,
      deprecated: false
    }
  ],
  examples: []
};
var verifySubcommand = {
  name: "verify",
  aliases: [],
  description: "Check a domain's DNS configuration and explain what to fix when it is misconfigured or unverified",
  arguments: [
    {
      name: "domain",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "strict",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Check DNS for the exact domain only, without falling back to the parent zone configuration"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Check why a domain is not working",
      value: `${packageName} domains verify example.com`
    },
    {
      name: "Check a domain against a specific project",
      value: `${packageName} domains verify example.com --project my-site`
    },
    {
      name: "JSON output (the exit code is non-zero when the domain is misconfigured or unverified)",
      value: `${packageName} domains verify example.com --json`
    },
    {
      name: "Agent-friendly output with status, reason, and suggested next commands",
      value: `${packageName} domains verify example.com --non-interactive`
    }
  ]
};
var domainsCommand = {
  name: "domains",
  aliases: ["domain"],
  description: "Manage domains",
  arguments: [],
  subcommands: [
    listSubcommand10,
    inspectSubcommand4,
    addSubcommand5,
    buySubcommand,
    checkSubcommand,
    moveSubcommand,
    priceSubcommand,
    searchSubcommand2,
    transferInSubcommand,
    removeSubcommand7,
    verifySubcommand
  ],
  options: [],
  examples: []
};

// src/commands/firewall/command.ts
var teamLevelOption = {
  name: "team-level",
  shorthand: null,
  type: Boolean,
  deprecated: false,
  description: "Operate on the team-level firewall configuration, which applies to every project in the team. No linked project required. Cannot be combined with --project"
};
var overviewSubcommand = {
  name: "overview",
  aliases: [],
  description: "Show a summary of your project's firewall configuration, including active rules, IP blocks, bypasses, and any unpublished draft changes",
  arguments: [],
  options: [
    projectOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output as JSON"
    }
  ],
  examples: [
    {
      name: "Show firewall overview",
      value: `${packageName} firewall overview`
    }
  ]
};
var diffSubcommand = {
  name: "diff",
  aliases: [],
  description: "Show draft changes that have been made but are not yet published to production",
  arguments: [],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output as JSON"
    }
  ],
  examples: [
    {
      name: "Show unpublished changes",
      value: `${packageName} firewall diff`
    },
    {
      name: "Show unpublished team-level changes",
      value: `${packageName} firewall diff --team-level`
    }
  ]
};
var publishSubcommand = {
  name: "publish",
  aliases: [],
  description: "Publish all draft firewall changes to production, making them live immediately",
  arguments: [],
  options: [projectOption, teamLevelOption, yesOption],
  examples: [
    {
      name: "Publish draft changes",
      value: `${packageName} firewall publish`
    },
    {
      name: "Publish without confirmation",
      value: `${packageName} firewall publish --yes`
    },
    {
      name: "Publish team-level draft changes",
      value: `${packageName} firewall publish --team-level`
    }
  ]
};
var discardSubcommand = {
  name: "discard",
  aliases: [],
  description: "Permanently discard all unpublished draft changes, reverting to the current production configuration",
  arguments: [],
  options: [projectOption, teamLevelOption, yesOption],
  examples: [
    {
      name: "Discard draft changes",
      value: `${packageName} firewall discard`
    },
    {
      name: "Discard without confirmation",
      value: `${packageName} firewall discard --yes`
    }
  ]
};
var systemBypassListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List all system bypass rules that allow specific IPs to skip firewall checks",
  arguments: [],
  options: [
    projectOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output as JSON"
    }
  ],
  examples: [
    {
      name: "List bypass rules",
      value: `${packageName} firewall system-bypass list`
    }
  ]
};
var systemBypassAddSubcommand = {
  name: "add",
  aliases: [],
  description: "Add a system bypass rule to allow a specific IP address to skip firewall checks. Takes effect immediately (no publish required)",
  arguments: [{ name: "ip", required: true }],
  options: [
    projectOption,
    {
      name: "domain",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Scope bypass to a specific domain (default: all domains)"
    },
    {
      name: "notes",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Add a note to the bypass rule"
    },
    yesOption
  ],
  examples: [
    {
      name: "Add a bypass for an IP (all domains)",
      value: `${packageName} firewall system-bypass add 10.0.0.1`
    },
    {
      name: "Add a bypass scoped to a domain",
      value: `${packageName} firewall system-bypass add 10.0.0.1 --domain example.com`
    }
  ]
};
var systemBypassRemoveSubcommand = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove a system bypass rule so the IP is no longer exempt from firewall checks. Takes effect immediately (no publish required)",
  arguments: [{ name: "ip", required: true }],
  options: [
    projectOption,
    {
      name: "domain",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Scope removal to a specific domain"
    },
    yesOption
  ],
  examples: [
    {
      name: "Remove a bypass rule",
      value: `${packageName} firewall system-bypass remove 10.0.0.1`
    }
  ]
};
var systemBypassSubcommand = {
  name: "system-bypass",
  aliases: [],
  description: "Manage system bypass rules that allow specific IPs to skip firewall checks",
  arguments: [],
  subcommands: [
    systemBypassListSubcommand,
    systemBypassAddSubcommand,
    systemBypassRemoveSubcommand
  ],
  options: [],
  examples: [
    {
      name: "List bypass rules",
      value: `${packageName} firewall system-bypass list`
    },
    {
      name: "Add a bypass for an IP",
      value: `${packageName} firewall system-bypass add 10.0.0.1`
    },
    {
      name: "Remove a bypass",
      value: `${packageName} firewall system-bypass remove 10.0.0.1`
    }
  ]
};
var ipBlocksListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List all IP blocking rules, including any unpublished draft changes",
  arguments: [],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output as JSON"
    }
  ],
  examples: [
    {
      name: "List IP blocking rules",
      value: `${packageName} firewall ip-blocks list`
    }
  ]
};
var ipBlocksBlockSubcommand = {
  name: "block",
  aliases: [],
  description: "Block an IP address or CIDR range from accessing your project. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "ip", required: true }],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "hostname",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Scope block to a specific hostname (default: * for all hosts)"
    },
    {
      name: "notes",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Add a note to the block rule"
    },
    yesOption
  ],
  examples: [
    {
      name: "Block an IP",
      value: `${packageName} firewall ip-blocks block 1.2.3.4`
    },
    {
      name: "Block a CIDR range with a note",
      value: `${packageName} firewall ip-blocks block 10.0.0.0/24 --notes "Suspicious range"`
    },
    {
      name: "Block scoped to a hostname",
      value: `${packageName} firewall ip-blocks block 1.2.3.4 --hostname example.com`
    }
  ]
};
var ipBlocksUnblockSubcommand = {
  name: "unblock",
  aliases: ["rm"],
  description: "Remove an IP blocking rule to allow the address to access your project again. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "id-or-ip", required: true }],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "hostname",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Narrow match to a specific hostname (useful when the same IP is blocked on multiple hosts)"
    },
    yesOption
  ],
  examples: [
    {
      name: "Unblock by IP",
      value: `${packageName} firewall ip-blocks unblock 1.2.3.4`
    },
    {
      name: "Unblock scoped to a hostname",
      value: `${packageName} firewall ip-blocks unblock 1.2.3.4 --hostname example.com`
    },
    {
      name: "Unblock by rule ID",
      value: `${packageName} firewall ip-blocks unblock ip_abc123`
    }
  ]
};
var ipBlocksSubcommand = {
  name: "ip-blocks",
  aliases: [],
  description: "Manage IP blocking rules that deny access from specific addresses or ranges",
  arguments: [],
  subcommands: [
    ipBlocksListSubcommand,
    ipBlocksBlockSubcommand,
    ipBlocksUnblockSubcommand
  ],
  options: [],
  examples: [
    {
      name: "List IP blocking rules",
      value: `${packageName} firewall ip-blocks list`
    },
    {
      name: "Block an IP",
      value: `${packageName} firewall ip-blocks block 1.2.3.4`
    },
    {
      name: "Unblock an IP",
      value: `${packageName} firewall ip-blocks unblock 1.2.3.4`
    }
  ]
};
var rulesListSubcommand2 = {
  name: "list",
  aliases: ["ls"],
  description: "List all custom firewall rules, including any unpublished draft changes",
  arguments: [],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "expand",
      shorthand: "e",
      type: Boolean,
      deprecated: false,
      description: "Show full condition details for each rule"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output as JSON"
    }
  ],
  examples: [
    {
      name: "List rules",
      value: `${packageName} firewall rules list`
    },
    {
      name: "List rules with full condition details",
      value: `${packageName} firewall rules list --expand`
    },
    {
      name: "List team-level rules",
      value: `${packageName} firewall rules list --team-level`
    }
  ]
};
var rulesInspectSubcommand = {
  name: "inspect",
  aliases: [],
  description: "Show the full configuration of a custom firewall rule, including conditions, action, and rate limit settings",
  arguments: [{ name: "name-or-id", required: true }],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output as JSON"
    }
  ],
  examples: [
    {
      name: "Inspect a rule by name",
      value: `${packageName} firewall rules inspect "Block bots"`
    },
    {
      name: "Inspect a rule by ID",
      value: `${packageName} firewall rules inspect rule_abc123`
    }
  ]
};
var rulesAddSubcommand2 = {
  name: "add",
  aliases: [],
  description: "Create a new custom firewall rule using AI, an interactive builder, JSON, or command-line flags. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "name", required: false }],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "ai",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Generate rule from natural language (AI-powered)"
    },
    {
      name: "json",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Create rule from JSON payload"
    },
    {
      name: "condition",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: `Condition as JSON (repeatable). Multiple conditions are AND'd together. Fields: type (required), op (required), value, key (for header/cookie/query), neg (boolean). Example: '{"type":"path","op":"pre","value":"/api"}'.`
    },
    {
      name: "or",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Start a new OR group. Conditions before --or are AND'd, conditions after form a separate group. Example: --condition A --condition B --or --condition C matches (A AND B) OR C."
    },
    {
      name: "action",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Action: deny, challenge, log, bypass, rate_limit, redirect"
    },
    {
      name: "duration",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Action duration: 1m, 5m, 15m, 30m, 1h"
    },
    {
      name: "description",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Rule description (max 256 chars)"
    },
    {
      name: "disabled",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Create as disabled (default: enabled)"
    },
    {
      name: "rate-limit-algo",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Rate limit algorithm: fixed_window, token_bucket (default: fixed_window)"
    },
    {
      name: "rate-limit-window",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Rate limit window in seconds, 10-3600 (required for rate_limit)"
    },
    {
      name: "rate-limit-requests",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Rate limit max requests per window, 1-10000000 (required for rate_limit)"
    },
    {
      name: "rate-limit-keys",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Rate limit keys (repeatable): ip, ja4, header:name (default: ip)"
    },
    {
      name: "rate-limit-action",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Action when rate limit is exceeded: log, deny, challenge, rate_limit (default: rate_limit)"
    },
    {
      name: "redirect-url",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Redirect URL or path"
    },
    {
      name: "redirect-permanent",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Permanent redirect (301). Default: temporary (307)"
    },
    yesOption
  ],
  examples: [
    {
      name: "Interactive mode",
      value: `${packageName} firewall rules add`
    },
    {
      name: "Create with AI",
      value: `${packageName} firewall rules add --ai "Rate limit /api to 100 requests per minute by IP"`
    },
    {
      name: "Create from JSON",
      value: `${packageName} firewall rules add --json '{"name":"Block bots","active":true,"conditionGroup":[{"conditions":[{"type":"user_agent","op":"sub","value":"crawler"}]}],"action":{"mitigate":{"action":"deny"}}}'`
    },
    {
      name: "Create with flags",
      value: `${packageName} firewall rules add "Block bots" --condition '{"type":"user_agent","op":"sub","value":"crawler"}' --action deny --yes`
    },
    {
      name: "Create with OR groups",
      value: `${packageName} firewall rules add "Block suspicious" --condition '{"type":"user_agent","op":"sub","value":"crawler"}' --or --condition '{"type":"ip_address","op":"eq","value":"1.2.3.4"}' --action deny --yes`
    }
  ]
};
var rulesEditSubcommand2 = {
  name: "edit",
  aliases: [],
  description: "Edit an existing custom firewall rule using AI, an interactive editor, JSON, or command-line flags. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "name-or-id", required: true }],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "ai",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Describe changes using natural language (AI-powered)"
    },
    {
      name: "json",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Replace rule with JSON payload"
    },
    {
      name: "condition",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: `Replace conditions as JSON (repeatable). Example: '{"type":"path","op":"pre","value":"/api"}'. Fields: type, op, value, key (for header/cookie/query), neg (boolean). Use --or between conditions for OR groups.`
    },
    {
      name: "or",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Start a new OR condition group"
    },
    {
      name: "name",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Rename the rule"
    },
    {
      name: "action",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Change action: deny, challenge, log, bypass, rate_limit, redirect"
    },
    {
      name: "duration",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Change action duration: 1m, 5m, 15m, 30m, 1h"
    },
    {
      name: "description",
      shorthand: null,
      type: String,
      deprecated: false,
      description: 'Change description (use "" to clear)'
    },
    {
      name: "enabled",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Set rule to enabled"
    },
    {
      name: "disabled",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Set rule to disabled"
    },
    {
      name: "rate-limit-algo",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Rate limit algorithm: fixed_window, token_bucket"
    },
    {
      name: "rate-limit-window",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Rate limit window in seconds (10-3600)"
    },
    {
      name: "rate-limit-requests",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Rate limit max requests per window (1-10000000)"
    },
    {
      name: "rate-limit-keys",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Rate limit keys (repeatable): ip, ja4, header:name"
    },
    {
      name: "rate-limit-action",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Action when rate limit is exceeded: log, deny, challenge, rate_limit (default: rate_limit)"
    },
    {
      name: "redirect-url",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Redirect URL or path"
    },
    {
      name: "redirect-permanent",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Permanent redirect (301). Default: temporary (307)"
    },
    yesOption
  ],
  examples: [
    {
      name: "Interactive mode",
      value: `${packageName} firewall rules edit "My Rule"`
    },
    {
      name: "Edit with AI",
      value: `${packageName} firewall rules edit "My Rule" --ai "Change action to challenge"`
    },
    {
      name: "Change action via flags",
      value: `${packageName} firewall rules edit "My Rule" --action challenge --duration 5m --yes`
    },
    {
      name: "Replace conditions",
      value: `${packageName} firewall rules edit "My Rule" --condition '{"type":"path","op":"pre","value":"/new"}' --yes`
    },
    {
      name: "Rename a rule",
      value: `${packageName} firewall rules edit "My Rule" --name "New Name" --yes`
    }
  ]
};
var rulesEnableSubcommand = {
  name: "enable",
  aliases: [],
  description: "Enable a disabled custom firewall rule. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "name-or-id", required: true }],
  options: [projectOption, teamLevelOption, yesOption],
  examples: [
    {
      name: "Enable a rule",
      value: `${packageName} firewall rules enable "My Rule"`
    }
  ]
};
var rulesDisableSubcommand = {
  name: "disable",
  aliases: [],
  description: "Disable a custom firewall rule without removing it. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "name-or-id", required: true }],
  options: [projectOption, teamLevelOption, yesOption],
  examples: [
    {
      name: "Disable a rule",
      value: `${packageName} firewall rules disable "My Rule"`
    }
  ]
};
var rulesRemoveSubcommand2 = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove a custom firewall rule. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "name-or-id", required: true }],
  options: [projectOption, teamLevelOption, yesOption],
  examples: [
    {
      name: "Remove a rule",
      value: `${packageName} firewall rules remove "My Rule" --yes`
    }
  ]
};
var rulesReorderSubcommand = {
  name: "reorder",
  aliases: ["move"],
  description: "Change the priority order of a custom firewall rule. Stages a draft change \u2014 run `publish` to make it live",
  arguments: [{ name: "name-or-id", required: true }],
  options: [
    projectOption,
    teamLevelOption,
    {
      name: "position",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Target position (1-based)"
    },
    {
      name: "first",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Move to first position"
    },
    {
      name: "last",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Move to last position"
    },
    yesOption
  ],
  examples: [
    {
      name: "Move to first position",
      value: `${packageName} firewall rules reorder "My Rule" --first --yes`
    },
    {
      name: "Move to position 3",
      value: `${packageName} firewall rules reorder "My Rule" --position 3 --yes`
    }
  ]
};
var rulesSubcommand2 = {
  name: "rules",
  aliases: [],
  description: "Manage custom firewall rules that control how traffic is handled based on conditions",
  arguments: [],
  subcommands: [
    rulesListSubcommand2,
    rulesInspectSubcommand,
    rulesAddSubcommand2,
    rulesEditSubcommand2,
    rulesEnableSubcommand,
    rulesDisableSubcommand,
    rulesRemoveSubcommand2,
    rulesReorderSubcommand
  ],
  options: [],
  examples: [
    {
      name: "List rules",
      value: `${packageName} firewall rules list`
    },
    {
      name: "Inspect a rule",
      value: `${packageName} firewall rules inspect "Block bots"`
    },
    {
      name: "Create with AI",
      value: `${packageName} firewall rules add --ai "Rate limit /api to 100 requests per minute by IP"`
    },
    {
      name: "Edit with AI",
      value: `${packageName} firewall rules edit "My Rule" --ai "Change action to challenge"`
    }
  ]
};
var attackModeEnableSubcommand = {
  name: "enable",
  aliases: [],
  description: "Enable attack mode \u2014 all visitors will be shown a verification challenge before accessing your site. Takes effect immediately (no publish required)",
  arguments: [],
  options: [
    projectOption,
    {
      name: "duration",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Duration: 1h, 6h, or 24h (default: 1h)"
    },
    yesOption
  ],
  examples: [
    {
      name: "Enable attack mode for 1 hour",
      value: `${packageName} firewall attack-mode enable`
    },
    {
      name: "Enable attack mode for 24 hours",
      value: `${packageName} firewall attack-mode enable --duration 24h`
    }
  ]
};
var attackModeDisableSubcommand = {
  name: "disable",
  aliases: [],
  description: "Disable attack mode \u2014 visitors will no longer be challenged. Takes effect immediately (no publish required)",
  arguments: [],
  options: [projectOption, yesOption],
  examples: [
    {
      name: "Disable attack mode",
      value: `${packageName} firewall attack-mode disable`
    }
  ]
};
var attackModeSubcommand = {
  name: "attack-mode",
  aliases: [],
  description: "Manage attack mode, which challenges all incoming requests with a verification page",
  arguments: [],
  subcommands: [attackModeEnableSubcommand, attackModeDisableSubcommand],
  options: [],
  examples: [
    {
      name: "Enable attack mode",
      value: `${packageName} firewall attack-mode enable`
    },
    {
      name: "Disable attack mode",
      value: `${packageName} firewall attack-mode disable`
    }
  ]
};
var systemMitigationsPauseSubcommand = {
  name: "pause",
  aliases: [],
  description: "Pause automatic DDoS protection and system-level traffic filtering for 24 hours. Takes effect immediately (no publish required)",
  arguments: [],
  options: [projectOption, yesOption],
  examples: [
    {
      name: "Pause system mitigations",
      value: `${packageName} firewall system-mitigations pause`
    }
  ]
};
var systemMitigationsResumeSubcommand = {
  name: "resume",
  aliases: [],
  description: "Resume automatic DDoS protection and system-level traffic filtering. Takes effect immediately (no publish required)",
  arguments: [],
  options: [projectOption, yesOption],
  examples: [
    {
      name: "Resume system mitigations",
      value: `${packageName} firewall system-mitigations resume`
    }
  ]
};
var systemMitigationsSubcommand = {
  name: "system-mitigations",
  aliases: [],
  description: "Manage automatic DDoS protection and system-level traffic filtering",
  arguments: [],
  subcommands: [
    systemMitigationsPauseSubcommand,
    systemMitigationsResumeSubcommand
  ],
  options: [],
  examples: [
    {
      name: "Pause system mitigations",
      value: `${packageName} firewall system-mitigations pause`
    }
  ]
};
var firewallCommand = {
  name: "firewall",
  aliases: [],
  description: "Manage your project's firewall rules, IP blocks, and system bypass configuration",
  arguments: [],
  subcommands: [
    overviewSubcommand,
    diffSubcommand,
    publishSubcommand,
    discardSubcommand,
    ipBlocksSubcommand,
    rulesSubcommand2,
    systemBypassSubcommand,
    attackModeSubcommand,
    systemMitigationsSubcommand
  ],
  options: [],
  examples: [
    {
      name: "Show firewall overview",
      value: `${packageName} firewall overview`
    },
    {
      name: "Show unpublished changes",
      value: `${packageName} firewall diff`
    },
    {
      name: "Add a system bypass for an IP",
      value: `${packageName} firewall system-bypass add 10.0.0.1`
    }
  ]
};

// src/util/flags/comparators.ts
var FLAG_CONDITION_COMPARATORS = [
  "eq",
  "!eq",
  "oneOf",
  "!oneOf",
  "containsAllOf",
  "containsAnyOf",
  "containsNoneOf",
  "startsWith",
  "endsWith",
  "contains",
  "!contains",
  "ex",
  "!ex",
  "gt",
  "gte",
  "lt",
  "lte"
];
var FLAG_CONDITION_LIST_COMPARATORS = [
  "oneOf",
  "!oneOf",
  "containsAllOf",
  "containsAnyOf",
  "containsNoneOf"
];
var FLAG_CONDITION_RHS_OPTIONAL_COMPARATORS = [
  "ex",
  "!ex"
];
function formatFlagConditionComparatorList() {
  return FLAG_CONDITION_COMPARATORS.join(", ");
}
var FLAG_CONDITION_COMPARATOR_LABELS = {
  eq: "is",
  "!eq": "is not",
  oneOf: "is in",
  "!oneOf": "is not in",
  containsAllOf: "contains all of",
  containsAnyOf: "contains any of",
  containsNoneOf: "contains none of",
  startsWith: "starts with",
  endsWith: "ends with",
  contains: "contains",
  "!contains": "does not contain",
  ex: "has any value",
  "!ex": "has no value",
  gt: "is greater than",
  gte: "is greater than or equal to",
  lt: "is less than",
  lte: "is less than or equal to"
};
var LEGACY_FLAG_CONDITION_COMPARATOR_LABELS = {
  notContains: FLAG_CONDITION_COMPARATOR_LABELS["!contains"]
};
function formatFlagConditionComparator(comparator, options) {
  const label = FLAG_CONDITION_COMPARATOR_LABELS[comparator] ?? LEGACY_FLAG_CONDITION_COMPARATOR_LABELS[comparator] ?? comparator;
  if (options?.ignoreCase) {
    return `${label} (case-insensitive)`;
  }
  return label;
}

// src/commands/flags/evaluations-config.ts
var FLAG_EVALUATIONS_GRANULARITIES = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];
function isFlagEvaluationsGranularity(value) {
  return FLAG_EVALUATIONS_GRANULARITIES.some(
    (granularity) => granularity === value
  );
}

// src/commands/flags/command.ts
var segmentRuleOperatorDescription = `Valid operators: ${formatFlagConditionComparatorList()}`;
var listSubcommand11 = {
  name: "list",
  aliases: ["ls"],
  description: "List all feature flags for the current project",
  default: true,
  arguments: [],
  options: [
    projectOption,
    {
      name: "state",
      shorthand: "s",
      type: String,
      deprecated: false,
      description: "Filter flags by state (active or archived)",
      argument: "STATE"
    },
    {
      name: "tag",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Filter flags by tag (repeatable; all must match)",
      argument: "TAG"
    },
    {
      name: "created-by",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Filter flags by the id of the user or team that created them",
      argument: "ID"
    },
    {
      name: "maintainer-id",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Filter flags by maintainer user id (repeatable; any may match)",
      argument: "ID"
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Return a single page of at most NUMBER flags (1-100) instead of all",
      argument: "NUMBER"
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Pagination cursor from a previous list response",
      argument: "CURSOR"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "List all active flags",
      value: `${packageName} flags ls`
    },
    {
      name: "List archived flags",
      value: `${packageName} flags ls --state archived`
    },
    {
      name: "Filter flags by tag, creator, and maintainer",
      value: `${packageName} flags ls --tag checkout --created-by user_123 --maintainer-id user_456`
    },
    {
      name: "List the first page of 10 flags",
      value: `${packageName} flags ls --limit 10`
    },
    {
      name: "List the next page using the cursor from the previous page",
      value: `${packageName} flags ls --limit 10 --next <cursor>`
    },
    {
      name: "List flags as JSON",
      value: `${packageName} flags ls --json`
    }
  ]
};
var inspectSubcommand5 = {
  name: "inspect",
  aliases: [],
  description: "Display information about a feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [projectOption],
  examples: [
    {
      name: "Show details of a feature flag",
      value: `${packageName} flags inspect my-feature-flag`
    }
  ]
};
var versionsListSubcommand = {
  name: "list",
  aliases: ["ls"],
  default: true,
  description: "List version history for a feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "Filter versions by changed environment",
      argument: "ENV"
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Return at most NUMBER versions (1-100)",
      argument: "NUMBER"
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Continue from a previous response",
      argument: "CURSOR"
    },
    {
      name: "cursor",
      shorthand: null,
      type: String,
      deprecated: true,
      description: "Pagination cursor from a previous versions response",
      argument: "CURSOR"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "List version history for a feature flag",
      value: `${packageName} flags versions my-feature-flag`
    },
    {
      name: "List version history using the explicit list subcommand",
      value: `${packageName} flags versions list my-feature-flag`
    },
    {
      name: "List production version history",
      value: `${packageName} flags versions my-feature-flag --environment production`
    },
    {
      name: "List the next page of version history",
      value: `${packageName} flags versions my-feature-flag --limit 10 --next <cursor>`
    },
    {
      name: "List version history as JSON",
      value: `${packageName} flags versions my-feature-flag --json`
    }
  ]
};
var versionsDiffSubcommand = {
  name: "diff",
  aliases: [],
  description: "Show changes introduced by a feature flag version",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "revision",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Revision number to compare with the previous revision",
      argument: "NUMBER"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output the diff in JSON format"
    }
  ],
  examples: [
    {
      name: "Show what changed in a revision",
      value: `${packageName} flags versions diff my-feature-flag --revision 4`
    },
    {
      name: "Show the revision diff as JSON",
      value: `${packageName} flags versions diff my-feature-flag --revision 4 --json`
    }
  ]
};
var versionsSubcommand = {
  name: "versions",
  aliases: [],
  description: "List and compare version history for a feature flag",
  arguments: [],
  subcommands: [versionsListSubcommand, versionsDiffSubcommand],
  options: [],
  examples: [
    {
      name: "List version history for a feature flag",
      value: `${packageName} flags versions my-feature-flag`
    },
    {
      name: "Show what changed in a revision",
      value: `${packageName} flags versions diff my-feature-flag --revision 4`
    }
  ]
};
var evaluationsSubcommand = {
  name: "evaluations",
  aliases: [],
  description: "Display evaluation metrics for a feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "since",
      shorthand: "s",
      type: String,
      deprecated: false,
      description: "Start time: relative (1h, 30m, 2d) or ISO date (default: 1h)",
      argument: "TIME"
    },
    {
      name: "until",
      shorthand: "u",
      type: String,
      deprecated: false,
      description: "End time (default: now)",
      argument: "TIME"
    },
    {
      name: "granularity",
      shorthand: "g",
      type: String,
      deprecated: false,
      description: `Time bucket size: ${FLAG_EVALUATIONS_GRANULARITIES.join(", ")} (default: auto)`,
      argument: "SIZE"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "Show evaluations by variant for the last hour",
      value: `${packageName} flags evaluations my-feature`
    },
    {
      name: "Show evaluation metrics as JSON",
      value: `${packageName} flags evaluations my-feature --since 24h --json`
    }
  ]
};
var createSubcommand4 = {
  name: "create",
  aliases: ["add"],
  description: "Create a new feature flag",
  arguments: [
    {
      name: "slug",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "kind",
      shorthand: "k",
      type: String,
      deprecated: false,
      description: "The type of the flag value (boolean, string, number, or json)",
      argument: "KIND"
    },
    {
      name: "description",
      shorthand: "d",
      type: String,
      deprecated: false,
      description: "Description of the feature flag",
      argument: "TEXT"
    },
    {
      name: "variant",
      shorthand: "v",
      type: [String],
      deprecated: false,
      description: "Variant definition as VALUE[=LABEL] (can be repeated for string, number, and json flags)",
      argument: "VALUE[=LABEL]"
    }
  ],
  examples: [
    {
      name: "Create a boolean feature flag",
      value: `${packageName} flags create my-feature`
    },
    {
      name: "Create a string feature flag with description",
      value: `${packageName} flags create my-feature --kind string --description "My feature flag"`
    },
    {
      name: "Create a string feature flag with explicit variants",
      value: `${packageName} flags add my-feature --kind string --variant control="Welcome back" --variant treatment="New onboarding"`
    },
    {
      name: "Create a JSON feature flag with explicit variants",
      value: `${packageName} flags add layout-config --kind json --variant '{"theme":"light"}'=Light --variant '{"theme":"dark","sidebar":true}'=Dark`
    }
  ]
};
var openSubcommand2 = {
  name: "open",
  aliases: [],
  description: "Open feature flags in the Vercel dashboard",
  arguments: [
    {
      name: "flag",
      required: false
    }
  ],
  options: [projectOption],
  examples: [
    {
      name: "Open the project feature flags dashboard",
      value: `${packageName} flags open`
    },
    {
      name: "Open a specific feature flag",
      value: `${packageName} flags open my-feature-flag`
    }
  ]
};
var updateSubcommand3 = {
  name: "update",
  aliases: [],
  description: "Update an existing feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "variant",
      shorthand: "v",
      type: String,
      deprecated: false,
      description: "Variant ID or value to update",
      argument: "VARIANT"
    },
    {
      name: "value",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "New variant value",
      argument: "VALUE"
    },
    {
      name: "label",
      shorthand: "l",
      type: String,
      deprecated: false,
      description: "New variant label",
      argument: "LABEL"
    },
    {
      name: "add-variant",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Add a variant as VALUE[=LABEL] (repeatable for string, number, and json flags)",
      argument: "VALUE[=LABEL]"
    },
    {
      name: "remove-variant",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Remove a variant by ID or value (repeatable)",
      argument: "VARIANT"
    },
    {
      name: "message",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Optional revision message for the update",
      argument: "TEXT"
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing a variant"
    }
  ],
  examples: [
    {
      name: "Update a string variant value and label",
      value: `${packageName} flags update my-feature --variant control --value welcome-back --label "Welcome back"`
    },
    {
      name: "Update a variant with a revision message",
      value: `${packageName} flags update my-feature --variant control --label "Control" --message "Rename control variant"`
    },
    {
      name: "Rename a boolean variant label",
      value: `${packageName} flags update my-feature --variant false --label "Disabled"`
    },
    {
      name: "Add a new variant",
      value: `${packageName} flags update my-feature --add-variant treatment="New onboarding"`
    },
    {
      name: "Remove variants by value or ID",
      value: `${packageName} flags update my-feature --remove-variant control --remove-variant var_123 --yes`
    }
  ]
};
var setSubcommand2 = {
  name: "set",
  aliases: [],
  description: "Set the served variant for a feature flag in an environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to set the variant in (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "variant",
      shorthand: "v",
      type: String,
      deprecated: false,
      description: "The variant ID or value to serve",
      argument: "VARIANT"
    },
    {
      name: "message",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Optional revision message for the update",
      argument: "TEXT"
    }
  ],
  examples: [
    {
      name: "Set a string variant in production",
      value: `${packageName} flags set welcome-message --environment production --variant control`
    },
    {
      name: "Set a number variant in preview",
      value: `${packageName} flags set bucket-size -e preview --variant 20`
    },
    {
      name: "Set a boolean flag to true in development",
      value: `${packageName} flags set my-feature -e development --variant true`
    }
  ]
};
var splitSubcommand = {
  name: "split",
  aliases: [],
  description: "Configure a weighted split for a feature flag in an environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to configure (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "by",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Entity attribute used for bucketing, in the form entity.attribute",
      argument: "ENTITY.ATTRIBUTE"
    },
    {
      name: "weight",
      shorthand: "w",
      type: [String],
      deprecated: false,
      description: "Variant weight ratio as VARIANT=WEIGHT. Repeat for each variant; values are normalized and 0 receives no traffic.",
      argument: "VARIANT=WEIGHT"
    },
    {
      name: "default-variant",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "The fallback variant to serve when the split attribute is unavailable",
      argument: "VARIANT"
    },
    {
      name: "message",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Optional revision message for the update",
      argument: "TEXT"
    }
  ],
  examples: [
    {
      name: "Split a boolean flag in production",
      value: `${packageName} flags split redesigned-checkout --environment production --by user.userId --weight off=95 --weight on=5`
    },
    {
      name: "Split a string flag with a fallback variant",
      value: `${packageName} flags split welcome-message -e production --by user.userId --default-variant control --weight control=90 --weight treatment=10`
    },
    {
      name: "Exclude a variant from the split",
      value: `${packageName} flags split checkout-copy -e preview --by user.userId --default-variant control --weight control=50 --weight treatment=50 --weight legacy=0`
    }
  ]
};
var rolloutSubcommand = {
  name: "rollout",
  aliases: [],
  description: "Configure a progressive rollout for a feature flag in an environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to configure (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "from-variant",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "The variant to roll away from (defaults to false for boolean flags)",
      argument: "VARIANT"
    },
    {
      name: "to-variant",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "The variant to roll towards (defaults to true for boolean flags)",
      argument: "VARIANT"
    },
    {
      name: "default-variant",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "The fallback variant to serve when the rollout attribute is unavailable",
      argument: "VARIANT"
    },
    {
      name: "by",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Entity attribute used for bucketing, in the form entity.attribute",
      argument: "ENTITY.ATTRIBUTE"
    },
    {
      name: "stage",
      shorthand: "s",
      type: [String],
      deprecated: false,
      description: 'Add a rollout stage as PERCENTAGE,DURATION (e.g. "5,6h"). Can be specified multiple times. 100% is implied at the end.',
      argument: "PERCENTAGE,DURATION"
    },
    {
      name: "start",
      shorthand: null,
      type: String,
      deprecated: false,
      description: 'When the rollout should start: "now", a future relative time like "1h", or an ISO 8601 datetime',
      argument: "TIME"
    },
    {
      name: "message",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Optional revision message for the update",
      argument: "TEXT"
    }
  ],
  examples: [
    {
      name: "Start a progressive boolean rollout in production",
      value: `${packageName} flags rollout redesigned-checkout --environment production --by user.userId --stage 5,6h --stage 10,6h --stage 25,12h --stage 50,1d`
    },
    {
      name: "Schedule a string-flag rollout for later",
      value: `${packageName} flags rollout welcome-message -e production --by user.userId --from-variant control --to-variant treatment --default-variant control --stage 10,2h --stage 50,12h --start 2026-04-16T09:00:00Z`
    },
    {
      name: "Update only the rollout schedule while keeping current variants",
      value: `${packageName} flags rollout redesigned-checkout -e production --stage 5,30m --stage 25,2h --stage 50,8h`
    }
  ]
};
var ruleConditionDescription = `Rule condition as ENTITY.ATTRIBUTE:OPERATOR:VALUE or segment:OPERATOR:SEGMENT. Repeatable; semicolon-separated conditions are also supported. ${segmentRuleOperatorDescription}`;
var ruleOutcomeOptions = [
  {
    name: "variant",
    shorthand: "v",
    type: String,
    deprecated: false,
    description: "Variant ID or value to serve when the rule matches",
    argument: "VARIANT"
  },
  {
    name: "by",
    shorthand: null,
    type: String,
    deprecated: false,
    description: "Entity attribute used for split or rollout bucketing, in the form entity.attribute",
    argument: "ENTITY.ATTRIBUTE"
  },
  {
    name: "weight",
    shorthand: "w",
    type: [String],
    deprecated: false,
    description: "Split weight ratio as VARIANT=WEIGHT. Repeat for each variant.",
    argument: "VARIANT=WEIGHT"
  },
  {
    name: "default-variant",
    shorthand: null,
    type: String,
    deprecated: false,
    description: "Fallback variant for split or rollout outcomes when the bucketing attribute is unavailable",
    argument: "VARIANT"
  },
  {
    name: "from-variant",
    shorthand: null,
    type: String,
    deprecated: false,
    description: "Variant to roll away from for rollout outcomes",
    argument: "VARIANT"
  },
  {
    name: "to-variant",
    shorthand: null,
    type: String,
    deprecated: false,
    description: "Variant to roll towards for rollout outcomes",
    argument: "VARIANT"
  },
  {
    name: "stage",
    shorthand: "s",
    type: [String],
    deprecated: false,
    description: "Add a rollout stage as PERCENTAGE,DURATION. Can be specified multiple times.",
    argument: "PERCENTAGE,DURATION"
  },
  {
    name: "start",
    shorthand: null,
    type: String,
    deprecated: false,
    description: 'When the rollout should start: "now", a relative time like "1h", or an ISO 8601 datetime',
    argument: "TIME"
  }
];
var ruleMessageOption = {
  name: "message",
  shorthand: null,
  type: String,
  deprecated: false,
  description: "Optional revision message for the update",
  argument: "TEXT"
};
var rulesListSubcommand3 = {
  name: "list",
  aliases: ["ls"],
  description: "List conditional rules for a feature flag environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to list rules for (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "List production rules for a flag",
      value: `${packageName} flags rules ls my-feature --environment production`
    },
    {
      name: "List rules as JSON",
      value: `${packageName} flags rules ls my-feature -e production --json`
    }
  ]
};
var rulesAddSubcommand3 = {
  name: "add",
  aliases: [],
  description: "Add a conditional rule to a feature flag environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to add the rule to (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "condition",
      shorthand: "c",
      type: [String],
      deprecated: false,
      description: ruleConditionDescription,
      argument: "CONDITION"
    },
    ...ruleOutcomeOptions,
    {
      name: "position",
      shorthand: "p",
      type: Number,
      deprecated: false,
      description: "1-based position for the new rule (defaults to last)",
      argument: "N"
    },
    ruleMessageOption
  ],
  examples: [
    {
      name: "Add a variant rule",
      value: `${packageName} flags rules add my-feature --environment production --condition user.plan:eq:pro --variant on`
    },
    {
      name: "Add a segment rule",
      value: `${packageName} flags rules add my-feature -e production --condition segment:eq:seg_beta123 --variant on`
    },
    {
      name: "Add a split rule at the top",
      value: `${packageName} flags rules add my-feature -e production --condition user.plan:eq:pro --by user.userId --weight off=90 --weight on=10 --position 1`
    }
  ]
};
var rulesUpdateSubcommand = {
  name: "update",
  aliases: [],
  description: "Update a conditional rule in a feature flag environment",
  arguments: [
    {
      name: "flag",
      required: true
    },
    {
      name: "rule",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment containing the rule (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "condition",
      shorthand: "c",
      type: [String],
      deprecated: false,
      description: "Replace rule conditions. " + ruleConditionDescription,
      argument: "CONDITION"
    },
    ...ruleOutcomeOptions,
    ruleMessageOption
  ],
  examples: [
    {
      name: "Replace rule conditions",
      value: `${packageName} flags rules update my-feature rule_123 --environment production --condition user.plan:eq:enterprise`
    },
    {
      name: "Update a rule outcome",
      value: `${packageName} flags rules update my-feature rule_123 -e production --variant off`
    }
  ]
};
var rulesRemoveSubcommand3 = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove a conditional rule from a feature flag environment",
  arguments: [
    {
      name: "flag",
      required: true
    },
    {
      name: "rule",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment containing the rule (production, preview, or development)",
      argument: "ENV"
    },
    ruleMessageOption
  ],
  examples: [
    {
      name: "Remove a rule",
      value: `${packageName} flags rules rm my-feature rule_123 --environment production`
    }
  ]
};
var rulesMoveSubcommand = {
  name: "move",
  aliases: [],
  description: "Move a conditional rule within a feature flag environment",
  arguments: [
    {
      name: "flag",
      required: true
    },
    {
      name: "rule",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment containing the rule (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "position",
      shorthand: "p",
      type: Number,
      deprecated: false,
      description: "1-based destination position for the rule",
      argument: "N"
    },
    ruleMessageOption
  ],
  examples: [
    {
      name: "Move a rule to the top",
      value: `${packageName} flags rules move my-feature rule_123 --environment production --position 1`
    }
  ]
};
var rulesSubcommand3 = {
  name: "rules",
  aliases: [],
  description: "Manage conditional rules for feature flags",
  arguments: [],
  subcommands: [
    rulesListSubcommand3,
    rulesAddSubcommand3,
    rulesUpdateSubcommand,
    rulesRemoveSubcommand3,
    rulesMoveSubcommand
  ],
  options: [],
  examples: []
};
var removeSubcommand8 = {
  name: "remove",
  aliases: ["rm"],
  description: "Delete a feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when deleting a flag"
    }
  ],
  examples: [
    {
      name: "Delete a feature flag",
      value: `${packageName} flags rm my-feature-flag`
    },
    {
      name: "Delete without confirmation",
      value: `${packageName} flags rm my-feature-flag --yes`
    }
  ]
};
var archiveSubcommand = {
  name: "archive",
  aliases: [],
  description: "Archive a feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when archiving a flag"
    }
  ],
  examples: [
    {
      name: "Archive a feature flag",
      value: `${packageName} flags archive my-feature-flag`
    },
    {
      name: "Archive without confirmation",
      value: `${packageName} flags archive my-feature-flag --yes`
    }
  ]
};
var unarchiveSubcommand = {
  name: "unarchive",
  aliases: [],
  description: "Unarchive a feature flag",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when unarchiving a flag"
    }
  ],
  examples: [
    {
      name: "Unarchive a feature flag",
      value: `${packageName} flags unarchive my-feature-flag`
    },
    {
      name: "Unarchive without confirmation",
      value: `${packageName} flags unarchive my-feature-flag --yes`
    }
  ]
};
var disableSubcommand = {
  name: "disable",
  aliases: [],
  description: "Shortcut to serve the false variant of a boolean feature flag in an environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to disable the flag in (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "variant",
      shorthand: "v",
      type: String,
      deprecated: false,
      description: "The variant ID or value to serve while the flag is disabled",
      argument: "VARIANT"
    },
    {
      name: "message",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Optional revision message for the update",
      argument: "TEXT"
    }
  ],
  examples: [
    {
      name: "Disable a flag in production",
      value: `${packageName} flags disable my-feature --environment production`
    },
    {
      name: "Disable a flag with a specific variant",
      value: `${packageName} flags disable my-feature -e production --variant false`
    },
    {
      name: "Disable a flag with a revision message",
      value: `${packageName} flags disable my-feature -e production --message "Pause rollout in production"`
    }
  ]
};
var enableSubcommand = {
  name: "enable",
  aliases: [],
  description: "Shortcut to serve the true variant of a boolean feature flag in an environment",
  arguments: [
    {
      name: "flag",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment to enable the flag in (production, preview, or development)",
      argument: "ENV"
    },
    {
      name: "message",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Optional revision message for the update",
      argument: "TEXT"
    }
  ],
  examples: [
    {
      name: "Enable a flag in production",
      value: `${packageName} flags enable my-feature --environment production`
    },
    {
      name: "Enable a flag with a revision message",
      value: `${packageName} flags enable my-feature --environment production --message "Resume production rollout"`
    }
  ]
};
var segmentsListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List all feature flag segments for the current project",
  arguments: [],
  options: [
    projectOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "List all segments",
      value: `${packageName} flags segments ls`
    },
    {
      name: "List segments as JSON",
      value: `${packageName} flags segments ls --json`
    }
  ]
};
var segmentsInspectSubcommand = {
  name: "inspect",
  aliases: [],
  description: "Display information about a feature flag segment",
  arguments: [
    {
      name: "segment",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "Show details of a segment",
      value: `${packageName} flags segments inspect beta-users`
    },
    {
      name: "Show segment data as JSON",
      value: `${packageName} flags segments inspect beta-users --json`
    }
  ]
};
var segmentsCreateSubcommand = {
  name: "create",
  aliases: ["add"],
  description: "Create a feature flag segment",
  arguments: [
    {
      name: "slug",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "label",
      shorthand: "l",
      type: String,
      deprecated: false,
      description: "Human-readable label for the segment",
      argument: "LABEL"
    },
    {
      name: "description",
      shorthand: "d",
      type: String,
      deprecated: false,
      description: "Description of the segment",
      argument: "TEXT"
    },
    {
      name: "hint",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Hint describing who belongs in the segment",
      argument: "TEXT"
    },
    {
      name: "data",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Full segment data JSON with rules, include, and exclude fields",
      argument: "JSON"
    },
    {
      name: "add",
      shorthand: "a",
      type: [String],
      deprecated: false,
      description: `Add include:ENTITY.ATTRIBUTE=VALUE, exclude:ENTITY.ATTRIBUTE=VALUE, or rule:ENTITY.ATTRIBUTE:OPERATOR:VALUE; repeatable. ${segmentRuleOperatorDescription}`,
      argument: "TARGET"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output the created segment as JSON"
    }
  ],
  examples: [
    {
      name: "Create a segment with included users",
      value: `${packageName} flags segments create beta-users --label "Beta users" --add include:user.id=user_123 --add include:user.id=user_456`
    },
    {
      name: "Create a segment from rules",
      value: `${packageName} flags segments create enterprise-users --label "Enterprise users" --add rule:user.plan:eq:enterprise`
    },
    {
      name: "Create a segment from full JSON data",
      value: `${packageName} flags segments create staff --label Staff --data '{"rules":[],"include":{"user":{"email":[{"value":"me@company.com"}]}},"exclude":{}}'`
    }
  ]
};
var segmentsUpdateSubcommand = {
  name: "update",
  aliases: [],
  description: "Update a feature flag segment",
  arguments: [
    {
      name: "segment",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      name: "label",
      shorthand: "l",
      type: String,
      deprecated: false,
      description: "New human-readable label for the segment",
      argument: "LABEL"
    },
    {
      name: "description",
      shorthand: "d",
      type: String,
      deprecated: false,
      description: "New description for the segment",
      argument: "TEXT"
    },
    {
      name: "hint",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "New hint for the segment",
      argument: "TEXT"
    },
    {
      name: "data",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Replace the full segment data JSON with rules, include, and exclude fields",
      argument: "JSON"
    },
    {
      name: "add",
      shorthand: "a",
      type: [String],
      deprecated: false,
      description: `Add include:ENTITY.ATTRIBUTE=VALUE, exclude:ENTITY.ATTRIBUTE=VALUE, or rule:ENTITY.ATTRIBUTE:OPERATOR:VALUE; repeatable. ${segmentRuleOperatorDescription}`,
      argument: "TARGET"
    },
    {
      name: "remove",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: `Remove include:ENTITY.ATTRIBUTE=VALUE, exclude:ENTITY.ATTRIBUTE=VALUE, rule:ENTITY.ATTRIBUTE:OPERATOR:VALUE, or rule:RULE_ID; repeatable. ${segmentRuleOperatorDescription}`,
      argument: "TARGET"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output the updated segment as JSON"
    }
  ],
  examples: [
    {
      name: "Rename a segment",
      value: `${packageName} flags segments update beta-users --label "Early access users"`
    },
    {
      name: "Add and remove included users",
      value: `${packageName} flags segments update beta-users --add include:user.id=user_789 --remove include:user.id=user_123`
    },
    {
      name: "Add and remove rules",
      value: `${packageName} flags segments update enterprise-users --add rule:user.email:ends-with:@company.com --remove rule:user.plan:eq:pro`
    }
  ]
};
var segmentsRemoveSubcommand = {
  name: "remove",
  aliases: ["rm"],
  description: "Delete a feature flag segment",
  arguments: [
    {
      name: "segment",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when deleting a segment"
    }
  ],
  examples: [
    {
      name: "Delete a segment",
      value: `${packageName} flags segments rm beta-users`
    },
    {
      name: "Delete without confirmation",
      value: `${packageName} flags segments rm beta-users --yes`
    }
  ]
};
var segmentsSubcommand = {
  name: "segments",
  aliases: [],
  description: "Manage feature flag segments",
  arguments: [],
  subcommands: [
    segmentsListSubcommand,
    segmentsInspectSubcommand,
    segmentsCreateSubcommand,
    segmentsUpdateSubcommand,
    segmentsRemoveSubcommand
  ],
  options: [],
  examples: []
};
var sdkKeysListSubcommand = {
  name: "list",
  aliases: ["ls"],
  description: "List all SDK keys for the current project",
  arguments: [],
  options: [
    projectOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output in JSON format"
    }
  ],
  examples: [
    {
      name: "List all SDK keys",
      value: `${packageName} flags sdk-keys ls`
    },
    {
      name: "List SDK keys as JSON",
      value: `${packageName} flags sdk-keys ls --json`
    }
  ]
};
var sdkKeysAddSubcommand = {
  name: "add",
  aliases: [],
  description: "Create a new SDK key",
  arguments: [],
  options: [
    projectOption,
    {
      name: "type",
      // No shorthand: `-t` is already used globally for `--token`
      shorthand: null,
      type: String,
      deprecated: false,
      description: "The type of SDK key (server, client, or mobile)",
      argument: "TYPE"
    },
    {
      name: "environment",
      shorthand: "e",
      type: String,
      deprecated: false,
      description: "The environment for the SDK key",
      argument: "ENV"
    },
    {
      name: "label",
      shorthand: "l",
      type: String,
      deprecated: false,
      description: "Optional label for the SDK key",
      argument: "LABEL"
    }
  ],
  examples: [
    {
      name: "Create a server SDK key for production",
      value: `${packageName} flags sdk-keys add --type server --environment production`
    },
    {
      name: "Create a client SDK key with a label",
      value: `${packageName} flags sdk-keys add --type client -e preview --label "Preview App"`
    }
  ]
};
var sdkKeysRemoveSubcommand = {
  name: "remove",
  aliases: ["rm"],
  description: "Delete an SDK key",
  arguments: [
    {
      name: "key",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when deleting an SDK key"
    }
  ],
  examples: [
    {
      name: "Delete an SDK key",
      value: `${packageName} flags sdk-keys rm <hash-key>`
    }
  ]
};
var sdkKeysSubcommand = {
  name: "sdk-keys",
  aliases: [],
  description: "Manage SDK keys for feature flags",
  arguments: [],
  subcommands: [
    sdkKeysListSubcommand,
    sdkKeysAddSubcommand,
    sdkKeysRemoveSubcommand
  ],
  options: [],
  examples: []
};
var prepareSubcommand = {
  name: "prepare",
  aliases: [],
  description: "Prepare flag definition fallbacks for the build",
  arguments: [],
  options: [],
  examples: []
};
var overrideSubcommand = {
  name: "override",
  aliases: [],
  description: "Encrypt flag overrides into a secure token for the vercel-flag-overrides cookie",
  arguments: [
    {
      name: "flag=value",
      required: false
    }
  ],
  options: [
    {
      name: "expiration",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Expiration time for the encrypted token (default: 1y)",
      argument: "TIME"
    },
    {
      name: "decrypt",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Decrypt an encrypted override token and print the JSON",
      argument: "TOKEN"
    }
  ],
  examples: [
    {
      name: "Encrypt a single flag override",
      value: `${packageName} flags override my-flag=true`
    },
    {
      name: "Encrypt multiple flag overrides",
      value: `${packageName} flags override flag-a=true flag-b=hello`
    },
    {
      name: "Set a custom expiration",
      value: `${packageName} flags override my-flag=42 --expiration 30d`
    },
    {
      name: "Decrypt an override token",
      value: `${packageName} flags override --decrypt <token>`
    }
  ]
};
var flagsCommand = {
  name: "flags",
  aliases: [],
  description: "Manage feature flags for a Vercel project",
  arguments: [],
  subcommands: [
    listSubcommand11,
    inspectSubcommand5,
    versionsSubcommand,
    evaluationsSubcommand,
    createSubcommand4,
    openSubcommand2,
    updateSubcommand3,
    setSubcommand2,
    splitSubcommand,
    rolloutSubcommand,
    removeSubcommand8,
    archiveSubcommand,
    unarchiveSubcommand,
    disableSubcommand,
    enableSubcommand,
    rulesSubcommand3,
    segmentsSubcommand,
    sdkKeysSubcommand,
    prepareSubcommand,
    overrideSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/git/command.ts
var connectSubcommand = {
  name: "connect",
  aliases: [],
  description: "Connect your Vercel Project to your Git repository or provide the remote URL to your Git repository",
  arguments: [
    {
      name: "git-url",
      required: false
    }
  ],
  options: [projectOption, yesOption, confirmOption],
  examples: [
    {
      name: "Connect your Vercel Project to your Git repository defined in your local `.git` config",
      value: `${packageName} git connect`
    },
    {
      name: "Connect your Vercel Project to a Git repository using the remote URL",
      value: `${packageName} git connect https://github.com/user/repo.git`
    }
  ]
};
var disconnectSubcommand = {
  name: "disconnect",
  aliases: [],
  description: "Disconnect the Git repository from your Vercel Project",
  arguments: [],
  options: [projectOption, yesOption, confirmOption],
  examples: [
    {
      name: "Disconnect the Git repository",
      value: `${packageName} git disconnect`
    }
  ]
};
var gitCommand = {
  name: "git",
  aliases: [],
  description: "Manage your Git repository connection to the current Project",
  arguments: [],
  subcommands: [connectSubcommand, disconnectSubcommand],
  options: [],
  examples: []
};

// src/commands/global-config/command.ts
var listSubcommand12 = {
  name: "list",
  aliases: ["ls"],
  description: "List Global Config stores for the current team",
  default: true,
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List Global Configs as JSON",
      value: `${packageName} global-config list --json`
    }
  ]
};
var addSubcommand6 = {
  name: "add",
  aliases: ["create"],
  description: "Create a Global Config store",
  arguments: [
    {
      name: "slug",
      required: true
    }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      name: "items",
      shorthand: null,
      type: String,
      argument: "JSON",
      deprecated: false,
      description: 'Optional JSON object of initial items `{ "key": <value>, ... }`'
    }
  ],
  examples: [
    {
      name: "Create a store with slug `flags`",
      value: `${packageName} global-config add flags`
    }
  ]
};
var getSubcommand = {
  name: "get",
  aliases: ["inspect"],
  description: "Show metadata for a Global Config (id `ecfg_\u2026` or slug)",
  arguments: [
    {
      name: "id-or-slug",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: []
};
var updateSubcommand4 = {
  name: "update",
  aliases: [],
  description: "Rename a Global Config (`--slug`) and/or patch items (`--patch` JSON)",
  arguments: [
    {
      name: "id-or-slug",
      required: true
    }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      name: "slug",
      shorthand: null,
      type: String,
      argument: "SLUG",
      deprecated: false,
      description: "New slug for the Global Config"
    },
    {
      name: "patch",
      shorthand: null,
      type: String,
      argument: "JSON",
      deprecated: false,
      description: 'JSON for `PATCH /v1/global-config/:id/items`: `{"items":[...]}` or a bare array. Each item needs `operation` (create | update | upsert | delete), `key`, and usually `value` (see REST API: update-edge-config-items-in-batch)'
    }
  ],
  examples: []
};
var removeSubcommand9 = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Delete a Global Config store",
  arguments: [
    {
      name: "id-or-slug",
      required: true
    }
  ],
  options: [yesOption, formatOption, jsonOption],
  examples: []
};
var itemsSubcommand = {
  name: "items",
  aliases: [],
  description: "List items in a Global Config, or fetch one item with `--key`",
  arguments: [
    {
      name: "id-or-slug",
      required: true
    }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      name: "key",
      shorthand: "k",
      type: String,
      argument: "KEY",
      deprecated: false,
      description: "When set, fetch a single item by key"
    }
  ],
  examples: []
};
var tokensSubcommand = {
  name: "tokens",
  aliases: [],
  description: "List, create (`--add`), or revoke (`--remove`) read tokens for a Global Config",
  arguments: [
    {
      name: "id-or-slug",
      required: true
    }
  ],
  options: [
    formatOption,
    jsonOption,
    yesOption,
    {
      name: "add",
      shorthand: null,
      type: String,
      argument: "LABEL",
      deprecated: false,
      description: "Create a token with this label (1\u201352 characters)"
    },
    {
      name: "remove",
      shorthand: null,
      type: [String],
      argument: "ID_OR_TOKEN",
      deprecated: false,
      description: "Revoke one or more tokens by id or plaintext token (repeatable). Requires `--yes` in non-interactive mode"
    }
  ],
  examples: []
};
var backupsSubcommand = {
  name: "backups",
  aliases: [],
  description: "List, inspect, or restore Global Config backups",
  arguments: [
    {
      name: "id-or-slug",
      required: true
    }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when restoring"
    },
    {
      name: "backup-version",
      shorthand: null,
      type: String,
      argument: "VERSION_ID",
      deprecated: false,
      description: "Fetch a single backup by version id"
    },
    {
      name: "restore",
      shorthand: null,
      type: String,
      argument: "VERSION_ID",
      deprecated: false,
      description: "Restore items from the backup version id. Requires confirmation because it updates live Global Config items"
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      deprecated: false,
      description: "Maximum number of backups to list (0-50)"
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      argument: "CURSOR",
      deprecated: false,
      description: "Pagination cursor from a previous backup list response"
    }
  ],
  examples: [
    {
      name: "List backups for a Global Config",
      value: `${packageName} global-config backups my-store`
    },
    {
      name: "Inspect a backup as JSON",
      value: `${packageName} global-config backups my-store --backup-version <version-id> --json`
    },
    {
      name: "Restore a backup",
      value: `${packageName} global-config backups my-store --restore <version-id> --yes`
    }
  ]
};
var globalConfigCommand = {
  name: "global-config",
  aliases: ["edge-config"],
  description: "Manage Global Config stores (dashboard API parity)",
  arguments: [],
  subcommands: [
    listSubcommand12,
    addSubcommand6,
    getSubcommand,
    updateSubcommand4,
    removeSubcommand9,
    itemsSubcommand,
    tokensSubcommand,
    backupsSubcommand
  ],
  options: [],
  examples: [
    {
      name: "List stores",
      value: `${packageName} global-config list`
    }
  ]
};

// src/commands/guidance/command.ts
var statusSubcommand = {
  name: "status",
  aliases: [],
  description: "Shows whether guidance messages are enabled or disabled",
  arguments: [],
  options: [],
  examples: []
};
var enableSubcommand2 = {
  name: "enable",
  aliases: [],
  description: "Enables guidance messages",
  arguments: [],
  options: [],
  examples: []
};
var disableSubcommand2 = {
  name: "disable",
  aliases: [],
  description: "Disables guidance messages",
  arguments: [],
  options: [],
  examples: []
};
var guidanceCommand = {
  name: "guidance",
  aliases: [],
  description: "Allows you to enable or disable guidance messages",
  arguments: [],
  subcommands: [enableSubcommand2, disableSubcommand2, statusSubcommand],
  options: [],
  examples: []
};

// src/commands/httpstat/command.ts
var httpstatCommand = {
  name: "httpstat",
  aliases: [],
  description: "Execute httpstat with automatic deployment URL and protection bypass to visualize HTTP timing statistics.",
  arguments: [
    {
      name: "path",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip confirmation when linking is required (e.g. in non-interactive mode)"
    },
    {
      name: "deployment",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "The deployment ID or URL to target",
      argument: "ID|URL"
    },
    {
      name: "protection-bypass",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Protection bypass secret for accessing protected deployments",
      argument: "SECRET"
    }
  ],
  examples: [
    {
      name: "Visualize timing for a GET request to an API endpoint",
      value: `${packageName} httpstat /api/hello`
    },
    {
      name: "Make a POST request with data and see timing details",
      value: `${packageName} httpstat /api/users -- -X POST -d '{"name": "John"}'`
    },
    {
      name: "Target a specific deployment by ID",
      value: `${packageName} httpstat /api/status --deployment ERiL45NJvP8ghWxgbvCM447bmxwV`
    },
    {
      name: "Use curl flags after the separator",
      value: `${packageName} httpstat /api/test -- -H "Content-Type: application/json" -X PUT`
    },
    {
      name: "Use with protection bypass secret",
      value: `${packageName} httpstat /api/protected --protection-bypass <secret>`
    }
  ]
};

// src/commands/init/command.ts
var initCommand = {
  name: "init",
  aliases: [],
  description: "Initialize example Vercel Projects",
  arguments: [
    {
      name: "example",
      required: false
    },
    {
      name: "dir",
      required: false
    }
  ],
  options: [
    {
      ...forceOption,
      description: "Overwrite destination directory if exists [off]",
      argument: void 0
    }
  ],
  examples: [
    {
      name: "Choose from all available examples",
      value: `${packageName} init`
    },
    {
      name: "Initialize example project into a new directory",
      value: `${packageName} init <example>`
    },
    {
      name: "Initialize example project into specified directory",
      value: `${packageName} init <example> <dir>`
    },
    {
      name: "Initialize example project without checking",
      value: `${packageName} init <example> --force`
    }
  ]
};

// src/commands/inspect/command.ts
var inspectCommand = {
  name: "inspect",
  aliases: [],
  description: "Show information about a deployment.",
  arguments: [
    {
      name: "url|deploymentId",
      required: true
    }
  ],
  options: [
    {
      name: "timeout",
      description: "Time to wait for deployment completion [3m]",
      argument: "TIME",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "wait",
      description: "Blocks until deployment completes",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "logs",
      shorthand: "l",
      type: Boolean,
      deprecated: false,
      description: "Prints the build logs instead of the deployment summary"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Get information about a deployment by its unique URL",
      value: `${packageName} inspect my-deployment-ji2fjij2.vercel.app`
    },
    {
      name: "Get information about the deployment an alias points to",
      value: `${packageName} inspect my-deployment.vercel.app`
    },
    {
      name: "Get information about a deployment by piping in the URL",
      value: `echo my-deployment.vercel.app | ${packageName} inspect`
    },
    {
      name: "Wait up to 90 seconds for deployment to complete",
      value: `${packageName} inspect my-deployment.vercel.app --wait --timeout 90s`
    },
    {
      name: "Get deployment build logs",
      value: `${packageName} inspect my-deployment.vercel.app --logs`
    },
    {
      name: "Get deployment information as JSON",
      value: `${packageName} inspect my-deployment.vercel.app --json`
    }
  ]
};

// src/commands/integration-resource/command.ts
var removeSubcommand10 = {
  name: "remove",
  aliases: ["rm"],
  description: "Delete an integration resource",
  arguments: [
    {
      name: "resource",
      required: true
    }
  ],
  options: [
    {
      name: "disconnect-all",
      description: "Disconnects all projects from the specified resource before deletion",
      shorthand: "a",
      type: Boolean,
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt when deleting a resource"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Delete a resource",
      value: [
        `${packageName} integration-resource remove <resource>`,
        `${packageName} integration-resource remove my-acme-resource`
      ]
    },
    {
      name: "Disconnect all projects from a resource, then delete it",
      value: [
        `${packageName} integration-resource remove <resource> --disconnect-all`,
        `${packageName} integration-resource remove my-acme-resource --disconnect-all`,
        `${packageName} integration-resource remove my-acme-resource -a`
      ]
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration-resource remove my-acme-resource --json --yes`
    }
  ]
};
var disconnectSubcommand2 = {
  name: "disconnect",
  aliases: [],
  description: "Disconnect a marketplace resource from a project",
  arguments: [
    {
      name: "resource",
      required: true
    },
    {
      name: "project",
      required: false
    }
  ],
  options: [
    {
      name: "all",
      description: "Disconnects all projects from the specified resource",
      shorthand: "a",
      type: Boolean,
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt when disconnecting a resource"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Disconnect a resource from the current project",
      value: [
        `${packageName} integration-resource disconnect <resource>`,
        `${packageName} integration-resource disconnect my-acme-resource`
      ]
    },
    {
      name: "Disconnect all projects from a resource",
      value: [
        `${packageName} integration-resource disconnect <resource> --all`,
        `${packageName} integration-resource disconnect my-acme-resource --all`,
        `${packageName} integration-resource disconnect my-acme-resource -a`
      ]
    },
    {
      name: "Disconnect a resource from a specified project",
      value: [
        `${packageName} integration-resource disconnect <resource> <project>`,
        `${packageName} integration-resource disconnect my-acme-resource my-project`
      ]
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration-resource disconnect my-acme-resource --json --yes`
    }
  ]
};
var connectSubcommand2 = {
  name: "connect",
  aliases: [],
  description: "Connect a marketplace resource to a project",
  arguments: [
    {
      name: "resource",
      required: true
    },
    {
      name: "project",
      required: false
    }
  ],
  options: [
    {
      name: "environment",
      shorthand: "e",
      type: [String],
      argument: "ENV",
      deprecated: false,
      description: "Environment to connect (can be repeated: production, preview, development). Defaults to all."
    },
    {
      name: "prefix",
      shorthand: null,
      type: String,
      argument: "PREFIX",
      deprecated: false,
      description: "Prefix for environment variable names (e.g., --prefix NEON2_ creates NEON2_DATABASE_URL instead of DATABASE_URL)"
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt when connecting a resource"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Connect a resource to the current project",
      value: [
        `${packageName} integration resource connect <resource>`,
        `${packageName} integration resource connect my-acme-resource`
      ]
    },
    {
      name: "Connect a resource to a specified project",
      value: [
        `${packageName} integration resource connect <resource> <project>`,
        `${packageName} integration resource connect my-acme-resource my-project`
      ]
    },
    {
      name: "Connect only to specific environments",
      value: [
        `${packageName} integration resource connect my-acme-resource -e production`,
        `${packageName} integration resource connect my-acme-resource -e production -e preview`
      ]
    },
    {
      name: "Connect with a prefix for environment variable names",
      value: `${packageName} integration resource connect my-acme-resource --prefix NEON2_`
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration resource connect my-acme-resource --json --yes`
    }
  ]
};
var createThresholdSubcommand = {
  name: "create-threshold",
  aliases: [],
  description: "Creates a threshold for a resource (or installation, if the integration uses installation-level thresholds)",
  arguments: [
    {
      name: "resource",
      required: true
    },
    {
      name: "minimum",
      required: true
    },
    {
      name: "spend",
      required: true
    },
    {
      name: "limit",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when creating a threshold"
    }
  ],
  examples: [
    {
      name: "create threshold",
      value: [
        `${packageName} integration-resource create-threshold <resource> <minimum> <spend> <limit> [options]`,
        `${packageName} integration-resource create-threshold my-acme-resource 50 100 2000`,
        `${packageName} integration-resource create-threshold my-acme-resource 50 100 2000 --yes`
      ]
    }
  ]
};
var claimSubcommand = {
  name: "claim",
  aliases: [],
  description: "Claim a sandbox marketplace resource (e.g. Stripe, Shopify) by opening the provider claim URL in your browser",
  arguments: [
    {
      name: "resource",
      required: false
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when claiming a single sandbox resource"
    },
    {
      name: "no-wait",
      description: "Print the claim URL and exit without polling for completion",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Claim a sandbox resource by name",
      value: [
        `${packageName} integration-resource claim <resource>`,
        `${packageName} integration-resource claim my-stripe`
      ]
    },
    {
      name: "Pick a sandbox resource interactively (current team)",
      value: `${packageName} integration-resource claim`
    },
    {
      name: "Print the claim URL as JSON without waiting",
      value: `${packageName} integration-resource claim my-stripe --json --no-wait`
    }
  ]
};
var inspectSubcommand6 = {
  name: "inspect",
  aliases: ["status"],
  description: "Show live details and status for a marketplace integration resource, fetched fresh from the provider",
  arguments: [
    {
      name: "resource",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Show live details and status for a resource",
      value: [
        `${packageName} integration resource inspect <resource>`,
        `${packageName} integration resource inspect my-acme-resource`
      ]
    },
    {
      name: "Show live status for a resource (alias)",
      value: `${packageName} integration resource status my-acme-resource`
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration resource inspect my-acme-resource --json`
    }
  ]
};
var integrationResourceCommand = {
  name: "integration-resource",
  aliases: ["ir"],
  description: "Manage marketplace integration resources (alias for `vercel integration resource`)",
  options: [],
  arguments: [],
  subcommands: [
    connectSubcommand2,
    createThresholdSubcommand,
    disconnectSubcommand2,
    removeSubcommand10,
    claimSubcommand,
    inspectSubcommand6
  ],
  examples: []
};

// src/commands/integration/command.ts
var addSubcommand7 = {
  name: "add",
  aliases: ["install"],
  description: "Installs a marketplace integration",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: [
    {
      name: "name",
      description: "Custom name for the resource (auto-generated if not provided)",
      shorthand: "n",
      type: String,
      deprecated: false,
      argument: "NAME"
    },
    {
      name: "metadata",
      description: "Metadata for the resource as KEY=VALUE (can be repeated). Run `vercel integration add <name> --help` to see available keys.",
      shorthand: "m",
      type: [String],
      deprecated: false,
      argument: "KEY=VALUE"
    },
    {
      name: "plan",
      shorthand: "p",
      type: String,
      deprecated: false,
      argument: "PLAN_ID",
      description: "Billing plan ID to use for the resource"
    },
    {
      name: "no-connect",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Skip connecting the resource to the current project (also skips env pull)"
    },
    {
      name: "no-env-pull",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Skip running env pull after provisioning"
    },
    {
      name: "environment",
      shorthand: "e",
      type: [String],
      deprecated: false,
      argument: "ENV",
      description: "Environment to connect (can be repeated: production, preview, development). Defaults to all."
    },
    {
      name: "prefix",
      shorthand: null,
      type: String,
      deprecated: false,
      argument: "PREFIX",
      description: "Prefix for environment variable names (e.g., --prefix NEON2_ creates NEON2_DATABASE_URL instead of DATABASE_URL)"
    },
    {
      name: "installation-id",
      shorthand: null,
      type: String,
      deprecated: false,
      argument: "ID",
      description: "Installation ID to use when multiple installations exist for the integration"
    },
    {
      name: "claim",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "If the new resource is a sandbox (e.g. Stripe, Shopify), claim it immediately without prompting"
    },
    {
      name: "no-claim",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "If the new resource is a sandbox, skip the offer to claim it (only print a hint)"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Install a marketplace integration (auto-generates resource name)",
      value: [
        `${packageName} integration add <integration-name>`,
        `${packageName} integration add acme`
      ]
    },
    {
      name: "Install a specific product from an integration",
      value: [
        `${packageName} integration add <integration>/<product>`,
        `${packageName} integration add acme/acme-redis`
      ]
    },
    {
      name: "Search by keyword (prompts to select a matching integration)",
      value: [
        `${packageName} integration add postgres`,
        `${packageName} integration add redis`
      ]
    },
    {
      name: "Install with a custom resource name",
      value: [
        `${packageName} integration add acme --name my-database`,
        `${packageName} integration add acme -n my-database`
      ]
    },
    {
      name: "Install with metadata options",
      value: [
        `${packageName} integration add acme --metadata region=us-east-1`,
        `${packageName} integration add acme -m region=us-east-1 -m version=16`,
        `${packageName} integration add acme -m auth=true`,
        `${packageName} integration add acme -m "readRegions=sfo1,iad1"`
      ]
    },
    {
      name: "Install with a specific billing plan",
      value: [
        `${packageName} integration add acme --plan pro`,
        `${packageName} integration add acme -p pro`
      ]
    },
    {
      name: "Install and connect to specific environments only",
      value: [
        `${packageName} integration add acme --environment production`,
        `${packageName} integration add acme -e production -e preview`
      ]
    },
    {
      name: "Install without connecting to the current project",
      value: `${packageName} integration add acme --no-connect`
    },
    {
      name: "Install without pulling environment variables",
      value: `${packageName} integration add acme --no-env-pull`
    },
    {
      name: "Install with a prefix for environment variable names",
      value: `${packageName} integration add acme --prefix NEON2_`
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration add acme --json`
    },
    {
      name: "Show available products for an integration",
      value: `${packageName} integration add acme --help`
    },
    {
      name: "Discover available marketplace products and their slugs",
      value: `${packageName} integration discover`
    }
  ]
};
var acceptTermsSubcommand = {
  name: "accept-terms",
  aliases: [],
  description: "Accept marketplace legal terms for an integration and install it on the current team (installation only; no product resource). Requires an interactive terminal and human confirmation. Does not replace integrations that require a browser or device attestation.",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Accept terms interactively, then install on the team",
      value: [
        `${packageName} integration accept-terms <integration>`,
        `${packageName} integration accept-terms neon`
      ]
    },
    {
      name: "Output result as JSON",
      value: `${packageName} integration accept-terms neon --json`
    }
  ]
};
var openSubcommand3 = {
  name: "open",
  aliases: [],
  description: "Opens a marketplace integration's or resource's dashboard via SSO",
  arguments: [
    {
      name: "name",
      required: true
    },
    {
      name: "resource",
      required: false
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Open a marketplace integration's dashboard",
      value: [
        `${packageName} integration open <integration-name>`,
        `${packageName} integration open acme`
      ]
    },
    {
      name: "Open a resource's dashboard within an integration",
      value: [
        `${packageName} integration open <integration-name> <resource-name>`,
        `${packageName} integration open acme my-acme-store`
      ]
    },
    {
      name: "Get the SSO link as JSON",
      value: [
        `${packageName} integration open acme --json`,
        `${packageName} integration open acme my-acme-store --json`
      ]
    }
  ]
};
var installationsSubcommand = {
  name: "installations",
  aliases: ["installation"],
  description: "List marketplace integration installations for the current team (account scope)",
  arguments: [],
  options: [
    {
      name: "integration",
      description: "Limit to installations of this integration (slug or id)",
      shorthand: "i",
      type: String,
      deprecated: false,
      argument: "SLUG_OR_ID"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List all marketplace installations for the team",
      value: [`${packageName} integration installations`]
    },
    {
      name: "Filter by integration slug",
      value: [`${packageName} integration installations --integration neon`]
    },
    {
      name: "JSON output",
      value: [`${packageName} integration installations --json`]
    }
  ]
};
var listSubcommand13 = {
  name: "list",
  aliases: ["ls"],
  description: "List resources from marketplace integrations for the current project",
  arguments: [
    {
      name: "project",
      required: false
    }
  ],
  options: [
    {
      name: "integration",
      description: "Limits the resources listed to a designated integration",
      shorthand: "i",
      type: String,
      deprecated: false,
      argument: "NAME"
    },
    {
      name: "all",
      description: "Lists all resources regardless of project",
      shorthand: "a",
      type: Boolean,
      deprecated: false
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List resources for the current linked project",
      value: [`${packageName} integration list`]
    },
    {
      name: "Filter the resources to a single integration",
      value: [
        `${packageName} integration list --integration <integration>`,
        `${packageName} integration list --integration acme`,
        `${packageName} integration list -i acme`
      ]
    },
    {
      name: "List all marketplace resources for the current team",
      value: [
        `${packageName} integration list --all`,
        `${packageName} integration list -a`
      ]
    },
    {
      name: "List resources as JSON",
      value: [`${packageName} integration list --json`]
    }
  ]
};
var discoverSubcommand = {
  name: "discover",
  aliases: [],
  description: "Discover available marketplace integrations",
  arguments: [
    {
      name: "query",
      required: false
    }
  ],
  options: [
    {
      name: "category",
      shorthand: "c",
      type: [String],
      deprecated: false,
      argument: "CATEGORY",
      description: "Filter integrations by category (can be repeated; e.g., -c storage -c authentication). Run `vercel integration categories` for valid slugs."
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Discover marketplace integrations",
      value: [`${packageName} integration discover`]
    },
    {
      name: "Search for integrations matching a query",
      value: [
        `${packageName} integration discover postgres`,
        `${packageName} integration discover aws`
      ]
    },
    {
      name: "Filter integrations by category",
      value: [
        `${packageName} integration discover --category storage`,
        `${packageName} integration discover -c authentication`
      ]
    },
    {
      name: "Filter by multiple categories at once (repeat the flag)",
      value: [
        `${packageName} integration discover --category storage --category authentication`,
        `${packageName} integration discover -c commerce -c payments -c authentication`
      ]
    },
    {
      name: "List available category slugs to use with --category",
      value: [`${packageName} integration categories`]
    },
    {
      name: "Discover marketplace integrations as JSON",
      value: [`${packageName} integration discover --json`]
    }
  ]
};
var categoriesSubcommand = {
  name: "categories",
  aliases: [],
  description: "List marketplace integration categories (slugs valid for `integration discover --category`)",
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List marketplace categories",
      value: [`${packageName} integration categories`]
    },
    {
      name: "List categories as JSON",
      value: [`${packageName} integration categories --json`]
    },
    {
      name: "Use a category slug to filter discover results",
      value: [`${packageName} integration discover --category storage`]
    }
  ]
};
var balanceSubcommand = {
  name: "balance",
  aliases: [],
  description: "Shows the balances and thresholds of a specified marketplace integration",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Show the balance(s) & threshold(s) of a marketplace integration",
      value: [
        `${packageName} integration balance <integration-name>`,
        `${packageName} integration balance acme`
      ]
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration balance acme --json`
    }
  ]
};
var updateSubcommand5 = {
  name: "update",
  aliases: [],
  description: "Update a marketplace integration installation (billing plan or which projects can access it). Install, remove, and connect flows are separate (integration add, integration remove, integration-resource, env pull, etc.) \u2014 not part of update. UI-only flows (OAuth in a browser, consent screens, marketplace purchase) may not map one-to-one to a single CLI flag; pass --plan and --authorization-id when the product requires them for billing changes. Any extra fields on the configuration resource that the API exposes but this command PATCH body does not send are not covered until the API and CLI support them.",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: [
    {
      name: "plan",
      shorthand: "p",
      type: String,
      deprecated: false,
      argument: "PLAN_ID",
      description: "Billing plan ID for integrations that support installation-level billing plans"
    },
    {
      name: "authorization-id",
      shorthand: null,
      type: String,
      deprecated: false,
      argument: "ID",
      description: "Billing authorization ID when the platform requires it for plan changes"
    },
    {
      name: "projects",
      shorthand: null,
      type: [String],
      deprecated: false,
      argument: "PROJECT",
      description: 'Project ID allowed to use this installation, or "all" for all projects (repeatable)'
    },
    {
      name: "installation-id",
      shorthand: null,
      type: String,
      deprecated: false,
      argument: "ID",
      description: "Configuration ID when multiple marketplace installations exist for this integration"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Grant all team projects access to the integration",
      value: [
        `${packageName} integration update <integration> --projects all`,
        `${packageName} integration update neon --projects all`
      ]
    },
    {
      name: "Limit access to specific projects",
      value: `${packageName} integration update neon --projects prj_abc --projects prj_def`
    },
    {
      name: "Change installation billing plan",
      value: `${packageName} integration update acme --plan pro`
    },
    {
      name: "Select installation when several exist",
      value: `${packageName} integration update neon --installation-id icfg_xxx --projects all`
    },
    {
      name: "Output result as JSON",
      value: `${packageName} integration update neon --projects all --json`
    },
    {
      name: "Non-interactive (JSON success and errors on stdout)",
      value: `${packageName} integration update neon --projects all --non-interactive`
    }
  ]
};
var removeSubcommand11 = {
  name: "remove",
  aliases: [],
  description: "Uninstalls a marketplace integration. Resources must be removed first using `integration-resource remove`.",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when uninstalling an integration"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Uninstall an integration",
      value: [
        `${packageName} integration remove <integration>`,
        `${packageName} integration remove acme`
      ]
    },
    {
      name: "Remove a resource before uninstalling",
      value: `${packageName} integration-resource remove <resource-name> --disconnect-all --yes`
    },
    {
      name: "Output as JSON",
      value: `${packageName} integration remove acme --json --yes`
    }
  ]
};
var guideSubcommand = {
  name: "guide",
  aliases: [],
  description: "Show getting started guides and code snippets for a marketplace integration",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: [
    {
      name: "framework",
      shorthand: "f",
      type: String,
      deprecated: false,
      argument: "FRAMEWORK",
      description: "Select a framework guide without interactive prompt (e.g., nextjs, remix, astro, nuxtjs, sveltekit)"
    }
  ],
  examples: [
    {
      name: "Show guides for a single-product integration",
      value: [
        `${packageName} integration guide <integration-name>`,
        `${packageName} integration guide neon`
      ]
    },
    {
      name: "Show guides for a specific product of a multi-product integration",
      value: [
        `${packageName} integration guide <integration>/<product>`,
        `${packageName} integration guide aws/aws-dynamodb`
      ]
    },
    {
      name: "Show the Next.js guide without prompts (useful for CI/agents)",
      value: `${packageName} integration guide neon --framework nextjs`
    },
    {
      name: "Discover available integrations and product slugs",
      value: `${packageName} integration discover`
    }
  ]
};
var resourceSubcommand = {
  name: "resource",
  aliases: [],
  description: "Manage marketplace integration resources (connect, disconnect, remove, create-threshold, claim)",
  options: [],
  arguments: [],
  subcommands: [
    connectSubcommand2,
    createThresholdSubcommand,
    disconnectSubcommand2,
    removeSubcommand10,
    claimSubcommand,
    inspectSubcommand6
  ],
  examples: [
    {
      name: "Connect a resource to the current project",
      value: `${packageName} integration resource connect my-acme-resource`
    },
    {
      name: "Disconnect a resource from the current project",
      value: `${packageName} integration resource disconnect my-acme-resource`
    },
    {
      name: "Remove a resource (disconnecting all projects first)",
      value: `${packageName} integration resource remove my-acme-resource --disconnect-all --yes`
    }
  ]
};
var integrationCommand = {
  name: "integration",
  aliases: [],
  description: "Manage marketplace integrations. To manage individual resources, see `vercel integration resource`.",
  options: [],
  arguments: [],
  subcommands: [
    addSubcommand7,
    acceptTermsSubcommand,
    balanceSubcommand,
    categoriesSubcommand,
    discoverSubcommand,
    guideSubcommand,
    installationsSubcommand,
    listSubcommand13,
    openSubcommand3,
    resourceSubcommand,
    updateSubcommand5,
    removeSubcommand11
  ],
  examples: [
    {
      name: "Install a specific product from an integration",
      value: `${packageName} integration add acme/acme-redis`
    },
    {
      name: "Connect an existing resource to the current project",
      value: `${packageName} integration resource connect my-acme-resource`
    }
  ]
};

// src/commands/install/command.ts
var installCommand = {
  name: "install",
  aliases: ["i"],
  description: "Install an integration from the marketplace (alias for `integration add`)",
  arguments: [
    {
      name: "integration",
      required: true
    }
  ],
  options: addSubcommand7.options,
  examples: [
    {
      name: "Install an integration from the marketplace",
      value: `${packageName} install acme`
    },
    {
      name: "Install a specific product",
      value: `${packageName} install acme/acme-redis`
    }
  ]
};

// src/util/kms/types.ts
var KMS_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA"
];
var PROJECT_GRANT_POLICY_KIND = "project-grant";
function isProjectGrant(policy) {
  return policy.kind === PROJECT_GRANT_POLICY_KIND;
}
function issuerUrl(issuerId) {
  return `https://kms.vercel.com/${issuerId}`;
}
function issuerJwksUrl(issuerId) {
  return `${issuerUrl(issuerId)}/jwks.json`;
}

// src/commands/kms/command.ts
var cursorOption = {
  name: "next",
  shorthand: null,
  type: String,
  argument: "CURSOR",
  deprecated: false,
  description: "Show the next page of results, using a cursor from a prior page"
};
var algorithmOption = {
  name: "algorithm",
  shorthand: "a",
  type: String,
  argument: "ALGORITHM",
  deprecated: false,
  description: `Signing algorithm: ${KMS_ALGORITHMS.join(", ")} (default: RS512)`
};
var importAlgorithmOption = {
  name: "algorithm",
  shorthand: "a",
  type: String,
  argument: "ALGORITHM",
  deprecated: false,
  description: `Signing algorithm: ${KMS_ALGORITHMS.join(", ")} (required for RSA keys, otherwise derived from the key)`
};
var nameOption = {
  name: "name",
  shorthand: null,
  type: String,
  argument: "NAME",
  deprecated: false,
  description: "New name for the issuer"
};
var claimsSchemaOption = {
  name: "claims-schema",
  shorthand: null,
  type: String,
  argument: "JSON",
  deprecated: false,
  description: "JSON Schema validating token claims, as inline JSON, `@<file>`, or `@-` for stdin"
};
var removeClaimsSchemaOption = {
  name: "remove-claims-schema",
  shorthand: null,
  type: Boolean,
  deprecated: false,
  description: "Remove the claims schema, so claims are no longer validated"
};
var tokenClaimsOption = {
  name: "token-claims",
  shorthand: null,
  type: String,
  argument: "JSON",
  deprecated: false,
  description: "Claims to include in tokens signed for this grant, as inline JSON, `@<file>`, or `@-` for stdin"
};
var removeTokenClaimsOption = {
  name: "remove-token-claims",
  shorthand: null,
  type: Boolean,
  deprecated: false,
  description: "Remove the token claims from the grant"
};
var grantProjectOption = {
  ...projectOption,
  shorthand: "p"
};
var environmentOption2 = {
  name: "environment",
  shorthand: "e",
  type: [String],
  argument: "ENV",
  deprecated: false,
  description: "Environment the grant applies to: a system environment (production, preview, development) or a custom environment ID (env_\u2026). Repeatable"
};
var keyOption = {
  name: "key",
  shorthand: "k",
  type: String,
  argument: "FILE",
  deprecated: false,
  description: "Path to the PEM private key to import, or `-` to read it from stdin"
};
var keyIdOption = {
  name: "key-id",
  shorthand: null,
  type: String,
  argument: "KID",
  deprecated: false,
  description: "JWKS `kid` for the imported key (default: server-generated)"
};
var revokePreviousAfterHoursOption = {
  name: "revoke-previous-after-hours",
  shorthand: null,
  type: Number,
  argument: "HOURS",
  deprecated: false,
  description: "Hours the previous key keeps verifying after activation (default: 1)"
};
var activationOption = {
  name: "activation",
  shorthand: null,
  type: String,
  argument: "MODE",
  deprecated: false,
  description: "When the key starts signing: automatic or manual (default: automatic)"
};
function skipConfirmationOption(action) {
  return {
    ...yesOption,
    description: `Skip the confirmation prompt when ${action}`
  };
}
var listSubcommand14 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all KMS issuers",
  default: true,
  arguments: [],
  options: [formatOption, jsonOption, limitOption, cursorOption],
  examples: [
    {
      name: "List issuers as JSON",
      value: `${packageName} kms ls --format json`
    }
  ]
};
var inspectSubcommand7 = {
  name: "inspect",
  aliases: ["get"],
  description: "Show an issuer with its signing keys and grants",
  arguments: [
    {
      name: "issuerId",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Inspect an issuer",
      value: `${packageName} kms inspect iss_1a2b3c4d`
    }
  ]
};
var addSubcommand8 = {
  name: "add",
  aliases: ["create"],
  description: "Create an issuer with a Vercel-generated signing key",
  arguments: [
    {
      name: "name",
      required: true
    }
  ],
  options: [algorithmOption, claimsSchemaOption, formatOption, jsonOption],
  examples: [
    {
      name: "Create an issuer that signs with ES256",
      value: `${packageName} kms add my-issuer --algorithm ES256`
    }
  ]
};
var importSubcommand2 = {
  name: "import",
  aliases: [],
  description: "Create an issuer from a private key you already have",
  arguments: [
    {
      name: "name",
      required: true
    }
  ],
  options: [
    keyOption,
    keyIdOption,
    importAlgorithmOption,
    claimsSchemaOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Import an EC private key, whose algorithm is derived from the key",
      value: `${packageName} kms import my-issuer --key ./private-key.pem`
    },
    {
      name: "Import an RSA private key from stdin",
      value: `cat private-key.pem | ${packageName} kms import my-issuer --key - --algorithm RS256`
    }
  ]
};
var updateSubcommand6 = {
  name: "update",
  aliases: [],
  description: "Rename an issuer or change its claims schema",
  arguments: [
    {
      name: "issuerId",
      required: true
    }
  ],
  options: [
    nameOption,
    claimsSchemaOption,
    removeClaimsSchemaOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Rename an issuer",
      value: `${packageName} kms update iss_1a2b3c4d --name billing-tokens`
    },
    {
      name: "Replace the claims schema from a file",
      value: `${packageName} kms update iss_1a2b3c4d --claims-schema @claims-schema.json`
    }
  ]
};
var removeSubcommand12 = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Delete an issuer and all of its keys",
  arguments: [
    {
      name: "issuerId",
      required: true
    }
  ],
  options: [skipConfirmationOption("deleting an issuer")],
  examples: [
    {
      name: "Delete an issuer",
      value: `${packageName} kms rm iss_1a2b3c4d`
    }
  ]
};
var addKeySubcommand = {
  name: "add-key",
  aliases: [],
  description: "Add a Vercel-generated signing key to an issuer",
  arguments: [
    {
      name: "issuerId",
      required: true
    }
  ],
  options: [
    activationOption,
    revokePreviousAfterHoursOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Rotate to a new key, retiring the previous one after 24 hours",
      value: `${packageName} kms add-key iss_1a2b3c4d --revoke-previous-after-hours 24`
    },
    {
      name: "Stage a key without activating it",
      value: `${packageName} kms add-key iss_1a2b3c4d --activation manual`
    }
  ]
};
var importKeySubcommand = {
  name: "import-key",
  aliases: [],
  description: "Add a signing key you already have to an imported issuer",
  arguments: [
    {
      name: "issuerId",
      required: true
    }
  ],
  options: [
    keyOption,
    keyIdOption,
    activationOption,
    revokePreviousAfterHoursOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Rotate an imported issuer to a new private key",
      value: `${packageName} kms import-key iss_1a2b3c4d --key ./private-key.pem`
    }
  ]
};
var activateKeySubcommand = {
  name: "activate-key",
  aliases: [],
  description: "Start signing with a staged key",
  arguments: [
    {
      name: "issuerId",
      required: true
    },
    {
      name: "keyId",
      required: true
    }
  ],
  options: [revokePreviousAfterHoursOption, formatOption, jsonOption],
  examples: [
    {
      name: "Activate a key",
      value: `${packageName} kms activate-key iss_1a2b3c4d key_5e6f7g8h`
    }
  ]
};
var revokeKeySubcommand = {
  name: "revoke-key",
  aliases: [],
  description: "End a scheduled revocation now, so a key stops verifying",
  arguments: [
    {
      name: "issuerId",
      required: true
    },
    {
      name: "keyId",
      required: true
    }
  ],
  options: [skipConfirmationOption("revoking a key")],
  examples: [
    {
      name: "Revoke a key that is already scheduled for revocation",
      value: `${packageName} kms revoke-key iss_1a2b3c4d key_5e6f7g8h`
    }
  ]
};
var addGrantSubcommand = {
  name: "add-grant",
  aliases: [],
  description: "Grant a project permission to sign with an issuer",
  arguments: [
    {
      name: "issuerId",
      required: true
    }
  ],
  options: [
    grantProjectOption,
    environmentOption2,
    tokenClaimsOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Grant a project signing access in Production and Preview",
      value: `${packageName} kms add-grant iss_1a2b3c4d --project prj_9i8h7g6f --environment production --environment preview`
    },
    {
      name: "Grant a project signing access in a custom environment",
      value: `${packageName} kms add-grant iss_1a2b3c4d --project prj_9i8h7g6f --environment env_1a2b3c4d`
    }
  ]
};
var updateGrantSubcommand = {
  name: "update-grant",
  aliases: [],
  description: "Change a project grant's environments or token claims",
  arguments: [
    {
      name: "issuerId",
      required: true
    },
    {
      name: "projectId",
      required: true
    }
  ],
  options: [
    environmentOption2,
    tokenClaimsOption,
    removeTokenClaimsOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Restrict a grant to Production",
      value: `${packageName} kms update-grant iss_1a2b3c4d prj_9i8h7g6f --environment production`
    }
  ]
};
var removeGrantSubcommand = {
  name: "remove-grant",
  aliases: ["rm-grant", "delete-grant"],
  description: "Revoke a project's permission to sign with an issuer",
  arguments: [
    {
      name: "issuerId",
      required: true
    },
    {
      name: "projectId",
      required: true
    }
  ],
  options: [skipConfirmationOption("removing a grant")],
  examples: [
    {
      name: "Remove a project grant",
      value: `${packageName} kms rm-grant iss_1a2b3c4d prj_9i8h7g6f`
    }
  ]
};
var kmsCommand = {
  name: "kms",
  aliases: [],
  description: "Manage KMS issuers, signing keys, and project grants",
  arguments: [],
  subcommands: [
    listSubcommand14,
    inspectSubcommand7,
    addSubcommand8,
    importSubcommand2,
    updateSubcommand6,
    removeSubcommand12,
    addKeySubcommand,
    importKeySubcommand,
    activateKeySubcommand,
    revokeKeySubcommand,
    addGrantSubcommand,
    updateGrantSubcommand,
    removeGrantSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/login/command.ts
var loginCommand = {
  name: "login",
  aliases: [],
  description: "Sign in to your Vercel account.",
  arguments: [
    {
      name: "email or team id",
      required: false
    }
  ],
  options: [
    {
      name: "github",
      description: "Log in with GitHub",
      shorthand: null,
      type: Boolean,
      deprecated: true
    },
    {
      name: "oob",
      description: 'Log in with "out of band" authentication',
      shorthand: null,
      type: Boolean,
      deprecated: true
    },
    { name: "gitlab", shorthand: null, type: Boolean, deprecated: true },
    { name: "bitbucket", shorthand: null, type: Boolean, deprecated: true },
    {
      name: "future",
      description: "Sign in using OAuth Device Authorization",
      shorthand: null,
      type: Boolean,
      deprecated: true
    }
  ],
  examples: [
    {
      name: "Sign in to your Vercel account.",
      value: `${packageName} login`
    }
  ],
  disabledGlobalOptions: ["token"]
};

// src/commands/logout/command.ts
var logoutCommand = {
  name: "logout",
  aliases: [],
  description: "Sign out the currently authenticated user.",
  arguments: [],
  options: [],
  examples: [
    {
      name: "Sign out the currently authenticated user.",
      value: `${packageName} logout`
    }
  ]
};

// src/commands/logs/command.ts
var CommandTimeout = "5 minutes";
var logsCommand = {
  name: "logs",
  aliases: ["log"],
  description: "Display request logs for a project.\n\nUse --follow to stream live runtime logs from a deployment. By default, --follow prefers the active production deployment and falls back to your latest READY deployment.\n\nSource types: \u03BB = serverless, \u03B5 = edge/middleware, \u25C7 = static/external",
  arguments: [
    {
      name: "url|deploymentId",
      required: false
    }
  ],
  options: [
    { ...projectOption, shorthand: "p" },
    {
      name: "deployment",
      shorthand: "d",
      type: String,
      deprecated: false,
      description: "Filter logs to a specific deployment ID or URL (alternative to positional argument)"
    },
    {
      name: "environment",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Filter by environment: production or preview; with --follow, select the active production deployment or your latest preview deployment"
    },
    {
      name: "level",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Filter by log level: error, warning, info, fatal"
    },
    {
      name: "status-code",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Filter by HTTP status code (e.g., 500, 4xx)"
    },
    {
      name: "source",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Filter by source: serverless, edge-function, edge-middleware, static"
    },
    {
      name: "since",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Start time (ISO format or relative: 1h, 30m)"
    },
    {
      name: "until",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "End time (ISO format or relative, default: now)"
    },
    {
      name: "limit",
      shorthand: "n",
      type: Number,
      deprecated: false,
      description: "Maximum number of results (default: 100)"
    },
    {
      name: "json",
      shorthand: "j",
      type: Boolean,
      deprecated: false,
      description: "Output logs as JSON Lines for piping to other tools"
    },
    {
      name: "follow",
      shorthand: "f",
      type: Boolean,
      deprecated: false,
      description: "Stream live runtime logs from a deployment"
    },
    {
      name: "no-follow",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "No-op; deployment arguments only stream logs when --follow is set"
    },
    {
      name: "query",
      shorthand: "q",
      type: String,
      deprecated: false,
      description: 'Advanced search query (supports filter syntax, e.g. "status:500 error")'
    },
    {
      name: "search",
      shorthand: null,
      type: String,
      deprecated: true,
      description: 'Advanced search query (supports filter syntax, e.g. "status:500 error")'
    },
    {
      name: "request-id",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Filter by request ID"
    },
    {
      name: "expand",
      shorthand: "x",
      type: Boolean,
      deprecated: false,
      description: "Show full log message below each request line (default when output is not a TTY)"
    },
    {
      name: "branch",
      shorthand: "b",
      type: String,
      deprecated: false,
      description: "Filter by Git branch; with --follow, require a matching READY deployment"
    },
    {
      name: "no-branch",
      shorthand: null,
      type: Boolean,
      deprecated: true,
      description: "Deprecated no-op; use --branch to filter by branch"
    }
  ],
  examples: [
    {
      name: "Display recent request logs for the linked project",
      value: `${packageName} logs`
    },
    {
      name: "Display request logs for a specific project",
      value: `${packageName} logs --project my-app`
    },
    {
      name: "Display request error logs from the last hour",
      value: `${packageName} logs --level error --since 1h`
    },
    {
      name: "Display request logs for a specific deployment",
      value: `${packageName} logs dpl_xxxxx`
    },
    {
      name: "Filter request logs by status code and output as JSON",
      value: `${packageName} logs --status-code 500 --json`
    },
    {
      name: "Search request logs by status and message",
      value: `${packageName} logs --query 'status:500 error' --json | jq '.message'`
    },
    {
      name: "Display request logs from production",
      value: `${packageName} logs --environment production`
    },
    {
      name: "Display request logs for a specific request",
      value: `${packageName} logs --request-id req_xxxxx`
    },
    {
      name: "Display request logs with full message details",
      value: `${packageName} logs --expand`
    },
    {
      name: "Display request logs for a specific branch",
      value: `${packageName} logs --branch feature-x`
    },
    {
      name: "Stream runtime logs for the active production deployment",
      value: `${packageName} logs --follow`
    },
    {
      name: "Stream runtime logs for your latest preview deployment",
      value: `${packageName} logs --follow --environment preview`
    },
    {
      name: "Stream runtime logs for a specific deployment",
      value: `${packageName} logs dpl_xxxxx --follow`
    }
  ]
};

// src/commands/mcp/command.ts
var mcpCommand = {
  name: "mcp",
  aliases: [],
  description: "Set up MCP agents and configuration for Vercel integration",
  arguments: [],
  options: [
    {
      name: "project",
      description: "Set up project-specific MCP access for the currently linked project",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "clients",
      description: "Comma-separated list of MCP clients to set up. In interactive mode, skips the client picker when set. Required in non-interactive mode. Options: Claude Code, Claude.ai and Claude for desktop, Cursor, VS Code with Copilot",
      shorthand: null,
      type: String,
      argument: "CLIENTS",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Interactively set up MCP agents",
      value: `${packageName} mcp`
    },
    {
      name: "Set up project-specific MCP access",
      value: `${packageName} mcp --project`
    },
    {
      name: "Non-interactive: set up Cursor and VS Code",
      value: `${packageName} mcp --clients "Cursor,VS Code with Copilot"`
    }
  ]
};

// src/commands/microfrontends/command.ts
var createGroupSubcommand = {
  name: "create-group",
  aliases: [],
  description: "Create a new microfrontends group to compose multiple projects into one cohesive application with shared routing",
  arguments: [],
  options: [
    {
      name: "name",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Name of the microfrontends group"
    },
    {
      name: "project",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Project name to include (repeatable)"
    },
    {
      name: "default-app",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Project name for the default application"
    },
    {
      name: "default-route",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Default route for the default application"
    },
    {
      name: "project-default-route",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: 'Default route for a non-default project in the form "<project>=<route>" (repeatable)'
    },
    {
      ...yesOption,
      description: "Skip creation confirmation prompt"
    }
  ],
  examples: [
    {
      name: "Create a microfrontends group interactively",
      value: `${packageName} microfrontends create-group`
    },
    {
      name: "Create a microfrontends group with flags",
      value: `${packageName} mf create-group --name="My Group" --project=web --project=docs --default-app=web --project-default-route=docs=/docs --yes`
    }
  ]
};
var addToGroupSubcommand = {
  name: "add-to-group",
  aliases: [],
  description: "Add the current project to a microfrontends group so it can be independently deployed as part of the microfrontends group",
  arguments: [],
  options: [
    {
      name: "group",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Name of the microfrontends group to add to"
    },
    {
      name: "default-route",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Default route for this project (e.g. /docs)"
    }
  ],
  examples: [
    {
      name: "Add current project to a group interactively",
      value: `${packageName} microfrontends add-to-group`
    },
    {
      name: "Add current project to a group with flags",
      value: `${packageName} mf add-to-group --group="My Group" --default-route=/docs`
    }
  ]
};
var removeFromGroupSubcommand = {
  name: "remove-from-group",
  aliases: [],
  description: "Remove the current project from its microfrontends group so it is no longer part of the composed application",
  arguments: [],
  options: [
    {
      ...yesOption,
      description: "Skip project linking confirmation"
    }
  ],
  examples: [
    {
      name: "Remove current project from its group interactively",
      value: `${packageName} microfrontends remove-from-group`
    }
  ]
};
var deleteGroupSubcommand = {
  name: "delete-group",
  aliases: [],
  description: "Delete a microfrontends group and all of its settings. This action is not reversible.",
  arguments: [],
  options: [
    {
      ...yesOption,
      description: "Skip project linking confirmation"
    },
    {
      name: "group",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Name or ID of the microfrontends group to delete"
    }
  ],
  examples: [
    {
      name: "Delete a microfrontends group interactively",
      value: `${packageName} microfrontends delete-group`
    },
    {
      name: "Delete a microfrontends group with flags",
      value: `${packageName} mf delete-group --group="My Group"`
    }
  ]
};
var pullSubcommand = {
  name: "pull",
  aliases: [],
  description: "Pull a Vercel Microfrontends configuration into your project",
  arguments: [],
  options: [
    {
      ...yesOption,
      description: "Skip confirmation when linking is required (e.g. in non-interactive mode)"
    },
    {
      name: "dpl",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "The deploymentId to use for pulling the microfrontends configuration"
    }
  ],
  examples: [
    {
      name: "Pull a microfrontends configuration",
      value: `${packageName} microfrontends pull`
    },
    {
      name: "Pull a microfrontends configuration for a specific deployment",
      value: `${packageName} microfrontends pull --dpl=<deployment-id>`
    }
  ]
};
var inspectGroupSubcommand = {
  name: "inspect-group",
  aliases: [],
  description: "Inspect a microfrontends group and return project metadata used for setup automation",
  arguments: [],
  options: [
    {
      name: "group",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Name or ID of the microfrontends group to inspect"
    },
    {
      name: "config-file-name",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Custom microfrontends config file path/name relative to the default app root (must end with .json or .jsonc)"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Inspect a microfrontends group interactively",
      value: `${packageName} microfrontends inspect-group`
    },
    {
      name: "Inspect a microfrontends group as JSON",
      value: `${packageName} mf inspect-group --group="My Group" --json`
    }
  ]
};
var microfrontendsCommand = {
  name: "microfrontends",
  aliases: ["mf"],
  description: "Manage microfrontends groups that compose multiple projects into one cohesive application",
  arguments: [],
  subcommands: [
    createGroupSubcommand,
    addToGroupSubcommand,
    removeFromGroupSubcommand,
    deleteGroupSubcommand,
    inspectGroupSubcommand,
    pullSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/open/command.ts
var openCommand = {
  name: "open",
  aliases: [],
  description: "Opens the current project in the Vercel Dashboard.",
  arguments: [],
  options: [
    {
      ...yesOption,
      description: "Skip confirmation when linking is required (e.g. in non-interactive mode)"
    }
  ],
  examples: [
    {
      name: "Open the current project in the Vercel Dashboard",
      value: `${packageName} open`
    }
  ]
};

// src/commands/project/command.ts
var addSubcommand9 = {
  name: "add",
  aliases: [],
  description: "Add a new project",
  arguments: [
    {
      name: "name",
      required: true
    }
  ],
  options: [],
  examples: [
    {
      name: "Add a new project",
      value: `${packageName} project add my-project`
    }
  ]
};
var checksBlocksOption = {
  name: "blocks",
  shorthand: null,
  type: String,
  description: "When listing: filter by blocking stage. When adding: blocking stage for the new check. Values: build-start, deployment-start, deployment-alias, deployment-promotion, none",
  deprecated: false
};
var checksAddFlags = [
  formatOption,
  jsonOption,
  checksBlocksOption,
  {
    name: "file",
    shorthand: null,
    type: String,
    description: "Path to JSON file for the POST body (see REST: Create a check). Overrides --check-name / related flags.",
    deprecated: false
  },
  {
    name: "check-name",
    shorthand: null,
    type: String,
    description: "Name of the deployment check (required with --requires unless --file is set)",
    deprecated: false
  },
  {
    name: "requires",
    shorthand: null,
    type: String,
    description: "When the check runs: build-ready, deployment-url, or none (required with --check-name unless --file)",
    deprecated: false
  },
  {
    name: "timeout",
    shorthand: null,
    type: Number,
    description: "Timeout in seconds for the new check (default 300)",
    deprecated: false
  },
  {
    name: "targets",
    shorthand: null,
    type: String,
    description: "Comma-separated deployment targets (e.g. production,preview)",
    deprecated: false
  },
  {
    name: "source",
    shorthand: null,
    type: String,
    description: "JSON string for the `source` object (integration, webhook, or git-provider)",
    deprecated: false
  }
];
var checksRemoveFlags = [formatOption, jsonOption];
var checksSubcommand = {
  name: "checks",
  aliases: [],
  description: "List, add, or remove deployment checks for a project (GET/POST/DELETE /v2/projects/.../checks)",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [...checksAddFlags],
  examples: [
    {
      name: "List checks for the linked project",
      value: `${packageName} project checks`
    },
    {
      name: "Checks that block production alias assignment",
      value: `${packageName} project checks --blocks deployment-alias`
    },
    {
      name: "Add a check from a JSON file",
      value: `${packageName} project checks add my-app --file ./check.json`
    },
    {
      name: "Add a check with flags (requires integration/webhook setup in the body via --file or --source)",
      value: `${packageName} project checks add --check-name "CI" --requires deployment-url --blocks deployment-alias`
    },
    {
      name: "Remove a check by id",
      value: `${packageName} project checks remove chk_abc123 my-app`
    }
  ]
};
var inspectSubcommand8 = {
  name: "inspect",
  aliases: [],
  description: "Displays information related to a project",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [yesOption],
  examples: [
    {
      name: "Inspect the linked project from the current directory",
      value: `${packageName} project inspect`
    },
    {
      name: 'Inspect the project named "my-project"',
      value: `${packageName} project inspect my-project`
    }
  ]
};
var listSubcommand15 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all projects in the selected scope",
  default: true,
  arguments: [],
  options: [
    nextOption,
    limitOption,
    formatOption,
    jsonOption,
    {
      name: "update-required",
      description: "A list of projects affected by an upcoming deprecation",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "filter",
      shorthand: "f",
      type: String,
      argument: "NAME",
      description: "Filter projects by name (substring match)",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Paginate projects, where `1584722256178` is the time in milliseconds since the UNIX epoch",
      value: `${packageName} project ls --next 1584722256178`
    },
    {
      name: "List projects using a deprecated Node.js version in JSON format",
      value: `${packageName} project ls --update-required --json`
    },
    {
      name: "Filter projects by name",
      value: `${packageName} project ls --filter my-app`
    }
  ]
};
var pauseSubcommand = {
  name: "pause",
  aliases: [],
  description: "Pause production traffic for a project (visitors will see an error page)",
  arguments: [
    {
      name: "project",
      required: false
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Pause the linked project",
      value: `${packageName} project pause`
    },
    {
      name: 'Pause the project named "my-project"',
      value: `${packageName} project pause my-project`
    },
    {
      name: "Pause a project and print the result as JSON",
      value: `${packageName} project pause my-project --json`
    }
  ]
};
var removeSubcommand13 = {
  name: "remove",
  aliases: ["rm"],
  description: "Delete a project",
  arguments: [
    {
      name: "name",
      required: true
    }
  ],
  options: [],
  examples: []
};
var renameSubcommand = {
  name: "rename",
  aliases: [],
  description: "Rename a project",
  arguments: [
    {
      name: "name",
      required: true
    },
    {
      name: "new-name",
      required: true
    }
  ],
  options: [],
  examples: [
    {
      name: "Rename a project",
      value: `${packageName} project rename my-project my-renamed-project`
    }
  ]
};
var updateSubcommand7 = {
  name: "update",
  aliases: ["set"],
  description: "Update one or more project settings; omitted settings remain unchanged",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [
    {
      name: "framework",
      shorthand: null,
      type: String,
      argument: "SLUG",
      description: 'Set the framework preset by slug; use "other" to clear the preset',
      deprecated: false
    },
    {
      name: "build-command",
      shorthand: null,
      type: String,
      argument: "COMMAND",
      description: "Set the build command",
      deprecated: false
    },
    {
      name: "dev-command",
      shorthand: null,
      type: String,
      argument: "COMMAND",
      description: "Set the development command",
      deprecated: false
    },
    {
      name: "install-command",
      shorthand: null,
      type: String,
      argument: "COMMAND",
      description: "Set the install command",
      deprecated: false
    },
    {
      name: "output-directory",
      shorthand: null,
      type: String,
      argument: "DIR",
      description: "Set the output directory",
      deprecated: false
    },
    {
      name: "root-directory",
      shorthand: null,
      type: String,
      argument: "DIR",
      description: "Set the project root directory",
      deprecated: false
    },
    {
      name: "auto-detect",
      shorthand: null,
      type: [String],
      argument: "SETTING",
      description: "Reset a setting to automatic detection; repeat for build-command, dev-command, install-command, output-directory, or root-directory",
      deprecated: false
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Set the linked project framework preset to Next.js",
      value: `${packageName} project update --framework nextjs`
    },
    {
      name: "Set a named project framework preset to Vite",
      value: `${packageName} project update my-project --framework vite`
    },
    {
      name: "Update multiple settings in one command",
      value: `${packageName} project update my-project --build-command "pnpm build" --output-directory dist`
    },
    {
      name: "Reset individual settings to automatic detection",
      value: `${packageName} project update my-project --auto-detect build-command --auto-detect output-directory`
    },
    {
      name: "Clear the framework preset and return JSON",
      value: `${packageName} project update my-project --framework other --json`
    }
  ]
};
var tokenSubcommand2 = {
  name: "token",
  aliases: [],
  description: "Get a development OIDC token for a project",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [yesOption, formatOption, jsonOption],
  examples: [
    {
      name: "Get a development OIDC token for the linked project",
      value: `${packageName} project token`
    },
    {
      name: 'Get a development OIDC token for the project named "my-project"',
      value: `${packageName} project token my-project`
    },
    {
      name: "Get a development OIDC token as JSON",
      value: `${packageName} project token my-project --json`
    }
  ]
};
var accessSummarySubcommand = {
  name: "access-summary",
  aliases: ["summary"],
  description: "Show member counts by team role for project access (requires access groups entitlement)",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Summary for the linked project",
      value: `${packageName} project access-summary`
    },
    {
      name: "Summary as JSON",
      value: `${packageName} project access-summary my-app --json`
    }
  ]
};
var membersSubcommand = {
  name: "members",
  aliases: ["member"],
  description: "List project members for a project",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      name: "search",
      shorthand: null,
      type: String,
      description: "Filter project members by name, username, or email",
      deprecated: false
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      description: "Limit number of project members returned (1-100)",
      deprecated: false
    },
    nextOption
  ],
  examples: [
    {
      name: "List members for the linked project",
      value: `${packageName} project members`
    },
    {
      name: "List members for a named project as JSON",
      value: `${packageName} project members my-project --json`
    }
  ]
};
var protectionSubcommand = {
  name: "protection",
  aliases: [],
  description: "Show or toggle deployment protection settings for a project",
  arguments: [
    { name: "action", required: false },
    { name: "name", required: false }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      name: "sso",
      shorthand: null,
      type: Boolean,
      description: "Apply action to SSO protection.",
      deprecated: false
    },
    {
      name: "password",
      shorthand: null,
      type: Boolean,
      description: "Apply action to password protection (requires eligible plan/permissions).",
      deprecated: false
    },
    {
      name: "protection-password",
      shorthand: null,
      type: String,
      argument: "PASSWORD",
      description: "Password value when enabling password protection (max 72 characters). Requires --password.",
      deprecated: false
    },
    {
      name: "customer-support-code-visibility",
      shorthand: null,
      type: Boolean,
      description: "Apply action to customer support code visibility protection.",
      deprecated: false
    },
    {
      name: "skew",
      shorthand: null,
      type: Boolean,
      description: "Apply action to skew protection.",
      deprecated: false
    },
    {
      name: "skew-max-age",
      shorthand: null,
      type: String,
      argument: "SECONDS",
      description: "When enabling with --skew, max age in seconds for skew protection (default 2592000, 30 days).",
      deprecated: false
    },
    {
      name: "protection-bypass",
      shorthand: null,
      type: Boolean,
      description: "Apply action to automation protection bypass secrets.",
      deprecated: false
    },
    {
      name: "protection-bypass-secret",
      shorthand: null,
      type: String,
      argument: "SECRET",
      description: "Optional secret value for protection bypass. Required when disabling bypass.",
      deprecated: false
    },
    {
      name: "git-fork-protection",
      shorthand: null,
      type: Boolean,
      description: "Apply action to Git fork protection.",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Protection settings for the linked project",
      value: `${packageName} project protection`
    },
    {
      name: "Named project as JSON",
      value: `${packageName} project protection my-app --json`
    },
    {
      name: "Disable password protection",
      value: `${packageName} project protection disable my-app --password`
    },
    {
      name: "Enable password protection",
      value: `${packageName} project protection enable my-app --password`
    },
    {
      name: "Enable password protection with a password",
      value: `${packageName} project protection enable my-app --password --protection-password <password>`
    },
    {
      name: "Enable customer support code visibility",
      value: `${packageName} project protection enable my-app --customer-support-code-visibility`
    },
    {
      name: "Disable customer support code visibility",
      value: `${packageName} project protection disable my-app --customer-support-code-visibility`
    },
    {
      name: "Enable skew protection",
      value: `${packageName} project protection enable my-app --skew`
    },
    {
      name: "Enable skew protection with custom max age (seconds)",
      value: `${packageName} project protection enable my-app --skew --skew-max-age 604800`
    },
    {
      name: "Disable skew protection",
      value: `${packageName} project protection disable my-app --skew`
    },
    {
      name: "Enable automation protection bypass",
      value: `${packageName} project protection enable my-app --protection-bypass`
    },
    {
      name: "Disable bypass with secret",
      value: `${packageName} project protection disable my-app --protection-bypass --protection-bypass-secret <secret>`
    },
    {
      name: "Enable Git fork protection",
      value: `${packageName} project protection enable my-app --git-fork-protection`
    },
    {
      name: "Disable Git fork protection",
      value: `${packageName} project protection disable my-app --git-fork-protection`
    },
    {
      name: "Enable SSO deployment protection",
      value: `${packageName} project protection enable my-app --sso`
    },
    {
      name: "Disable SSO for a named project",
      value: `${packageName} project protection disable my-app --sso`
    }
  ]
};
var accessGroupsSubcommand = {
  name: "access-groups",
  aliases: ["accessgroups"],
  description: "List access groups for a project",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [
    formatOption,
    jsonOption,
    nextOption,
    {
      name: "search",
      shorthand: null,
      type: String,
      description: "Search access groups by name",
      deprecated: false
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      description: "Limit number of access groups returned (1-100)",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "List access groups for the linked project",
      value: `${packageName} project access-groups`
    },
    {
      name: "List access groups for a named project as JSON",
      value: `${packageName} project access-groups my-project --json`
    }
  ]
};
var webAnalyticsSubcommand = {
  name: "web-analytics",
  aliases: [],
  description: "Enable Web Analytics for a project",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Enable Web Analytics for the linked project",
      value: `${packageName} project web-analytics`
    },
    {
      name: "Enable Web Analytics for a named project",
      value: `${packageName} project web-analytics my-project`
    },
    {
      name: "Confirm enablement as JSON (non-interactive / agents)",
      value: `${packageName} project web-analytics --json`
    }
  ]
};
var speedInsightsSubcommand = {
  name: "speed-insights",
  aliases: [],
  description: "Enable Speed Insights for a project",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Enable Speed Insights for the linked project",
      value: `${packageName} project speed-insights`
    },
    {
      name: "Enable Speed Insights for a named project",
      value: `${packageName} project speed-insights my-project`
    },
    {
      name: "Confirm enablement as JSON (non-interactive / agents)",
      value: `${packageName} project speed-insights --json`
    }
  ]
};
var projectCommand = {
  name: "project",
  aliases: ["projects"],
  description: "Manage your Vercel projects",
  arguments: [],
  subcommands: [
    addSubcommand9,
    accessSummarySubcommand,
    checksSubcommand,
    inspectSubcommand8,
    listSubcommand15,
    membersSubcommand,
    accessGroupsSubcommand,
    protectionSubcommand,
    webAnalyticsSubcommand,
    speedInsightsSubcommand,
    pauseSubcommand,
    updateSubcommand7,
    renameSubcommand,
    removeSubcommand13,
    tokenSubcommand2
  ],
  options: [],
  examples: []
};

// src/commands/promote/command.ts
var timeoutOption = {
  name: "timeout",
  description: "Time to wait for promotion completion [3m]",
  argument: "TIME",
  shorthand: null,
  type: String,
  deprecated: false
};
var statusSubcommand2 = {
  name: "status",
  aliases: [],
  description: "Show the status of any current pending promotions",
  arguments: [
    {
      name: "project",
      required: false
    }
  ],
  options: [
    timeoutOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when linking a Project"
    }
  ],
  examples: [
    {
      name: "Show the status of any current pending promotions",
      value: [
        `${packageName} promote status`,
        `${packageName} promote status <project>`,
        `${packageName} promote status --timeout 30s`
      ]
    }
  ]
};
var promoteCommand = {
  name: "promote",
  aliases: [],
  description: "Promote an existing Deployment to current",
  arguments: [
    {
      name: "url|deploymentId",
      required: true
    }
  ],
  subcommands: [statusSubcommand2],
  options: [
    timeoutOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when linking a Project"
    }
  ],
  examples: [
    {
      name: "Promote a Deployment using ID or URL",
      value: `${packageName} promote <deployment id|url>`
    }
  ]
};

// src/commands/redeploy/command.ts
var redeployCommand = {
  name: "redeploy",
  aliases: [],
  description: "Rebuild and deploy a previous deployment.",
  arguments: [
    {
      name: "url|deploymentId",
      required: false
    }
  ],
  options: [
    {
      name: "no-wait",
      shorthand: null,
      description: "Don't wait for the redeploy to finish",
      type: Boolean,
      deprecated: false
    },
    {
      name: "target",
      shorthand: null,
      argument: "TARGET",
      description: "Redeploy to a specific target environment",
      type: String,
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Rebuild and deploy an existing deployment using id or url",
      value: `${packageName} redeploy my-deployment.vercel.app`
    },
    {
      name: "Write Deployment URL to a file",
      value: `${packageName} redeploy my-deployment.vercel.app > deployment-url.txt`
    },
    {
      name: "Rebuild and deploy an existing deployment to a specific target environment",
      value: `${packageName} redeploy my-deployment.vercel.app --target preview`
    }
  ]
};

// src/commands/redirects/command.ts
var listSubcommand16 = {
  name: "list",
  aliases: ["ls"],
  description: "List all redirects for the current project. These redirects apply to all deployments and environments. There may also be redirects defined in a deployment that are not listed here.",
  arguments: [],
  options: [
    projectOption,
    {
      name: "search",
      description: "Search for redirects by source or destination",
      shorthand: "s",
      type: String,
      argument: "QUERY",
      deprecated: false
    },
    {
      name: "next",
      description: "Continue from a previous response",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      deprecated: false
    },
    {
      name: "limit",
      description: "Number of redirects per page (default: 50)",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      deprecated: false
    },
    {
      name: "page",
      description: "Page number to display",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      deprecated: true
    },
    {
      name: "per-page",
      description: "Number of redirects per page (default: 50)",
      shorthand: null,
      type: Number,
      argument: "NUMBER",
      deprecated: true
    },
    {
      name: "staging",
      description: "List redirects from the staging version",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "version",
      description: "List redirects from a specific version ID",
      shorthand: null,
      type: String,
      argument: "VERSION_ID",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "List all redirects",
      value: `${packageName} redirects list`
    },
    {
      name: "Search for redirects",
      value: `${packageName} redirects list --search "/old-path"`
    },
    {
      name: "List redirects on page 2",
      value: `${packageName} redirects list --next 2`
    },
    {
      name: "List redirects with custom page size",
      value: `${packageName} redirects list --limit 25`
    }
  ]
};
var listVersionsSubcommand = {
  name: "list-versions",
  aliases: ["ls-versions"],
  description: "List all versions of redirects",
  arguments: [],
  options: [projectOption],
  examples: [
    {
      name: "List all redirect versions",
      value: `${packageName} redirects list-versions`
    }
  ]
};
var addSubcommand10 = {
  name: "add",
  aliases: [],
  description: "Add a new redirect",
  arguments: [
    {
      name: "source",
      required: false
    },
    {
      name: "destination",
      required: false
    }
  ],
  options: [
    projectOption,
    {
      name: "status",
      description: "HTTP status code (301, 302, 307, or 308)",
      shorthand: null,
      type: Number,
      argument: "CODE",
      deprecated: false
    },
    {
      name: "case-sensitive",
      description: "Make the redirect case sensitive",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "preserve-query-params",
      description: "Preserve query parameters when redirecting",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "name",
      description: "Version name for this redirect (max 256 characters)",
      shorthand: null,
      type: String,
      argument: "NAME",
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip prompts and use default values"
    }
  ],
  examples: [
    {
      name: "Add a new redirect interactively",
      value: `${packageName} redirects add`
    },
    {
      name: "Add a new redirect with arguments",
      value: `${packageName} redirects add /old-path /new-path`
    },
    {
      name: "Add a redirect with all options",
      value: `${packageName} redirects add /old-path /new-path --status 301 --case-sensitive --preserve-query-params --name "My redirect"`
    },
    {
      name: "Add a redirect non-interactively",
      value: `${packageName} redirects add /old-path /new-path --yes`
    }
  ]
};
var uploadSubcommand = {
  name: "upload",
  aliases: ["import"],
  description: "Upload redirects from a CSV or JSON file",
  arguments: [
    {
      name: "file",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip confirmation prompt"
    },
    {
      name: "overwrite",
      description: "Replace all existing redirects",
      shorthand: null,
      type: Boolean,
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Upload redirects from CSV file",
      value: `${packageName} redirects upload redirects.csv`
    },
    {
      name: "Upload redirects from JSON file",
      value: `${packageName} redirects upload redirects.json`
    },
    {
      name: "Upload and overwrite existing redirects",
      value: `${packageName} redirects upload redirects.csv --overwrite`
    },
    {
      name: "Upload without confirmation",
      value: `${packageName} redirects upload redirects.csv --yes`
    }
  ]
};
var removeSubcommand14 = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove a redirect",
  arguments: [
    {
      name: "source",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing a redirect"
    }
  ],
  examples: [
    {
      name: "Remove a redirect",
      value: `${packageName} redirects remove /old-path`
    }
  ]
};
var promoteSubcommand = {
  name: "promote",
  aliases: [],
  description: "Promote a staged redirects version to production",
  arguments: [
    {
      name: "version-id",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when promoting"
    }
  ],
  examples: [
    {
      name: "Promote a redirect version",
      value: `${packageName} redirects promote <version-id>`
    }
  ]
};
var restoreSubcommand = {
  name: "restore",
  aliases: [],
  description: "Restore a previous redirects version",
  arguments: [
    {
      name: "version-id",
      required: true
    }
  ],
  options: [
    projectOption,
    {
      ...yesOption,
      description: "Skip the confirmation prompt when restoring"
    }
  ],
  examples: [
    {
      name: "Restore a redirects version",
      value: `${packageName} redirects restore <version-id>`
    }
  ]
};
var redirectsCommand = {
  name: "redirects",
  aliases: ["redirect"],
  description: "Manage redirects for a project. Redirects managed at the project level apply to all deployments and environments and take effect immediately after being created and promoted to production.",
  arguments: [],
  subcommands: [
    listSubcommand16,
    listVersionsSubcommand,
    addSubcommand10,
    uploadSubcommand,
    removeSubcommand14,
    promoteSubcommand,
    restoreSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/remove/command.ts
var removeCommand = {
  name: "remove",
  aliases: ["rm"],
  description: "Remove deployment(s) by project name or deployment ID.",
  arguments: [
    {
      name: "name|deploymentId",
      required: true,
      multiple: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip confirmation"
    },
    {
      name: "safe",
      shorthand: "s",
      type: Boolean,
      deprecated: false,
      description: "Skip deployments with an active alias"
    },
    { name: "hard", shorthand: null, type: Boolean, deprecated: false }
  ],
  examples: [
    {
      name: "Remove a deployment identified by Deployment ID",
      value: `${packageName} remove dpl_abcdef123456890`
    },
    {
      name: "Remove all deployments with Project name `my-app`",
      value: `${packageName} remove my-app`
    },
    {
      name: "Remove two deployments with Deployment IDs",
      value: `${packageName} remove dpl_eyWt6zuSdeus dpl_uWHoA9RQ1d1o`
    }
  ]
};

// src/commands/rollback/command.ts
var timeoutOption2 = {
  name: "timeout",
  description: "Time to wait for rollback completion [3m]",
  argument: "TIME",
  shorthand: null,
  type: String,
  deprecated: false
};
var statusSubcommand3 = {
  name: "status",
  aliases: [],
  description: "Show the status of any current pending rollbacks",
  arguments: [
    {
      name: "project",
      required: false
    }
  ],
  options: [timeoutOption2],
  examples: [
    {
      name: "Show the status of any current pending rollbacks",
      value: [
        `${packageName} rollback status`,
        `${packageName} rollback status <project>`,
        `${packageName} rollback status --timeout 30s`
      ]
    }
  ]
};
var rollbackCommand = {
  name: "rollback",
  aliases: [],
  description: "Quickly revert back to a previous deployment",
  arguments: [
    {
      name: "url|deploymentId",
      required: true
    }
  ],
  subcommands: [statusSubcommand3],
  options: [timeoutOption2, yesOption],
  examples: [
    {
      name: "Rollback a deployment using id or url",
      value: `${packageName} rollback <deployment id/url>`
    }
  ]
};

// src/commands/rolling-release/command.ts
var configureSubcommand = {
  name: "configure",
  description: "Configure rolling release settings for a project",
  aliases: [],
  arguments: [],
  examples: [
    {
      name: "Enable automatic rolling release: 10% for 5 minutes, then 50% for 10 minutes, then 100%",
      value: `${packageName} rolling-release configure --enable --advancement-type=automatic --stage=10,5m --stage=50,10m`
    },
    {
      name: "Enable manual-approval rolling release: 10%, then 50%, then 100% (each stage requires approval)",
      value: `${packageName} rolling-release configure --enable --advancement-type=manual-approval --stage=10 --stage=50`
    },
    {
      name: "Disable rolling releases",
      value: `${packageName} rolling-release configure --disable`
    },
    {
      name: "Configure with raw JSON (advanced)",
      value: `${packageName} rolling-release configure --cfg='{"enabled":true, "advancementType":"automatic", "stages":[{"targetPercentage":10,"duration":5},{"targetPercentage":100}]}'`
    }
  ],
  options: [
    projectOption,
    {
      name: "cfg",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "Raw JSON configuration (advanced). Overrides other flags."
    },
    {
      name: "enable",
      shorthand: null,
      deprecated: false,
      type: Boolean,
      description: "Enable rolling releases for this project"
    },
    {
      name: "disable",
      shorthand: null,
      deprecated: false,
      type: Boolean,
      description: "Disable rolling releases for this project"
    },
    {
      name: "advancement-type",
      shorthand: null,
      deprecated: false,
      type: String,
      argument: "TYPE",
      description: 'How stages advance: "automatic" or "manual-approval"'
    },
    {
      name: "stage",
      shorthand: null,
      deprecated: false,
      type: [String],
      argument: "PERCENTAGE[,DURATION]",
      description: 'Add a rollout stage. Percentage (1-99) with optional duration for automatic advancement (e.g. "10,5m"). Can be specified multiple times. A final 100% stage is added automatically.'
    }
  ]
};
var startSubcommand = {
  name: "start",
  description: "Start a rolling release",
  aliases: [],
  arguments: [],
  examples: [
    {
      name: "Start a rolling release",
      value: `${packageName} rr start --dpl=dpl_123`
    },
    {
      name: "Start a rolling release using URL",
      value: `${packageName} rr start --dpl=https://example.vercel.app`
    },
    {
      name: "Non-interactive (e.g. preview deployment): use --yes to promote",
      value: `${packageName} rr start --dpl=dpl_123 --yes`
    }
  ],
  options: [
    {
      name: "dpl",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "The deploymentId or URL to target for the rolling release",
      required: true
    },
    projectOption,
    yesOption
  ]
};
var approveSubcommand = {
  name: "approve",
  description: "Approve the current stage of an active rolling release",
  aliases: [],
  arguments: [],
  examples: [
    {
      name: "Approve the current stage of an active rolling release",
      value: `${packageName} rolling-release approve --currentStageIndex=0 --dpl=dpl_123`
    }
  ],
  options: [
    projectOption,
    {
      name: "dpl",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "The deploymentId of the rolling release"
    },
    {
      name: "currentStageIndex",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "The current stage of a rolling release to approve"
    }
  ]
};
var abortSubcommand = {
  name: "abort",
  description: "Abort an active rolling release",
  aliases: [],
  arguments: [],
  examples: [
    {
      name: "Abort an active rolling release",
      value: `${packageName} rolling-release abort --dpl=dpl_123`
    }
  ],
  options: [
    projectOption,
    {
      name: "dpl",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "The deploymentId of the rolling release to abort"
    }
  ]
};
var completeSubcommand = {
  name: "complete",
  description: "Complete an active rolling release",
  aliases: [],
  arguments: [],
  examples: [
    {
      name: "Complete an active rolling release",
      value: `${packageName} rolling-release complete --dpl=dpl_123`
    }
  ],
  options: [
    projectOption,
    {
      name: "dpl",
      shorthand: null,
      deprecated: false,
      type: String,
      description: "The deploymentId of the rolling release to complete"
    }
  ]
};
var fetchSubcommand = {
  name: "fetch",
  description: "Fetch details about a rolling release",
  aliases: [],
  arguments: [],
  examples: [
    {
      name: "Fetch details about a rolling release",
      value: `${packageName} rolling-release fetch`
    }
  ],
  options: [projectOption]
};
var rollingReleaseCommand = {
  name: "rolling-release",
  aliases: ["rr"],
  description: "Rolling releases gradually shift traffic to a new deployment in stages, allowing you to monitor for errors before serving all traffic. Learn more: https://vercel.com/docs/rolling-releases",
  arguments: [],
  subcommands: [
    configureSubcommand,
    startSubcommand,
    approveSubcommand,
    abortSubcommand,
    completeSubcommand,
    fetchSubcommand
  ],
  options: [],
  examples: [
    {
      name: "Enable automatic rolling release with two stages",
      value: `${packageName} rr configure --enable --advancement-type=automatic --stage=10,5m --stage=50,10m`
    },
    {
      name: "Enable manual-approval rolling release",
      value: `${packageName} rr configure --enable --advancement-type=manual-approval --stage=10 --stage=50`
    },
    {
      name: "Disable rolling releases",
      value: `${packageName} rr configure --disable`
    },
    {
      name: "Start a rolling release",
      value: `${packageName} rr start --dpl=dpl_123`
    },
    {
      name: "Approve an active rolling release stage",
      value: `${packageName} rr approve --currentStageIndex=0 --dpl=dpl_123`
    },
    {
      name: "Abort an active rolling release",
      value: `${packageName} rr abort --dpl=dpl_123`
    },
    {
      name: "Complete an active rolling release",
      value: `${packageName} rr complete --dpl=dpl_123`
    }
  ]
};

// src/commands/sandbox/command.ts
var sandboxCommand = {
  name: "sandbox",
  aliases: [],
  description: "Interact with Vercel Sandbox",
  arguments: [],
  options: [],
  examples: [
    {
      name: "List sandboxes for the current project",
      value: `${packageName} sandbox list`
    },
    {
      name: "Create a sandbox and connect to it",
      value: `${packageName} sandbox create --connect`
    }
  ]
};

// src/commands/security/command.ts
var checkSubcommand2 = {
  name: "check",
  aliases: [],
  description: "Run the security checks for the current team and show each check with its risk level, status, violation count, and muted findings. Pass check slugs to compute only those checks and list their findings",
  default: true,
  arguments: [
    {
      name: "check",
      required: false,
      multiple: true
    }
  ],
  options: [
    {
      name: "findings",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "List individual findings under each check, including muted ones. Implied when a check slug is passed"
    },
    {
      name: "limit",
      shorthand: null,
      type: Number,
      argument: "N",
      deprecated: false,
      description: "Max findings listed per check; by default every available finding is listed. Violation counts are always exact even when findings are capped"
    },
    {
      ...projectOption,
      shorthand: "p",
      description: "Scope the report to one project"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Run all security checks",
      value: `${packageName} security check`
    },
    {
      name: "Deep-dive one check and its findings",
      value: `${packageName} security check pats-no-expiration`
    },
    {
      name: "Output the raw report as JSON",
      value: `${packageName} security check --json`
    }
  ]
};
var securityCommand = {
  name: "security",
  aliases: [],
  description: "Inspect the security posture of the current team",
  arguments: [],
  subcommands: [checkSubcommand2],
  options: [],
  examples: []
};

// src/commands/skills/command.ts
var skillsCommand = {
  name: "skills",
  aliases: [],
  description: "Discover agent skills relevant to your project",
  arguments: [{ name: "query", required: false }],
  options: [
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output results as JSON"
    },
    {
      name: "format",
      shorthand: null,
      type: String,
      argument: "FORMAT",
      deprecated: false
    },
    yesOption
  ],
  examples: [
    {
      name: "Recommend skills based on detected project",
      value: `${packageName} skills`
    },
    {
      name: "Search for skills by keyword",
      value: `${packageName} skills nextjs`
    }
  ]
};

// src/commands/target/command.ts
var listSubcommand17 = {
  name: "list",
  aliases: ["ls"],
  description: "List targets defined for the current Project",
  arguments: [],
  options: [
    formatOption,
    jsonOption,
    projectOption,
    {
      ...yesOption,
      description: "Skip confirmation when linking is required (e.g. in non-interactive mode)"
    }
  ],
  examples: [
    {
      name: "List all targets for the current Project",
      value: `${packageName} target ls my-project`
    }
  ]
};
var targetCommand = {
  name: "target",
  aliases: ["targets"],
  description: `Manage your Vercel Project's "targets" (custom environments).`,
  arguments: [],
  subcommands: [listSubcommand17],
  options: [],
  examples: []
};

// src/commands/teams/command.ts
var requestSubcommand = {
  name: "request",
  aliases: ["access-request"],
  description: "Show join-request status for the current team (defaults to the authenticated user)",
  arguments: [
    {
      name: "userId",
      required: false
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Status for your pending request",
      value: `${packageName} teams request`
    },
    {
      name: "Status for another user id",
      value: `${packageName} teams request user_abc123`
    }
  ]
};
var addSubcommand11 = {
  name: "add",
  aliases: ["create"],
  description: "Create a new team",
  arguments: [],
  options: [
    {
      name: "slug",
      shorthand: null,
      type: String,
      description: "Team URL slug (e.g. acme for vercel.com/acme); required in non-interactive mode",
      deprecated: false
    },
    {
      name: "name",
      shorthand: null,
      type: String,
      description: "Display name for the team; required in non-interactive mode",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "Create a team (interactive)",
      value: `${packageName} teams add`
    },
    {
      name: "Create a team non-interactively",
      value: `${packageName} teams add --slug acme --name "Acme Corp"`
    }
  ]
};
var listSubcommand18 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all teams that you're a member of",
  arguments: [],
  options: [
    nextOption,
    limitOption,
    formatOption,
    jsonOption,
    { name: "since", shorthand: null, type: String, deprecated: true },
    { name: "until", shorthand: null, type: String, deprecated: true },
    { name: "count", shorthand: "C", type: Number, deprecated: true }
  ],
  examples: [
    {
      name: "Paginate results, where `1584722256178` is the time in milliseconds since the UNIX epoch",
      value: `${packageName} teams ls --next 1584722256178`
    }
  ]
};
var switchSubcommand = {
  name: "switch",
  aliases: ["change"],
  description: "Switch to a different team",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [],
  examples: [
    {
      name: "Switch to a team. If your team's url is 'vercel.com/name', then 'name' is the slug. If the slug is omitted, you can choose interactively",
      value: `${packageName} teams switch <slug>`
    }
  ],
  disabledGlobalOptions: ["token"]
};
var inviteSubcommand = {
  name: "invite",
  aliases: [],
  description: "Invite a new member to a team",
  arguments: [
    {
      name: "email",
      required: true,
      multiple: true
    }
  ],
  options: [],
  examples: [
    {
      name: "Invite new members (interactively)",
      value: `${packageName} teams invite`
    },
    {
      name: "Invite multiple members (required in non-interactive mode)",
      value: `${packageName} teams invite abc@vercel.com xyz@vercel.com`
    }
  ]
};
var ssoSubcommand = {
  name: "sso",
  aliases: [],
  description: "Show SAML / SSO configuration for the current team",
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Human-readable SAML summary",
      value: `${packageName} teams sso`
    },
    {
      name: "JSON",
      value: `${packageName} teams sso --json`
    }
  ]
};
var membersSubcommand2 = {
  name: "members",
  aliases: ["member"],
  description: "List members for the currently scoped team",
  arguments: [],
  options: [nextOption, limitOption, formatOption, jsonOption],
  examples: [
    {
      name: "List team members",
      value: `${packageName} teams members`
    },
    {
      name: "List team members as JSON",
      value: `${packageName} teams members --json`
    },
    {
      name: "Paginate results, where `1584722256178` is the time in milliseconds since the UNIX epoch",
      value: `${packageName} teams members --next 1584722256178`
    }
  ]
};
var teamsCommand = {
  name: "teams",
  aliases: ["switch", "team"],
  description: "Manage Teams under your Vercel account",
  arguments: [],
  subcommands: [
    addSubcommand11,
    inviteSubcommand,
    listSubcommand18,
    requestSubcommand,
    switchSubcommand,
    ssoSubcommand,
    membersSubcommand2
  ],
  options: [],
  examples: []
};

// src/commands/tokens/command.ts
var listSubcommand19 = {
  name: "list",
  aliases: ["ls"],
  description: "List your personal authentication tokens",
  default: true,
  arguments: [],
  options: [
    formatOption,
    jsonOption,
    {
      name: "limit",
      shorthand: null,
      type: Number,
      description: "Maximum number of tokens to return (default 20)",
      deprecated: false
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      description: "Continue from a previous response",
      argument: "CURSOR",
      deprecated: false
    }
  ],
  examples: [
    {
      name: "List tokens as JSON",
      value: `${packageName} tokens ls --json`
    }
  ]
};
var addSubcommand12 = {
  name: "add",
  aliases: ["create"],
  description: "Create a new personal authentication token",
  arguments: [
    {
      name: "name",
      required: true
    }
  ],
  options: [
    formatOption,
    jsonOption,
    {
      ...projectOption,
      description: "Optional project ID to scope the token to"
    }
  ],
  examples: [
    {
      name: "Create a token",
      value: `${packageName} tokens add "CI deploy"`
    }
  ]
};
var removeSubcommand15 = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Delete a personal authentication token by ID",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Remove a token",
      value: `${packageName} tokens rm tok_abc123`
    }
  ]
};
var tokensCommand = {
  name: "tokens",
  aliases: [],
  description: "Manage your personal Vercel authentication tokens",
  arguments: [],
  subcommands: [addSubcommand12, listSubcommand19, removeSubcommand15],
  options: [],
  examples: []
};

// src/commands/telemetry/command.ts
var statusSubcommand4 = {
  name: "status",
  aliases: [],
  description: "Shows whether telemetry collection is enabled or disabled",
  arguments: [],
  options: [],
  examples: []
};
var enableSubcommand3 = {
  name: "enable",
  aliases: [],
  description: "Enables telemetry collection",
  arguments: [],
  options: [],
  examples: []
};
var flushSubcommand = {
  name: "flush",
  aliases: [],
  description: "Internal command to flush telemetry events",
  hidden: true,
  arguments: [],
  options: [],
  examples: []
};
var disableSubcommand3 = {
  name: "disable",
  aliases: [],
  description: "Disables telemetry collection",
  arguments: [],
  options: [],
  examples: []
};
var telemetryCommand = {
  name: "telemetry",
  aliases: [],
  description: "Allows you to enable or disable telemetry collection",
  arguments: [],
  subcommands: [
    enableSubcommand3,
    disableSubcommand3,
    statusSubcommand4,
    flushSubcommand
  ],
  options: [],
  examples: []
};

// src/commands/traces/command.ts
var getSubcommand2 = {
  name: "get",
  aliases: [],
  default: true,
  description: "Fetch a captured trace by request id.",
  arguments: [{ name: "requestId", required: false }],
  options: [
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Print the raw trace JSON to stdout instead of the markdown summary."
    },
    {
      name: "project",
      shorthand: null,
      type: String,
      argument: "NAME|ID",
      deprecated: false,
      description: "Project name or id to fetch the trace from (overrides the linked project)."
    },
    {
      name: "open",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Open the trace in the Vercel Dashboard instead of printing it."
    },
    {
      name: "view",
      shorthand: null,
      type: String,
      argument: "timeline|tree|waterfall",
      deprecated: false,
      description: "Dashboard view to open. Only valid with --open. Defaults to timeline."
    }
  ],
  examples: [
    {
      name: "Fetch a trace by request id",
      value: `${packageName} traces get req_1234567890`
    },
    {
      name: "Print the raw trace JSON",
      value: `${packageName} traces get req_1234567890 --json`
    },
    {
      name: "`get` is the default \u2014 this is equivalent to the above",
      value: `${packageName} traces req_1234567890`
    },
    {
      name: "Fetch a trace from a specific team and project",
      value: `${packageName} traces get req_1234567890 --scope my-team --project my-app`
    },
    {
      name: "Open the trace in the Vercel Dashboard",
      value: `${packageName} traces get req_1234567890 --open`
    },
    {
      name: "Open the trace in the Vercel Dashboard with the waterfall view",
      value: `${packageName} traces get req_1234567890 --open --view waterfall`
    }
  ]
};
var createSubcommand5 = {
  name: "create",
  aliases: [],
  description: "Capture a session trace for a request (alias for `vercel curl --trace`).",
  arguments: [{ name: "path", required: true }],
  options: [
    deploymentOption,
    protectionBypassOption,
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Emit { response, requestId } as JSON on stdout"
    },
    {
      ...yesOption,
      description: "Skip the production confirmation prompt (e.g. in non-interactive mode)"
    }
  ],
  examples: [
    {
      name: "Capture a session trace for a request",
      value: `${packageName} traces create /api/hello`
    },
    {
      name: "Target a specific deployment",
      value: `${packageName} traces create /api/status --deployment https://your-project-abc123.vercel.app`
    },
    {
      name: "Pass curl flags after the separator",
      value: `${packageName} traces create /api/test -- --request POST --data '{"name": "John"}'`
    }
  ]
};
var tracesCommand = {
  name: "traces",
  aliases: [],
  description: "Fetch traces captured for a Vercel project.",
  arguments: [{ name: "requestId", required: false }],
  subcommands: [getSubcommand2, createSubcommand5],
  options: [],
  examples: [
    {
      name: "Fetch a trace by request id",
      value: `${packageName} traces get req_1234567890`
    },
    {
      name: "Print the raw trace JSON",
      value: `${packageName} traces get req_1234567890 --json`
    },
    {
      name: "Capture a session trace for a request",
      value: `${packageName} traces create /api/hello`
    }
  ]
};

// src/commands/upgrade/command.ts
var upgradeCommand = {
  name: "upgrade",
  aliases: [],
  description: "Upgrades the Vercel CLI to the latest version.",
  arguments: [],
  options: [
    {
      name: "dry-run",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Show the upgrade command without executing it"
    },
    {
      name: "enable-auto",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Enable automatic CLI updates for future releases"
    },
    {
      name: "disable-auto",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Disable automatic CLI updates"
    },
    {
      // Internal: opt in/out of the native CLI binary. Undocumented (no
      // `description`) so it is omitted from `--help`.
      name: "enable-binary",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "disable-binary",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Upgrade the Vercel CLI to the latest version",
      value: `${packageName} upgrade`
    },
    {
      name: "Show the upgrade command without running it",
      value: `${packageName} upgrade --dry-run`
    },
    {
      name: "Enable automatic CLI updates",
      value: `${packageName} upgrade --enable-auto`
    },
    {
      name: "Get upgrade information as JSON",
      value: `${packageName} upgrade --json`
    }
  ]
};

// src/commands/usage/command.ts
var usageCommand = {
  name: "usage",
  aliases: [],
  description: "Show billing usage (MIUs and costs) for the current billing period or a custom date range",
  arguments: [],
  options: [
    {
      name: "from",
      shorthand: null,
      type: String,
      argument: "DATE",
      description: "Start date (YYYY-MM-DD, interpreted as midnight LA time)",
      deprecated: false
    },
    {
      name: "to",
      shorthand: null,
      type: String,
      argument: "DATE",
      description: "End date (YYYY-MM-DD, interpreted as end of day LA time)",
      deprecated: false
    },
    {
      name: "breakdown",
      shorthand: null,
      type: String,
      argument: "PERIOD",
      description: "Show usage breakdown by time period instead of aggregated totals (daily, weekly, monthly)",
      deprecated: false
    },
    {
      name: "group-by",
      shorthand: null,
      type: String,
      argument: "DIMENSION",
      description: "Group usage by a dimension instead of aggregated totals (project, region)",
      deprecated: false
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Show usage for the current billing period",
      value: `${packageName} usage`
    },
    {
      name: "Show usage for a custom date range",
      value: `${packageName} usage --from 2025-01-01 --to 2025-01-31`
    },
    {
      name: "Show daily usage breakdown",
      value: `${packageName} usage --breakdown daily`
    },
    {
      name: "Show weekly usage breakdown",
      value: `${packageName} usage --breakdown weekly`
    },
    {
      name: "Show usage grouped by project",
      value: `${packageName} usage --group-by project`
    },
    {
      name: "Show usage grouped by region",
      value: `${packageName} usage --group-by region`
    },
    {
      name: "Output usage data as JSON",
      value: `${packageName} usage --json`
    }
  ]
};

// src/commands/version/command.ts
var listSubcommand20 = {
  name: "list",
  aliases: ["ls"],
  description: "Lists Vercel CLI versions available to install",
  arguments: [],
  options: [],
  examples: []
};
var installedSubcommand = {
  name: "installed",
  aliases: [],
  description: "Lists installed Vercel CLI versions",
  arguments: [],
  options: [],
  examples: []
};
var useSubcommand = {
  name: "use",
  aliases: ["switch", "install"],
  description: "Installs and switches to a specific Vercel CLI version",
  arguments: [
    {
      name: "version",
      required: true
    }
  ],
  options: [],
  examples: [
    {
      name: "Use a specific version (pins it)",
      value: `${packageName} version use 50.1.0`
    },
    {
      name: "Return to the latest version (unpins)",
      value: `${packageName} version use latest`
    }
  ]
};
var updateSubcommand8 = {
  name: "update",
  aliases: ["upgrade"],
  description: "Updates the Vercel CLI to the latest version",
  arguments: [],
  options: [],
  examples: []
};
var autoupdateSubcommand = {
  name: "autoupdate",
  aliases: [],
  description: "Enables or disables automatic CLI updates",
  arguments: [
    {
      name: "enable|disable|status",
      required: false
    }
  ],
  options: [],
  examples: [
    {
      name: "Enable automatic updates",
      value: `${packageName} version autoupdate enable`
    },
    {
      name: "Show whether automatic updates are enabled",
      value: `${packageName} version autoupdate status`
    }
  ]
};
var versionCommand = {
  name: "version",
  aliases: ["versions"],
  description: "Manages the installed Vercel CLI version.",
  arguments: [],
  subcommands: [
    listSubcommand20,
    installedSubcommand,
    useSubcommand,
    updateSubcommand8,
    autoupdateSubcommand
  ],
  options: [],
  examples: [
    {
      name: "Show the current version and install details",
      value: `${packageName} version`
    },
    {
      name: "List installed versions",
      value: `${packageName} version installed`
    },
    {
      name: "Use a specific version",
      value: `${packageName} version use 50.1.0`
    }
  ]
};

// src/commands/whoami/command.ts
var whoamiCommand = {
  name: "whoami",
  aliases: [],
  description: "Shows the username of the currently logged in user.",
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "Shows the username of the currently logged in user",
      value: `${packageName} whoami`
    }
  ]
};

// src/commands/blob/command.ts
var ifMatchOption = {
  name: "if-match",
  shorthand: null,
  type: String,
  deprecated: false,
  description: "Only perform the operation if the blob's ETag matches this value",
  argument: "STRING"
};
var ifNoneMatchOption = {
  name: "if-none-match",
  shorthand: null,
  type: String,
  deprecated: false,
  description: "Only return content if the blob's ETag does not match this value (returns 304 if unchanged)",
  argument: "STRING"
};
var accessOption = {
  name: "access",
  shorthand: "a",
  type: String,
  deprecated: false,
  description: "Access level for the blob: public or private (required)",
  argument: "String",
  choices: ["public", "private"]
};
var environmentOption3 = {
  name: "environment",
  shorthand: "e",
  type: [String],
  deprecated: false,
  argument: "ENV",
  description: "Environment to connect (can be repeated: production, preview, development). Defaults to all when --yes is used."
};
var listSubcommand21 = {
  name: "list",
  aliases: ["ls"],
  description: "List all files in the Blob store",
  arguments: [],
  options: [
    {
      name: "limit",
      shorthand: "l",
      type: Number,
      deprecated: false,
      description: "Number of results to return per page (default: 10, max: 1000)",
      argument: "NUMBER"
    },
    {
      name: "next",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Continue from a previous response",
      argument: "CURSOR"
    },
    {
      name: "cursor",
      shorthand: "c",
      type: String,
      deprecated: true,
      description: "Cursor from previous page to start listing from",
      argument: "STRING"
    },
    {
      name: "prefix",
      shorthand: "p",
      type: String,
      deprecated: false,
      description: "Prefix to filter Blobs by",
      argument: "STRING"
    },
    {
      name: "mode",
      shorthand: "m",
      type: String,
      deprecated: false,
      description: "Mode to filter Blobs by either folded or expanded (default: expanded)",
      argument: "String",
      choices: ["folded", "expanded"]
    }
  ],
  examples: []
};
var putSubcommand = {
  name: "put",
  aliases: [],
  description: "Upload a file to the Blob store",
  arguments: [
    {
      name: "pathToFile",
      required: true
    }
  ],
  options: [
    accessOption,
    {
      name: "add-random-suffix",
      shorthand: "r",
      type: Boolean,
      deprecated: false,
      description: "Add a random suffix to the file name (default: false)",
      argument: "Boolean"
    },
    {
      name: "pathname",
      shorthand: "p",
      type: String,
      deprecated: false,
      description: "Pathname to upload the file to (default: filename)",
      argument: "String"
    },
    {
      name: "multipart",
      shorthand: "u",
      type: Boolean,
      deprecated: false,
      description: "If true upload the file in multiple small chunks for performance and reliability (default: true)",
      argument: "Boolean"
    },
    {
      name: "content-type",
      shorthand: "t",
      type: String,
      deprecated: false,
      description: "Overwrite the content-type. Will be inferred from the file extension if not provided",
      argument: "String"
    },
    {
      name: "cache-control-max-age",
      shorthand: "c",
      type: Number,
      deprecated: false,
      description: "Max-age of the cache-control header directive (default: 2592000 = 30 days)",
      argument: "Number"
    },
    {
      name: "allow-overwrite",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Overwrite the file if it already exists (default: false)",
      argument: "Boolean"
    },
    ifMatchOption
  ],
  examples: []
};
var delSubcommand = {
  name: "del",
  aliases: [],
  description: "Delete a file from the Blob store",
  arguments: [
    {
      name: "urlsOrPathnames",
      required: true
    }
  ],
  options: [ifMatchOption],
  examples: []
};
var copySubcommand = {
  name: "copy",
  aliases: ["cp"],
  description: "Copy a file in the Blob store",
  arguments: [
    {
      name: "fromUrlOrPathname",
      required: true
    },
    {
      name: "toPathname",
      required: true
    }
  ],
  options: [
    accessOption,
    {
      name: "add-random-suffix",
      shorthand: "r",
      type: Boolean,
      deprecated: false,
      description: "Add a random suffix to the file name",
      argument: "Boolean"
    },
    {
      name: "content-type",
      shorthand: "t",
      type: String,
      deprecated: false,
      description: "Overwrite the content-type. Will be inferred from the file extension if not provided",
      argument: "String"
    },
    {
      name: "cache-control-max-age",
      shorthand: "c",
      type: Number,
      deprecated: false,
      description: "Max-age of the cache-control header directive (default: 2592000 = 30 days)",
      argument: "Number"
    },
    ifMatchOption
  ],
  examples: []
};
var getSubcommand3 = {
  name: "get",
  aliases: [],
  description: "Download a blob by URL or pathname",
  arguments: [
    {
      name: "urlOrPathname",
      required: true
    }
  ],
  options: [
    accessOption,
    {
      name: "output",
      shorthand: "o",
      type: String,
      deprecated: false,
      description: "Save blob content to a file instead of stdout",
      argument: "PATH"
    },
    ifNoneMatchOption
  ],
  examples: []
};
var putImageSubcommand = {
  name: "put-image",
  aliases: [],
  description: "Optimize an image with Vercel Image Optimization and store the result in the Blob store (requires OIDC credentials)",
  arguments: [
    {
      name: "pathToFileOrUrl",
      required: true
    }
  ],
  options: [
    accessOption,
    {
      name: "width",
      shorthand: "w",
      type: Number,
      deprecated: false,
      description: "Width of the optimized image in pixels, between 1 and 8192 (required)",
      argument: "NUMBER"
    },
    {
      name: "quality",
      shorthand: "q",
      type: Number,
      deprecated: false,
      description: "Quality of the optimized image, between 1 and 100 (default: 75)",
      argument: "NUMBER"
    },
    {
      name: "format",
      shorthand: "F",
      type: String,
      deprecated: false,
      description: "Output format: jpeg, png, webp, or avif. Keeps the original format when omitted",
      argument: "FORMAT",
      choices: ["jpeg", "png", "webp", "avif"]
    },
    {
      name: "pathname",
      shorthand: "p",
      type: String,
      deprecated: false,
      description: "Pathname to store the optimized image at in the Blob store (required)",
      argument: "String"
    },
    {
      name: "add-random-suffix",
      shorthand: "r",
      type: Boolean,
      deprecated: false,
      description: "Add a random suffix to the file name (default: false)",
      argument: "Boolean"
    },
    {
      name: "cache-control-max-age",
      shorthand: "c",
      type: Number,
      deprecated: false,
      description: "Max-age of the cache-control header directive (default: 2592000 = 30 days)",
      argument: "Number"
    },
    {
      name: "allow-overwrite",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Overwrite the file if it already exists (default: false)",
      argument: "Boolean"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output the stored blob as JSON"
    }
  ],
  examples: [
    {
      name: "Optimize a local image and upload it",
      value: "vercel blob put-image photo.png --pathname images/photo.png --width 1200 --access public"
    },
    {
      name: "Optimize an image from a public URL and convert it to WebP",
      value: "vercel blob put-image https://example.com/hero.png --pathname images/hero.webp --width 800 --quality 60 --format webp --access public"
    }
  ]
};
var signedTokenSubcommand = {
  name: "signed-token",
  aliases: [],
  description: "Issue a short-lived signed token for Blob operations",
  arguments: [],
  options: [
    {
      name: "pathname",
      shorthand: "p",
      type: String,
      deprecated: false,
      description: 'Pathname scope for the token. Defaults to "*" when omitted',
      argument: "STRING"
    },
    {
      name: "operation",
      shorthand: "o",
      type: [String],
      deprecated: false,
      description: "Allowed operation(s): get, head, put, delete (repeatable)",
      argument: "OPERATION",
      choices: ["get", "head", "put", "delete"]
    },
    {
      name: "valid-until",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Absolute expiration time as Unix timestamp in milliseconds (mutually exclusive with --valid-for)",
      argument: "TIMESTAMP_MS"
    },
    {
      name: "valid-for",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Relative duration before expiration (for example: 15m, 1h, 7d; mutually exclusive with --valid-until)",
      argument: "DURATION"
    },
    {
      name: "allowed-content-type",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Allowed content type(s) for put operations (repeatable, supports wildcards)",
      argument: "MIME_TYPE"
    },
    {
      name: "maximum-size-in-bytes",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Maximum upload size in bytes for put operations (max: 5TB)",
      argument: "BYTES"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output signed token payload as JSON"
    }
  ],
  examples: [
    {
      name: "Issue a signed token for reads",
      value: "vercel blob signed-token --pathname media/photo.jpg --operation get"
    },
    {
      name: "Issue a signed token for uploads with constraints",
      value: "vercel blob signed-token --pathname uploads/* --operation put --allowed-content-type image/* --maximum-size-in-bytes 10485760"
    }
  ]
};
var presignSubcommand = {
  name: "presign",
  aliases: [],
  description: "Generate a presigned URL for Blob operations",
  arguments: [
    {
      name: "pathname",
      required: true
    }
  ],
  options: [
    accessOption,
    {
      name: "operation",
      shorthand: "o",
      type: String,
      deprecated: false,
      description: "Operation for the presigned URL: get, head, put, or delete (default: get)",
      argument: "OPERATION",
      choices: ["get", "head", "put", "delete"]
    },
    {
      name: "delegation-token",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Delegation token from `vercel blob signed-token` (must be used with --client-signing-token)",
      argument: "STRING"
    },
    {
      name: "client-signing-token",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Signing secret/token from `vercel blob signed-token` (must be used with --delegation-token)",
      argument: "STRING"
    },
    {
      name: "valid-until",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Absolute expiration time as Unix timestamp in milliseconds (mutually exclusive with --valid-for)",
      argument: "TIMESTAMP_MS"
    },
    {
      name: "valid-for",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Relative duration before expiration (for example: 15m, 1h, 7d; mutually exclusive with --valid-until)",
      argument: "DURATION"
    },
    {
      name: "if-match",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "If-Match constraint for put or delete operations",
      argument: "STRING"
    },
    {
      name: "allow-overwrite",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Allow overwriting existing blobs (put only)"
    },
    {
      name: "add-random-suffix",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Add a random suffix to the pathname (put only)"
    },
    {
      name: "cache-control-max-age",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Cache-Control max-age in seconds (put only)",
      argument: "SECONDS"
    },
    {
      name: "allowed-content-type",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Allowed content type(s) for uploads (put only, repeatable)",
      argument: "MIME_TYPE"
    },
    {
      name: "maximum-size-in-bytes",
      shorthand: null,
      type: Number,
      deprecated: false,
      description: "Maximum upload size in bytes (put only, max: 5TB)",
      argument: "BYTES"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output presign result as JSON"
    }
  ],
  examples: [
    {
      name: "Generate a presigned GET URL",
      value: "vercel blob presign media/photo.jpg --access public"
    },
    {
      name: "Generate a presigned PUT URL with upload constraints",
      value: "vercel blob presign uploads/image.jpg --access private --operation put --allowed-content-type image/* --maximum-size-in-bytes 10485760"
    },
    {
      name: "Generate a presigned URL from existing signed-token output",
      value: "vercel blob presign uploads/image.jpg --access private --operation put --delegation-token <delegationToken> --client-signing-token <clientSigningToken>"
    }
  ]
};
var createStoreSubcommand = {
  name: "create-store",
  aliases: [],
  description: "Create a new Blob store",
  arguments: [
    {
      name: "name",
      required: false
    }
  ],
  options: [
    accessOption,
    {
      name: "region",
      shorthand: "r",
      type: String,
      deprecated: false,
      description: 'Region to create the Blob store in (default: "iad1"). See https://vercel.com/docs/edge-network/regions#region-list for all available regions',
      argument: "STRING"
    },
    yesOption,
    environmentOption3
  ],
  examples: [
    {
      name: 'Create a blob store (uses default region "iad1")',
      value: "vercel blob create-store my-store --access private"
    },
    {
      name: "Create a blob store in a specific region",
      value: "vercel blob create-store my-store --access private --region cdg1"
    },
    {
      name: "Create and connect to project in CI",
      value: "vercel blob create-store my-store --access private --yes --environment production --environment preview"
    }
  ]
};
var deleteStoreSubcommand = {
  name: "delete-store",
  aliases: [],
  description: "Delete a Blob store",
  arguments: [
    {
      name: "storeId",
      required: false
    }
  ],
  options: [yesOption],
  examples: []
};
var emptyStoreSubcommand = {
  name: "empty-store",
  aliases: [],
  description: "Delete all blobs in a Blob store",
  arguments: [],
  options: [yesOption],
  examples: []
};
var getStoreInfoSubcommand = {
  name: "get-store",
  aliases: [],
  description: "Get a Blob store",
  arguments: [
    {
      name: "storeId",
      required: false
    }
  ],
  options: [],
  examples: []
};
var listStoresSubcommand = {
  name: "list-stores",
  aliases: ["ls-stores"],
  description: "List all Blob stores",
  arguments: [],
  options: [
    {
      name: "all",
      shorthand: "a",
      type: Boolean,
      deprecated: false,
      description: "List all blob stores for the team, not just the ones connected to the current project"
    },
    {
      name: "json",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Output results as JSON"
    },
    {
      name: "no-projects",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Hide the Projects column (table output only)"
    }
  ],
  examples: [
    {
      name: "List blob stores for the linked project",
      value: "vercel blob list-stores"
    },
    {
      name: "List all team blob stores as JSON",
      value: "vercel blob list-stores --all --json"
    }
  ]
};
var blobCommand = {
  name: "blob",
  aliases: [],
  description: "Interact with Vercel Blob",
  arguments: [],
  subcommands: [
    listSubcommand21,
    putSubcommand,
    putImageSubcommand,
    getSubcommand3,
    delSubcommand,
    copySubcommand,
    signedTokenSubcommand,
    presignSubcommand,
    createStoreSubcommand,
    deleteStoreSubcommand,
    getStoreInfoSubcommand,
    listStoresSubcommand,
    emptyStoreSubcommand
  ],
  options: [
    {
      name: "rw-token",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Read_Write_Token for the Blob store",
      argument: "String"
    },
    {
      name: "oidc-token",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "OIDC token for the Blob store (must be passed together with --store-id)",
      argument: "String"
    },
    {
      name: "store-id",
      shorthand: null,
      type: String,
      deprecated: false,
      description: 'Blob store id, with or without the "store_" prefix (must be passed together with --oidc-token)',
      argument: "String"
    }
  ],
  examples: []
};

// src/commands/webhooks/command.ts
var listSubcommand22 = {
  name: "list",
  aliases: ["ls"],
  description: "Show all webhooks",
  default: true,
  arguments: [],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List all webhooks as JSON",
      value: `${packageName} webhooks ls --json`
    }
  ]
};
var getSubcommand4 = {
  name: "get",
  aliases: ["inspect"],
  description: "Displays information related to a webhook",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [formatOption, jsonOption],
  examples: []
};
var createSubcommand6 = {
  name: "create",
  aliases: ["add"],
  description: "Create a new webhook",
  arguments: [
    {
      name: "url",
      required: true
    }
  ],
  options: [
    {
      name: "event",
      shorthand: "e",
      type: [String],
      argument: "EVENT",
      deprecated: false,
      description: "Webhook event to subscribe to (can be used multiple times)"
    },
    {
      name: "project",
      shorthand: "p",
      type: [String],
      argument: "PROJECT_ID",
      deprecated: false,
      description: "Project ID to associate with the webhook (can be used multiple times)"
    }
  ],
  examples: [
    {
      name: "Create a webhook for deployment events",
      value: `${packageName} webhooks create https://example.com/webhook --event deployment.created --event deployment.ready`
    }
  ]
};
var removeSubcommand16 = {
  name: "remove",
  aliases: ["rm", "delete"],
  description: "Remove a webhook",
  arguments: [
    {
      name: "id",
      required: true
    }
  ],
  options: [
    {
      ...yesOption,
      description: "Skip the confirmation prompt when removing a webhook"
    }
  ],
  examples: []
};
var webhooksCommand = {
  name: "webhooks",
  aliases: ["webhook"],
  description: "Manage webhooks",
  arguments: [],
  subcommands: [
    listSubcommand22,
    getSubcommand4,
    createSubcommand6,
    removeSubcommand16
  ],
  options: [],
  examples: []
};

// src/commands/index.ts
var commandsStructs = [
  agentCommand,
  agentRunsCommand,
  aiGatewayCommand,
  alertsCommand,
  aliasCommand,
  activityCommand,
  apiCommand,
  blobCommand,
  bisectCommand,
  buildCommand,
  buyCommand,
  cacheCommand,
  certsCommand,
  changelogCommand,
  commentsCommand,
  contractCommand,
  cronsCommand,
  curlCommand,
  deployCommand,
  deployHooksCommand,
  devCommand,
  dnsCommand,
  domainsCommand,
  envCommand,
  firewallCommand,
  flagsCommand,
  gitCommand,
  globalConfigCommand,
  httpstatCommand,
  initCommand,
  inspectCommand,
  installCommand,
  integrationCommand,
  integrationResourceCommand,
  kmsCommand,
  linkCommand,
  listCommand,
  loginCommand,
  logoutCommand,
  logsCommand,
  mcpCommand,
  microfrontendsCommand,
  openCommand,
  projectCommand,
  promoteCommand,
  pullCommand,
  redeployCommand,
  redirectsCommand,
  removeCommand,
  routesCommand,
  rollbackCommand,
  rollingReleaseCommand,
  sandboxCommand,
  securityCommand,
  skillsCommand,
  targetCommand,
  teamsCommand,
  tokensCommand,
  telemetryCommand,
  tracesCommand,
  upgradeCommand,
  webhooksCommand,
  usageCommand,
  vcrCommand,
  versionCommand,
  whoamiCommand,
  // added because we don't have a full help command
  { name: "help", aliases: [] }
];
if (process.env.FF_GUIDANCE_MODE) {
  commandsStructs.push(guidanceCommand);
}
commandsStructs.push(metricsCommand);
commandsStructs.push(connexCommand);
function getCommandAliases(command) {
  return [command.name].concat(command.aliases);
}
var commands = /* @__PURE__ */ new Map();
for (const command of commandsStructs) {
  const aliases = getCommandAliases(command);
  output_manager_default.debug(
    `Registering command ${command.name} with aliases: ${JSON.stringify(aliases)}`
  );
  for (const alias of aliases) {
    output_manager_default.debug(`Setting alias ${alias} -> ${command.name}`);
    commands.set(alias, command.name);
  }
}
output_manager_default.debug(
  `All registered commands: ${JSON.stringify(Array.from(commands.entries()))}`
);
var commandNames = Array.from(commands.keys());

export {
  agentCommand,
  listSubcommand,
  inspectSubcommand,
  traceSubcommand,
  projectsSubcommand,
  agentRunsCommand,
  createSubcommand,
  listSubcommand2,
  inspectSubcommand2,
  removeSubcommand,
  apiKeysSubcommand,
  rulesAddSubcommand,
  rulesListSubcommand,
  rulesEditSubcommand,
  rulesRemoveSubcommand,
  rulesSubcommand,
  setupSubcommand,
  codingAgentsSubcommand,
  modelsListSubcommand,
  modelsEndpointsSubcommand,
  modelsSubcommand,
  budgetsSetSubcommand,
  budgetsListSubcommand,
  budgetsRemoveSubcommand,
  leaderboardModelsSubcommand,
  budgetsDefaultsListSubcommand,
  budgetsDefaultsSetSubcommand,
  budgetsDefaultsRemoveSubcommand,
  budgetsDefaultsSubcommand,
  budgetsSubcommand,
  leaderboardLabsSubcommand,
  leaderboardAppsSubcommand,
  leaderboardProvidersSubcommand,
  leaderboardSubcommand,
  aiGatewayCommand,
  setSubcommand,
  listSubcommand3,
  removeSubcommand2,
  aliasCommand,
  listSubcommand4,
  apiCommand,
  bisectCommand,
  CUSTOM_ENVIRONMENTS_PER_PACK,
  CUSTOM_ENVIRONMENT_EXAMPLE_PACK_COUNT,
  isCustomEnvironmentAddonAlias,
  SUPPORTED_CREDIT_TYPES,
  CREDIT_TYPE_LABELS,
  creditsSubcommand,
  SUPPORTED_ADDON_NAMES,
  addonSubcommand,
  proSubcommand,
  domainSubcommand,
  buyCommand,
  purgeSubcommand,
  invalidateSubcommand,
  dangerouslyDeleteSubcommand,
  cacheCommand,
  removeSubcommand3,
  issueSubcommand,
  listSubcommand5,
  addSubcommand2 as addSubcommand,
  certsCommand,
  searchSubcommand,
  changelogCommand,
  createSubcommand2,
  updateSubcommand,
  listSubcommand6,
  removeSubcommand4,
  tokenSubcommand,
  revokeTokensSubcommand,
  openSubcommand,
  attachSubcommand,
  detachSubcommand,
  connexCommand,
  contractCommand,
  addSubcommand3 as addSubcommand2,
  listSubcommand7,
  runSubcommand,
  cronsCommand,
  curlCommand,
  deprecatedArchiveSplitTgz,
  initSubcommand,
  continueSubcommand,
  deployCommand,
  listSubcommand8,
  createSubcommand3,
  removeSubcommand5,
  deployHooksCommand,
  importSubcommand,
  listSubcommand9,
  addSubcommand4 as addSubcommand3,
  inspectSubcommand3,
  removeSubcommand6,
  updateSubcommand2,
  dnsCommand,
  listSubcommand10,
  inspectSubcommand4,
  addSubcommand5 as addSubcommand4,
  removeSubcommand7,
  priceSubcommand,
  searchSubcommand2,
  buySubcommand,
  checkSubcommand,
  moveSubcommand,
  transferInSubcommand,
  verifySubcommand,
  domainsCommand,
  overviewSubcommand,
  diffSubcommand,
  publishSubcommand,
  discardSubcommand,
  systemBypassListSubcommand,
  systemBypassAddSubcommand,
  systemBypassRemoveSubcommand,
  systemBypassSubcommand,
  ipBlocksListSubcommand,
  ipBlocksBlockSubcommand,
  ipBlocksUnblockSubcommand,
  ipBlocksSubcommand,
  rulesListSubcommand2,
  rulesInspectSubcommand,
  rulesAddSubcommand2,
  rulesEditSubcommand2,
  rulesEnableSubcommand,
  rulesDisableSubcommand,
  rulesRemoveSubcommand2,
  rulesReorderSubcommand,
  rulesSubcommand2,
  attackModeEnableSubcommand,
  attackModeDisableSubcommand,
  attackModeSubcommand,
  systemMitigationsPauseSubcommand,
  systemMitigationsResumeSubcommand,
  systemMitigationsSubcommand,
  firewallCommand,
  FLAG_CONDITION_LIST_COMPARATORS,
  FLAG_CONDITION_RHS_OPTIONAL_COMPARATORS,
  formatFlagConditionComparatorList,
  formatFlagConditionComparator,
  FLAG_EVALUATIONS_GRANULARITIES,
  isFlagEvaluationsGranularity,
  listSubcommand11,
  inspectSubcommand5,
  versionsListSubcommand,
  versionsDiffSubcommand,
  versionsSubcommand,
  evaluationsSubcommand,
  createSubcommand4,
  openSubcommand2,
  updateSubcommand3,
  setSubcommand2,
  splitSubcommand,
  rolloutSubcommand,
  rulesListSubcommand3,
  rulesAddSubcommand3,
  rulesUpdateSubcommand,
  rulesRemoveSubcommand3,
  rulesMoveSubcommand,
  rulesSubcommand3,
  removeSubcommand8,
  archiveSubcommand,
  unarchiveSubcommand,
  disableSubcommand,
  enableSubcommand,
  segmentsListSubcommand,
  segmentsInspectSubcommand,
  segmentsCreateSubcommand,
  segmentsUpdateSubcommand,
  segmentsRemoveSubcommand,
  segmentsSubcommand,
  sdkKeysListSubcommand,
  sdkKeysAddSubcommand,
  sdkKeysRemoveSubcommand,
  sdkKeysSubcommand,
  prepareSubcommand,
  overrideSubcommand,
  flagsCommand,
  connectSubcommand,
  disconnectSubcommand,
  gitCommand,
  listSubcommand12,
  addSubcommand6 as addSubcommand5,
  getSubcommand,
  updateSubcommand4,
  removeSubcommand9,
  itemsSubcommand,
  tokensSubcommand,
  backupsSubcommand,
  globalConfigCommand,
  statusSubcommand,
  enableSubcommand2,
  disableSubcommand2,
  guidanceCommand,
  httpstatCommand,
  initCommand,
  inspectCommand,
  removeSubcommand10,
  disconnectSubcommand2,
  connectSubcommand2,
  createThresholdSubcommand,
  claimSubcommand,
  inspectSubcommand6,
  integrationResourceCommand,
  addSubcommand7 as addSubcommand6,
  acceptTermsSubcommand,
  openSubcommand3,
  installationsSubcommand,
  listSubcommand13,
  discoverSubcommand,
  categoriesSubcommand,
  balanceSubcommand,
  updateSubcommand5,
  removeSubcommand11,
  guideSubcommand,
  resourceSubcommand,
  integrationCommand,
  installCommand,
  KMS_ALGORITHMS,
  PROJECT_GRANT_POLICY_KIND,
  isProjectGrant,
  issuerUrl,
  issuerJwksUrl,
  listSubcommand14,
  inspectSubcommand7,
  addSubcommand8 as addSubcommand7,
  importSubcommand2,
  updateSubcommand6,
  removeSubcommand12,
  addKeySubcommand,
  importKeySubcommand,
  activateKeySubcommand,
  revokeKeySubcommand,
  addGrantSubcommand,
  updateGrantSubcommand,
  removeGrantSubcommand,
  kmsCommand,
  addSubcommand as addSubcommand8,
  linkCommand,
  loginCommand,
  logoutCommand,
  CommandTimeout,
  logsCommand,
  mcpCommand,
  createGroupSubcommand,
  addToGroupSubcommand,
  removeFromGroupSubcommand,
  deleteGroupSubcommand,
  pullSubcommand,
  inspectGroupSubcommand,
  microfrontendsCommand,
  openCommand,
  addSubcommand9,
  checksAddFlags,
  checksRemoveFlags,
  checksSubcommand,
  inspectSubcommand8,
  listSubcommand15,
  pauseSubcommand,
  removeSubcommand13,
  renameSubcommand,
  updateSubcommand7,
  tokenSubcommand2,
  accessSummarySubcommand,
  membersSubcommand,
  protectionSubcommand,
  accessGroupsSubcommand,
  webAnalyticsSubcommand,
  speedInsightsSubcommand,
  projectCommand,
  statusSubcommand2,
  promoteCommand,
  redeployCommand,
  listSubcommand16,
  listVersionsSubcommand,
  addSubcommand10,
  uploadSubcommand,
  removeSubcommand14,
  promoteSubcommand,
  restoreSubcommand,
  redirectsCommand,
  removeCommand,
  statusSubcommand3,
  rollbackCommand,
  configureSubcommand,
  startSubcommand,
  approveSubcommand,
  abortSubcommand,
  completeSubcommand,
  fetchSubcommand,
  rollingReleaseCommand,
  checkSubcommand2,
  securityCommand,
  skillsCommand,
  listSubcommand17,
  targetCommand,
  requestSubcommand,
  addSubcommand11,
  listSubcommand18,
  switchSubcommand,
  inviteSubcommand,
  ssoSubcommand,
  membersSubcommand2,
  teamsCommand,
  listSubcommand19,
  addSubcommand12,
  removeSubcommand15,
  tokensCommand,
  statusSubcommand4,
  enableSubcommand3,
  flushSubcommand,
  disableSubcommand3,
  telemetryCommand,
  getSubcommand2,
  createSubcommand5,
  tracesCommand,
  upgradeCommand,
  usageCommand,
  listSubcommand20,
  installedSubcommand,
  useSubcommand,
  updateSubcommand8,
  autoupdateSubcommand,
  versionCommand,
  whoamiCommand,
  listSubcommand21,
  putSubcommand,
  delSubcommand,
  copySubcommand,
  getSubcommand3,
  putImageSubcommand,
  signedTokenSubcommand,
  presignSubcommand,
  createStoreSubcommand,
  deleteStoreSubcommand,
  emptyStoreSubcommand,
  getStoreInfoSubcommand,
  listStoresSubcommand,
  blobCommand,
  listSubcommand22,
  getSubcommand4,
  createSubcommand6,
  removeSubcommand16,
  webhooksCommand,
  getCommandAliases,
  commands,
  commandNames
};
