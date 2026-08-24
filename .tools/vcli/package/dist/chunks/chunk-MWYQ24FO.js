import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  getResolvedOrderMetadata,
  getRollupColumnName
} from "./chunk-CV4S27SS.js";
import {
  formatGranularity
} from "./chunk-5AJPMLDV.js";
import {
  indent_default
} from "./chunk-A3NYPUKZ.js";
import {
  ellipsizeMiddle
} from "./chunk-VDJN4WKH.js";
import {
  elapsed
} from "./chunk-VXYGCOKL.js";
import {
  require_ms
} from "./chunk-GGP5R3FU.js";
import {
  table
} from "./chunk-VAFU7DXZ.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/metrics/time-utils.ts
var import_ms = __toESM(require_ms(), 1);
var MINUTE_MS = 60 * 1e3;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;
function toGranularityDuration(input) {
  const milliseconds = (0, import_ms.default)(input);
  if (milliseconds === void 0) {
    throw new Error(
      `Invalid granularity format "${input}". Use 1m, 5m, 15m, 1h, 4h, 1d.`
    );
  }
  if (milliseconds >= DAY_MS) {
    return { days: milliseconds / DAY_MS };
  }
  if (milliseconds >= HOUR_MS) {
    return { hours: milliseconds / HOUR_MS };
  }
  return { minutes: milliseconds / MINUTE_MS };
}
function toGranularityMs(input) {
  const milliseconds = (0, import_ms.default)(input);
  if (milliseconds === void 0) {
    throw new Error(`Invalid granularity format "${input}".`);
  }
  return milliseconds;
}
var GRANULARITY_THRESHOLDS = [
  [1 * HOUR_MS, "1m", "1m"],
  // ≤1h
  [2 * HOUR_MS, "5m", "5m"],
  // ≤2h
  [12 * HOUR_MS, "15m", "5m"],
  // ≤12h
  [3 * DAY_MS, "1h", "1h"],
  // ≤3d
  [30 * DAY_MS, "4h", "4h"]
  // ≤30d
];
var FALLBACK_GRANULARITY = "1d";
function getAutoGranularity(rangeMs) {
  for (const [maxRange, defaultG] of GRANULARITY_THRESHOLDS) {
    if (rangeMs <= maxRange) {
      return defaultG;
    }
  }
  return FALLBACK_GRANULARITY;
}
function getMinGranularity(rangeMs) {
  for (const [maxRange, , minG] of GRANULARITY_THRESHOLDS) {
    if (rangeMs <= maxRange) {
      return minG;
    }
  }
  return FALLBACK_GRANULARITY;
}
function computeGranularity(rangeMs, explicit) {
  if (!explicit) {
    const auto = getAutoGranularity(rangeMs);
    return {
      duration: toGranularityDuration(auto),
      adjusted: false
    };
  }
  const minG = getMinGranularity(rangeMs);
  const explicitMs = toGranularityMs(explicit);
  const minMs = toGranularityMs(minG);
  if (explicitMs < minMs) {
    const rangeDays = Math.round(rangeMs / DAY_MS);
    const rangeHours = Math.round(rangeMs / HOUR_MS);
    const rangeLabel = rangeDays >= 1 ? `${rangeDays}-day` : `${rangeHours}-hour`;
    return {
      duration: toGranularityDuration(minG),
      adjusted: true,
      notice: `Granularity adjusted from ${explicit} to ${minG} for a ${rangeLabel} time range.`
    };
  }
  return {
    duration: toGranularityDuration(explicit),
    adjusted: false
  };
}
function toGranularityMsFromDuration(duration) {
  if ("minutes" in duration) {
    return duration.minutes * MINUTE_MS;
  }
  if ("hours" in duration) {
    return duration.hours * HOUR_MS;
  }
  return duration.days * DAY_MS;
}

// src/commands/metrics/types.ts
var CANONICAL_AGGREGATIONS = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "stddev"
];
function isCanonicalAggregation(aggregation) {
  return CANONICAL_AGGREGATIONS.includes(aggregation);
}

