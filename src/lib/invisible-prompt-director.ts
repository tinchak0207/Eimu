/**
 * Invisible Prompt Director — 規則層影片提示詞導演。
 *
 * 用戶的短 prompt 在進上游之前被這層自動「導演化」：偵測六槽公式
 * (Camera + Subject + Action + Setting + Style + Lighting) 的缺漏並補齊、
 * 替換 anti-slop 空形容詞、修復同義詞陷阱、把負面句改成正向聲明、
 * 執行引擎規則（age-blind、≤3 tracked characters）、附加品質鎖。
 * 全程在後端發生，用戶無感。
 *
 * 知識來源：Higgsfield Hell Grind 開源 95 分鐘長片 pipeline 與 Seedance 2.0
 * 工業級 prompt 規則庫（OSideMedia/higgsfield-ai-prompt-skill，MIT）。
 * 每個規則對應一項「某種鏡頭為什麼會掛」的生產事實。
 */

export interface DirectorOptions {
  /** 上游模型 id。不同模型家族有不同語法偏好。 */
  modelId?: string;
  /** 目標影片時長（秒）。 */
  durationSeconds?: number;
  /** 是否生成音軌：true 時不強制 SFX-only 尾巴。 */
  generateAudio?: boolean;
}

/** 六槽公式偵測用正則。槽位存在時保留用戶原話，缺漏時才補中性指令。 */
const SLOT_PATTERNS = {
  camera: /(camera|shot|angle|dolly|pan|tilt|zoom|track|push|pull|orbit|crane|handheld|aerial|drone|fpv|low angle|high angle|close-?up|wide shot|medium shot|establishing|over-the-shoulder|point-of-view|pov|static|locked)/i,
  action: /(\b(runs?|walks?|drives?|jumps?|sprints?|turns?|reaches|grabs|punches|kicks|falls|dives|flies|swims|climbs|pushes|pulls|lifts|drops|slides|rolls|rises|sinks|explodes|breaks|opens|closes|steps|enters|exits|darts|slips|stumbles|crouches|twists|swings|strikes|fires|throws|catches|dodges|vaults|leaps|charges|retreats|advances|circles|paces)\b|\b(transforms|morphs|shifts|changes|grows|shrinks|dissolves|melts|hardens|cracks)\b)/i,
  setting: /(in |on |at |through |across |inside |outside |by the |near |under |above |over |between |behind |beyond )(the |a |an )?[a-z]+|(street|alley|room|city|desert|ocean|forest|space|mountain|beach|rooftop|corridor|hallway|warehouse|garage|kitchen|office|stadium|train|airport|market|church|castle|cave|factory|subway|bridge|river|lake|valley|field|meadow|jungle|tundra|snow|rain|storm|sunset|sunrise|night|dusk|dawn|morning|noon|indoors|outdoors)/i,
  style: /(style|look|grade|palette|noir|neon|vhs|anamorphic|cinematic|desaturated|monochrome|sepia|pastel|vivid|muted|grimy|glossy|matte|minimalist|baroque|cyberpunk|steampunk|fantasy|realistic|photoreal|cartoon|anime|stop-motion|film grain|letterbox)/i,
  lighting: /(light|lit|lighting|backlit|backlight|rim light|shadow|shadows|golden hour|blue hour|neon light|harsh light|soft light|diffused|direct|low key|high key|practical|flare|underexposed|overexposed|silhouette|candlelight|moonlight|sunlight|twilight|firelight|lighting rig)/i,
};

/** Anti-slop：空形容詞 → 具體可採樣語彙。regex 只做標記，替換由 mapping 決定。 */
const SLOP_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/beautiful/g, "striking detail"],
  [/stunning/g, "arresting composition"],
  [/amazing/g, "remarkable"],
  [/\bepic\b/g, "large-scale"],
  [/\bdynamic\b/g, "fast-tracking"],
  [/\benergetic\b/g, "vigorous"],
  [/\bhigh quality\b/g, "sharp"],
  [/\bhigh-res\b/g, "sharp"],
  [/\bcool transition\b/g, "match-cut"],
];

