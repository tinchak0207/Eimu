import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  ellipsis
} from "./chunk-KDYRLN6H.js";
import {
  ALIGNED_LABEL_WIDTH
} from "./chunk-KDL2L4KL.js";
import {
  require_ms
} from "./chunk-GGP5R3FU.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/comments/format.ts
var import_chalk = __toESM(require_source(), 1);
var import_ms = __toESM(require_ms(), 1);
function alignedRow(label, value) {
  return `  ${import_chalk.default.bold(label.padEnd(ALIGNED_LABEL_WIDTH))}${value}`;
}
function actorLabel(actor) {
  if (!actor) {
    return "-";
  }
  const base = actor.name || actor.username || actor.id;
  return actor.type === "app" ? `${base} (app)` : base;
}
function relativeAge(timestamp) {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "-";
  }
  const delta = Date.now() - timestamp;
  if (delta < 1e3) {
    return "now";
  }
  return (0, import_ms.default)(delta);
}
function displayPath(thread) {
  const href = thread.context?.href;
  if (href) {
    try {
      return new URL(href).pathname;
    } catch {
    }
  }
  return thread.context?.path || "/";
}
function truncate(text, max) {
  return ellipsis(text.replace(/\s+/g, " ").trim(), max);
}
function firstMessageText(thread) {
  return thread.messages[0]?.text ?? "";
}
function threadAge(thread) {
  return relativeAge(thread.messages[0]?.timestamp);
}
function renderThreadSummary(thread, complete) {
  const replies = thread.messageCount - 1;
  const rootAuthorId = complete ? thread.messages[0]?.author.id : void 0;
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  for (const message of thread.messages) {
    const { author } = message;
    if (author.id === rootAuthorId || seen.has(author.id)) {
      continue;
    }
    seen.add(author.id);
    names.push(actorLabel(author));
  }
  const shown = names.slice(0, 3);
  const overflow = names.length - shown.length;
  const participants = shown.length > 0 ? `${shown.join(", ")}${overflow > 0 ? ` +${overflow} more` : ""}` : void 0;
  const lastTimestamp = thread.messages[thread.messages.length - 1]?.timestamp;
  const parts = [`\u2192 ${replies} ${replies === 1 ? "reply" : "replies"}`];
  if (participants) {
    parts.push(participants);
  }
  parts.push(`last ${relativeAge(lastTimestamp)} ago`);
  return parts.join(" \xB7 ");
}
function renderThreadRow(thread, opts) {
  const complete = thread.messageCount <= thread.messages.length;
  const dot = thread.resolved ? import_chalk.default.dim("\u25CB") : "\u25CF";
  const author = complete ? actorLabel(thread.messages[0]?.author) : "\u2026";
  const columns = [
    dot,
    thread.id,
    import_chalk.default.dim(threadAge(thread)),
    author,
    displayPath(thread)
  ];
  if (opts.showBranch && thread.branch) {
    columns.push(import_chalk.default.dim(thread.branch));
  }
  if (thread.isLocalhost) {
    columns.push(import_chalk.default.dim("localhost"));
  }
  const lines = [`  ${columns.join("  ")}`];
  if (complete) {
    const excerpt = truncate(firstMessageText(thread), 80);
    if (excerpt) {
      lines.push(`    \u201C${excerpt}\u201D`);
    }
  } else {
    lines.push(
      import_chalk.default.dim("    (long thread \u2014 inspect for the full conversation)")
    );
  }
  const selection = thread.context?.selection;
  if (selection) {
    lines.push(import_chalk.default.dim(`    \u2192 selected: \u201C${truncate(selection, 60)}\u201D`));
  }
  if (thread.messageCount > 1) {
    lines.push(import_chalk.default.dim(`    ${renderThreadSummary(thread, complete)}`));
  }
  const meta = [];
  const reactionCount = thread.messages.reduce(
    (acc, message) => acc + (message.reactions?.length ?? 0),
    0
  );
  if (reactionCount > 0) {
    meta.push(
      `${reactionCount} ${reactionCount === 1 ? "reaction" : "reactions"}`
    );
  }
  const attachmentCount = thread.messages.reduce(
    (acc, message) => acc + (message.attachments?.length ?? 0),
    0
  );
  if (attachmentCount > 0) {
    meta.push(
      `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`
    );
  }
  if (thread.resolved) {
    meta.push(`resolved by ${actorLabel(thread.resolvedBy)}`);
  }
  if (meta.length > 0) {
    lines.push(import_chalk.default.dim(`    ${meta.join(" \xB7 ")}`));
  }
  return lines.join("\n");
}
function renderReactions(message) {
  if (!message.reactions || message.reactions.length === 0) {
    return void 0;
  }
  return message.reactions.map((r) => `${r.emoji} ${r.name} \xB7 ${r.users.length}`).join("   ");
}
function renderMessage(message) {
  const lines = [
    `${import_chalk.default.bold(actorLabel(message.author))} \xB7 ${relativeAge(message.timestamp)} ago \xB7 ${import_chalk.default.dim(message.id)}`
  ];
  for (const textLine of message.text.split("\n")) {
    lines.push(`  ${textLine}`);
  }
  for (const attachment of message.attachments ?? []) {
    const dimensions = attachment.width && attachment.height ? ` (${attachment.width}\xD7${attachment.height})` : "";
    lines.push(
      `${import_chalk.default.dim(`  \u2192 attachment ${attachment.filename}${dimensions}`)} ${import_chalk.default.cyan(attachment.url)}`
    );
  }
  const reactions = renderReactions(message);
  if (reactions) {
    lines.push(`  ${reactions}`);
  }
  return lines.join("\n");
}
function renderThreadDetail(thread, messages, opts) {
  const sections = [];
  const status = thread.resolved ? import_chalk.default.dim(`resolved by ${actorLabel(thread.resolvedBy)}`) : "unresolved";
  const headline = [import_chalk.default.bold(thread.id), status];
  if (thread.branch) {
    headline.push(import_chalk.default.dim(thread.branch));
  }
  if (thread.isLocalhost) {
    headline.push(import_chalk.default.dim("localhost"));
  }
  sections.push(headline.join(" \xB7 "));
  const headerLines = [];
  const path = displayPath(thread);
  const pageTitle = thread.context?.pageTitle;
  headerLines.push(pageTitle ? `${path} \u2014 \u201C${pageTitle}\u201D` : path);
  if (thread.context?.href) {
    headerLines.push(import_chalk.default.cyan(thread.context.href));
  }
  sections.push(headerLines.join("\n"));
  const contextLines = [];
  if (thread.context?.selection) {
    contextLines.push(alignedRow("Selected", `\u201C${thread.context.selection}\u201D`));
  }
  if (thread.context?.selector) {
    contextLines.push(alignedRow("Element", thread.context.selector));
  }
  for (const link of thread.links ?? []) {
    contextLines.push(
      alignedRow("Linked", `${link.label} \u2014 ${import_chalk.default.cyan(link.link)}`)
    );
  }
  if (contextLines.length > 0) {
    sections.push(contextLines.join("\n"));
  }
  sections.push(messages.map(renderMessage).join("\n\n"));
  if (opts.showContext) {
    const extra = [];
    if (thread.context?.frameworkContext) {
      extra.push(
        `${import_chalk.default.bold("Framework context")}
${thread.context.frameworkContext}`
      );
    }
    if (thread.context?.device) {
      extra.push(
        `${import_chalk.default.bold("Device")}
${JSON.stringify(thread.context.device, null, 2)}`
      );
    }
    if (extra.length > 0) {
      sections.push(extra.join("\n\n"));
    }
  }
  if (thread.webUrl) {
    sections.push(`Open in Vercel \u2192 ${import_chalk.default.cyan(thread.webUrl)}`);
  }
  return sections.join("\n\n");
}

export {
  actorLabel,
  displayPath,
  truncate,
  threadAge,
  renderThreadRow,
  renderThreadDetail
};