// src/commands/metrics/metric-units.ts
var DURATION_UNITS = /* @__PURE__ */ new Set([
  "nanoseconds",
  "microseconds",
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
  "days"
]);
function normalizeMetricUnit(unit) {
  return unit.trim().toLowerCase().replace(/[_\s]+/g, " ");
}
function getPreferredCustomMetricAggregation(unit) {
  const normalizedUnit = normalizeMetricUnit(unit);
  if (DURATION_UNITS.has(normalizedUnit)) {
    return "p75";
  }
  if (normalizedUnit === "percent") {
    return "avg";
  }
  return "sum";
}
function getDefaultCustomMetricAggregation(unit, aggregations) {
  const preferredAggregation = getPreferredCustomMetricAggregation(unit);
  if (aggregations?.includes(preferredAggregation)) {
    return preferredAggregation;
  }
  if (aggregations?.includes("sum")) {
    return "sum";
  }
  return aggregations?.find(isCanonicalAggregation);
}

// src/commands/metrics/text-output.ts
var import_chalk = __toESM(require_source(), 1);
var GROUP_KEY_DELIMITER = "";
var MAX_SPARKLINE_LENGTH = 120;
var DURATION_SCALE_MS = {
  seconds: 1e3,
  minutes: 6e4,
  hours: 36e5,
  days: 864e5
};
var BYTE_SCALE = {
  bytes: 1,
  kilobytes: 1e3,
  megabytes: 1e6,
  gigabytes: 1e9,
  terabytes: 1e12,
  petabytes: 1e15
};
var COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short"
});
var TWO_FRACTION_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});
var TWO_SIGNIFICANT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumSignificantDigits: 2,
  maximumSignificantDigits: 2,
  maximumFractionDigits: 2
});
var PERCENTAGE_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "unit",
  unit: "percent",
  unitDisplay: "narrow",
  maximumFractionDigits: 1
});
var USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
var BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
var MISSING_CHAR = "\xB7";
function isAggregationWithDimension(aggregation) {
  const [, dimension] = aggregation.split("/");
  return Boolean(dimension);
}
function toGroupKey(groupValues) {
  if (groupValues.length === 0) {
    return "";
  }
  return groupValues.join(GROUP_KEY_DELIMITER);
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad4(n) {
  return String(n).padStart(4, "0");
}
function formatHumanMinute(date) {
  return `${pad4(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}
function formatPeriodBound(input) {
  const date = new Date(input);
  if (isNaN(date.getTime())) {
    return input;
  }
  return formatHumanMinute(date);
}
function formatPeriodSpan(startInput, endInput) {
  const start = Date.parse(startInput);
  const end = Date.parse(endInput);
  const durationMs = end - start;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return elapsed(durationMs);
}
function getStatColumns(aggregation) {
  if (aggregation === "sum" || aggregation === "count") {
    return ["total", "avg", "min", "max"];
  }
  return ["avg", "min", "max"];
}
function toNumericValue(value) {
  if (value === null || value === void 0) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function isNonNullNumber(value) {
  return value !== null;
}
function isPointWithValue(point) {
  return point.value !== null;
}
function getOrCreate(map, key, make) {
  const existing = map.get(key);
  if (existing !== void 0) {
    return existing;
  }
  const created = make();
  map.set(key, created);
  return created;
}
function getGroupFieldValue(row, field) {
  const value = row[field];
  return value == null || value === "" ? "(not set)" : String(value);
}
function normalizeTimestampToIso(timestamp) {
  const parsed = Date.parse(timestamp);
  if (isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}
function formatStatCell(column, stats, periodStart, periodEnd, formatValue) {
  switch (column) {
    case "total":
      return formatValue(stats.total);
    case "avg":
      return formatValue(stats.avg, {
        preserveFractionalCount: true
      });
    case "min": {
      const ts = formatMinMaxTimestamp(
        new Date(stats.min.timestamp),
        periodStart,
        periodEnd
      );
      return `${formatValue(stats.min.value)} at ${ts}`;
    }
    case "max": {
      const ts = formatMinMaxTimestamp(
        new Date(stats.max.timestamp),
        periodStart,
        periodEnd
      );
      return `${formatValue(stats.max.value)} at ${ts}`;
    }
  }
}
function buildExpectedTimestamps(periodStart, periodEnd, granularityMs) {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (isNaN(start) || isNaN(end) || granularityMs <= 0 || end <= start) {
    return [];
  }
  const timestamps = [];
  for (let current = start; current < end; current += granularityMs) {
    timestamps.push(new Date(current).toISOString());
  }
  return timestamps;
}
function buildObservedTimestamps(observedTimestamps, granularityMs) {
  const timestamps = [...observedTimestamps].map((timestamp) => Date.parse(timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  if (timestamps.length === 0 || granularityMs <= 0) {
    return [];
  }
  const start = timestamps[0];
  const end = timestamps[timestamps.length - 1] + granularityMs;
  return buildExpectedTimestamps(
    new Date(start).toISOString(),
    new Date(end).toISOString(),
    granularityMs
  );
}
function buildSeriesTimestamps(periodStart, periodEnd, granularityMs, observedTimestamps) {
  const expectedTimestamps = buildExpectedTimestamps(
    periodStart,
    periodEnd,
    granularityMs
  );
  if (observedTimestamps.size === 0 || expectedTimestamps.some((timestamp) => observedTimestamps.has(timestamp))) {
    return expectedTimestamps;
  }
  return buildObservedTimestamps(observedTimestamps, granularityMs);
}
function formatCount(n) {
  return Math.round(n).toLocaleString("en-US");
}
function formatDecimal(n) {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  if (n === 0 || Object.is(n, -0)) {
    return "0";
  }
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1) {
    return `${sign}${abs.toFixed(1)}`;
  }
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, Math.max(2, -exponent + 1));
  const fixed = abs.toFixed(decimals);
  const trimmed = fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "");
  return `${sign}${trimmed}`;
}
function formatDuration(durationMs) {
  const durationSeconds = durationMs / 1e3;
  if (durationMs < 1e3) {
    return `${durationMs.toFixed(0)}ms`;
  }
  if (durationMs < 5e3) {
    return `${Math.round(durationSeconds * 100) / 100}s`;
  }
  if (durationSeconds < 60) {
    return `${durationSeconds.toFixed(0)}s`;
  }
  if (durationSeconds < 3600) {
    return `${(durationSeconds / 60).toFixed(0)}m`;
  }
  return `${(durationSeconds / 3600).toFixed(0)}h`;
}
function formatBytes(bytes) {
  if (bytes === 0) {
    return "0 Bytes";
  }
  const units = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
  const absoluteBytes = Math.abs(bytes);
  let unitIndex = Math.min(
    units.length - 1,
    Math.max(0, Math.floor(Math.log(absoluteBytes) / Math.log(1e3)))
  );
  let value = bytes / 1e3 ** unitIndex;
  if (unitIndex === 1 || unitIndex === 2) {
    value = Math.round(value);
    if (Math.abs(value) === 1e3 && unitIndex < units.length - 1) {
      value /= 1e3;
      unitIndex += 1;
    }
  }
  return `${TWO_FRACTION_NUMBER_FORMATTER.format(value)} ${units[unitIndex]}`;
}
function formatMetricValue(value, baseUnit, aggregation, opts) {
  const formatCountValue = () => opts?.preserveFractionalCount && !Number.isInteger(value) ? formatDecimal(value) : formatCount(value);
  if (isAggregationWithDimension(aggregation) || aggregation === "count") {
    return formatCountValue();
  }
  const unit = normalizeMetricUnit(baseUnit ?? "units");
  if (aggregation === "percent" || unit === "percent") {
    return PERCENTAGE_FORMATTER.format(value);
  }
  if (aggregation === "unique") {
    return COMPACT_NUMBER_FORMATTER.format(value);
  }
  const withRateSuffix = (formatted2) => aggregation === "persecond" ? `${formatted2}/s` : formatted2;
  if (unit === "milliseconds") {
    return withRateSuffix(formatDuration(value));
  }
  const durationScale = DURATION_SCALE_MS[unit];
  if (durationScale) {
    return withRateSuffix(formatDuration(value * durationScale));
  }
  if (unit === "nanoseconds" || unit === "microseconds") {
    const suffix = unit === "nanoseconds" ? " ns" : " \xB5s";
    const formatted2 = TWO_FRACTION_NUMBER_FORMATTER.format(value);
    return withRateSuffix(`${formatted2}${suffix}`);
  }
  const byteScale = BYTE_SCALE[unit];
  if (byteScale) {
    return withRateSuffix(formatBytes(value * byteScale));
  }
  if (unit === "gigabyte hour" || unit === "gigabyte hours") {
    const formatted2 = TWO_SIGNIFICANT_NUMBER_FORMATTER.format(value);
    return withRateSuffix(`${formatted2} GB-hrs`);
  }
  if (unit === "usd" || unit === "us dollars" || unit === "dollars") {
    return withRateSuffix(USD_FORMATTER.format(value));
  }
  if (unit === "count" && aggregation === "sum") {
    return formatCountValue();
  }
  const formatted = COMPACT_NUMBER_FORMATTER.format(value);
  const unitLabel = baseUnit?.trim();
  if (!unitLabel || unit === "units" || unit === "count" || unit === "ratio") {
    return withRateSuffix(formatted);
  }
  return withRateSuffix(`${formatted} ${unitLabel}`);
}
function formatMinMaxTimestamp(date, periodStart, periodEnd) {
  const sameDay = periodStart.getUTCFullYear() === periodEnd.getUTCFullYear() && periodStart.getUTCMonth() === periodEnd.getUTCMonth() && periodStart.getUTCDate() === periodEnd.getUTCDate();
  if (sameDay) {
    return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  }
  const sameYear = periodStart.getUTCFullYear() === periodEnd.getUTCFullYear();
  if (sameYear) {
    return `${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  }
  return `${pad4(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}
function extractGroupedSeries(data, groupBy, rollupColumn, periodStart, periodEnd, granularityMs) {
  const groups = [];
  const groupValues = /* @__PURE__ */ new Map();
  const valueByGroup = /* @__PURE__ */ new Map();
  const observedTimestamps = /* @__PURE__ */ new Set();
  for (const row of data) {
    const values = groupBy.map((field) => getGroupFieldValue(row, field));
    const key = toGroupKey(values);
    if (!groupValues.has(key)) {
      groups.push(key);
      groupValues.set(key, values);
    }
    const groupMap = getOrCreate(valueByGroup, key, () => /* @__PURE__ */ new Map());
    const rawTimestamp = row.timestamp;
    if (rawTimestamp.length === 0) {
      continue;
    }
    const timestamp = normalizeTimestampToIso(rawTimestamp);
    if (!timestamp) {
      continue;
    }
    observedTimestamps.add(timestamp);
    const numeric = toNumericValue(row[rollupColumn]);
    groupMap.set(timestamp, numeric);
  }
  const expectedTimestamps = buildSeriesTimestamps(
    periodStart,
    periodEnd,
    granularityMs,
    observedTimestamps
  );
  const series = /* @__PURE__ */ new Map();
  for (const key of groups) {
    const byTimestamp = valueByGroup.get(key);
    if (!byTimestamp) {
      continue;
    }
    const points = expectedTimestamps.map((timestamp) => ({
      timestamp,
      value: byTimestamp.has(timestamp) ? byTimestamp.get(timestamp) ?? null : null
    }));
    series.set(key, points);
  }
  return { groups, series, groupValues };
}
function computeGroupStats(points) {
  const present = points.filter(isPointWithValue);
  if (present.length === 0) {
    return {
      total: 0,
      avg: 0,
      min: { value: 0, timestamp: "" },
      max: { value: 0, timestamp: "" },
      count: 0,
      allMissing: true
    };
  }
  let total = 0;
  let min = present[0];
  let max = present[0];
  for (const point of present) {
    total += point.value;
    if (point.value < min.value) {
      min = point;
    }
    if (point.value > max.value) {
      max = point;
    }
  }
  return {
    total,
    avg: total / present.length,
    min: { value: min.value, timestamp: min.timestamp },
    max: { value: max.value, timestamp: max.timestamp },
    count: present.length,
    allMissing: false
  };
}
var MAX_GROUP_VALUE_LENGTH = 60;
function downsample(values, maxLen) {
  if (maxLen <= 0) {
    return [];
  }
  if (values.length <= maxLen) {
    return [...values];
  }
  const result = [];
  for (let i = 0; i < maxLen; i++) {
    const start = Math.floor(i * values.length / maxLen);
    const end = Math.floor((i + 1) * values.length / maxLen);
    const bucket = values.slice(start, Math.max(start + 1, end));
    const nullCount = bucket.filter((value) => value === null).length;
    if (nullCount === bucket.length || nullCount > bucket.length / 2) {
      result.push(null);
      continue;
    }
    const present = bucket.filter(isNonNullNumber);
    const avg = present.reduce((sum, value) => sum + value, 0) / present.length;
    result.push(avg);
  }
  return result;
}
function generateSparkline(values) {
  const sampled = downsample(values, MAX_SPARKLINE_LENGTH);
  if (sampled.length === 0) {
    return "";
  }
  const present = sampled.filter(isNonNullNumber);
  if (present.length === 0) {
    return sampled.map(() => MISSING_CHAR).join("");
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (min === max) {
    const block = min === 0 ? BLOCKS[0] : BLOCKS[BLOCKS.length - 1];
    return sampled.map((value) => value === null ? MISSING_CHAR : block).join("");
  }
  const range = max - min;
  return sampled.map((value) => {
    if (value === null) {
      return MISSING_CHAR;
    }
    const ratio = (value - min) / range;
    const index = Math.max(
      0,
      Math.min(BLOCKS.length - 1, Math.round(ratio * (BLOCKS.length - 1)))
    );
    return BLOCKS[index];
  }).join("");
}
function formatMetadataHeader(opts) {
  const periodSpan = opts.compact ? formatPeriodSpan(opts.periodStart, opts.periodEnd) : null;
  const rows = [];
  if (!opts.compact) {
    rows.push({
      key: "Metric",
      value: `${opts.metric} ${opts.aggregation}`
    });
  }
  rows.push(
    {
      // Period bounds are always UTC; annotate them so the boundary is
      // unambiguous when the Interval below reports a different
      // --bucket-timezone.
      key: "Period",
      value: `${formatPeriodBound(opts.periodStart)} to ${formatPeriodBound(opts.periodEnd)} (UTC)${periodSpan ? ` ${periodSpan}` : ""}`
    },
    {
      // Period bounds are always UTC; the timezone only controls calendar
      // bucket alignment, which is a no-op below 1d granularity. Annotate the
      // interval (instead of a standalone Timezone row) to avoid implying the
      // period itself is zone-local.
      key: "Interval",
      value: "days" in opts.granularity ? `${formatGranularity(opts.granularity)} (${opts.bucketTimezone ?? "UTC"})` : formatGranularity(opts.granularity)
    }
  );
  if (typeof opts.periodUnique === "number") {
    rows.push({
      key: "Unique (period)",
      value: formatCount(opts.periodUnique)
    });
  }
  if (!opts.compact && opts.filter) {
    rows.push({ key: "Filter", value: opts.filter });
  }
  if (!opts.compact && opts.orderBy && opts.orderDirection) {
    rows.push({
      key: "Order By",
      value: `${opts.orderBy} ${opts.orderDirection}${opts.orderBy === "count" ? " (default)" : ""}`
    });
  }
  if (opts.scope.type === "project") {
    rows.push({
      key: "Project",
      value: `${opts.projectName ?? opts.scope.projectIds[0]} (${opts.teamName ?? opts.scope.ownerId})`
    });
  } else {
    rows.push({
      key: "Team",
      value: `${opts.teamName ?? opts.scope.ownerId} (all projects)`
    });
  }
  if (!opts.compact && typeof opts.groupCount === "number") {
    rows.push({ key: "Groups", value: String(opts.groupCount) });
  }
  return rows.map((row) => `> ${import_chalk.default.gray(`${row.key}:`)} ${row.value}`).join("\n");
}
function formatSummaryTable(opts) {
  const statColumns = getStatColumns(opts.aggregation);
  const header = [...opts.groupByFields, ...statColumns];
  const rows = [header.map((name) => import_chalk.default.bold(import_chalk.default.cyan(name)))];
  for (const row of opts.rows) {
    const nextRow = row.groupValues.map(
      (v) => ellipsizeMiddle(v, MAX_GROUP_VALUE_LENGTH, opts.ansiAwareGroupValues)
    );
    if (row.stats.allMissing) {
      nextRow.push(...statColumns.map(() => "--"));
      rows.push(nextRow);
      continue;
    }
    nextRow.push(
      ...statColumns.map(
        (column) => formatStatCell(
          column,
          row.stats,
          opts.periodStart,
          opts.periodEnd,
          opts.formatValue
        )
      )
    );
    rows.push(nextRow);
  }
  const centeredColumns = /* @__PURE__ */ new Set(["min", "max"]);
  const align = header.map(
    (col) => centeredColumns.has(col) ? "c" : "r"
  );
  return indent_default(
    table(rows, {
      align,
      hsep: 2
    }),
    2
  );
}
function formatSparklineSection(groupRows, sparklines, groupByFields, compact = false) {
  if (groupRows.length === 0) {
    const sparkline = sparklines[0];
    const chart2 = sparkline ? indent_default(sparkline, 2) : "";
    return compact ? chart2 : ["sparklines:", chart2].filter(Boolean).join("\n");
  }
  const header = [...groupByFields, compact ? "" : "sparkline"];
  const rows = [
    header.map((name) => import_chalk.default.bold(import_chalk.default.cyan(name))),
    ...groupRows.map((groupValues, index) => [
      ...groupValues.map(
        (v) => ellipsizeMiddle(v, MAX_GROUP_VALUE_LENGTH, compact)
      ),
      sparklines[index] ?? ""
    ])
  ];
  const align = groupByFields.map(() => "r");
  align.push("l");
  const chart = indent_default(
    table(rows, {
      align,
      hsep: 2
    }),
    2
  );
  return compact ? chart : `sparklines:
${chart}`;
}
function formatText(response, opts) {
  const rollupColumn = getRollupColumnName(opts.metric, opts.aggregation);
  const formatValue = (value, formatOptions) => formatMetricValue(value, opts.metricUnit, opts.aggregation, formatOptions);
  const granularityMs = toGranularityMsFromDuration(opts.granularity);
  const orderMetadata = getResolvedOrderMetadata(opts, response);
  const { groups, series, groupValues } = extractGroupedSeries(
    response.data ?? [],
    opts.groupBy,
    rollupColumn,
    opts.periodStart,
    opts.periodEnd,
    granularityMs
  );
  let periodUnique;
  if (isAggregationWithDimension(opts.aggregation) && opts.groupBy.length === 0) {
    const summaryValue = toNumericValue(response.summary?.[0]?.[rollupColumn]);
    if (summaryValue !== null) {
      periodUnique = summaryValue;
    }
  }
  const metadata = formatMetadataHeader({
    metric: opts.metric,
    aggregation: opts.aggregation,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    granularity: opts.granularity,
    periodUnique,
    bucketTimezone: opts.bucketTimezone,
    filter: opts.filter,
    ...opts.groupBy.length > 0 ? orderMetadata : {},
    scope: opts.scope,
    projectName: opts.projectName,
    teamName: opts.teamName,
    groupCount: opts.groupBy.length > 0 ? groups.length : void 0,
    compact: opts.presentation?.compact
  });
  if (groups.length === 0) {
    return `${metadata}

No data found for this period.
`;
  }
  const summaryRows = [];
  const groupRows = [];
  const sparklineRows = [];
  for (const key of groups) {
    const points = series.get(key) ?? [];
    const values = points.map((point) => point.value);
    const currentGroupValues = groupValues.get(key) ?? [];
    const displayGroupValues = currentGroupValues.map((value, index) => {
      const field = opts.groupBy[index];
      return opts.presentation?.formatGroupValue?.(field, value) ?? value;
    });
    summaryRows.push({
      groupValues: displayGroupValues,
      stats: computeGroupStats(points)
    });
    groupRows.push(displayGroupValues);
    sparklineRows.push(generateSparkline(values));
  }
  const summaryTable = formatSummaryTable({
    rows: summaryRows,
    groupByFields: opts.groupBy,
    aggregation: opts.aggregation,
    periodStart: new Date(opts.periodStart),
    periodEnd: new Date(opts.periodEnd),
    formatValue,
    ansiAwareGroupValues: opts.presentation?.compact
  });
  const groupedOutput = opts.groupBy.length > 0;
  const sparklineSection = formatSparklineSection(
    groupedOutput ? groupRows : [],
    sparklineRows,
    opts.groupBy,
    opts.presentation?.compact
  );
  const sections = [metadata, summaryTable, sparklineSection];
  return `${sections.join("\n\n")}
`;
}

export {
  computeGranularity,
  toGranularityMsFromDuration,
  isCanonicalAggregation,
  getDefaultCustomMetricAggregation,
  formatText
};
