// 兩段式上傳第一段（P1-10 / 對稱差 D36）：VPS 後端的直傳憑證簽發。
//
// 為什麼要有這支：`issueDirectUploadCredential` 原本在 VPS 後端**一律 501**
// （`vps_blob_direct_upload_unsupported`），因為 image-data-api 只認母鑰、沒有簽名端點。
// 2026-09-29 在 image-data-api 補了 `POST /api/blob/presign`（HMAC 短效簽名）之後，
// 本檔把「母鑰只留在伺服器端、下發給瀏覽器的是短效簽名」這件事釘成行為斷言。
//
// vps-blob-adapter 的 BASE_URL/API_KEY 是**模組載入期快照**，故先設 env 再動態 import
// （照抄 `blob-backend.vps.test.ts` 的既有手法）。
import { test } from "node:test";
import assert from "node:assert/strict";

const VPS_BASE = "https://vps-data.example";
const MASTER_KEY = "test-master-key-do-not-log";
process.env.IMAGE_DATA_BASE_URL = VPS_BASE;
process.env.IMAGE_DATA_API_KEY = MASTER_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;

type PresignResponse = {
  status: number;
  body?: unknown;
};

/** presign 端點替身：真記錄請求（URL／標頭／body），斷言「母鑰只在伺服器端」。 */
function stubPresign(response: PresignResponse): {
  calls: { url: string; key: string | null; body: Record<string, unknown> }[];
  restore: () => void;
} {
  const calls: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      url,
      key: headers.get("x-image-data-key"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function jsonRequest(): Request {
  return new Request("https://eimu.dev/api/uploads/sign", { method: "POST" });
}

test("VPS 後端判定為 vps-blob（不會再走 Vercel 分支）", async () => {
  const { resolveDirectUploadBackend } = await import("./two-phase-upload");
  assert.equal(resolveDirectUploadBackend(), "vps-blob");
});

test("第一段：向 image-data-api 取短效簽名，母鑰只留在伺服器端、下發的是 ticket", async () => {
  const { issueDirectUploadCredential } = await import("./two-phase-upload");
  const stub = stubPresign({
    status: 200,
    body: {
      url: `${VPS_BASE}/api/blob/uploads/7/20260929/deadbeef-clip.mp4`,
      ticket: "signed-ticket-abc",
      contentType: "video/mp4",
      expiresInMs: 3_600_000,
      expiresAt: "2026-09-29T17:00:00.000Z",
      maxBytes: 104_857_600,
      headers: {
        "x-upload-ticket": "signed-ticket-abc",
        "x-upload-path": "uploads/7/20260929/deadbeef-clip.mp4",
        "x-upload-expires": "1789000000000",
        "x-content-type": "video/mp4",
      },
    },
  });
  try {
    const credential = await issueDirectUploadCredential({
      userId: 7,
      filename: "clip.mp4",
      contentType: "video/mp4",
      size: 3_145_728,
      request: jsonRequest(),
    });

    // 憑證形狀：目標主機＝物件存儲，不是我方網域。
    assert.equal(credential.backend, "vps-blob");
    assert.equal(credential.method, "PUT");
    assert.equal(new URL(credential.uploadUrl).host, "vps-data.example");
    assert.notEqual(new URL(credential.uploadUrl).host, "eimu.dev");
    // 瀏覽器拿到的是短效簽名，不是母鑰。
    assert.equal(credential.clientToken, "signed-ticket-abc");
    assert.equal(credential.headers?.["x-upload-ticket"], "signed-ticket-abc");
    assert.ok(
      !JSON.stringify(credential).includes(MASTER_KEY),
      "母鑰不得出現在下發給瀏覽器的憑證裡",
    );
    // objectKey 落在呼叫者自己的前綴下；公網 URL 由 VPS base 推導。
    assert.match(credential.objectKey, /^uploads\/7\//);
    assert.equal(credential.downloadUrl, `${VPS_BASE}/files/${credential.objectKey}`);
    // maxBytes 取端點回報的真實上限（VPS 管線），不是本檔常數 512MB。
    assert.equal(credential.maxBytes, 104_857_600);
    assert.equal(credential.expiresInMs, 3_600_000);

    // 伺服器端確實帶母鑰去打簽名端點，且請求體只有 metadata、零檔案位元組。
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.url, `${VPS_BASE}/api/blob/presign`);
    assert.equal(stub.calls[0]!.key, MASTER_KEY);
    assert.equal(stub.calls[0]!.body.pathname, credential.objectKey);
    assert.equal(stub.calls[0]!.body.contentType, "video/mp4");
    assert.equal(stub.calls[0]!.body.size, undefined, "第一段請求體不得帶檔案大小以外的位元組欄位");
  } finally {
    stub.restore();
  }
});

test("maxBytes 取端點回報值並受本檔上限夾住（不超賣）", async () => {
  const { issueDirectUploadCredential, MAX_UPLOAD_BYTES } = await import("./two-phase-upload");
  const stub = stubPresign({
    status: 200,
    body: { url: `${VPS_BASE}/api/blob/x`, ticket: "t", maxBytes: MAX_UPLOAD_BYTES * 4 },
  });
  try {
    const credential = await issueDirectUploadCredential({
      userId: 7,
      filename: "big.mp4",
      contentType: "video/mp4",
      request: jsonRequest(),
    });
    assert.equal(credential.maxBytes, MAX_UPLOAD_BYTES);
  } finally {
    stub.restore();
  }
});

test("舊部署沒有簽名端點（404/405）⇒ 具名錯誤，不假裝成功", async () => {
  const { issueDirectUploadCredential, UploadSignError } = await import("./two-phase-upload");
  for (const status of [404, 405]) {
    const stub = stubPresign({ status, body: { error: "not found" } });
    try {
      await assert.rejects(
        () =>
          issueDirectUploadCredential({
            userId: 7,
            filename: "clip.mp4",
            contentType: "video/mp4",
            request: jsonRequest(),
          }),
        (error: unknown) => {
          assert.ok(error instanceof UploadSignError);
          assert.equal(error.code, "vps_blob_direct_upload_unsupported");
          assert.equal(error.status, 501);
          return true;
        },
      );
    } finally {
      stub.restore();
    }
  }
});

test("回傳形狀不完整（缺 ticket）⇒ 具名錯誤，不下發半套憑證", async () => {
  const { issueDirectUploadCredential, UploadSignError } = await import("./two-phase-upload");
  const stub = stubPresign({ status: 200, body: { url: `${VPS_BASE}/api/blob/x` } });
  try {
    await assert.rejects(
      () =>
        issueDirectUploadCredential({
          userId: 7,
          filename: "clip.mp4",
          contentType: "video/mp4",
          request: jsonRequest(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof UploadSignError);
        assert.equal(error.code, "presign_malformed");
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test("回寫授權：宣告別人的 pathname 一律 403（不因後端分岔而放寬）", async () => {
  const { issueDirectUploadCredential, UploadSignError } = await import("./two-phase-upload");
  const stub = stubPresign({ status: 200, body: { url: `${VPS_BASE}/api/blob/x`, ticket: "t" } });
  try {
    await assert.rejects(
      () =>
        issueDirectUploadCredential({
          userId: 7,
          pathname: "uploads/999/someone-else.mp4",
          contentType: "video/mp4",
          request: jsonRequest(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof UploadSignError);
        assert.equal(error.code, "object_key_not_owned");
        assert.equal(error.status, 403);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0, "越界 pathname 不該打到簽名端點");
  } finally {
    stub.restore();
  }
});

test("3D 型別在白名單內：model/gltf-binary 與 model/gltf+json 都能簽發，物件鍵尾碼正確", async () => {
  const { issueDirectUploadCredential } = await import("./two-phase-upload");
  const stub = stubPresign({ status: 200, body: { url: `${VPS_BASE}/api/blob/x`, ticket: "t" } });
  const cases = [
    ["scene.glb", "model/gltf-binary", "glb"],
    ["scene.gltf", "model/gltf+json", "gltf"],
  ] as const;
  try {
    for (const [filename, contentType, ext] of cases) {
      const credential = await issueDirectUploadCredential({
        userId: 7,
        filename,
        contentType,
        size: 8 * 1024 * 1024,
        request: jsonRequest(),
      });
      assert.equal(credential.contentType, contentType);
      assert.ok(
        credential.objectKey.endsWith(`.${ext}`),
        `${contentType} 的物件鍵尾碼應為 .${ext}，實得 ${credential.objectKey}`,
      );
    }
  } finally {
    stub.restore();
  }
});

test("octet-stream／空 type ＋已知 3D 副檔名 ⇒ 由副檔名推導正確型別（不再 415）", async () => {
  const { issueDirectUploadCredential } = await import("./two-phase-upload");
  const stub = stubPresign({ status: 200, body: { url: `${VPS_BASE}/api/blob/x`, ticket: "t" } });
  try {
    const binary = await issueDirectUploadCredential({
      userId: 7,
      filename: "model.glb",
      contentType: "application/octet-stream",
      request: jsonRequest(),
    });
    assert.equal(binary.contentType, "model/gltf-binary");
    assert.ok(binary.objectKey.endsWith(".glb"));

    const json = await issueDirectUploadCredential({
      userId: 7,
      filename: "scene.gltf",
      contentType: "",
      request: jsonRequest(),
    });
    assert.equal(json.contentType, "model/gltf+json");
    assert.ok(json.objectKey.endsWith(".gltf"));
  } finally {
    stub.restore();
  }
});

test("octet-stream 僅對 3D 推導：.txt 的 octet-stream／白名單外型別仍 415；空型別＋未知副檔名仍 400", async () => {
  const { issueDirectUploadCredential, UploadSignError } = await import("./two-phase-upload");
  const stub = stubPresign({ status: 200, body: { url: `${VPS_BASE}/api/blob/x`, ticket: "t" } });
  const cases = [
    ["notes.txt", "application/octet-stream", 415],
    ["notes.txt", "text/plain", 415],
    ["archive.bin", "", 400],
  ] as const;
  try {
    for (const [filename, contentType, status] of cases) {
      await assert.rejects(
        () => issueDirectUploadCredential({ userId: 7, filename, contentType, request: jsonRequest() }),
        (error: unknown) => {
          assert.ok(error instanceof UploadSignError);
          assert.equal(error.status, status, `${filename} / "${contentType}" 應 ${status}`);
          return true;
        },
      );
    }
  } finally {
    stub.restore();
  }
});

test("內容型別白名單：不在名單內一律 415", async () => {
  const { issueDirectUploadCredential, UploadSignError } = await import("./two-phase-upload");
  const stub = stubPresign({ status: 200, body: { url: `${VPS_BASE}/api/blob/x`, ticket: "t" } });
  try {
    await assert.rejects(
      () =>
        issueDirectUploadCredential({
          userId: 7,
          filename: "evil.exe",
          contentType: "application/octet-stream",
          request: jsonRequest(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof UploadSignError);
        assert.equal(error.code, "unsupported_content_type");
        assert.equal(error.status, 415);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});
