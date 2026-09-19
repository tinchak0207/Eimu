/**
 * Jev (TypeSafe System One) 客戶端 — 語義判定閘的單一出口。
 *
 * 範式：對一個 state 平行求值一批帶型別問題（Choice/Score/Noul），回型別化
 * answers＋機率分佈＋confidence，無文字生成、無事後解析。所有調用方必須
 * 批次提問（平行性是範式核心，禁一題一呼）。
 *
 * 紀律（PRD docs/plans/2026-09-19-jev-system-one-prd.md）：
 * - Jev 是輔助判定層：任何失敗（網路/逾時/HTTP 非 2xx/回應畸形）靜默回
 *   { ok:false }，調用方各自降級——絕不因判定閘掛掉而阻斷主鏈路（fail-open）。
 * - JEV_ENABLED 默認 off，按刀灰度。
 * - key 走 TYPESAFE_API_KEY env（Vercel/VPS 環境變數注入，非 repo 明文）。
 */

/** Noul：是非題，回 0–1 機率（0.5 = 不確定，非「中等」）。 */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** Choice：離散選項選一，回 choice＋跨選項機率分佈＋confidence。 */
export interface JevChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** Score：有序等級量表，回 score（可落在兩級之間）＋legend＋confidence。 */
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
  /** HTTP 非 2xx 時的狀態碼；其餘 reason 為 undefined。 */
  readonly status?: number;
}

export type JevOutcome<Q extends JevQuestions> =
  | ({ readonly ok: true } & JevResult<Q>)
  | JevFailure;

/** 實測基線 770ms（2026-09-19，兩題平行含 RTT）；2000ms 留 2.6x 餘量。 */
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

/** 逐題驗型：答案鎖死在題目型別內才算可用（畸形答案整包降級，不猜）。 */
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
 * 對 state 批次求值一批問題（單一出口）。失敗靜默回 { ok:false, reason }，
 * 調用方按各自閘的降級策略處置；journal 記量由調用方負責（帶 reason/ms）。
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
