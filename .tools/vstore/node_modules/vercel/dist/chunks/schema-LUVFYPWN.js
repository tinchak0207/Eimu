import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  CUSTOM_ALERT_EVENT_HELP
} from "./chunk-MXLA3VQS.js";
import {
  indent_default
} from "./chunk-A3NYPUKZ.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import {
  formatTable
} from "./chunk-BBSS3XIW.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  rulesSchemaSubcommand
} from "./chunk-UMA66MKW.js";
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
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import "./chunk-TZ2YI2VH.js";

// src/commands/alerts/rules/schema.ts
var RULE_TYPES = [
  {
    type: "usage_anomaly",
    description: "Built-in usage anomaly alerts"
  },
  {
    type: "error_anomaly",
    description: "Built-in error anomaly alerts"
  },
  {
    type: "custom_alert",
    description: "Custom Observability metric alerts"
  }
];
var BUILT_IN_COMMON_FIELDS = [
  field("name", "yes", "string", "Rule name"),
  field("alertTypes", "yes", "array", "One or more alert type configs"),
  field(
    "projectId",
    "no",
    "string",
    "OData project filter; omit for team-wide"
  ),
  field(
    "autosubscribeOwnersInKnock",
    "no",
    "boolean",
    "Subscribe project owners"
  )
];
var CUSTOM_ALERT_COMMON_FIELDS = [
  field("name", "yes", "string", "Rule name"),
  field(
    "projectId",
    "no",
    "string",
    "Defaults to --project or the linked project"
  ),
  field("alertTypes", "yes", "array", "One or more alert type configs"),
  field("customAlert", "yes", "object", "Custom alert definition"),
  field(
    "autosubscribeOwnersInKnock",
    "no",
    "boolean",
    "Subscribe project owners"
  )
];
var USAGE_METRICS = [
  "fluid_cpu_duration",
  "fluid_duration",
  "fast_data_transfer",
  "edge_requests",
  "function_invocations"
];
var customQueryJson = {
  event: "incomingRequest",
  rollups: {
    requests: {
      measure: "count",
      aggregation: "sum"
    }
  },
  groupBy: ["route"],
  granularity: { minutes: 5 }
};
var ratioQueryJson = {
  event: "incomingRequest",
  rollups: {
    numerator: {
      measure: "count",
      aggregation: "sum",
      filter: "httpStatus ge 500"
    },
    denominator: {
      measure: "count",
      aggregation: "sum"
    }
  },
  granularity: { hours: 1 }
};
var SCHEMAS = {
  usage_anomaly: {
    type: "usage_anomaly",
    description: "Built-in usage anomaly alerts",
    fields: [
      ...BUILT_IN_COMMON_FIELDS,
      field("alertTypes[].type", "yes", "string", "usage_anomaly"),
      field(
        "alertTypes[].filter",
        "no",
        "string",
        "OData filter for this type"
      )
    ],
    alertTypeFilterValues: [["metric", USAGE_METRICS.join(", ")]],
    examples: [
      {
        name: "Minimal",
        body: {
          name: "Usage anomalies",
          alertTypes: [{ type: "usage_anomaly" }]
        }
      },
      {
        name: "Filtered to one metric",
        body: {
          name: "Edge request anomalies",
          projectId: "projectId eq 'prj_123'",
          alertTypes: [
            { type: "usage_anomaly", filter: "metric eq 'edge_requests'" }
          ]
        }
      }
    ]
  },
  error_anomaly: {
    type: "error_anomaly",
    description: "Built-in error anomaly alerts",
    fields: [
      ...BUILT_IN_COMMON_FIELDS,
      field("alertTypes[].type", "yes", "string", "error_anomaly"),
      field(
        "alertTypes[].filter",
        "no",
        "string",
        "OData filter for this type"
      )
    ],
    alertTypeFilterValues: [
      ["statusGroup", "4xx, 5xx"],
      ["route", `route eq '/api/checkout', contains(route, '/api')`]
    ],
    examples: [
      {
        name: "Minimal",
        body: {
          name: "Error anomalies",
          alertTypes: [{ type: "error_anomaly" }]
        }
      },
      {
        name: "Filtered to 5xx on one route",
        body: {
          name: "Checkout 5xx errors",
          projectId: "projectId eq 'prj_123'",
          alertTypes: [
            {
              type: "error_anomaly",
              filter: "statusGroup eq '5xx' and route eq '/api/checkout'"
            }
          ]
        }
      }
    ]
  },
  custom_alert: {
    type: "custom_alert",
    description: "Custom Observability metric alerts",
    fields: [
      ...CUSTOM_ALERT_COMMON_FIELDS,
      field("alertTypes[].type", "yes", "string", "custom_alert")
    ],
    customAlertFields: [
      field(
        "customAlert.queryJsonString",
        "yes",
        "string",
        "Escaped query JSON"
      ),
      field("customAlert.triggerType", "yes", "string", "threshold, anomaly"),
      field("customAlert.triggerOperator", "yes", "string", "gt, gte, lt, lte"),
      field(
        "customAlert.triggerThreshold",
        "yes",
        "number",
        "Threshold value or z-score"
      ),
      field(
        "customAlert.minThreshold",
        "no",
        "number",
        "Minimum observed value"
      ),
      field(
        "customAlert.formula",
        "no",
        "object",
        "Ratio formula; left and right reference rollup keys"
      )
    ],
    queryJsonFields: [
      field("scope", "no", "object", "Project scope"),
      field(
        "event",
        "yes",
        "string",
        "Alert query event name, for example incomingRequest"
      ),
      field("rollups", "yes", "object", "Named measure aggregations"),
      field("rollups.*.measure", "yes", "string", "Metric measure"),
      field("rollups.*.aggregation", "yes", "string", "Metric aggregation"),
      field("rollups.*.filter", "no", "string", "Rollup-level OData filter"),
      field("groupBy", "no", "array", "At most one dimension"),
      field("filter", "no", "string", "Top-level OData filter"),
      field("granularity", "no", "object", "5m, 1h, or 1d; defaults to 5m")
    ],
    queryJsonBeforeEscaping: customQueryJson,
    help: CUSTOM_ALERT_EVENT_HELP,
    examples: [
      {
        name: "Anomaly",
        body: {
          name: "Request volume anomaly",
          alertTypes: [{ type: "custom_alert" }],
          customAlert: {
            queryJsonString: JSON.stringify(customQueryJson),
            triggerType: "anomaly",
            triggerOperator: "gt",
            triggerThreshold: 3
          }
        }
      },
      {
        name: "Threshold ratio",
        body: {
          name: "Checkout error rate",
          alertTypes: [{ type: "custom_alert" }],
          customAlert: {
            queryJsonString: JSON.stringify(ratioQueryJson),
            triggerType: "threshold",
            triggerOperator: "gt",
            triggerThreshold: 0.05,
            formula: {
              operator: "divide",
              left: "numerator",
              right: "denominator"
            },
            minThreshold: 20
          }
        }
      }
    ]
  }
};
async function schema(client, argv) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(rulesSchemaSubcommand.options)
    );
  } catch (err) {
    printError(err);
    return 1;
  }
  const formatResult = validateJsonOutput(parsedArgs.flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  const ruleType = normalizeRuleType(parsedArgs.flags["--type"]);
  if (!ruleType) {
    if (parsedArgs.flags["--type"]) {
      return outputError(
        client,
        jsonOutput,
        "INVALID_ARGUMENTS",
        `Invalid alert rule type "${String(parsedArgs.flags["--type"])}". Use usage_anomaly, error_anomaly, or custom_alert.`
      );
    }
    if (jsonOutput) {
      client.stdout.write(
        `${JSON.stringify({ types: RULE_TYPES }, null, 2)}
`
      );
    } else {
      output_manager_default.log("Alert rule schema");
      output_manager_default.print(
        `
${formatRows(
          ["Type", "Description"],
          RULE_TYPES.map((type) => [type.type, type.description])
        )}

Run \`vercel alerts rules schema --type <type>\` to see a rule body schema.
`
      );
    }
    return 0;
  }
  printRuleSchema(client, SCHEMAS[ruleType], jsonOutput);
  return 0;
}
function field(field2, required, type, notes) {
  return { field: field2, required, type, notes };
}
function normalizeRuleType(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return RULE_TYPES.some((type) => type.type === normalized) ? normalized : void 0;
}
function printRuleSchema(client, schema2, jsonOutput) {
  if (jsonOutput) {
    client.stdout.write(`${JSON.stringify({ schema: schema2 }, null, 2)}
`);
    return;
  }
  output_manager_default.log(`Alert rule schema: ${schema2.type}`);
  output_manager_default.print("\n");
  printFieldSection("Fields", schema2.fields);
  if (schema2.alertTypeFilterValues) {
    output_manager_default.print("alertTypes[].filter values\n\n");
    output_manager_default.print(
      `${formatRows(
        ["Field", "Allowed values / examples"],
        schema2.alertTypeFilterValues
      )}

`
    );
  }
  if (schema2.customAlertFields) {
    printFieldSection("Custom alert fields", schema2.customAlertFields);
  }
  if (schema2.queryJsonFields) {
    printFieldSection(
      "customAlert.queryJsonString fields",
      schema2.queryJsonFields
    );
  }
  if (schema2.queryJsonBeforeEscaping) {
    output_manager_default.print("customAlert.queryJsonString before escaping\n\n");
    output_manager_default.print(
      `${indent_default(JSON.stringify(schema2.queryJsonBeforeEscaping, null, 2), 2)}

`
    );
  }
  if (schema2.help) {
    output_manager_default.print("Custom alert metric discovery\n\n");
    output_manager_default.print(`${indent_default(schema2.help.join("\n"), 2)}

`);
  }
  output_manager_default.print("Body examples\n\n");
  for (const example of schema2.examples) {
    output_manager_default.print(`  ${example.name}

`);
    output_manager_default.print(`${indent_default(JSON.stringify(example.body, null, 2), 4)}

`);
  }
}
function printFieldSection(title, fields) {
  output_manager_default.print(`${title}

`);
  output_manager_default.print(
    `${formatRows(
      ["Field", "Required", "Type", "Values / notes"],
      fields.map((field2) => [
        field2.field,
        field2.required,
        field2.type,
        field2.notes
      ])
    )}

`
  );
}
function formatRows(headers, rows) {
  const alignment = headers.map(() => "l");
  const tableRows = rows.map((row) => [...row]);
  return formatTable(headers, alignment, [{ rows: tableRows }]).trim();
}
export {
  schema as default
};
