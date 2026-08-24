import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  isJSONObject
} from "./chunk-WODLA275.js";
import {
  getProjectByNameOrId
} from "./chunk-KDL2L4KL.js";
import {
  AGENT_REASON,
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import {
  ProjectNotFound,
  isAPIError
} from "./chunk-SOFC4MLS.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";

// src/commands/alerts/rules/custom-alert-query.ts
async function resolveCustomAlertProjectName(client, scope, projectId) {
  if (scope.projectId === projectId && scope.projectName) {
    return scope.projectName;
  }
  try {
    const project = await getProjectByNameOrId(client, projectId, scope.teamId);
    return project instanceof ProjectNotFound ? void 0 : project.name;
  } catch (error) {
    if (isAPIError(error)) {
      return void 0;
    }
    throw error;
  }
}
function parseCustomAlertQueryBody(client, body) {
  const customAlert = body.customAlert;
  if (!isJSONObject(customAlert)) {
    return void 0;
  }
  const queryJsonString = customAlert.queryJsonString;
  if (typeof queryJsonString !== "string") {
    return void 0;
  }
  let query;
  try {
    query = JSON.parse(queryJsonString);
  } catch {
    const message = "Invalid JSON in customAlert.queryJsonString.";
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message,
        hint: "Provide queryJsonString as an escaped JSON string. Run `vercel alerts rules schema --type custom_alert` for examples."
      },
      1
    );
    output_manager_default.error(message);
    return 1;
  }
  if (!isJSONObject(query)) {
    return void 0;
  }
  return { customAlert, query };
}
function setMissingCustomAlertProjectScope(parsedQuery, teamId, projectId, projectName) {
  const existingScope = parsedQuery.query.scope;
  if (existingScope !== void 0 && !isJSONObject(existingScope)) {
    return;
  }
  const projectScope = existingScope ?? {
    type: "project",
    ownerId: teamId,
    projectIds: [projectId]
  };
  if (!Object.hasOwn(projectScope, "projectId")) {
    projectScope.projectId = projectId;
  }
  if (projectName && !Object.hasOwn(projectScope, "projectName")) {
    projectScope.projectName = projectName;
  }
  parsedQuery.query.scope = projectScope;
  parsedQuery.customAlert.queryJsonString = JSON.stringify(parsedQuery.query);
}

export {
  resolveCustomAlertProjectName,
  parseCustomAlertQueryBody,
  setMissingCustomAlertProjectScope
};
