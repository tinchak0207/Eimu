import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  canPrompt
} from "./chunk-2473DUBR.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";

// src/commands/comments/content.ts
import { readFileSync } from "fs";
function readAllStandardInput(stdin) {
  if (stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      if (chunks.length === 0) {
        cleanup();
        resolve("");
      }
    }, 500);
    const onData = (chunk) => {
      chunks.push(String(chunk));
    };
    const onEnd = () => {
      cleanup();
      resolve(chunks.join(""));
    };
    function cleanup() {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
    }
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}
async function resolveMessageContent(client, flags, jsonOutput) {
  if (flags.message !== void 0 && flags.file !== void 0) {
    return outputError(
      client,
      jsonOutput,
      "CONFLICTING_CONTENT",
      "Use either --message or --file, not both."
    );
  }
  if (flags.message !== void 0) {
    return flags.message;
  }
  if (flags.file !== void 0) {
    if (flags.file === "-") {
      const piped2 = await readAllStandardInput(client.stdin);
      if (piped2) {
        return piped2;
      }
      return outputError(
        client,
        jsonOutput,
        "MISSING_CONTENT",
        "No content received on stdin for `--file -`."
      );
    }
    try {
      return readFileSync(flags.file, "utf8");
    } catch (err) {
      return outputError(
        client,
        jsonOutput,
        "FILE_READ_ERROR",
        `Could not read ${flags.file}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const piped = await readAllStandardInput(client.stdin);
  if (piped) {
    return piped;
  }
  if (flags.hasAttachments) {
    return void 0;
  }
  if (canPrompt(client) && !jsonOutput) {
    const text = await client.input.text({ message: "Comment message:" });
    if (text) {
      return text;
    }
  }
  return outputError(
    client,
    jsonOutput,
    "MISSING_CONTENT",
    'No content provided. Pass -m <text>, --file <path>, or pipe stdin (e.g. `echo "LGTM" | vercel comments reply <thread>`).'
  );
}

export {
  resolveMessageContent
};
