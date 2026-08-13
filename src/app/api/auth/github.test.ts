import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

test("github auth routes exist for start and callback flow", () => {
  const startRoute = read("src/app/api/auth/github/start/route.ts");
  const callbackRoute = read("src/app/api/auth/github/callback/route.ts");

  assert.match(startRoute, /export async function GET/);
  assert.match(callbackRoute, /export async function GET/);
});

test("public authentication only exposes OAuth (GitHub + WeChat)", () => {
  const navbar = read("src/components/Navbar.tsx");
  const playground = read("src/components/ImagePlayground.tsx");
  const pricing = read("src/components/PricingClient.tsx");
  const history = read("src/components/HistoryClient.tsx");
  const authClient = read("src/lib/auth-client.ts");
  const loginRoute = read("src/app/api/auth/login/route.ts");
  const registerRoute = read("src/app/api/auth/register/route.ts");

  assert.match(navbar, /SplitLoginButton|github\/start|wechat-login/);
  assert.doesNotMatch(navbar, /AuthModal|authOpen|openAuth/);
  assert.match(playground, /window\.location\.href = "\/api\/auth\/github\/start"/);
  assert.match(pricing, /window\.location\.href = "\/api\/auth\/github\/start"/);
  for (const source of [playground, pricing, history]) assert.doesNotMatch(source, /AuthModal/);
  assert.doesNotMatch(authClient, /\/api\/auth\/(login|register)/);
  for (const route of [loginRoute, registerRoute]) {
    assert.match(route, /status: 410/);
    assert.match(route, /GitHub/);
    assert.doesNotMatch(route, /loginViaNewApi|mockLogin|mockRegister|\/api\/user\/register/);
  }
});
