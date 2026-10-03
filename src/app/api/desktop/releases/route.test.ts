import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_RELEASES } from "../../../../lib/desktop-releases";
import { GET } from "./route";

// 執行器限定 `npx --yes tsx --test`（repo 的 npm test 走它）。
// 這條路由是 DESKTOP_RELEASES 的對外投射：斷言 HTTP 契約（狀態碼／快取頭／鍵形狀）
// 與「值確實等於單一真源」，不另立第二份版本資料。

test("GET /api/desktop/releases 回來源真值與兩平台欄位", async () => {
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
    // 逐平台版號是舊殼提示的比對基準，必須是該平台自身版本、非 top-level。
    assert.equal(body.releases[platform].version, release.version);
    assert.match(body.releases[platform].url, /^https:\/\//, `${platform} 應為 https 下載網址`);
    assert.ok(body.releases[platform].size > 0, `${platform} size 應為正整數`);
    assert.match(body.releases[platform].sha256, /^[0-9a-f]{64}$/, `${platform} sha256 應為 64 位 hex`);
  }
  // 兩平台版號各自獨立、皆為該平台自身的最新產物版號 0.3.2，不可被 top-level 取代。
  assert.equal(body.releases.linux.version, "0.3.2");
  assert.equal(body.releases.windows.version, "0.3.2");
});

test("GET /api/desktop/releases 帶短快取、不洩漏 secret", async () => {
  const response = await GET();
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
  const raw = JSON.stringify(await response.json());
  // 對外只該有公開下載欄位；不應出現憑證類字樣。
  assert.doesNotMatch(raw, /secret|token|api[_-]?key|password/i);
});
