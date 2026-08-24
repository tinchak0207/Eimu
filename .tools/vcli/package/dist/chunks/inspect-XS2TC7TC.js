import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  formatTriggerOperator,
  getGroupStartedAt,
  getGroupTitle,
  getGroupType,
  humanizeReference,
  normalizeTimestamp,
  renderAlertTable
} from "./chunk-F7OXZLY2.js";
import {
  resolveAlertsScope
} from "./chunk-6GWLC2IP.js";
import {
  formatDate
} from "./chunk-GZLPFESR.js";
import {
  formatGranularity
} from "./chunk-5AJPMLDV.js";
import "./chunk-A3NYPUKZ.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import "./chunk-FGDKMNEN.js";
import "./chunk-PRWJUY5U.js";
import {
  truncateEnd,
  truncateMiddle
} from "./chunk-VDJN4WKH.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  inspectSubcommand
} from "./chunk-3L2YLLHC.js";
import "./chunk-UMA66MKW.js";
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

// src/commands/alerts/inspect.ts
var import_chalk = __toESM(require_source(), 1);
var aggregationLabels = {
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  p50: "P50",
  p75: "P75",
  p90: "P90",
  p95: "P95",
  p99: "P99",
  stddev: "Std Dev",
  unique: "Unique",
  persecond: "Per Second",
  percent: "Percent"
};
var formatCustomAlertRatioBelowFivePercent = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "percent"
});
var formatCustomAlertRatioThresholdValue = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
  minimumFractionDigits: 0,
  style: "percent"
});
function getGroupStatus(group) {
  if (group.status) {
    return group.status;
  }
  const alerts = group.alerts ?? [];
  if (alerts.some((alert) => alert.status === "active")) {
    return "active";
  }
  if (alerts.length > 0) {
    return "resolved";
  }
  return "-";
}
function humanizeLabel(value) {
  return humanizeReference(value, { case: "title" });
}
function formatAlertFieldValue(value, maxLength = 64) {
  if (value === null || value === void 0) {
    return void 0;
  }
  const displayValue = typeof value === "number" ? formatNumber(value) : String(value);
  if (!displayValue) {
    return void 0;
  }
  return truncateMiddle(displayValue, maxLength);
}
function formatNumber(value) {
  const absValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  for (const [threshold, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"]
  ]) {
    if (absValue >= threshold) {
      return `${sign}${(absValue / threshold).toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}
function parseFormattedNumber(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
  }
  const number = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(number) ? number : void 0;
}
function formatRatio(value) {
  if (value.trim().endsWith("%")) {
    return value;
  }
  const number = parseFormattedNumber(value);
  if (number === void 0) {
    return value;
  }
  const percent = number * 100;
  if (percent >= 5) {
    return `${Math.floor(percent)}%`;
  }
  return formatCustomAlertRatioBelowFivePercent.format(number);
}
function formatRatioThreshold(value) {
  if (value.trim().endsWith("%")) {
    return value;
  }
  const number = parseFormattedNumber(value);
  return number === void 0 ? value : formatCustomAlertRatioThresholdValue.format(number);
}
function getAlertSonarQuery(alert) {
  return alert.sonarQuery ?? alert.data?.sonarQuery;
}
function getCustomAlertBaselineTitle(alert) {
  const granularity = getAlertSonarQuery(alert)?.granularity;
  const baseline = granularity && ("hours" in granularity || "days" in granularity) ? "7-day baseline" : "24-hour baseline";
  return baseline.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}
function appendUnit(value, unit) {
  if (!unit || unit === "score") {
    return value;
  }
  if (unit === "ratio") {
    return formatRatio(value);
  }
  if (unit === "%") {
    return value.endsWith("%") ? value : `${value}%`;
  }
  if (value.toLowerCase().includes(unit.toLowerCase())) {
    return value;
  }
  return `${value} ${unit}`;
}
function formatThreshold(alert) {
  const data = alert.data;
  const formatted = alert.formattedValues?.formattedThreshold ?? (data?.triggerThreshold === void 0 ? void 0 : formatNumber(data.triggerThreshold));
  if (!formatted) {
    return void 0;
  }
  const operator = formatTriggerOperator(data?.triggerOperator);
  const threshold = data?.triggerType === "anomaly" ? `${formatted} z-score` : alert.unit === "ratio" ? formatRatioThreshold(formatted) : appendUnit(formatted, alert.unit);
  return [operator, threshold].filter(Boolean).join(" ");
}
function getRuleIds(alert) {
  const ids = /* @__PURE__ */ new Set();
  const dataRuleId = alert.data?.ruleId;
  if (dataRuleId) {
    ids.add(dataRuleId);
  }
  for (const ruleId of alert.rules ?? []) {
    if (ruleId) {
      ids.add(ruleId);
    }
  }
  return [...ids];
}
function getAlertResolvedAt(alert) {
  return normalizeTimestamp(alert.recordedResolvedAt ?? alert.resolvedAt);
}
function getSignalRows(alert) {
  const rows = [];
  const formattedValues = alert.formattedValues ?? {};
  const observed = formattedValues.formattedCount;
  const baseline = formattedValues.formattedAvg;
  const change = [formattedValues.changeDirection, formattedValues.changeAmount].filter(Boolean).join(" ");
  const zscore = alert.data?.zscore;
  const threshold = formatThreshold(alert);
  const minThreshold = alert.data?.minThreshold;
  const isRatioFormulaAlert = Boolean(getCustomAlertFormula(alert));
  if (alert.eventLabel) {
    rows.push(["Event", alert.eventLabel]);
  }
  if (alert.measureLabel) {
    rows.push(["Measure", alert.measureLabel]);
  }
  if (observed) {
    rows.push(["Observed Value", appendUnit(observed, alert.unit)]);
  }
  if (baseline) {
    rows.push([
      alert.type === "custom_alert" && alert.data?.triggerType === "anomaly" ? getCustomAlertBaselineTitle(alert) : "Baseline",
      appendUnit(baseline, alert.unit)
    ]);
  }
  if (change) {
    rows.push(["Change", change]);
  }
  if (zscore !== void 0) {
    rows.push(["Observed Deviation", `${formatNumber(zscore)} z-score`]);
  }
  if (threshold) {
    rows.push(["Threshold", threshold]);
  }
  if (minThreshold !== void 0 && !isRatioFormulaAlert) {
    rows.push([
      "Minimum",
      alert.unit === "ratio" ? formatNumber(minThreshold) : appendUnit(formatNumber(minThreshold), alert.unit)
    ]);
  }
  if (formattedValues.errorRate) {
    rows.push(["Error Rate", formattedValues.errorRate]);
  }
  if (formattedValues.avgErrorRate) {
    rows.push(["Baseline Error Rate", formattedValues.avgErrorRate]);
  }
  rows.push(...getFieldRows(alert));
  return rows;
}
function getFieldRows(alert) {
  const fields = alert.data?.fields;
  if (!fields) {
    return [];
  }
  const groupBy = getAlertSonarQuery(alert)?.groupBy ?? [];
  const fieldKeys = [
    ...groupBy,
    ...Object.keys(fields).filter((key) => !groupBy.includes(key))
  ];
  return fieldKeys.flatMap((key) => {
    const value = fields[key];
    const displayValue = formatAlertFieldValue(value);
    return displayValue ? [[humanizeLabel(key), displayValue]] : [];
  });
}
function formatAggregation(value) {
  return value ? aggregationLabels[value] ?? humanizeLabel(value) : void 0;
}
function formatQueryReference(value) {
  return value ? humanizeLabel(value) : void 0;
}
function formatRollupDetail(rollup, fallbackMeasure) {
  if (!rollup) {
    return void 0;
  }
  const aggregation = formatAggregation(rollup.aggregation);
  const measure = fallbackMeasure ?? formatQueryReference(rollup.measure);
  const detail = [aggregation, measure].filter(Boolean).join(" ");
  return detail || void 0;
}
function getPrimaryRollup(rollups) {
  return Object.values(rollups ?? {})[0];
}
function getCustomAlertFormula(alert) {
  const formula = alert.data?.formula;
  if (formula?.operator === "divide" && formula.left && formula.right) {
    return {
      operator: formula.operator,
      left: formula.left,
      right: formula.right
    };
  }
  return void 0;
}
function getQueryRows(alert) {
  if (alert.type !== "custom_alert") {
    return [];
  }
  const query = getAlertSonarQuery(alert);
  if (!query) {
    return [];
  }
  const formula = getCustomAlertFormula(alert);
  const rows = [];
  const addRow = (label, value) => {
    if (value) {
      rows.push([label, truncateMiddle(value, 120)]);
    }
  };
  addRow("Event", alert.eventLabel ?? formatQueryReference(query.event));
  if (formula) {
    addRow("Numerator", formatRollupDetail(query.rollups?.[formula.left]));
    addRow("Denominator", formatRollupDetail(query.rollups?.[formula.right]));
  } else {
    const primaryRollup = getPrimaryRollup(query.rollups);
    addRow(
      "Measure",
      alert.measureLabel ?? formatQueryReference(primaryRollup?.measure)
    );
    addRow("Aggregation", formatAggregation(primaryRollup?.aggregation));
  }
  addRow("Granularity", formatGranularity(query.granularity));
  const groupBy = query.groupBy?.filter(Boolean) ?? [];
  if (groupBy.length > 0) {
    addRow("Group by", groupBy.map(humanizeLabel).join(", "));
  }
  if (formula && typeof alert.data?.minThreshold === "number") {
    addRow("Minimum Numerator", formatNumber(alert.data.minThreshold));
  }
  addRow("Filter by", query.filter?.trim());
  if (formula) {
    for (const [label, rollupName] of [
      ["Numerator filter", formula.left],
      ["Denominator filter", formula.right]
    ]) {
      addRow(label, query.rollups?.[rollupName]?.filter?.trim());
    }
  }
  return rows;
}
function getDetailRows(alert) {
  const data = alert.data;
  if (!data) {
    return [];
  }
  const rows = [];
  const addRow = (label, value) => {
    const displayValue = formatAlertFieldValue(value);
    if (displayValue) {
      rows.push([label, displayValue]);
    }
  };
  addRow("Route", data.route);
  addRow("Status Group", data.statusGroup);
  addRow("Deployment ID", data.deploymentId);
  return rows;
}
function renderAlertSections(alert) {
  const lines = [];
  const signalRows = getSignalRows(alert);
  if (signalRows.length > 0) {
    lines.push(import_chalk.default.cyan("Signals"));
    lines.push(renderAlertTable(signalRows, 3));
  }
  const queryRows = getQueryRows(alert);
  if (queryRows.length > 0) {
    lines.push(import_chalk.default.cyan("Query"));
    lines.push(renderAlertTable(queryRows, 3));
  }
  return lines.join("\n");
}
function renderAlert(alert, index, totalAlerts) {
  const title = alert.title || `Alert ${index + 1}`;
  const ruleIds = getRuleIds(alert);
  const resolvedAt = getAlertResolvedAt(alert);
  const sections = renderAlertSections(alert);
  const summaryRows = [
    ["Alert id", alert.id || "-"],
    ["Type", alert.type || "-"],
    ["Status", alert.status || "-"],
    [
      "Started At",
      formatDate(
        normalizeTimestamp(alert.recordedStartedAt ?? alert.startedAt)
      )
    ],
    ...resolvedAt !== void 0 ? [["Resolved At", formatDate(resolvedAt)]] : [],
    ...ruleIds.length > 0 ? [["Rule id", ruleIds.map((id) => truncateMiddle(id, 48)).join(", ")]] : [],
    ...getDetailRows(alert)
  ];
  return [
    import_chalk.default.bold(totalAlerts > 1 ? `Alert ${index + 1}: ${title}` : title),
    renderAlertTable(summaryRows, 3),
    ...sections ? [sections] : []
  ].join("\n");
}
function printAlertGroup(group, groupId) {
  const alerts = group.alerts ?? [];
  const singleAlert = alerts.length === 1 ? alerts[0] : void 0;
  const singleAlertRuleIds = singleAlert ? getRuleIds(singleAlert) : [];
  const singleAlertResolvedAt = singleAlert ? getAlertResolvedAt(singleAlert) : void 0;
  const summaryRows = [
    ["Title", truncateEnd(getGroupTitle(group), 80)],
    ["Group id", group.id || groupId],
    ["Type", getGroupType(group)],
    ["Status", getGroupStatus(group)],
    ["Started At", formatDate(getGroupStartedAt(group))],
    ...singleAlertResolvedAt !== void 0 ? [["Resolved At", formatDate(singleAlertResolvedAt)]] : [],
    ["Alerts", String(alerts.length)],
    ...singleAlert?.id ? [["Alert id", singleAlert.id]] : [],
    ...singleAlertRuleIds.length > 0 ? [
      [
        "Rule id",
        singleAlertRuleIds.map((id) => truncateMiddle(id, 48)).join(", ")
      ]
    ] : [],
    ...singleAlert ? getDetailRows(singleAlert) : []
  ];
  const renderedAlerts = alerts.length > 0 ? alerts.length === 1 ? renderAlertSections(alerts[0]) : alerts.map((alert, index) => renderAlert(alert, index, alerts.length)).join("\n\n") : "No alerts in this group.";
  output_manager_default.print(
    [
      "",
      `${import_chalk.default.bold("Alert group")} ${import_chalk.default.cyan(group.id || groupId)}`,
      renderAlertTable(summaryRows, 3),
      "",
      renderedAlerts,
      ""
    ].join("\n")
  );
}
async function inspect(client, argv) {
  let parsedArgs;
  const spec = getFlagsSpecification(inspectSubcommand.options);
  try {
    parsedArgs = parseArguments(argv, spec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const projectFlagMissingArg = msg.includes("--project") && msg.includes("requires argument");
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: projectFlagMissingArg ? "`--project` requires a project name or id (for example `--project my-app`)." : msg,
        next: projectFlagMissingArg ? [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts inspect <groupId> --project <name-or-id>"
            ),
            when: "Re-run with placeholders replaced"
          }
        ] : [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts inspect --help"
            ),
            when: "See valid `alerts inspect` usage"
          }
        ]
      },
      1
    );
    printError(e);
    return 1;
  }
  const groupId = parsedArgs.args[0];
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
  if (!groupId) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message: `Missing group id. Example: ${packageName} alerts inspect <groupId>`,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts inspect <groupId>"
            ),
            when: "Replace <groupId> with a group id from `vercel alerts`"
          }
        ]
      },
      1
    );
    return outputError(
      client,
      fr.jsonOutput,
      "MISSING_ARGUMENTS",
      "Usage: `vercel alerts inspect <groupId>`"
    );
  }
  const scope = await resolveAlertsScope(client, {
    project: parsedArgs.flags["--project"],
    all: parsedArgs.flags["--all"],
    jsonOutput: fr.jsonOutput,
    command: `alerts inspect ${groupId}`
  });
  if (typeof scope === "number") {
    return scope;
  }
  const query = new URLSearchParams({ teamId: scope.teamId });
  if (scope.projectId) {
    query.set("projectId", scope.projectId);
  }
  const path = `/alerts/v3/groups/${encodeURIComponent(groupId)}?${query.toString()}`;
  output_manager_default.spinner("Fetching alert group...");
  try {
    const group = await client.fetch(path);
    if (fr.jsonOutput) {
      client.stdout.write(`${JSON.stringify({ group }, null, 2)}
`);
    } else {
      printAlertGroup(group, groupId);
    }
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      const msg = err.serverMessage || `API error (${err.status}).`;
      const reason = err.status === 401 ? "not_authorized" : err.status === 403 ? "forbidden" : err.status === 404 ? AGENT_REASON.NOT_FOUND : err.status === 429 ? "rate_limited" : AGENT_REASON.API_ERROR;
      outputAgentError(
        client,
        {
          status: "error",
          reason,
          message: msg,
          ...err.status === 401 || err.status === 403 ? {
            hint: "Confirm team scope; use --scope <team-slug> if the group belongs to another team.",
            next: [
              {
                command: buildCommandWithGlobalFlags(client.argv, "whoami"),
                when: "See current user and team"
              },
              {
                command: buildCommandWithGlobalFlags(
                  client.argv,
                  `alerts inspect ${groupId}`
                ),
                when: "Retry after fixing scope or permissions"
              }
            ]
          } : {}
        },
        1
      );
      return outputError(client, fr.jsonOutput, err.code || "API_ERROR", msg);
    }
    throw err;
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  inspect as default
};
