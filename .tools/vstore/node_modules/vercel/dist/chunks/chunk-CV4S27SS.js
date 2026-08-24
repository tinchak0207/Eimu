import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";

// src/commands/metrics/output.ts
function getRollupColumnName(metric, aggregation) {
  return `${metric}_${aggregation}`.replace(/[./]/g, "_");
}
function getResolvedOrderMetadata(query, response) {
  const orderBy = query.orderBy ?? (response.orderBy ? "count" : void 0);
  const orderDirection = response.orderDirection ?? query.orderDirection;
  return {
    ...orderBy ? { orderBy } : {},
    ...orderDirection ? { orderDirection } : {}
  };
}
function formatQueryJson(query, response) {
  const orderMetadata = getResolvedOrderMetadata(query, response);
  const queryWithResponseMetadata = {
    ...query,
    ...orderMetadata
  };
  return JSON.stringify(
    {
      query: queryWithResponseMetadata,
      summary: response.summary ?? [],
      data: response.data ?? [],
      ...orderMetadata
    },
    null,
    2
  );
}
function formatErrorJson(code, message, allowedValues) {
  const error = {
    code,
    message
  };
  if (allowedValues && allowedValues.length > 0) {
    error.allowedValues = allowedValues;
  }
  return JSON.stringify({ error }, null, 2);
}
function handleApiError(err, jsonOutput, client, overrides = {}) {
  let code;
  let message;
  const override = overrides[err.status];
  if (override) {
    code = override.code || err.code || "BAD_REQUEST";
    message = override.message;
  } else {
    switch (err.status) {
      case 402:
        code = err.code || "PAYMENT_REQUIRED";
        message = err.serverMessage || "This feature requires an Observability Plus subscription. Upgrade at https://vercel.com/dashboard/settings/billing";
        break;
      case 429:
        code = err.code || "RATE_LIMITED";
        message = err.serverMessage || "You have reached the metrics query rate limit. Please wait and try again. If you need a higher limit, request one from your Vercel account team.";
        break;
      case 403:
        code = "FORBIDDEN";
        message = "You do not have permission to query metrics for this project/team.";
        break;
      case 500:
        code = "INTERNAL_ERROR";
        message = "An internal error occurred. Please try again later.";
        break;
      case 504:
        code = "TIMEOUT";
        message = "The query timed out. Try a shorter time range or fewer groups.";
        break;
      case 400:
        code = err.code || "BAD_REQUEST";
        message = err.serverMessage || `API error (${err.status})`;
        break;
      default:
        code = err.code || "BAD_REQUEST";
        message = err.serverMessage || `API error (${err.status})`;
    }
  }
  if (jsonOutput) {
    client.stdout.write(formatErrorJson(code, message, err.allowedValues));
  } else {
    output_manager_default.error(message);
    if (err.allowedValues && err.allowedValues.length > 0) {
      output_manager_default.print(`
Available values: ${err.allowedValues.join(", ")}
`);
    }
  }
  return 1;
}

export {
  getRollupColumnName,
  getResolvedOrderMetadata,
  formatQueryJson,
  formatErrorJson,
  handleApiError
};
