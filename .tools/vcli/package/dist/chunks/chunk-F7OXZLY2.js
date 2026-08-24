import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  indent_default
} from "./chunk-A3NYPUKZ.js";
import {
  humanizeIdentifier
} from "./chunk-FGDKMNEN.js";
import {
  truncateMiddle
} from "./chunk-VDJN4WKH.js";
import {
  table
} from "./chunk-VAFU7DXZ.js";

// src/commands/alerts/format.ts
function renderAlertTable(rows, hsep = 3) {
  return indent_default(
    table(rows, { hsep }).split("\n").map((line) => line.trimEnd()).join("\n"),
    2
  );
}
function normalizeTimestamp(value) {
  if (value === void 0 || !Number.isFinite(value)) {
    return void 0;
  }
  return Math.abs(value) < 1e12 ? value * 1e3 : value;
}
function getPrimaryAlert(group) {
  return group.alerts?.[0];
}
function getGroupTitle(group) {
  return group.ai?.title || group.title || getPrimaryAlert(group)?.title || "Alert group";
}
function getGroupType(group) {
  return group.type || getPrimaryAlert(group)?.type || "-";
}
function getGroupStartedAt(group) {
  const primaryAlert = getPrimaryAlert(group);
  return normalizeTimestamp(
    group.recordedStartedAt ?? primaryAlert?.recordedStartedAt ?? primaryAlert?.startedAt
  );
}
function formatTriggerOperator(value) {
  switch (value) {
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    default:
      return void 0;
  }
}
function humanizeReference(value, opts = {}) {
  return value.split("/").map((part) => {
    const label = humanizeIdentifier(part);
    return opts.case === "title" ? label : label.toLowerCase();
  }).join(" / ");
}
function formatRuleScope(rule, {
  projectIdMaxLength = 48,
  filterMaxLength = 80
} = {}) {
  const { projectId } = rule;
  if (!projectId) {
    return "team-wide";
  }
  if (isCustomAlertRule(rule)) {
    return `project: ${truncateMiddle(projectId, projectIdMaxLength)}`;
  }
  return truncateMiddle(projectId, filterMaxLength);
}
function isCustomAlertRule(rule) {
  return Boolean(rule.customAlert) || Boolean(
    rule.alertTypes?.some((alertType) => alertType.type === "custom_alert")
  );
}
function formatCustomAlertTrigger(customAlert) {
  const operator = formatTriggerOperator(customAlert.triggerOperator);
  const threshold = typeof customAlert.triggerThreshold === "number" ? String(customAlert.triggerThreshold) : void 0;
  const trigger = customAlert.triggerType === "anomaly" ? `z-score ${[operator, threshold].filter(Boolean).join(" ")}` : ["threshold", operator, threshold].filter(Boolean).join(" ");
  return trigger || void 0;
}
function parseCustomAlertQuery(value) {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
function formatFormula(formula) {
  if (!formula?.left || !formula.right) {
    return void 0;
  }
  switch (formula.operator) {
    case "divide":
      return `${humanizeReference(formula.left)} / ${humanizeReference(
        formula.right
      )}`;
    default:
      return void 0;
  }
}
function formatCustomAlertMetric(customAlert) {
  const formula = formatFormula(customAlert.formula);
  if (formula) {
    return formula;
  }
  const query = parseCustomAlertQuery(customAlert.queryJsonString);
  const firstRollup = Object.values(query.rollups ?? {})[0];
  const parts = [query.event, firstRollup?.aggregation, firstRollup?.measure];
  const base = parts.flatMap((part) => part ? [humanizeReference(part)] : []).join(" ");
  const groupBy = query.groupBy ?? [];
  if (base && groupBy.length > 0) {
    return `${base} by ${groupBy.map((value) => humanizeReference(value)).join(", ")}`;
  }
  return base || void 0;
}

export {
  renderAlertTable,
  normalizeTimestamp,
  getGroupTitle,
  getGroupType,
  getGroupStartedAt,
  formatTriggerOperator,
  humanizeReference,
  formatRuleScope,
  isCustomAlertRule,
  formatCustomAlertTrigger,
  parseCustomAlertQuery,
  formatCustomAlertMetric
};
