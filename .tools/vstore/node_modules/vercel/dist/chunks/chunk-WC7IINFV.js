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
  projectOption
} from "./chunk-SOFC4MLS.js";

// src/commands/vcr/tags/command.ts
var projectScopeOption = {
  ...projectOption,
  shorthand: "p",
  description: "Project name or ID (defaults to the linked project)."
};
var nextOption = {
  name: "next",
  shorthand: null,
  type: String,
  deprecated: false,
  description: "Continue from a previous response",
  argument: "CURSOR"
};
var cursorOption = {
  name: "cursor",
  shorthand: "c",
  type: String,
  deprecated: true,
  description: "Cursor from a previous page to continue listing from",
  argument: "STRING"
};
var TAGS_SORT_BY_CHOICES = ["updatedAt", "tag"];
var TAGS_SORT_ORDER_CHOICES = ["asc", "desc"];
var tagsLsSubcommand = {
  name: "ls",
  aliases: ["list"],
  description: "List a repository's tags",
  arguments: [
    {
      name: "repository",
      required: true
    }
  ],
  options: [
    projectScopeOption,
    {
      name: "sort-by",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Field to sort tags by (default: updatedAt)",
      argument: "FIELD",
      choices: TAGS_SORT_BY_CHOICES
    },
    {
      name: "sort-order",
      shorthand: null,
      type: String,
      deprecated: false,
      description: "Sort direction (default: desc)",
      argument: "ORDER",
      choices: TAGS_SORT_ORDER_CHOICES
    },
    limitOption,
    nextOption,
    cursorOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List a repository's tags",
      value: `${packageName} vcr tag ls my-app`
    }
  ]
};
var tagsInspectSubcommand = {
  name: "inspect",
  aliases: ["get"],
  description: "Show details for a single tag",
  arguments: [
    {
      name: "repository",
      required: true
    },
    {
      name: "tag",
      required: true
    }
  ],
  options: [projectScopeOption, formatOption, jsonOption],
  examples: [
    {
      name: "Inspect a tag by name",
      value: `${packageName} vcr tag inspect my-app latest`
    }
  ]
};
var tagsAggregateCommand = {
  name: "tag",
  aliases: ["tags"],
  description: "List or inspect a repository's tags",
  arguments: [],
  subcommands: [tagsLsSubcommand, tagsInspectSubcommand],
  options: [],
  examples: []
};

export {
  TAGS_SORT_BY_CHOICES,
  TAGS_SORT_ORDER_CHOICES,
  tagsLsSubcommand,
  tagsInspectSubcommand,
  tagsAggregateCommand
};
