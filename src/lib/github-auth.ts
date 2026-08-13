import { createHmac, randomUUID } from "node:crypto";

export interface GitHubProfile {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
}

export function buildGitHubAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri: string;
}) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function createGitHubState() {
  return randomUUID();
}

export function buildGitHubUsername(profile: GitHubProfile) {
  return `github_${profile.id}`;
}

export function buildGitHubPassword(profile: GitHubProfile, secret: string) {
  const digest = createHmac("sha256", secret)
    .update(`github:${profile.id}:${profile.login}`)
    .digest("hex");
  return `Gh${digest.slice(0, 14)}`;
}

export function buildGitHubDisplayName(profile: GitHubProfile) {
  return profile.name?.trim() || profile.login;
}

export function buildGitHubEmail(profile: GitHubProfile) {
  return `github-${profile.id}-gh4@users.noreply.github.com`;
}
