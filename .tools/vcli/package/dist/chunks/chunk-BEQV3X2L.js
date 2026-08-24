import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/commands/vcr/utils/paths.ts
function baseQuery(scope) {
  return new URLSearchParams({
    teamId: scope.teamId,
    projectId: scope.projectId
  });
}
function repositoriesPath(scope, opts = {}) {
  const query = baseQuery(scope);
  if (opts.limit !== void 0) {
    query.set("limit", String(opts.limit));
  }
  if (opts.cursor) {
    query.set("cursor", opts.cursor);
  }
  return `/v1/vcr/repository?${query.toString()}`;
}
function repositoryPath(scope, idOrName) {
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}?${baseQuery(scope).toString()}`;
}
function repositoryImagesPath(scope, idOrName, opts = {}) {
  const query = baseQuery(scope);
  if (opts.limit !== void 0) {
    query.set("limit", String(opts.limit));
  }
  if (opts.cursor) {
    query.set("cursor", opts.cursor);
  }
  if (opts.untagged) {
    query.set("untagged", "true");
  }
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}/images?${query.toString()}`;
}
function imagePath(scope, idOrName, imageId) {
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}/images/${encodeURIComponent(imageId)}?${baseQuery(scope).toString()}`;
}
function repositoryTagsPath(scope, idOrName, opts = {}) {
  const query = baseQuery(scope);
  if (opts.limit !== void 0) {
    query.set("limit", String(opts.limit));
  }
  if (opts.cursor) {
    query.set("cursor", opts.cursor);
  }
  if (opts.sortBy) {
    query.set("sortBy", opts.sortBy);
  }
  if (opts.sortOrder) {
    query.set("sortOrder", opts.sortOrder);
  }
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}/tags?${query.toString()}`;
}
function repositoryTagPath(scope, idOrName, tag) {
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}/tags/${encodeURIComponent(tag)}?${baseQuery(scope).toString()}`;
}
function repositoryPermissionsPath(scope, idOrName, opts = {}) {
  const query = baseQuery(scope);
  if (opts.limit !== void 0) {
    query.set("limit", String(opts.limit));
  }
  if (opts.cursor) {
    query.set("cursor", opts.cursor);
  }
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}/permissions?${query.toString()}`;
}
function repositoryPermissionsClearPath(scope, idOrName) {
  return `/v1/vcr/repository/${encodeURIComponent(idOrName)}/permissions/all?${baseQuery(scope).toString()}`;
}

export {
  repositoriesPath,
  repositoryPath,
  repositoryImagesPath,
  imagePath,
  repositoryTagsPath,
  repositoryTagPath,
  repositoryPermissionsPath,
  repositoryPermissionsClearPath
};