/** 同義詞陷阱（homograph）：模型可能讀成第二種物理含義的字 → 改成只有一種讀法。 */
const HOMOGRAPH_FIXES: ReadonlyArray<[RegExp, string]> = [
  [/wind tearing at/gi, "wind whipping violently at"],
  [/\btearing (?:at|through)\b/gi, "ripping through"],
  [/\bshoot(?:s|ing|er)?\b/gi, "fire"],
  [/\bduck(?:s)?\b/gi, "crouch"],
  [/\bbolt\b/gi, "sprint"],
  [/\bdraw(?:s|ing)?\b/gi, "pull"],
  [/\bwave(?:s)?\b/gi, "signal"],
  [/\bcharge(?:s)?\b/gi, "rush"],
  [/\brock(?:s|ing)?\b/gi, "sway"],
  [/\bdrop(?:s|ped)?\b/gi, "falls"],
  [/\bfire(?:s)?\b/gi, "opens fire"],
  [/\bstrike(?:s)?\b/gi, "hits"],
  [/\bbreak(?:s)?\b/gi, "shatters"],
  [/\bpound(?:s)?\b/gi, "hammer"],
  [/\bsnap(?:s)?\b/gi, "cracks"],
];

/** 情感標籤 → 肌肉/身體物理分解（模型 render 肌肉而不是情緒字）。 */
const EMOTION_TO_PHYSICS: Record<string, string> = {
  scared: "jaw clenches, nostrils flare, shallow breath, shoulders pull inward",
  angry: "jaw set and flexing, brows drawn down, chest expands with each sharp breath",
  sad: "the body settles low, slow blink, a light exhale through the nose, mouth relaxed",
  surprised: "eyes widen, sharp inhale through the mouth, body freezes, hand lifts toward the chest",
  shocked: "eyes widen, breath stops, body goes still, lips part slightly",
  happy: "eyes light with catchlights, smile builds gradually, shoulders relax",
  excited: "quick breath, wide eyes, weight shifts from foot to foot, hands gesture",
  tired: "weight settled low, slow blink interval, a long exhale, posture soft",
  nervous: "a single hand flexes open-closed at the side, shallow chest breath, eyes dart",
  calm: "steady even breath, relaxed jaw, slow deliberate movement, soft focus in the eyes",
  tense: "shoulders locked, jaw set, shallow breath, gaze fixed and watchful",
  anxious: "fingers press together, weight shifts, quick glances, shallow breath",
  determined: "set jaw, locked gaze, even forward stride, hands steady",
  confused: "slow blink, head tilts a fraction, brows draw together, lips press",
  thoughtful: "gaze drifts, brow furrows, head tilts slightly, hand absently touches the chin",
};

/** 品質尾巴：所有影片模型都想要的最低保底。以正向聲明寫。 */
const QUALITY_TAIL =
  "Cinematic. Photoreal. Stable composition, no flicker, no frame jitter. Detailed texture preserved, subject locked through the whole shot.";

/** 品質鎖：環境不發明 / 角色比例 / 物件不複製（Hell Grind POSITIVE LOCKS 精神）。 */
const POSITIVE_LOCKS =
  "The set contains only what is described. Character identity, wardrobe, and environment stay identical across every cut. No extra people, no duplicated furniture.";

