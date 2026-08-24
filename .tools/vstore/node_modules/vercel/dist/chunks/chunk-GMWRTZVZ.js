import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  formatOption,
  jsonOption,
  limitOption,
  packageName,
  projectOption,
  yesOption
} from "./chunk-SOFC4MLS.js";

// src/commands/comments/command.ts
var commentsProjectOption = {
  ...projectOption,
  shorthand: "p",
  description: "Project ID or name (defaults to the linked project)"
};
var messageContentOption = {
  name: "message",
  shorthand: "m",
  type: String,
  argument: "TEXT",
  deprecated: false,
  description: "Markdown message content"
};
var fileOption = {
  name: "file",
  shorthand: null,
  type: String,
  argument: "PATH",
  deprecated: false,
  description: "Read Markdown content from a file; use `-` for stdin"
};
var attachOption = {
  name: "attach",
  shorthand: null,
  type: [String],
  argument: "URL",
  deprecated: false,
  description: "Attach a file by https URL (repeatable, max 10)"
};
var nextCursorOption = {
  name: "next",
  shorthand: "N",
  type: String,
  argument: "CURSOR",
  deprecated: false,
  description: "Show the next page using the cursor from the previous output"
};
var listSubcommand = {
  name: "list",
  aliases: ["ls"],
  default: true,
  description: "List comments for a project",
  arguments: [],
  options: [
    commentsProjectOption,
    {
      name: "branch",
      shorthand: null,
      type: [String],
      argument: "BRANCH",
      deprecated: false,
      description: "Filter by Git branch (repeatable; defaults to the current branch when inferable)"
    },
    {
      name: "all-branches",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Show comments from every branch"
    },
    {
      name: "status",
      shorthand: null,
      type: String,
      argument: "STATUS",
      deprecated: false,
      description: "unresolved (default), resolved, or all"
    },
    {
      name: "page-path",
      shorthand: null,
      type: [String],
      argument: "PATH",
      deprecated: false,
      description: "Filter by recorded page path or glob (repeatable). Note: rewrites may record a different path than the browser URL"
    },
    {
      name: "page",
      shorthand: null,
      type: [String],
      argument: "PATH",
      deprecated: true,
      description: "Filter by recorded page path or glob"
    },
    {
      name: "author",
      shorthand: null,
      type: [String],
      argument: "USER",
      deprecated: false,
      description: "Filter by author user ID, or `me` (repeatable)"
    },
    {
      name: "content-id",
      shorthand: null,
      type: [String],
      argument: "ID",
      deprecated: false,
      description: "Filter by CMS content ID (repeatable)"
    },
    {
      name: "search",
      shorthand: null,
      type: String,
      argument: "TEXT",
      deprecated: false,
      description: "Search comment content"
    },
    limitOption,
    nextCursorOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List unresolved comments for the linked project",
      value: `${packageName} comments`
    },
    {
      name: "List comments on every branch",
      value: `${packageName} comments --all-branches --status all`
    },
    {
      name: "List comments as JSON",
      value: `${packageName} comments --json | jq '.threads[].id'`
    }
  ]
};
var inspectSubcommand = {
  name: "inspect",
  aliases: ["get"],
  description: "Show a comment thread with its full conversation",
  arguments: [{ name: "thread", required: false }],
  options: [
    commentsProjectOption,
    {
      name: "context",
      shorthand: null,
      type: Boolean,
      deprecated: false,
      description: "Include framework and device context"
    },
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Inspect a comment thread",
      value: `${packageName} comments inspect icZ9BnPPINuK`
    },
    {
      name: "Inspect a comment from its URL",
      value: `${packageName} comments inspect https://vercel.com/team/project/c/icZ9BnPPINuK`
    },
    {
      name: "Pick a comment interactively",
      value: `${packageName} comments inspect`
    },
    {
      name: "Inspect a thread whose ID starts with a dash",
      value: `${packageName} comments inspect -- -ULOL`
    }
  ]
};
var openSubcommand = {
  name: "open",
  aliases: [],
  description: "Open a comment thread on vercel.com",
  arguments: [{ name: "thread", required: true }],
  options: [commentsProjectOption],
  examples: [
    {
      name: "Open a comment in the browser",
      value: `${packageName} comments open icZ9BnPPINuK`
    }
  ]
};
var replySubcommand = {
  name: "reply",
  aliases: [],
  description: "Reply to a comment thread",
  arguments: [{ name: "thread", required: true }],
  options: [
    commentsProjectOption,
    messageContentOption,
    fileOption,
    attachOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Reply to a comment",
      value: `${packageName} comments reply icZ9BnPPINuK -m 'Fixed in **main**.'`
    },
    {
      name: "Reply from stdin",
      value: `git log -1 --format=%s | ${packageName} comments reply icZ9BnPPINuK`
    }
  ]
};
var resolveSubcommand = {
  name: "resolve",
  aliases: [],
  description: "Resolve comment threads, optionally with a closing reply",
  arguments: [{ name: "thread", required: true, multiple: true }],
  options: [
    commentsProjectOption,
    messageContentOption,
    yesOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Resolve a comment",
      value: `${packageName} comments resolve icZ9BnPPINuK`
    },
    {
      name: "Reply and resolve in one step",
      value: `${packageName} comments resolve icZ9BnPPINuK -m 'Fixed in the latest deployment'`
    }
  ]
};
var reopenSubcommand = {
  name: "reopen",
  aliases: [],
  description: "Reopen resolved comment threads",
  arguments: [{ name: "thread", required: true, multiple: true }],
  options: [commentsProjectOption, yesOption, formatOption, jsonOption],
  examples: [
    {
      name: "Reopen a comment",
      value: `${packageName} comments reopen icZ9BnPPINuK`
    }
  ]
};
var editSubcommand = {
  name: "edit",
  aliases: [],
  description: "Edit a comment message",
  arguments: [
    { name: "thread", required: true },
    { name: "message-id", required: true }
  ],
  options: [
    commentsProjectOption,
    messageContentOption,
    fileOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "Edit a message",
      value: `${packageName} comments edit icZ9BnPPINuK VvkhYF6dTqbpm7K -m 'Updated wording'`
    }
  ]
};
var deleteSubcommand = {
  name: "delete",
  aliases: [],
  description: "Delete a comment message",
  arguments: [
    { name: "thread", required: true },
    { name: "message-id", required: true }
  ],
  options: [commentsProjectOption, yesOption, formatOption, jsonOption],
  examples: [
    {
      name: "Delete a message",
      value: `${packageName} comments delete icZ9BnPPINuK VvkhYF6dTqbpm7K`
    }
  ]
};
var commentsCommand = {
  name: "comments",
  aliases: [],
  description: "Review and act on Vercel Toolbar comments from the command line",
  arguments: [],
  subcommands: [
    listSubcommand,
    inspectSubcommand,
    openSubcommand,
    replySubcommand,
    resolveSubcommand,
    reopenSubcommand,
    editSubcommand,
    deleteSubcommand
  ],
  options: [],
  examples: [
    {
      name: "Review unresolved comments for the linked project",
      value: `${packageName} comments`
    },
    {
      name: "Inspect a comment and reply",
      value: `${packageName} comments inspect icZ9BnPPINuK`
    },
    {
      name: "Reply and resolve in one step",
      value: `${packageName} comments resolve icZ9BnPPINuK -m 'Fixed!'`
    }
  ]
};

export {
  listSubcommand,
  inspectSubcommand,
  openSubcommand,
  replySubcommand,
  resolveSubcommand,
  reopenSubcommand,
  editSubcommand,
  deleteSubcommand,
  commentsCommand
};
