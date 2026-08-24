import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  formatOption,
  limitOption,
  packageName,
  projectOption,
  yesOption
} from "./chunk-SOFC4MLS.js";

// src/commands/vcr/permissions/command.ts
var PERMISSIONS_ACTIONS = {
  ls: ["ls", "list"],
  add: ["add"],
  rm: ["rm", "remove"],
  clear: ["clear"]
};
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
var permissionsLsSubcommand = {
  name: "ls",
  aliases: ["list"],
  description: "List teams with access to a repository",
  arguments: [],
  options: [
    projectScopeOption,
    limitOption,
    nextOption,
    cursorOption,
    formatOption
  ],
  examples: [
    {
      name: "List teams with access to a repository",
      value: `${packageName} vcr permissions my-app ls`
    },
    {
      name: "List teams with access as JSON",
      value: `${packageName} vcr permissions my-app ls --format json`
    }
  ]
};
var permissionsAddSubcommand = {
  name: "add",
  aliases: [],
  description: "Give one or more teams access to pull images from a repository",
  arguments: [
    {
      name: "team",
      required: true,
      multiple: true
    }
  ],
  options: [projectScopeOption, formatOption],
  examples: [
    {
      name: "Share a repository with a team by id",
      value: `${packageName} vcr permissions my-app add team_1a2b3c4d`
    },
    {
      name: "Share a repository with a team by slug",
      value: `${packageName} vcr permissions my-app add my-team`
    },
    {
      name: "Share a repository with multiple teams",
      value: `${packageName} vcr permissions my-app add team_1a2b3c4d,other-team`
    }
  ]
};
var permissionsRmSubcommand = {
  name: "rm",
  aliases: ["remove"],
  description: "Remove one or more teams' access to a repository",
  arguments: [
    {
      name: "team",
      required: true,
      multiple: true
    }
  ],
  options: [projectScopeOption, formatOption],
  examples: [
    {
      name: "Remove a team's access by id",
      value: `${packageName} vcr permissions my-app rm team_1a2b3c4d`
    },
    {
      name: "Remove multiple teams' access",
      value: `${packageName} vcr permissions my-app rm team_1a2b3c4d,other-team`
    }
  ]
};
var permissionsClearSubcommand = {
  name: "clear",
  aliases: [],
  description: "Remove access to a repository for every team",
  arguments: [],
  options: [projectScopeOption, yesOption, formatOption],
  examples: [
    {
      name: "Clear all repository permissions",
      value: `${packageName} vcr permissions my-app clear`
    },
    {
      name: "Clear all repository permissions without the confirmation prompt",
      value: `${packageName} vcr permissions my-app clear --yes`
    }
  ]
};
var permissionsAggregateCommand = {
  name: "permissions",
  aliases: ["permission"],
  description: "Manage which teams can pull images from a container registry repository",
  arguments: [
    {
      name: "repository",
      required: true
    }
  ],
  subcommands: [
    permissionsLsSubcommand,
    permissionsAddSubcommand,
    permissionsRmSubcommand,
    permissionsClearSubcommand
  ],
  options: [],
  examples: [
    {
      name: "List teams with access to a repository",
      value: `${packageName} vcr permissions my-app ls`
    },
    {
      name: "Share a repository with a team",
      value: `${packageName} vcr permissions my-app add team_1a2b3c4d`
    },
    {
      name: "Remove a team's access to a repository",
      value: `${packageName} vcr permissions my-app rm team_1a2b3c4d`
    },
    {
      name: "Clear all repository permissions",
      value: `${packageName} vcr permissions my-app clear`
    }
  ]
};

export {
  PERMISSIONS_ACTIONS,
  permissionsLsSubcommand,
  permissionsAddSubcommand,
  permissionsRmSubcommand,
  permissionsClearSubcommand,
  permissionsAggregateCommand
};
