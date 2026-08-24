import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/util/output/format-granularity.ts
function formatGranularity(value) {
  if (!value || typeof value !== "object") {
    return void 0;
  }
  const granularity = value;
  if (typeof granularity.minutes === "number") {
    return `${granularity.minutes}m`;
  }
  if (typeof granularity.hours === "number") {
    return `${granularity.hours}h`;
  }
  if (typeof granularity.days === "number") {
    return `${granularity.days}d`;
  }
  return void 0;
}

export {
  formatGranularity
};
