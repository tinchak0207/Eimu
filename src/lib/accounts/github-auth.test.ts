import test from "node:test";
import assert from "node:assert/strict";
import { buildGitHubEmail, buildGitHubPassword, buildGitHubUsername } from "./github-auth.ts";

const profile = {
  id: 123456789,
  login: "Very-Long.GitHub_User_Name",
  email: "real@example.com",
};

test("github oauth uses a short stable backend username", () => {
  const username = buildGitHubUsername(profile);
  assert.equal(username, "github_123456789");
  assert.equal(username.length <= 20, true);
});

test("github oauth uses a backend-safe generated password", () => {
  assert.match(buildGitHubPassword(profile, "secret"), /^Gh[a-f0-9]{14}$/);
});

test("github oauth uses a versioned synthetic email to avoid old account collisions", () => {
  assert.equal(buildGitHubEmail(profile), "github-123456789-gh4@users.noreply.github.com");
});
