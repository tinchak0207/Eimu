import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/commands/comments/threads.ts
function parseThreadArg(arg) {
  if (!/^https?:\/\//i.test(arg)) {
    return { id: arg };
  }
  let url;
  try {
    url = new URL(arg);
  } catch {
    return void 0;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const cIndex = segments.lastIndexOf("c");
  if (cIndex !== -1 && cIndex + 1 < segments.length) {
    const id = safeDecode(segments[cIndex + 1]);
    if (!id) {
      return void 0;
    }
    return {
      id,
      teamSlug: cIndex > 1 ? safeDecode(segments[0]) : void 0
    };
  }
  return void 0;
}
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment) || void 0;
  } catch {
    return void 0;
  }
}

export {
  parseThreadArg
};
