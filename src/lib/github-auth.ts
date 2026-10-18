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
    .update(`github:${profile.id}`)
    .digest("hex");
  return `Gh${digest.slice(0, 14)}`;
}

/** 改名之前的推导。只在新密码登录失败时再试一次，避免把未改名的老账号锁在门外。 */
export function buildGitHubPasswordLegacy(profile: GitHubProfile, secret: string) {
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

// PWA handoff：跨浏览器交接时 state 里额外携带一次性 ticket。
// state 与 ticket 都是不含 "." 的字符串（state = randomUUID，ticket = hex），
// 用 "." 分隔可逆；无 ticket 的 state 保持原样，老链路零影响。
export function embedTicketInState(baseState: string, ticket: string): string {
  return `${baseState}.${ticket}`;
}

export function extractTicketFromState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [base, ticket] = parts;
  if (!base || !ticket) return null;
  return ticket;
}

/** handoff 查询值可附带邀请码（ticket~invite）。ticket 本身不含 ~。 */
export function packHandoffTicket(ticket: string, invite: string | null | undefined): string {
  if (!invite || invite.includes("~") || invite.includes(".")) return ticket;
  return `${ticket}~${invite}`;
}

export function unpackHandoffTicket(raw: string | null | undefined): { ticket: string | null; invite: string | null } {
  if (!raw) return { ticket: null, invite: null };
  const splitAt = raw.indexOf("~");
  if (splitAt <= 0) return { ticket: raw, invite: null };
  const ticket = raw.slice(0, splitAt);
  const invite = raw.slice(splitAt + 1);
  if (!ticket || !invite) return { ticket: raw, invite: null };
  return { ticket, invite };
}
