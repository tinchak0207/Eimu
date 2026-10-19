import { createHmac, randomUUID } from "node:crypto";

export interface GoogleProfile {
  sub: string;
  name?: string | null;
  email?: string | null;
  email_verified?: boolean;
  picture?: string | null;
}

export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri: string;
}) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function createGoogleState() {
  return randomUUID();
}

export function buildGoogleUsername(profile: GoogleProfile) {
  return `google_${profile.sub}`;
}

export function buildGooglePassword(profile: GoogleProfile, secret: string) {
  const digest = createHmac("sha256", secret)
    .update(`google:${profile.sub}`)
    .digest("hex");
  return `Gg${digest.slice(0, 14)}`;
}

export function buildGoogleDisplayName(profile: GoogleProfile) {
  return profile.name?.trim() || profile.email?.split("@")[0] || "Google 用户";
}

export function buildGoogleEmail(profile: GoogleProfile) {
  return `google-${profile.sub}@oauth.eimu.dev`;
}
