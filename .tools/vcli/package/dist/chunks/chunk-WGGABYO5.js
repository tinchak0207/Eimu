import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/util/is-valid-name.ts
function isValidName(name = "") {
  const blacklist = ":/#?&@%+~".split("");
  return !name.split("").every((c) => blacklist.includes(c));
}

// src/util/get-pagination-opts.ts
function getPaginationOpts(opts) {
  const { "--next": nextTimestamp, "--limit": limit } = opts;
  if (typeof nextTimestamp !== void 0 && Number.isNaN(nextTimestamp)) {
    throw new Error("Please provide a number for option --next");
  }
  if (typeof limit === "number" && (!Number.isInteger(limit) || limit > 100 || limit < 1)) {
    throw new Error(
      "Please provide an integer from 1 to 100 for option --limit"
    );
  }
  return [nextTimestamp, limit];
}

export {
  isValidName,
  getPaginationOpts
};
