import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/commands/vcr/utils/image-ref.ts
var REPOSITORY_PATTERN = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
var TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
var DEFAULT_TAG = "latest";
function parseNameArg(nameArg, defaultRepo) {
  if (!nameArg) {
    return { repository: defaultRepo, tag: void 0 };
  }
  if (nameArg.includes("/")) {
    return {
      error: `Invalid image name "${nameArg}". Provide only a repository name (optionally with :tag); the registry, team, and project are added automatically.`
    };
  }
  const colon = nameArg.lastIndexOf(":");
  if (colon === -1) {
    return { repository: nameArg, tag: void 0 };
  }
  const repository = nameArg.slice(0, colon);
  const tag = nameArg.slice(colon + 1);
  if (!repository) {
    return {
      error: `Invalid image name "${nameArg}". Missing repository name before ":".`
    };
  }
  return { repository, tag };
}
function validateImageParts(parts) {
  if (!REPOSITORY_PATTERN.test(parts.repository)) {
    return `Invalid repository name "${parts.repository}". Use lowercase letters, digits, and separators (\`.\` \`_\` \`-\`), for example "my-app". Pass a valid name explicitly, e.g. \`... my-app\`.`;
  }
  if (parts.tag !== void 0 && !TAG_PATTERN.test(parts.tag)) {
    return `Invalid tag "${parts.tag}". Tags may contain letters, digits, "_", ".", "-" and be up to 128 characters.`;
  }
  return void 0;
}
function buildRepositoryReference(parts) {
  return `${parts.registry}/${parts.teamSlug}/${parts.projectName}/${parts.repository}`;
}

export {
  DEFAULT_TAG,
  parseNameArg,
  validateImageParts,
  buildRepositoryReference
};
