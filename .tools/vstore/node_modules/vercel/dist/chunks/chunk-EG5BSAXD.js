import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  formatOption,
  jsonOption,
  packageName,
  projectOption
} from "./chunk-SOFC4MLS.js";

// src/commands/metrics/command.ts
var schemaSubcommand = {
  name: "schema",
  aliases: [],
  description: "List available metrics or inspect a specific metric.",
  arguments: [{ name: "metric-or-prefix", required: false }],
  options: [formatOption, jsonOption],
  examples: [
    {
      name: "List all metrics",
      value: `${packageName} metrics schema`
    },
    {
      name: "Show metric details",
      value: `${packageName} metrics schema vercel.function_invocation`
    },
    {
      name: "Schema as JSON for agents",
      value: `${packageName} metrics schema vercel.request.count --json`
    }
  ]
};
var metricsCommand = {
  name: "metrics",
  aliases: [],
  description: "Query observability metrics for your Vercel project or team.",
  arguments: [{ name: "metric-id", required: false }],
  subcommands: [
    // Hidden placeholder so the help synopsis renders [command] as optional
    // (help.ts treats `command` as required unless a subcommand has `default: true`)
    {
      name: "query",
      aliases: [],
      description: "",
      default: true,
      hidden: true,
      arguments: [],
      options: [],
      examples: []
    },
    schemaSubcommand
  ],
  options: [
    {
      name: "aggregation",
      shorthand: "a",
      type: String,
      deprecated: false,
      description: "Aggregation function (default: sum for counts/bytes/currency, avg for durations/memory/ratios)",
      argument: "FN"
    },
    {
      name: "group-by",
      shorthand: null,
      type: [String],
      deprecated: false,
      description: "Dimensions to group by (repeatable)",
      argument: "DIM"
    },
    {
      name: "limit",
      shorthand: "l",
      type: Number,
      deprecated: false,
      description: "Max groups per time bucket (default: 10)",
      argument: "N"
    },
    {
      name: "order-by",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Order grouped results by value or count (default: count, or value when count is unsupported)",
      argument: "value|count"
    },
    {
      name: "order",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Order direction for grouped results: asc or desc (default: desc)",
      argument: "asc|desc"
    },
    {
      name: "filter",
      shorthand: "f",
      type: [String],
      deprecated: false,
      get description() {
        return process.env.FF_METRICS ? "KQL filter expression (repeatable, ANDed together)" : "OData filter expression (repeatable, ANDed together)";
      },
      argument: "EXPR"
    },
    {
      name: "prod",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Limit query to the production environment"
    },
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
      description: "Time bucket size: 5m, 15m, 1h, 1d (default: auto)",
      argument: "SIZE"
    },
    {
      name: "bucket-timezone",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "IANA timezone for calendar bucket alignment only; does not shift --since/--until or output timestamps (e.g., Europe/Paris)",
      argument: "ZONE"
    },
    {
      ...projectOption,
      shorthand: "p"
    },
    {
      name: "all",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Query across all projects for the team"
    },
    formatOption,
    jsonOption
  ],
  get examples() {
    const canonical = Boolean(process.env.FF_METRICS);
    const httpStatus = canonical ? "httpStatus" : "http_status";
    const errorCode = canonical ? "errorCode" : "error_code";
    const aiProvider = canonical ? "aiProvider" : "ai_provider";
    const visitorId = canonical ? "visitorId" : "visitor_id";
    const projectId = canonical ? "projectId" : "project_id";
    const statusFilter = canonical ? "httpStatus >= 500" : "http_status ge 500";
    const routeFilter = canonical ? `'route:"/api"'` : `"contains(request_path, '/api')"`;
    return [
      {
        name: "5xx errors by error code in the last hour",
        value: `${packageName} metrics vercel.function_invocation.count -f "${statusFilter}" --group-by ${errorCode} --since 1h`
      },
      {
        name: "Function invocations by HTTP status code",
        value: `${packageName} metrics vercel.function_invocation.count --group-by ${httpStatus} --since 6h`
      },
      {
        name: "Function duration by route",
        value: `${packageName} metrics vercel.function_invocation.function_duration_ms -a avg --group-by route --since 1h`
      },
      {
        name: "AI Gateway costs by provider",
        value: `${packageName} metrics vercel.ai_gateway_request.cost -a sum --group-by ${aiProvider} --since 7d`
      },
      {
        name: "Core Web Vitals (LCP) by route",
        value: `${packageName} metrics vercel.speed_insights.lcp_ms -a p75 --prod --group-by route --since 7d`
      },
      {
        name: "Routes with the lowest p75 LCP",
        value: `${packageName} metrics vercel.speed_insights.lcp_ms -a p75 --prod --group-by route --since 7d --order-by value --order asc`
      },
      {
        name: canonical ? "Daily pageviews" : "Daily pageviews with a Paris-aligned bucket",
        value: canonical ? `${packageName} metrics vercel.analytics_pageview.count --since 2026-05-28 --until 2026-05-29 --granularity 1d` : `${packageName} metrics vercel.analytics_pageview.count --since 2026-05-28 --until 2026-05-29 --granularity 1d --bucket-timezone Europe/Paris`
      },
      {
        name: "Visitors time series from the top 5 countries",
        value: `${packageName} metrics vercel.analytics_pageview.count -a unique/${visitorId} --group-by country --since 1d --granularity 1h --limit 5`
      },
      {
        name: "List available metrics",
        value: `${packageName} metrics schema`
      },
      {
        name: "Function executions matching an API route",
        value: `${packageName} metrics vercel.function_invocation.count -f ${routeFilter} --group-by route --since 1h`
      },
      {
        name: "Function executions matching multiple filters",
        value: `${packageName} metrics vercel.function_invocation.count -f "${statusFilter}" -f ${routeFilter} --since 1h`
      },
      {
        name: "Show schema for a metric prefix",
        value: `${packageName} metrics schema vercel.request`
      },
      {
        name: "Team-wide function executions by project",
        value: `${packageName} metrics --all vercel.function_invocation.count --group-by ${projectId} --since 24h`
      }
    ];
  }
};

export {
  schemaSubcommand,
  metricsCommand
};
