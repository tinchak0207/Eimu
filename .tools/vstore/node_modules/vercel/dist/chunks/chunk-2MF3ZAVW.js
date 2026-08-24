import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  tagsAggregateCommand
} from "./chunk-WC7IINFV.js";
import {
  imageAggregateCommand
} from "./chunk-RIB4S2IB.js";
import {
  permissionsAggregateCommand
} from "./chunk-GFCTRJI5.js";
import {
  formatOption,
  jsonOption,
  limitOption,
  packageName,
  projectOption,
  yesOption
} from "./chunk-SOFC4MLS.js";

// src/commands/vcr/command.ts
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
var platformOption = {
  name: "platform",
  shorthand: null,
  type: String,
  deprecated: false,
  description: "Target platform for the build (defaults to linux/amd64).",
  argument: "PLATFORM"
};
var pushOption = {
  name: "push",
  shorthand: null,
  type: Boolean,
  deprecated: false,
  description: "Push the image after building. With Docker this builds and pushes in one step (Buildx enables zstd compression); Podman and Buildah build, then push with zstd compression."
};
var publicOption = {
  name: "public",
  shorthand: null,
  type: String,
  deprecated: false,
  description: "Set the repository visibility: `true` for public, `false` for private.",
  argument: "BOOLEAN",
  choices: ["true", "false"]
};
var listSubcommand = {
  name: "ls",
  aliases: ["list"],
  description: "List container registry repositories for a project",
  arguments: [],
  options: [
    projectScopeOption,
    limitOption,
    nextOption,
    cursorOption,
    formatOption,
    jsonOption
  ],
  examples: [
    {
      name: "List repositories in the linked project",
      value: `${packageName} vcr ls`
    },
    {
      name: "List repositories for a specific project as JSON",
      value: `${packageName} vcr ls --project my-app --json`
    }
  ]
};
var inspectSubcommand = {
  name: "inspect",
  aliases: ["get"],
  description: "Show details for a single repository",
  arguments: [
    {
      name: "repository",
      required: true
    }
  ],
  options: [projectScopeOption, formatOption, jsonOption],
  examples: [
    {
      name: "Inspect a repository by name",
      value: `${packageName} vcr inspect my-repository`
    }
  ]
};
var addSubcommand = {
  name: "add",
  aliases: ["create"],
  description: "Create a container registry repository",
  arguments: [
    {
      name: "name",
      required: true
    }
  ],
  options: [projectScopeOption, formatOption, jsonOption],
  examples: [
    {
      name: "Create a repository",
      value: `${packageName} vcr add my-repository`
    }
  ]
};
var configSubcommand = {
  name: "config",
  aliases: [],
  description: "Configure a container registry repository, such as the repository's visibility",
  arguments: [
    {
      name: "repository",
      required: true
    }
  ],
  options: [publicOption, projectScopeOption, formatOption, jsonOption],
  examples: [
    {
      name: "Make a repository public",
      value: `${packageName} vcr config my-repository --public true`
    },
    {
      name: "Make a repository private",
      value: `${packageName} vcr config my-repository --public false`
    }
  ]
};
var removeSubcommand = {
  name: "rm",
  aliases: ["remove", "delete"],
  description: "Delete a container registry repository",
  arguments: [
    {
      name: "repository",
      required: true
    }
  ],
  options: [projectScopeOption, yesOption, formatOption, jsonOption],
  examples: [
    {
      name: "Delete a repository",
      value: `${packageName} vcr rm my-repository`
    },
    {
      name: "Delete a repository without the confirmation prompt",
      value: `${packageName} vcr rm my-repository --yes`
    }
  ]
};
var loginSubcommand = {
  name: "login",
  aliases: [],
  description: "Authenticate a container tool (docker, podman, or buildah) with the Vercel Container Registry",
  arguments: [
    {
      name: "engine",
      required: true
    }
  ],
  options: [projectScopeOption, formatOption, jsonOption],
  examples: [
    {
      name: "Log in with Docker",
      value: `${packageName} vcr login docker`
    },
    {
      name: "Log in with Podman",
      value: `${packageName} vcr login podman`
    },
    {
      name: "Log in with Buildah",
      value: `${packageName} vcr login buildah`
    },
    {
      name: "Log in for a specific project",
      value: `${packageName} vcr login docker --project my-app`
    }
  ]
};
var buildSubcommand = {
  name: "build",
  aliases: [],
  description: "Build a container image tagged for the Vercel Container Registry by shelling out to your container tool (docker, podman, or buildah)",
  arguments: [
    {
      name: "engine",
      required: true
    },
    {
      name: "path",
      required: false
    },
    {
      name: "name",
      required: false
    }
  ],
  options: [projectScopeOption, platformOption, pushOption],
  examples: [
    {
      name: "Build the current directory into the linked project (repository defaults to the project name, tag to latest)",
      value: `${packageName} vcr build docker`
    },
    {
      name: "Build and push in one step (Docker Buildx enables zstd compression)",
      value: `${packageName} vcr build docker --push`
    },
    {
      name: "Build a specific context path with a repository and tag",
      value: `${packageName} vcr build docker ./app my-api:1.2.3`
    },
    {
      name: "Pass extra flags through to the container tool",
      value: `${packageName} vcr build docker . -- --no-cache --build-arg KEY=value`
    }
  ]
};
var pushSubcommand = {
  name: "push",
  aliases: [],
  description: "Push a container image to the Vercel Container Registry by shelling out to your container tool (docker, podman, or buildah)",
  arguments: [
    {
      name: "engine",
      required: true
    },
    {
      name: "name",
      required: false
    }
  ],
  options: [projectScopeOption],
  examples: [
    {
      name: "Push the linked project image (repository defaults to the project name, tag to latest)",
      value: `${packageName} vcr push docker`
    },
    {
      name: "Push a specific repository and tag",
      value: `${packageName} vcr push docker my-api:1.2.3`
    }
  ]
};
var vcrCommand = {
  name: "vcr",
  aliases: [],
  description: "Manage Vercel Container Registry repositories and images (see `vcr image`).",
  arguments: [],
  subcommands: [
    listSubcommand,
    inspectSubcommand,
    addSubcommand,
    configSubcommand,
    removeSubcommand,
    loginSubcommand,
    buildSubcommand,
    pushSubcommand,
    tagsAggregateCommand,
    imageAggregateCommand,
    permissionsAggregateCommand
  ],
  options: [],
  examples: [
    {
      name: "List repositories in the linked project",
      value: `${packageName} vcr ls`
    },
    {
      name: "Create a repository",
      value: `${packageName} vcr add my-app`
    },
    {
      name: "List images in a repository",
      value: `${packageName} vcr image ls my-app`
    }
  ]
};

export {
  listSubcommand,
  inspectSubcommand,
  addSubcommand,
  configSubcommand,
  removeSubcommand,
  loginSubcommand,
  buildSubcommand,
  pushSubcommand,
  vcrCommand
};
