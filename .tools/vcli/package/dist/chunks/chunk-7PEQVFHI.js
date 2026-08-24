import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  getEnvTargetPlaceholder
} from "./chunk-KDL2L4KL.js";
import {
  packageName,
  projectOption,
  yesOption
} from "./chunk-SOFC4MLS.js";

// src/commands/build/command.ts
var buildCommand = {
  name: "build",
  aliases: [],
  description: "Build the project.",
  arguments: [],
  options: [
    {
      name: "prod",
      description: "Build a production deployment",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "target",
      shorthand: null,
      type: String,
      argument: "TARGET",
      deprecated: false,
      description: "Specify the target environment"
    },
    {
      name: "output",
      description: "Directory where built assets will be written to",
      shorthand: null,
      argument: "DIR",
      type: String,
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip the confirmation prompt about pulling environment variables and project settings when not found locally"
    },
    {
      name: "standalone",
      description: "Create a standalone build with all dependencies inlined into function output folders",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      name: "id",
      description: "Deployment ID to pull environment variables from (e.g. dpl_xxx)",
      shorthand: null,
      type: String,
      argument: "ID",
      deprecated: false
    },
    projectOption
  ],
  examples: [
    {
      name: "Build the project",
      value: `${packageName} build`
    },
    {
      name: "Build the project in a specific directory",
      value: `${packageName} build --cwd ./path-to-project`
    },
    {
      name: "Build with deployment-scoped environment variables",
      value: `${packageName} build --id dpl_xxx`
    }
  ]
};

// src/commands/pull/command.ts
var pullCommand = {
  name: "pull",
  aliases: [],
  description: "Pull latest environment variables and project settings from Vercel. ",
  arguments: [
    {
      name: "project-path",
      required: false
    }
  ],
  options: [
    {
      name: "environment",
      description: "Deployment environment [development]",
      argument: "TARGET",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "git-branch",
      description: "Specify the Git branch to pull specific Environment Variables for",
      argument: "NAME",
      shorthand: null,
      type: String,
      deprecated: false
    },
    {
      name: "prod",
      shorthand: null,
      type: Boolean,
      deprecated: false
    },
    {
      ...yesOption,
      description: "Skip questions when setting up new project using default scope and settings"
    },
    projectOption
  ],
  examples: [
    {
      name: "Pull the latest Environment Variables and Project Settings from the cloud",
      value: `${packageName} pull`
    },
    {
      name: "Pull the latest Environment Variables and Project Settings from the cloud targeting a directory",
      value: `${packageName} pull ./path-to-project`
    },
    {
      name: "Pull for a specific environment",
      value: `${packageName} pull --environment=${getEnvTargetPlaceholder()}`
    },
    {
      name: "Pull for a preview feature branch",
      value: `${packageName} pull --environment=preview --git-branch=feature-branch`
    },
    {
      name: "If you want to download environment variables to a specific file, use `vercel env pull` instead",
      value: `${packageName} env pull`
    }
  ]
};

export {
  buildCommand,
  pullCommand
};
