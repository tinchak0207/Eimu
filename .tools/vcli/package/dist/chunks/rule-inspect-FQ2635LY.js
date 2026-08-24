import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  emitRulesArgParseError,
  handleRulesApiError,
  parseRulesFlagsAndScope,
  rulesItemPath
} from "./chunk-Q6QCRFTC.js";
import {
  formatCustomAlertMetric,
  formatCustomAlertTrigger,
  formatRuleScope,
  humanizeReference,
  isCustomAlertRule,
  parseCustomAlertQuery,
  renderAlertTable
} from "./chunk-F7OXZLY2.js";
import "./chunk-6GWLC2IP.js";
import {
  formatDate
} from "./chunk-GZLPFESR.js";
import {
  formatGranularity
} from "./chunk-5AJPMLDV.js";
import "./chunk-A3NYPUKZ.js";
import "./chunk-KQRVZWJU.js";
import "./chunk-FGDKMNEN.js";
import "./chunk-PRWJUY5U.js";
import {
  truncateMiddle
} from "./chunk-VDJN4WKH.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  rulesInspectSubcommand
} from "./chunk-UMA66MKW.js";
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
  isAPIError,
  packageName
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

// src/commands/alerts/rules/rule-inspect.ts
var import_chalk = __toESM(require_source(), 1);
function formatBoolean(value) {
  if (value === void 0) {
    return "-";
  }
  return value ? "yes" : "no";
}
function getAlertTypeRows(rule) {
  const types = rule.alertTypes?.map((alertType) => alertType.type) ?? (rule.customAlert ? ["custom_alert"] : []);
  if (types.length === 0) {
    return [];
  }
  const uniqueTypes = [...new Set(types)];
  return [
    [
      uniqueTypes.length === 1 ? "Type" : "Types",
      uniqueTypes.map((value) => humanizeReference(value)).join(", ")
    ]
  ];
}
function getNotificationRows(rule) {
  const rows = [];
  if (rule.autosubscribeOwnersInKnock !== void 0) {
    rows.push([
      "Auto-subscribe owners",
      formatBoolean(rule.autosubscribeOwnersInKnock)
    ]);
  }
  const slackChannels = /* @__PURE__ */ new Set();
  const webhooks = /* @__PURE__ */ new Set();
  for (const notification of rule.notifications ?? []) {
    for (const channel of notification.slack ?? []) {
      slackChannels.add(channel);
    }
    for (const webhook of notification.webhooks ?? []) {
      webhooks.add(webhook);
    }
  }
  if (slackChannels.size > 0) {
    rows.push(["Slack", [...slackChannels].join(", ")]);
  }
  if (webhooks.size > 0) {
    rows.push(["Webhooks", [...webhooks].join(", ")]);
  }
  return rows;
}
function getCustomAlertRows(customAlert) {
  const query = parseCustomAlertQuery(customAlert.queryJsonString);
  const granularity = formatGranularity(query.granularity);
  const groupBy = query.groupBy ?? [];
  const rows = [
    ["Title", customAlert.title || "-"],
    ["Metric", formatCustomAlertMetric(customAlert) || "-"],
    ["Trigger", formatCustomAlertTrigger(customAlert) || "-"],
    ...typeof customAlert.minThreshold === "number" ? [["Minimum", String(customAlert.minThreshold)]] : [],
    ...query.event ? [["Event", humanizeReference(query.event)]] : [],
    ...groupBy.length > 0 ? [
      [
        "Group By",
        groupBy.map((value) => humanizeReference(value)).join(", ")
      ]
    ] : [],
    ...granularity ? [["Granularity", granularity]] : [],
    ...customAlert.createdAt ? [["Created At", formatDate(customAlert.createdAt)]] : []
  ];
  return rows.map(([label, value]) => [label, truncateMiddle(value, 96)]);
}
function printRule(rule, ruleId) {
  const summaryRows = [
    ["Name", rule.name || "-"],
    ...rule.action === "exclude" ? [["Action", rule.action]] : [],
    ["Scope", formatRuleScope(rule)],
    ...getAlertTypeRows(rule),
    ...rule.isDefault !== void 0 ? [["Default", formatBoolean(rule.isDefault)]] : [],
    ...rule.owner ? [["Owner", rule.owner]] : [],
    ...rule.teamId ? [["Team id", rule.teamId]] : [],
    ...rule.lastEditedByUserId ? [["Last Edited By", rule.lastEditedByUserId]] : [],
    ...rule.odataFilters ? [["OData Filters", rule.odataFilters]] : []
  ];
  const sections = [
    "",
    `${import_chalk.default.bold("Alert rule")} ${import_chalk.default.cyan(rule.id || ruleId)}`,
    renderAlertTable(summaryRows, 3)
  ];
  const notificationRows = getNotificationRows(rule);
  if (notificationRows.length > 0) {
    sections.push(
      "",
      import_chalk.default.cyan("Notifications"),
      renderAlertTable(notificationRows, 3)
    );
  }
  if (rule.customAlert) {
    sections.push(
      "",
      import_chalk.default.cyan("Custom Alert"),
      renderAlertTable(getCustomAlertRows(rule.customAlert), 3)
    );
  } else if (isCustomAlertRule(rule)) {
    sections.push(
      "",
      import_chalk.default.cyan("Custom Alert"),
      "  No custom alert definition returned."
    );
  }
  output_manager_default.print(`${sections.join("\n")}
`);
}
async function ruleInspect(client, argv) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(rulesInspectSubcommand.options)
    );
  } catch (e) {
    emitRulesArgParseError(
      client,
      e,
      "alerts rules inspect <ruleId> --project <name-or-id>"
    );
    printError(e);
    return 1;
  }
  const ruleId = parsedArgs.args[0];
  const fr = validateJsonOutput(parsedArgs.flags);
  if (!fr.valid) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: fr.error
      },
      1
    );
    output_manager_default.error(fr.error);
    return 1;
  }
  if (!ruleId) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message: `Missing rule id. Example: ${packageName} alerts rules inspect <ruleId>`,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts rules inspect <ruleId>"
            ),
            when: "Replace <ruleId> with an id from `alerts rules ls`"
          },
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts rules ls"
            ),
            when: "List rule ids in the current scope"
          }
        ]
      },
      1
    );
    output_manager_default.error("Usage: `vercel alerts rules inspect <ruleId>`");
    return 1;
  }
  const scope = await parseRulesFlagsAndScope(
    client,
    {
      "--project": parsedArgs.flags["--project"],
      "--all": parsedArgs.flags["--all"]
    },
    fr.jsonOutput,
    `alerts rules inspect ${ruleId}`
  );
  if (typeof scope === "number") {
    return scope;
  }
  const path = rulesItemPath(scope, ruleId);
  output_manager_default.spinner("Fetching alert rule...");
  try {
    const rule = await client.fetch(path);
    output_manager_default.stopSpinner();
    if (fr.jsonOutput) {
      client.stdout.write(`${JSON.stringify({ rule }, null, 2)}
`);
    } else {
      printRule(rule, ruleId);
    }
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      return handleRulesApiError(client, err, fr.jsonOutput);
    }
    throw err;
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  ruleInspect as default
};
