// 两段式上传第一段（P1-10 / 对称差 D36）：VPS 后端的直传凭证签发。
//
// 为什么要有这支：`issueDirectUploadCredential` 原本在 VPS 后端**一律 501**
// （`vps_blob_direct_upload_unsupported`），因为 image-data-api 只认母钥、没有签名端点。
// 2026-09-29 在 image-data-api 补了 `POST /api/blob/presign`（HMAC 短效签名）之后，
// 本档把「母钥只留在伺服器端、下发给浏览器的是短效签名」这件事钉成行为断言。
//
// vps-blob-adapter 的 BASE_URL/API_KEY 是**模组载入期快照**，故先设 env 再动态 import
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

/** presign 端点替身：真记录请求（URL／标头／body），断言「母钥只在伺服器端」。 */
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

test("VPS 后端判定为 vps-blob（不会再走 Vercel 分支）", async () => {
  const { resolveDirectUploadBackend } = await import("./two-phase-upload");
  assert.equal(resolveDirectUploadBackend(), "vps-blob");
});

test("第一段：向 image-data-api 取短效签名，母钥只留在伺服器端、下发的是 ticket", async () => {
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

    // 凭证形状：目标主机＝物件存储，不是我方网域。
    assert.equal(credential.backend, "vps-blob");
    assert.equal(credential.method, "PUT");
    assert.equal(new URL(credential.uploadUrl).host, "vps-data.example");
    assert.notEqual(new URL(credential.uploadUrl).host, "eimu.dev");
    // 浏览器拿到的是短效签名，不是母钥。
    assert.equal(credential.clientToken, "signed-ticket-abc");
    assert.equal(credential.headers?.["x-upload-ticket"], "signed-ticket-abc");
    assert.ok(
      !JSON.stringify(credential).includes(MASTER_KEY),
      "母钥不得出现在下发给浏览器的凭证里",
    );
    // objectKey 落在呼叫者自己的前缀下；公网 URL 由 VPS base 推导。
    assert.match(credential.objectKey, /^uploads\/7\//);
    assert.equal(credential.downloadUrl, `${VPS_BASE}/files/${credential.objectKey}`);
    // maxBytes 取端点回报的真实上限（VPS 管线），不是本档常数 512MB。
    assert.equal(credential.maxBytes, 104_857_600);
    assert.equal(credential.expiresInMs, 3_600_000);

    // 伺服器端确实带母钥去打签名端点，且请求体只有 metadata、零档案位元组。
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.url, `${VPS_BASE}/api/blob/presign`);
    assert.equal(stub.calls[0]!.key, MASTER_KEY);
    assert.equal(stub.calls[0]!.body.pathname, credential.objectKey);
    assert.equal(stub.calls[0]!.body.contentType, "video/mp4");
    assert.equal(stub.calls[0]!.body.size, undefined, "第一段请求体不得带档案大小以外的位元组栏位");
  } finally {
    stub.restore();
  }
});

test("maxBytes 取端点回报值并受本档上限夹住（不超卖）", async () => {
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

test("旧部署没有签名端点（404/405）⇒ 具名错误，不假装成功", async () => {
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

test("回传形状不完整（缺 ticket）⇒ 具名错误，不下发半套凭证", async () => {
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

test("回写授权：宣告别人的 pathname 一律 403（不因后端分岔而放宽）", async () => {
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
    assert.equal(stub.calls.length, 0, "越界 pathname 不该打到签名端点");
  } finally {
    stub.restore();
  }
});

test("3D 型别在白名单内：model/gltf-binary 与 model/gltf+json 都能签发，物件键尾码正确", async () => {
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
        `${contentType} 的物件键尾码应为 .${ext}，实得 ${credential.objectKey}`,
      );
    }
  } finally {
    stub.restore();
  }
});

test("octet-stream／空 type ＋已知 3D 副档名 ⇒ 由副档名推导正确型别（不再 415）", async () => {
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

test("octet-stream 仅对 3D 推导：.txt 的 octet-stream／白名单外型别仍 415；空型别＋未知副档名仍 400", async () => {
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
          assert.equal(error.status, status, `${filename} / "${contentType}" 应 ${status}`);
          return true;
        },
      );
    }
  } finally {
    stub.restore();
  }
});

test("内容型别白名单：不在名单内一律 415", async () => {
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