function replaceAll(prompt: string, table: ReadonlyArray<[RegExp, string]>): string {
  let out = prompt;
  for (const [pattern, replacement] of table) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Age-blind（引擎規則 1）：角色只能用角色/服裝/動作描述，禁止年齡詞。 */
function enforceAgeBlind(prompt: string): string {
  return prompt
    .replace(/\b(?:boy|girl|child|kid|young|teen|little) (?:man|woman|person)\b/gi, "the figure")
    .replace(/\b(?:a|the) (?:boy|girl|child|kid|teen)\b/gi, "the young figure")
    .replace(/\b(?:young|little) (?:man|woman)\b/gi, "the figure")
    .replace(/\ba (?:teen|child)\b/gi, "a young figure");
}

/** 分解泛情緒字：只處理獨立的情緒名詞/形容詞，避免誤傷敘述。 */
function decomposeGenericEmotion(prompt: string): string {
  let out = prompt;
  for (const [emotion, physics] of Object.entries(EMOTION_TO_PHYSICS)) {
    const pattern = new RegExp(`\\b(?:looks?|feels?|seems?|is|gets?) (${emotion})\\b`, "gi");
    out = out.replace(pattern, (m) => {
      const subject = m.split(" ")[0];
      return `${subject} with ${physics}`;
    });
  }
  return out;
}

/** 正向化：把「負面句」改成「正向聲明」。regex 只能處理常見形式。
 *  注意「no flicker / no jitter」這類短鎖尾是正向聲明內的合法寫法
 *  （Seedance field-proven），不做替換。只處理「動作被否定」的句子。 */
function enforcePositivePhrasing(prompt: string): string {
  return prompt
    .replace(/\b(?:does|do|did) not (?:fall|drop|touch|hit)\b/gi, "stays clear of")
    .replace(/\b(?:don['’]t|doesn['’]t|didn['’]t) (?:look|turn|move)\b/gi, "keeps the gaze forward");
}

/** 偵測槽位缺漏，缺的補中性指令——不替用戶決定具體鏡位。 */
function fillMissingSlots(
  prompt: string,
  cameraPresent: boolean,
  stylePresent: boolean,
  lightingPresent: boolean,
  options: DirectorOptions,
): string[] {
  const additions: string[] = [];
  const isSeedance = options.modelId?.toLowerCase().includes("seedance");

  if (!cameraPresent) {
    additions.push(
      isSeedance
        ? "Camera: a single deliberate move, named and held, ending on a clear target in the frame."
        : "Camera: motivated, steady, one deliberate move per shot.",
    );
  }
  if (!stylePresent) {
    additions.push("Style: cinematic color grade with a named palette — teal shadows with warm practical highlights.");
  }
  if (!lightingPresent) {
    additions.push("Lighting: one motivated light source, consistent direction of shadow, soft falloff.");
  }
  return additions;
}

/**
 * 優化一段影片 prompt。純函數、無副作用、同步執行——零成本零延遲。
 * 輸入已 trim 過。
 */
export function directVideoPrompt(rawPrompt: string, options: DirectorOptions = {}): string {
  const user = rawPrompt.trim();
  if (!user) return user;

  const cameraPresent = SLOT_PATTERNS.camera.test(user);
  const stylePresent = SLOT_PATTERNS.style.test(user);
  const lightingPresent = SLOT_PATTERNS.lighting.test(user);

  let enhanced = user;
  enhanced = replaceAll(enhanced, SLOP_WORDS);
  enhanced = replaceAll(enhanced, HOMOGRAPH_FIXES);
  enhanced = enforceAgeBlind(enhanced);
  enhanced = decomposeGenericEmotion(enhanced);
  enhanced = enforcePositivePhrasing(enhanced);

  const parts: string[] = [enhanced];
  parts.push(...fillMissingSlots(enhanced, cameraPresent, stylePresent, lightingPresent, options));

  // 開場 1 秒鎖位（Hell Grind）：只有影片才需要，且只在長片語義下注入。
  const hasPacing = options.durationSeconds && options.durationSeconds >= 4;
  if (hasPacing) {
    parts.push(
      `The first second establishes the layout — who stands where, where the light comes from — then the arrangement holds for the whole shot.`,
    );
  }

  // 品質尾巴 + 正向鎖：去重複、依音軌調整語義。
  if (!/(no flicker|stable composition|photoreal|cinematic\.)/i.test(enhanced)) {
    const audioClause = options.generateAudio ? "" : "SFX only, no music. ";
    parts.push(`${audioClause}${QUALITY_TAIL}`);
  }
  if (!/no extra people|no duplicated|identical across every cut/i.test(enhanced)) {
    parts.push(POSITIVE_LOCKS);
  }

  return parts.join(" ");
}