import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  fetchCatalogMetricDetailOrExit,
  fetchCombinedMetricListOrExit,
  fetchCustomMetricDetailOrExit,
  fetchMetricCatalogListOrExit,
  fetchMetricDetailOrExit
} from "./chunk-KAYSW4CJ.js";
import {
  formatErrorJson
} from "./chunk-CV4S27SS.js";
import {
  indent_default
} from "./chunk-A3NYPUKZ.js";
import {
  formatTable
} from "./chunk-BBSS3XIW.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  schemaSubcommand
} from "./chunk-EG5BSAXD.js";
import {
  getScope,
  require_pluralize
} from "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import "./chunk-J5ZEHLFM.js";
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
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/metrics/schema.ts
var import_pluralize = __toESM(require_pluralize(), 1);
async function schema(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(schemaSubcommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    printError(err);
    return 1;
  }
  const flags = parsedArgs.flags;
  const positionalArgs = parsedArgs.args.slice(1);
  const positionalMetric = positionalArgs[0] === "schema" ? positionalArgs[1] : positionalArgs[0];
  const formatResult = validateJsonOutput(flags);
  if (!formatResult.valid) {
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  const metric = positionalMetric;
  telemetry.trackCliArgumentMetricId(metric);
  telemetry.trackCliOptionFormat(flags["--format"]);
  const { team } = await getScope(client);
  if (!team) {
    const message = "The metrics schema API request was not authorized. Run `vercel login` to authenticate and `vercel switch` to select a team, then try again.";
    if (jsonOutput) {
      client.stdout.write(formatErrorJson("SCHEMA_UNAUTHORIZED", message));
    } else {
      output_manager_default.error(message);
    }
    return 1;
  }
  const useMetricsV1 = Boolean(process.env.FF_METRICS);
  if (metric) {
    const isPlatformMetric = metric.startsWith("vercel.");
    let detail;
    if (useMetricsV1) {
      const result = await fetchCatalogMetricDetailOrExit(
        client,
        team.id,
        jsonOutput,
        metric,
        isPlatformMetric ? "system" : "custom"
      );
      if (typeof result === "number")
        return result;
      detail = result;
    } else if (isPlatformMetric) {
      const result = await fetchMetricDetailOrExit(
        client,
        team.id,
        metric,
        jsonOutput
      );
      if (typeof result === "number")
        return result;
      detail = result;
    } else {
      const result = await fetchCustomMetricDetailOrExit(
        client,
        team.id,
        jsonOutput,
        metric
      );
      if (typeof result === "number")
        return result;
      detail = result;
    }
    if (detail.length === 0) {
      const message = `No metrics match "${metric}". Run \`vercel metrics schema\` to see available metrics.`;
      if (jsonOutput) {
        client.stdout.write(formatErrorJson("METRIC_NOT_FOUND", message));
      } else {
        output_manager_default.error(message);
      }
      return 1;
    }
    if (jsonOutput) {
      client.stdout.write(JSON.stringify(detail, null, 2));
      return 0;
    }
    output_manager_default.log(`Metric: ${metric}`);
    const metricsTable = formatMetricsTable(toDisplayMetrics(detail));
    if (metricsTable) {
      output_manager_default.print(metricsTable);
      output_manager_default.print("\n");
    }
    return 0;
  }
  const metricsOrExitCode = useMetricsV1 ? await fetchMetricCatalogListOrExit(client, team.id, jsonOutput) : await fetchCombinedMetricListOrExit(client, team.id, jsonOutput);
  if (typeof metricsOrExitCode === "number") {
    return metricsOrExitCode;
  }
  if (jsonOutput) {
    client.stdout.write(JSON.stringify(metricsOrExitCode, null, 2));
  } else {
    output_manager_default.log(`${(0, import_pluralize.default)("Metric", metricsOrExitCode.length, true)} found`);
    output_manager_default.print(formatMetricListTable(metricsOrExitCode));
    output_manager_default.print("\n");
  }
  return 0;
}
function formatMetricListTable(metrics) {
  return indent_default(
    formatTable(
      ["Metric", "Description"],
      ["l", "l"],
      [{ rows: metrics.map((metric) => [metric.id, metric.description]) }]
    ),
    1
  );
}
function toDisplayMetrics(metrics) {
  return metrics.map((metric) => {
    const dimensions = metric.dimensions.map(
      (dimension) => typeof dimension === "string" ? dimension : dimension.name
    );
    return {
      id: metric.id,
      description: metric.description,
      dimensions,
      unit: metric.unit,
      aggregations: metric.aggregations.map(
        (aggregation) => "defaultAggregation" in metric && aggregation === metric.defaultAggregation ? `${aggregation} (default)` : aggregation
      )
    };
  });
}
function formatMetricsTable(metrics) {
  if (metrics.length === 0) {
    return null;
  }
  const dimensionsByMetric = metrics.map((metric) => metric.dimensions);
  const sharedDimensions = dimensionsByMetric[0].filter(
    (dimension) => dimensionsByMetric.every(
      (metricDimensions) => metricDimensions.includes(dimension)
    )
  );
  const rows = metrics.map((metric) => {
    const extraDimensions = metric.dimensions.filter((dimension) => !sharedDimensions.includes(dimension)).map((dimension) => `+${dimension}`);
    const aggregations = metric.aggregations.join(", ");
    return {
      metric: metric.id,
      description: metric.description,
      unit: metric.unit,
      aggregations,
      extraDimensions
    };
  });
  const hasExtraDimensions = rows.some((row) => row.extraDimensions.length > 0);
  const tableHeaders = hasExtraDimensions ? ["Metric", "Description", "Unit", "Aggregations", "Dimensions"] : ["Metric", "Description", "Unit", "Aggregations"];
  const tableRows = rows.map(
    (row) => hasExtraDimensions ? [
      row.metric,
      row.description,
      row.unit,
      row.aggregations,
      row.extraDimensions.join(", ") || "\u2014"
    ] : [row.metric, row.description, row.unit, row.aggregations]
  );
  const sharedDimensionsLine = sharedDimensions.length > 0 ? metrics.length === 1 ? `Dimensions:
  ${sharedDimensions.join(", ")}` : `Shared dimensions:
  ${sharedDimensions.join(", ")}` : null;
  const table = indent_default(
    formatTable(
      tableHeaders,
      hasExtraDimensions ? ["l", "l", "l", "l", "l"] : ["l", "l", "l", "l"],
      [{ rows: tableRows }]
    ),
    1
  );
  return [`
${table}`, sharedDimensionsLine].filter(Boolean).join("\n\n");
}
export {
  schema as default
};
