import test from "node:test";
import assert from "node:assert/strict";
import { jevAsk, type JevChoiceQuestion, type JevNoulQuestion } from "./jev-client";

/** 全部 mock fetch：單測不打真 API（實彈驗證走 env JEV_ENABLED=true 的手動腳本）。 */

const STATE = '{"tool":"image_generate","ok":true,"task_id":"task_9f3a","url":null}';

const QUESTIONS = {
  artifact_pending: {
    type: "noul",
    instructions: "Does the response indicate the artifact is still being generated?",
  } satisfies JevNoulQuestion,
  expert_route: {
    type: "choice",
    instructions: "Which expert should handle this task?",
    criteria: { music: "作曲/編曲", editor: "剪輯", other: "none of the above" },
  } satisfies JevChoiceQuestion,
} as const;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function mockFetchOnce(handler: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("jevAsk: disabled by default returns { ok:false, reason:disabled }", async () => {
  const restore = mockFetchOnce(async () => {
    throw new Error("should not fetch");
  });
  try {
    await withEnv({ JEV_ENABLED: undefined, TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "disabled");
    });
  } finally {
    restore();
  }
});

test("jevAsk: enabled without key returns no_key", async () => {
  const restore = mockFetchOnce(async () => {
    throw new Error("should not fetch");
  });
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: undefined }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "no_key");
    });
  } finally {
    restore();
  }
});

test("jevAsk: happy path parses typed answers and passes questions through", async () => {
  const restore = mockFetchOnce(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { state: string; questions: unknown };
    assert.equal(body.state, STATE);
    assert.deepEqual(Object.keys(body.questions), ["artifact_pending", "expert_route"]);
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          artifact_pending: { type: "noul", noul: 0.96 },
          expert_route: {
            type: "choice",
            choice: "music",
            probabilities: { music: 0.99, editor: 0.01, other: 0 },
            confidence: 0.99,
          },
        },
        usage: { input_tokens: 500, output_tokens: 76 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.model, "jev-1.13.0");
      assert.equal(r.answers.artifact_pending.type, "noul");
      assert.equal(r.answers.artifact_pending.noul, 0.96);
      assert.equal(r.answers.expert_route.type, "choice");
      assert.equal(r.answers.expert_route.choice, "music");
      assert.equal(r.answers.expert_route.confidence, 0.99);
      assert.equal(r.usage.input_tokens, 500);
      assert.equal(typeof r.ms, "number");
    });
  } finally {
    restore();
  }
});

test("jevAsk: http error returns { ok:false, reason:http, status }", async () => {
  const restore = mockFetchOnce(
    async () => new Response("nope", { status: 401 }),
  );
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "http");
      assert.equal(r.status, 401);
    });
  } finally {
    restore();
  }
});

test("jevAsk: network failure returns reason:network", async () => {
  const restore = mockFetchOnce(async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "network");
    });
  } finally {
    restore();
  }
});

test("jevAsk: choice answer outside criteria is malformed (answer locked to options)", async () => {
  const restore = mockFetchOnce(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            artifact_pending: { type: "noul", noul: 0.5 },
            expert_route: {
              type: "choice",
              choice: "nonexistent-expert",
              probabilities: {},
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "malformed");
    });
  } finally {
    restore();
  }
});

test("jevAsk: answer type mismatch with question is malformed", async () => {
  const restore = mockFetchOnce(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            artifact_pending: { type: "choice", choice: "music", confidence: 1 },
            expert_route: {
              type: "choice",
              choice: "music",
              probabilities: {},
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "malformed");
    });
  } finally {
    restore();
  }
});

test("jevAsk: abort on timeout returns reason:network (2s budget enforced)", async () => {
  const restore = mockFetchOnce(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  );
  try {
    await withEnv({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "k" }, async () => {
      const r = await jevAsk(STATE, QUESTIONS);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "network");
    });
  } finally {
    restore();
  }
});
