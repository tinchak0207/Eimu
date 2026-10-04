import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_RELEASES } from "../../../../lib/desktop-releases";
import { GET } from "./route";

// 执行器限定 `npx --yes tsx --test`（repo 的 npm test 走它）。
// 这条路由是 DESKTOP_RELEASES 的对外投射：断言 HTTP 契约（状态码／快取头／键形状）
// 与「值确实等于单一真源」，不另立第二份版本资料。

test("GET /api/desktop/releases 回来源真值与两平台栏位", async () => {
  const response = await GET();
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    version: string;
    releases: Record<string, { version: string; url: string; size: number; sha256: string; ext: string }>;
  };

  assert.equal(body.version, DESKTOP_RELEASES.version);
  assert.deepEqual(Object.keys(body.releases).sort(), ["linux", "windows"]);
  for (const platform of ["linux", "windows"] as const) {
    const release = DESKTOP_RELEASES[platform];
    assert.deepEqual(body.releases[platform], {
      version: release.version,
      url: release.url,
      size: release.size,
      sha256: release.sha256,
      ext: release.ext,
    });
    // 逐平台版号是旧壳提示的比对基准，必须是该平台自身版本、非 top-level。
    assert.equal(body.releases[platform].version, release.version);
    assert.match(body.releases[platform].url, /^https:\/\//, `${platform} 应为 https 下载网址`);
    assert.ok(body.releases[platform].size > 0, `${platform} size 应为正整数`);
    assert.match(body.releases[platform].sha256, /^[0-9a-f]{64}$/, `${platform} sha256 应为 64 位 hex`);
  }
  // 两平台版号各自独立、皆为该平台自身的最新产物版号 0.3.2，不可被 top-level 取代。
  assert.equal(body.releases.linux.version, "0.3.2");
  assert.equal(body.releases.windows.version, "0.3.2");
});

test("GET /api/desktop/releases 带短快取、不泄漏 secret", async () => {
  const response = await GET();
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
  const raw = JSON.stringify(await response.json());
  // 对外只该有公开下载栏位；不应出现凭证类字样。
  assert.doesNotMatch(raw, /secret|token|api[_-]?key|password/i);
});
