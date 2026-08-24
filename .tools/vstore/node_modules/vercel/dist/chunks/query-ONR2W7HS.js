import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  OBSERVABILITY_METRICS_PATH,
  fetchCatalogMetricDetailOrExit,
  fetchMetricDetailOrExit,
  getDefaultAggregation
} from "./chunk-KAYSW4CJ.js";
import {
  computeGranularity,
  formatText,
  getDefaultCustomMetricAggregation,
  isCanonicalAggregation
} from "./chunk-MWYQ24FO.js";
import {
  formatErrorJson,
  formatQueryJson,
  getRollupColumnName,
  handleApiError
} from "./chunk-CV4S27SS.js";
import "./chunk-5AJPMLDV.js";
import "./chunk-A3NYPUKZ.js";
import {
  resolveTimeRange,
  validateAllProjectMutualExclusivity
} from "./chunk-KQRVZWJU.js";
import "./chunk-VDJN4WKH.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  metricsCommand
} from "./chunk-EG5BSAXD.js";
import "./chunk-VXYGCOKL.js";
import {
  getLinkedProject,
  getProjectByNameOrId,
  getScope
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
  ProjectNotFound,
  getFlagsSpecification,
  isAPIError
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

// src/commands/metrics/query.ts
var import_chalk = __toESM(require_source(), 1);

// src/commands/metrics/validation.ts
function validateRequiredMetric(metric) {
  if (metric) {
    return { valid: true, value: metric };
  }
  return {
    valid: false,
    code: "MISSING_METRIC",
    message: "Missing required metric. Specify the metric to query.\n\nRun 'vercel metrics schema' to see available metrics."
  };
}
function validateOrderDirection(orderDirection) {
  if (orderDirection === void 0) {
    return { valid: true, value: void 0 };
  }
  if (orderDirection === "asc" || orderDirection === "desc") {
    return { valid: true, value: orderDirection };
  }
  return {
    valid: false,
    code: "INVALID_ORDER",
    message: `Invalid order "${orderDirection}". Use "asc" or "desc".`,
    allowedValues: ["asc", "desc"]
  };
}
function validateOrderBy(orderBy) {
  if (orderBy === void 0) {
    return { valid: true, value: void 0 };
  }
  if (orderBy === "value" || orderBy === "count") {
    return { valid: true, value: orderBy };
  }
  return {
    valid: false,
    code: "INVALID_ORDER_BY",
    message: `Invalid order-by "${orderBy}". Use "value" or "count".`,
    allowedValues: ["value", "count"]
  };
}

// src/commands/metrics/query.ts
function handleValidationError(result, jsonOutput, client, telemetry) {
  telemetry.trackCliError(result.code);
  if (jsonOutput) {
    client.stdout.write(
      formatErrorJson(result.code, result.message, result.allowedValues)
    );
  } else {
    output_manager_default.error(result.message);
    if (result.allowedValues && result.allowedValues.length > 0) {
      output_manager_default.print(`
Available values: ${result.allowedValues.join(", ")}
`);
    }
  }
  return 1;
}
var PRODUCTION_ENVIRONMENT_FILTER = "environment eq 'production'";
var PRODUCTION_ENVIRONMENT_KQL_FILTER = "environment:production";
var CUSTOM_METRIC_VALUE_ALIAS = "value";
var CUSTOM_METRIC_COUNT_ALIAS = "__seriesCount";
var SUM_DEFAULT_METRIC_UNITS = /* @__PURE__ */ new Set(["bytes", "count", "usd", "units"]);
var FILTER_DEPRECATION_WARNING = "OData support in --filter is deprecated and will be removed soon. KQL will be the only supported filter syntax.";
function combineFilters(filters, prod, syntax = "odata") {
  const nonEmptyFilters = [
    ...filters?.filter((filter) => filter.length > 0) ?? [],
    ...prod ? [
      syntax === "kql" ? PRODUCTION_ENVIRONMENT_KQL_FILTER : PRODUCTION_ENVIRONMENT_FILTER
    ] : []
  ];
  if (nonEmptyFilters.length === 0) {
    return void 0;
  }
  if (nonEmptyFilters.length === 1) {
    return nonEmptyFilters[0];
  }
  const conjunction = syntax === "kql" ? " AND " : " and ";
  return nonEmptyFilters.map((filter) => `(${filter})`).join(conjunction);
}
function usesODataSyntax(filters) {
  return filters?.some((filter) => {
    const unquoted = filter.replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, "");
    return /\s(?:eq|ne|gt|ge|lt|le|in)\s/i.test(unquoted) || /\b(?:contains|startswith|endswith)\s*\(/i.test(unquoted);
  }) ?? false;
}
function getRequestOrderBy(metric, aggregation, orderBy) {
  return orderBy === "value" ? getRollupColumnName(metric, aggregation) : void 0;
}
function toBucketSeconds(granularity) {
  if ("minutes" in granularity)
    return granularity.minutes * 60;
  if ("hours" in granularity)
    return granularity.hours * 60 * 60;
  return granularity.days * 24 * 60 * 60;
}
function alignTimeRangeToGranularity(startTime, endTime, granularity) {
  const bucketMs = toBucketSeconds(granularity) * 1e3;
  return {
    startTime: new Date(Math.floor(startTime.getTime() / bucketMs) * bucketMs),
    endTime: new Date(Math.ceil(endTime.getTime() / bucketMs) * bucketMs)
  };
}
function getCatalogDefaultAggregation(metric, isPlatformMetric) {
  if (!isPlatformMetric) {
    return getDefaultCustomMetricAggregation(metric.unit, metric.aggregations);
  }
  const defaultAggregation = SUM_DEFAULT_METRIC_UNITS.has(metric.unit) ? "sum" : "avg";
  if (metric.aggregations.includes(defaultAggregation)) {
    return defaultAggregation;
  }
  if (defaultAggregation === "sum" && metric.aggregations.includes("count")) {
    return "count";
  }
  return metric.aggregations.includes("sum") ? "sum" : metric.aggregations[0];
}
function toCanonicalMetricSelection(metric, aggregation, supportedAggregations) {
  const [aggregationName, ...dimensionParts] = aggregation.split("/");
  const dimension = dimensionParts.join("/") || void 0;
  const countOnlyMetric = supportedAggregations?.includes("count") === true && !supportedAggregations.includes("sum");
  const additiveAggregation = supportedAggregations?.includes("sum") ? "sum" : countOnlyMetric || supportedAggregations === void 0 && metric.endsWith(".count") ? "count" : "sum";
  if (aggregation === "persecond") {
    return { metric, aggregation: additiveAggregation, per: "second" };
  }
  if (aggregation === "percent") {
    return { metric, aggregation: additiveAggregation, normalize: "percent" };
  }
  if (aggregationName === "unique") {
    if (dimension) {
      return { metric, aggregation: "unique", dimensions: [dimension] };
    }
    return {
      valid: false,
      code: "UNSUPPORTED_AGGREGATION",
      message: 'The unique aggregation requires a dimension, for example "unique/visitorId".'
    };
  }
  if (isCanonicalAggregation(aggregation)) {
    return { metric, aggregation };
  }
  return {
    valid: false,
    code: "INVALID_AGGREGATION",
    message: `Aggregation "${aggregation}" is not supported by the Observability query API.`
  };
}
function getCanonicalOrderBy(orderBy, selection, supportedAggregations) {
  if (orderBy === "value") {
    return "value";
  }
  const supportsCount = supportedAggregations === void 0 || supportedAggregations.includes("count");
  if (selection.aggregation === "count" || supportsCount) {
    return "count";
  }
  if (orderBy === "count") {
    return {
      valid: false,
      code: "INVALID_ORDER_BY",
      message: "--order-by count is not available because this metric does not support the count aggregation. Use --order-by value.",
      allowedValues: ["value"]
    };
  }
  return "value";
}
function createCanonicalMetricsRequest(options) {
  const metrics = {
    [CUSTOM_METRIC_VALUE_ALIAS]: options.selection
  };
  let rankMetric = CUSTOM_METRIC_VALUE_ALIAS;
  if (options.groupBy.length > 0 && options.orderBy === "count" && options.selection.aggregation !== "count") {
    metrics[CUSTOM_METRIC_COUNT_ALIAS] = {
      metric: options.metric,
      aggregation: "count"
    };
    rankMetric = CUSTOM_METRIC_COUNT_ALIAS;
  }
  return {
    scope: {
      ownerId: options.scope.ownerId,
      ...options.scope.type === "project" ? { projectIds: options.scope.projectIds } : {}
    },
    timeRange: {
      start: options.startTime.toISOString(),
      end: options.endTime.toISOString()
    },
    bucketSeconds: toBucketSeconds(options.granularity),
    ...options.groupBy.length > 0 ? { groupBy: options.groupBy } : {},
    ...options.filter ? { filter: options.filter } : {},
    metrics,
    outputs: [CUSTOM_METRIC_VALUE_ALIAS],
    ...options.groupBy.length > 0 ? {
      seriesSelection: {
        limit: options.limit,
        mode: "exact",
        rankBy: [
          {
            metric: rankMetric,
            direction: options.orderDirection ?? "desc"
          }
        ]
      }
    } : {}
  };
}
function canonicalResponseToMetricsResponse(response, rollupColumn, orderBy, orderDirection) {
  const toRow = (point) => ({
    ...point.dimensions,
    [rollupColumn]: point.values[CUSTOM_METRIC_VALUE_ALIAS] ?? null
  });
  return {
    ...response.series ? {
      data: response.series.map((point) => ({
        timestamp: point.timestamp,
        ...toRow(point)
      }))
    } : {},
    summary: response.summary.map(toRow),
    statistics: {
      rowsRead: response.meta.statistics.rowsRead,
      bytesRead: response.meta.statistics.bytesRead,
      dbTimeSeconds: response.meta.statistics.databaseElapsedMs / 1e3,
      engineTimeSeconds: response.meta.statistics.elapsedMs / 1e3,
      queryTable: [...new Set(response.meta.sources.map((source) => source.id))].sort().join(",")
    },
    ...orderBy ? { orderBy } : {},
    ...orderDirection ? { orderDirection } : {}
  };
}
async function resolveQueryScope(client, telemetry, opts) {
  if (opts.project || opts.all) {
    const { team } = await getScope(client);
    if (!team) {
      const errMsg = "No team context found. Run `vercel switch` to select a team, or use `vercel link` in a project directory.";
      return handleValidationError(
        { valid: false, code: "NO_TEAM", message: errMsg },
        opts.jsonOutput,
        client,
        telemetry
      );
    }
    if (opts.all) {
      return {
        scope: { type: "owner", ownerId: team.id },
        accountId: team.id,
        teamName: team.slug
      };
    }
    const project = await getProjectByNameOrId(client, opts.project, team.id);
    if (project instanceof ProjectNotFound) {
      const errMsg = `Project "${opts.project}" was not found in team "${team.slug}".`;
      return handleValidationError(
        { valid: false, code: "PROJECT_NOT_FOUND", message: errMsg },
        opts.jsonOutput,
        client,
        telemetry
      );
    }
    return {
      scope: {
        type: "project",
        ownerId: team.id,
        projectIds: [project.id]
      },
      accountId: team.id,
      teamName: team.slug,
      projectName: project.name
    };
  }
  const linkedProject = await getLinkedProject(client);
  if (linkedProject.status === "error") {
    telemetry.trackCliError("LINK_ERROR");
    return linkedProject.exitCode;
  }
  if (linkedProject.status === "not_linked") {
    const errMsg = "No linked project found. Run `vercel link` to link a project, or use --project <name-or-id> or --all.";
    return handleValidationError(
      { valid: false, code: "NOT_LINKED", message: errMsg },
      opts.jsonOutput,
      client,
      telemetry
    );
  }
  return {
    scope: {
      type: "project",
      ownerId: linkedProject.org.id,
      projectIds: [linkedProject.project.id]
    },
    accountId: linkedProject.org.id,
    teamName: linkedProject.org.slug,
    projectName: linkedProject.project.name
  };
}
async function query(client, telemetry) {
  let parsedArgs;
  const flagsSpecification = getFlagsSpecification(metricsCommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
  } catch (err) {
    telemetry.trackCliError("INVALID_ARGUMENTS");
    printError(err);
    return 1;
  }
  const flags = parsedArgs.flags;
  const positionalArgs = parsedArgs.args.slice(1);
  const positionalMetric = positionalArgs[0] === "query" ? positionalArgs[1] : positionalArgs[0];
  const formatResult = validateJsonOutput(flags);
  if (!formatResult.valid) {
    telemetry.trackCliError("INVALID_OUTPUT_FORMAT");
    output_manager_default.error(formatResult.error);
    return 1;
  }
  const jsonOutput = formatResult.jsonOutput;
  const metricFlag = positionalMetric;
  const aggregationFlag = flags["--aggregation"];
  const groupBy = flags["--group-by"] ?? [];
  const limit = flags["--limit"];
  const orderByInput = typeof flags["--order-by"] === "string" ? flags["--order-by"].trim().toLowerCase() : void 0;
  const orderInput = typeof flags["--order"] === "string" ? flags["--order"].trim().toLowerCase() : void 0;
  const filters = flags["--filter"];
  const prod = flags["--prod"];
  const since = flags["--since"];
  const until = flags["--until"];
  const granularity = flags["--granularity"];
  const bucketTimezone = flags["--bucket-timezone"]?.trim();
  const project = flags["--project"];
  const all = flags["--all"];
  telemetry.trackCliArgumentMetricId(metricFlag);
  telemetry.trackCliOptionAggregation(aggregationFlag);
  telemetry.trackCliOptionGroupBy(groupBy.length > 0 ? groupBy : void 0);
  telemetry.trackCliOptionLimit(limit);
  telemetry.trackCliOptionOrderBy(orderByInput);
  telemetry.trackCliOptionOrder(orderInput);
  telemetry.trackCliOptionFilter(filters);
  telemetry.trackCliFlagProd(prod);
  telemetry.trackCliOptionSince(since);
  telemetry.trackCliOptionUntil(until);
  telemetry.trackCliOptionGranularity(granularity);
  telemetry.trackCliOptionBucketTimezone(bucketTimezone);
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliFlagAll(all);
  telemetry.trackCliOptionFormat(flags["--format"]);
  const orderByResult = validateOrderBy(orderByInput);
  if (!orderByResult.valid) {
    return handleValidationError(orderByResult, jsonOutput, client, telemetry);
  }
  const orderByMode = orderByResult.value;
  const requiredMetric = validateRequiredMetric(metricFlag);
  if (!requiredMetric.valid) {
    return handleValidationError(requiredMetric, jsonOutput, client, telemetry);
  }
  const metric = requiredMetric.value;
  const mutualResult = validateAllProjectMutualExclusivity(all, project);
  if (!mutualResult.valid) {
    return handleValidationError(mutualResult, jsonOutput, client, telemetry);
  }
  const orderDirectionResult = validateOrderDirection(orderInput);
  if (!orderDirectionResult.valid) {
    return handleValidationError(
      orderDirectionResult,
      jsonOutput,
      client,
      telemetry
    );
  }
  const orderDirection = orderDirectionResult.value;
  const scopeResult = await resolveQueryScope(client, telemetry, {
    project,
    all,
    jsonOutput
  });
  if (typeof scopeResult === "number") {
    return scopeResult;
  }
  const { scope, accountId, teamName, projectName } = scopeResult;
  const isPlatformMetric = metric.startsWith("vercel.");
  const useCanonicalQuery = !isPlatformMetric || Boolean(process.env.FF_METRICS);
  const filterUsesOData = usesODataSyntax(filters);
  if (useCanonicalQuery && filterUsesOData) {
    output_manager_default.print(`${import_chalk.default.yellow("!")} ${FILTER_DEPRECATION_WARNING}
`);
  }
  const filter = combineFilters(
    filters,
    prod,
    useCanonicalQuery && !filterUsesOData ? "kql" : "odata"
  );
  let startTime;
  let endTime;
  try {
    ({ startTime, endTime } = resolveTimeRange(since, until));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return handleValidationError(
      { valid: false, code: "INVALID_TIME", message: errMsg },
      jsonOutput,
      client,
      telemetry
    );
  }
  let metricUnit;
  let aggregationInput;
  let canonicalAggregations;
  if (useCanonicalQuery) {
    const catalogOrExitCode = await fetchCatalogMetricDetailOrExit(
      client,
      accountId,
      jsonOutput,
      metric,
      isPlatformMetric ? "system" : "custom",
      startTime.toISOString()
    );
    if (typeof catalogOrExitCode === "number") {
      telemetry.trackCliError("SCHEMA_FETCH_FAILED");
      return catalogOrExitCode;
    }
    const catalogMetric = catalogOrExitCode.find((item) => item.id === metric);
    if (!catalogMetric) {
      return handleValidationError(
        {
          valid: false,
          code: "UNKNOWN_METRIC",
          message: `Unknown metric "${metric}".`,
          allowedValues: catalogOrExitCode.map((item) => item.id)
        },
        jsonOutput,
        client,
        telemetry
      );
    }
    metricUnit = catalogMetric.unit;
    canonicalAggregations = catalogMetric.aggregations;
    if (aggregationFlag) {
      aggregationInput = aggregationFlag;
    } else {
      const defaultAggregation = getCatalogDefaultAggregation(
        catalogMetric,
        isPlatformMetric
      );
      if (!defaultAggregation) {
        return handleValidationError(
          {
            valid: false,
            code: "INVALID_AGGREGATION",
            message: `Metric "${metric}" does not support any query aggregations.`
          },
          jsonOutput,
          client,
          telemetry
        );
      }
      aggregationInput = defaultAggregation;
    }
  } else {
    const detailOrExitCode = await fetchMetricDetailOrExit(
      client,
      accountId,
      metric,
      jsonOutput
    );
    if (typeof detailOrExitCode === "number") {
      telemetry.trackCliError("SCHEMA_FETCH_FAILED");
      return detailOrExitCode;
    }
    aggregationInput = aggregationFlag ?? getDefaultAggregation(detailOrExitCode, metric) ?? "sum";
    metricUnit = detailOrExitCode.find((item) => item.id === metric)?.unit ?? "count";
  }
  const aggregation = aggregationInput;
  const orderBy = getRequestOrderBy(metric, aggregation, orderByMode);
  const rangeMs = endTime.getTime() - startTime.getTime();
  const granResult = computeGranularity(rangeMs, granularity);
  const queryTimeRange = useCanonicalQuery ? alignTimeRangeToGranularity(startTime, endTime, granResult.duration) : { startTime, endTime };
  if (!jsonOutput && granResult.adjusted && granResult.notice) {
    output_manager_default.log(`Notice: ${granResult.notice}`);
  }
  let body;
  let canonicalOrderBy;
  if (!useCanonicalQuery) {
    body = {
      scope,
      metric,
      aggregation,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      granularity: granResult.duration,
      ...bucketTimezone ? { bucketTimezone } : {},
      ...groupBy.length > 0 ? { groupBy } : {},
      ...filter ? { filter } : {},
      limit: limit ?? 10,
      ...orderBy ? { orderBy } : {},
      ...orderDirection ? { orderDirection } : {}
    };
  } else {
    if (bucketTimezone) {
      return handleValidationError(
        {
          valid: false,
          code: "UNSUPPORTED_BUCKET_TIMEZONE",
          message: "--bucket-timezone is not supported by the new Observability query API yet."
        },
        jsonOutput,
        client,
        telemetry
      );
    }
    const selection = toCanonicalMetricSelection(
      metric,
      aggregation,
      canonicalAggregations
    );
    if ("valid" in selection) {
      return handleValidationError(selection, jsonOutput, client, telemetry);
    }
    const supportedAggregation = selection.aggregation;
    if (canonicalAggregations && !canonicalAggregations.includes(supportedAggregation)) {
      return handleValidationError(
        {
          valid: false,
          code: "INVALID_AGGREGATION",
          message: `Aggregation "${aggregation}" is not valid for metric "${metric}".`,
          allowedValues: [...canonicalAggregations]
        },
        jsonOutput,
        client,
        telemetry
      );
    }
    const canonicalOrderByResult = groupBy.length > 0 ? getCanonicalOrderBy(orderByMode, selection, canonicalAggregations) : void 0;
    if (canonicalOrderByResult && typeof canonicalOrderByResult !== "string") {
      return handleValidationError(
        canonicalOrderByResult,
        jsonOutput,
        client,
        telemetry
      );
    }
    canonicalOrderBy = canonicalOrderByResult;
    body = createCanonicalMetricsRequest({
      scope,
      metric,
      selection,
      startTime: queryTimeRange.startTime,
      endTime: queryTimeRange.endTime,
      granularity: granResult.duration,
      groupBy,
      filter,
      limit: limit ?? 10,
      orderBy: canonicalOrderBy,
      orderDirection
    });
  }
  const resolvedOrderBy = canonicalOrderBy ?? orderByMode;
  if (!jsonOutput) {
    output_manager_default.spinner("Querying metrics...");
  }
  let response;
  try {
    if (!useCanonicalQuery) {
      response = await client.fetch(
        "/v2/observability/query",
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          accountId,
          bailOn429: true
        }
      );
    } else {
      const canonicalResponse = await client.fetch(
        OBSERVABILITY_METRICS_PATH,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          accountId,
          bailOn429: true
        }
      );
      response = canonicalResponseToMetricsResponse(
        canonicalResponse,
        getRollupColumnName(metric, aggregation),
        canonicalOrderBy,
        groupBy.length > 0 ? orderDirection ?? "desc" : void 0
      );
    }
  } catch (err) {
    if (isAPIError(err)) {
      telemetry.trackCliError(err.code ?? "API_ERROR", err.status);
      return handleApiError(err, jsonOutput, client);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    telemetry.trackCliError("NETWORK_ERROR");
    if (jsonOutput) {
      client.stdout.write(formatErrorJson("NETWORK_ERROR", errMsg));
    } else {
      output_manager_default.error(errMsg);
    }
    return 1;
  } finally {
    if (!jsonOutput) {
      output_manager_default.stopSpinner();
    }
  }
  if (jsonOutput) {
    client.stdout.write(
      formatQueryJson(
        {
          metric,
          aggregation,
          groupBy,
          filter,
          startTime: queryTimeRange.startTime.toISOString(),
          endTime: queryTimeRange.endTime.toISOString(),
          granularity: granResult.duration,
          ...bucketTimezone ? { bucketTimezone } : {},
          ...resolvedOrderBy ? { orderBy: resolvedOrderBy } : {},
          ...orderDirection ? { orderDirection } : {}
        },
        response
      )
    );
  } else {
    client.stdout.write(
      formatText(response, {
        metric,
        metricUnit,
        aggregation,
        groupBy,
        filter,
        scope,
        projectName,
        teamName,
        periodStart: queryTimeRange.startTime.toISOString(),
        periodEnd: queryTimeRange.endTime.toISOString(),
        granularity: granResult.duration,
        bucketTimezone,
        orderBy: resolvedOrderBy,
        orderDirection
      })
    );
  }
  return 0;
}
export {
  query as default
};
