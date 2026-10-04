/**
 * Jev (TypeSafe System One) 客户端 — 语义判定闸的单一出口。
 *
 * 范式：对一个 state 平行求值一批带型别问题（Choice/Score/Noul），回型别化
 * answers＋机率分布＋confidence，无文字生成、无事后解析。所有调用方必须
 * 批次提问（平行性是范式核心，禁一题一呼）。
 *
 * 纪律（PRD docs/plans/2026-09-19-jev-system-one-prd.md）：
 * - Jev 是辅助判定层：任何失败（网路/逾时/HTTP 非 2xx/回应畸形）静默回
 *   { ok:false }，调用方各自降级——绝不因判定闸挂掉而阻断主链路（fail-open）。
 * - JEV_ENABLED 默认 off，按刀灰度。
 * - key 走 TYPESAFE_API_KEY env（Vercel/VPS 环境变数注入，非 repo 明文）。
 */

/** Noul：是非题，回 0–1 机率（0.5 = 不确定，非「中等」）。 */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** Choice：离散选项选一，回 choice＋跨选项机率分布＋confidence。 */
export interface JevChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** Score：有序等级量表，回 score（可落在两级之间）＋legend＋confidence。 */
export interface JevScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

export interface JevNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface JevChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface JevScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface JevResult<Q extends JevQuestions> {
  readonly model: string;
  readonly answers: { readonly [K in keyof Q & string]: JevAnswer };
  readonly usage: JevUsage;
  readonly ms: number;
}

export interface JevFailure {
  readonly ok: false;
  readonly reason: "disabled" | "no_key" | "network" | "http" | "malformed";
  /** HTTP 非 2xx 时的状态码；其余 reason 为 undefined。 */
  readonly status?: number;
}

export type JevOutcome<Q extends JevQuestions> =
  | ({ readonly ok: true } & JevResult<Q>)
  | JevFailure;

/** 实测基线 770ms（2026-09-19，两题平行含 RTT）；2000ms 留 2.6x 余量。 */
const JEV_TIMEOUT_MS = 2_000;
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

interface JevHttpSuccess<Q extends JevQuestions> {
  readonly model: string;
  readonly answers: { readonly [K in keyof Q & string]: unknown };
  readonly usage: JevUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 逐题验型：答案锁死在题目型别内才算可用（畸形答案整包降级，不猜）。 */
function validateAnswers<Q extends JevQuestions>(
  questions: Q,
  raw: unknown,
): { readonly [K in keyof Q & string]: JevAnswer } | null {
  if (!isRecord(raw)) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const id of Object.keys(questions)) {
    const answer = raw[id];
    if (!isRecord(answer)) return null;
    const type = questions[id].type;
    if (answer.type !== type) return null;
    if (type === "noul") {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) return null;
      answers[id] = { type: "noul", noul: answer.noul };
    } else if (type === "choice") {
      if (typeof answer.choice !== "string") return null;
      if (!(answer.choice in questions[id].criteria)) return null;
      if (typeof answer.confidence !== "number") return null;
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: (answer.probabilities ?? {}) as Record<string, number>,
        confidence: answer.confidence,
      };
    } else {
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) return null;
      if (typeof answer.confidence !== "number") return null;
      answers[id] = {
        type: "score",
        score: answer.score,
        legend: (answer.legend ?? {}) as Record<string, string>,
        confidence: answer.confidence,
      };
    }
  }
  return answers as { readonly [K in keyof Q & string]: JevAnswer };
}

/**
 * 对 state 批次求值一批问题（单一出口）。失败静默回 { ok:false, reason }，
 * 调用方按各自闸的降级策略处置；journal 记量由调用方负责（带 reason/ms）。
 */
export async function jevAsk<Q extends JevQuestions>(
  state: string,
  questions: Q,
): Promise<JevOutcome<Q>> {
  if (process.env.JEV_ENABLED !== "true") return { ok: false, reason: "disabled" };
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return { ok: false, reason: "no_key" };

  const startedAt = Date.now();
  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
    try {
      response = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!response.ok) return { ok: false, reason: "http", status: response.status };

  let payload: JevHttpSuccess<Q>;
  try {
    payload = (await response.json()) as JevHttpSuccess<Q>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.model !== "string" || !isRecord(payload.usage)) {
    return { ok: false, reason: "malformed" };
  }
  const answers = validateAnswers(questions, payload.answers);
  if (!answers) return { ok: false, reason: "malformed" };

  return {
    ok: true,
    model: payload.model,
    answers,
    usage: payload.usage,
    ms: Date.now() - startedAt,
  };
}
