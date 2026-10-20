/**
 * Invisible Prompt Director — 规则层影片提示词导演。
 *
 * 用户的短 prompt 在进上游之前被这层自动「导演化」：替换 anti-slop 空形容词、
 * 修复同义词陷阱、把负面句改成正向声明、执行引擎规则（age-blind、≤3 tracked
 * characters）。
 *
 * 六槽公式 (Camera + Subject + Action + Setting + Style + Lighting) 是**图片**语法；
 * 影片不走静态六槽，改用「状态变化合同」：起态 → 动作 beat → 终态 → 环境变化。
 * 画面必须从一个状态走到另一个可见不同的状态，运动由主体动作驱动，而不是
 * 「构图稳定、主体锁定、环境不变」。全程在后端发生，用户无感。
 *
 * 知识来源：Higgsfield Hell Grind 开源 95 分钟长片 pipeline 与 Seedance 2.0
 * 工业级 prompt 规则库（OSideMedia/higgsfield-ai-prompt-skill，MIT）。
 * 每个规则对应一项「某种镜头为什么会挂」的生产事实。
 */

import type { Scene3dCardMetadata } from "./canvas/types";
import { resolveSceneCameraRule, type CameraTrajectory } from "./camera-trajectory-to-prompt";

export interface DirectorOptions {
  /** 上游模型 id。不同模型家族有不同语法偏好。 */
  modelId?: string;
  /** 目标影片时长（秒）。 */
  durationSeconds?: number;
  /** 是否生成音轨：true 时不强制 SFX-only 尾巴。 */
  generateAudio?: boolean;
  /** 会话存在 3D 场景卡（scene_3d 节点）时启用 sceneCard 感知规则；缺省 = 零行为变化。 */
  sceneCard?: Scene3dCardMetadata;
  /** 相机轨迹种子（L1 move ids 或 bpy keyframes），与 sceneCard 同时在场才生效。 */
  cameraTrajectory?: CameraTrajectory;
}

/** 六槽公式侦测用正则。槽位存在时保留用户原话，缺漏时才补中性指令。 */
const SLOT_PATTERNS = {
  camera: /(camera|shot|angle|dolly|pan|tilt|zoom|track|push|pull|orbit|crane|handheld|aerial|drone|fpv|low angle|high angle|close-?up|wide shot|medium shot|establishing|over-the-shoulder|point-of-view|pov|static|locked|镜头|运镜|跟拍|推镜|拉镜|摇镜|移镜|俯拍|仰拍|航拍|手持|固定机位|环绕|特写|全景|中景|近景)/i,
  action: /(\b(runs?|walks?|drives?|jumps?|sprints?|turns?|reaches|grabs|punches|kicks|falls|dives|flies|swims|climbs|pushes|pulls|lifts|drops|slides|rolls|rises|sinks|explodes|breaks|opens|closes|steps|enters|exits|darts|slips|stumbles|crouches|twists|swings|strikes|fires|throws|catches|dodges|vaults|leaps|charges|retreats|advances|circles|paces|moves?|drifts?|beads?|ripples?|drips?|pools?|settles?|rebounds?|deforms?|sways?|stirs?|seeps?|spreads?|billows?|curls?)\b|\b(transforms|morphs|shifts|changes|grows|shrinks|dissolves|melts|hardens|cracks)\b|(走|跑|奔|冲|跳|跃|挥|斩|劈|刺|踢|拳|转身|回头|抬手|低头|蹲|站起|坐下|倒下|坠落|飞|游|爬|抓|握|推|拉|举|扔|抛|接|挡|躲|闪|翻滚|滑|冲刺|疾跑|前进|后退|靠近|离开|打开|关上|撕|裂|碎|爆|燃|融|化|流动|飘|散|涌|升|沉|抖动|摇晃))/i,
  setting: /(in |on |at |through |across |inside |outside |by the |near |under |above |over |between |behind |beyond )(the |a |an )?[a-z]+|(street|alley|room|city|desert|ocean|forest|space|mountain|beach|rooftop|corridor|hallway|warehouse|garage|kitchen|office|stadium|train|airport|market|church|castle|cave|factory|subway|bridge|river|lake|valley|field|meadow|jungle|tundra|snow|rain|storm|sunset|sunrise|night|dusk|dawn|morning|noon|indoors|outdoors)/i,
  style: /(style|look|grade|palette|noir|neon|vhs|anamorphic|cinematic|desaturated|monochrome|sepia|pastel|vivid|muted|grimy|glossy|matte|minimalist|baroque|cyberpunk|steampunk|fantasy|realistic|photoreal|cartoon|anime|stop-motion|film grain|letterbox)/i,
  lighting: /(light|lit|lighting|backlit|backlight|rim light|shadow|shadows|golden hour|blue hour|neon light|harsh light|soft light|diffused|direct|low key|high key|practical|flare|underexposed|overexposed|silhouette|candlelight|moonlight|sunlight|twilight|firelight|lighting rig)/i,
};

/** Anti-slop：空形容词 → 具体可采样语汇。regex 只做标记，替换由 mapping 决定。 */
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

/** 同义词陷阱（homograph）：模型可能读成第二种物理含义的字 → 改成只有一种读法。 */
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

/** 情感标签 → 肌肉/身体物理分解（模型 render 肌肉而不是情绪字）。 */
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

/** 运动合同：影片的核心是可见的物理状态变化，不是稳定构图。
 *  旧的品质尾（稳定构图／主体锁定／无闪烁）是把图片范式套到影片上的
 *  直接生成源，会让模型产出 PPT 式微动画面，已删除。 */
const MOTION_CONTRACT =
  "Continuous physical action drives the shot: the subject's position, pose, and silhouette change measurably from the first frame to the last. Foreground and background shift with real parallax as the action advances.";

/** 状态变化锁：主体必须从一个状态走到另一个可见不同的状态，
 *  途中至少有一次环境/调度变化；身份细节保持一致是为了不换人，不是为了锁死画面。 */
const TRANSFORMATION_LOCK =
  "The shot shows a clear state change: the subject begins in one state and ends in a visibly different state, with at least one change in the environment or staging along the way. Identity details stay consistent while the action advances.";

/** 纯运镜请求（「slow camera push in」这类只有相机、没有主体动作的提示词）会把
 *  运镜当成整条片子的内容，模型于是只推镜头、主体不动。补一条主体物理变化，
 *  让运镜成为动作的结果而不是替代动作。 */
const CAMERA_ONLY_FIX =
  "The camera move is not the content of the shot: while the camera advances, the subject itself must physically change — contents shift, surfaces deform, parts move, and the light or environment changes around it — so the last frame differs from the first in more than framing.";

function replaceAll(prompt: string, table: ReadonlyArray<[RegExp, string]>): string {
  let out = prompt;
  for (const [pattern, replacement] of table) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Age-blind（引擎规则 1）：角色只能用角色/服装/动作描述，禁止年龄词。 */
function enforceAgeBlind(prompt: string): string {
  return prompt
    .replace(/\b(?:boy|girl|child|kid|young|teen|little) (?:man|woman|person)\b/gi, "the figure")
    .replace(/\b(?:a|the) (?:boy|girl|child|kid|teen)\b/gi, "the young figure")
    .replace(/\b(?:young|little) (?:man|woman)\b/gi, "the figure")
    .replace(/\ba (?:teen|child)\b/gi, "a young figure");
}

/** 分解泛情绪字：只处理独立的情绪名词/形容词，避免误伤叙述。 */
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

/** 正向化：把「负面句」改成「正向声明」。regex 只能处理常见形式。
 *  注意音轨锁（"SFX only, no music."）这类短尾是正向声明内的合法写法，
 *  不做替换。只处理「动作被否定」的句子。 */
function enforcePositivePhrasing(prompt: string): string {
  return prompt
    .replace(/\b(?:does|do|did) not (?:fall|drop|touch|hit)\b/gi, "stays clear of")
    .replace(/\b(?:don['’]t|doesn['’]t|didn['’]t) (?:look|turn|move)\b/gi, "keeps the gaze forward");
}

/** 侦测槽位缺漏，缺的补中性指令——不替用户决定具体镜位。
 *  影片分支的 camera 槽不再补静态机位兜底（那是 PPT 的生成源之一），
 *  缺 camera 时补一条动作兜底：镜头里必须有可见的物理动作 beat。 */
function fillMissingSlots(
  prompt: string,
  cameraPresent: boolean,
  stylePresent: boolean,
  lightingPresent: boolean,
): string[] {
  const additions: string[] = [];

  if (!cameraPresent) {
    additions.push("The shot must contain a visible physical action beat, not only camera movement.");
  }
  if (!stylePresent) {
    additions.push("Style: cinematic color grade with a named palette — teal shadows with warm practical highlights.");
  }
  if (!lightingPresent) {
    additions.push("Lighting: one motivated light source, consistent direction of shadow, soft falloff.");
  }
  return additions;
}

// ───────────────────────────────────────────────
// 图片规则层（directImagePrompt）
// ───────────────────────────────────────────────

/**
 * 图片六槽侦测用正则。与影片版分开：图片没有 camera 槽（镜头运动是影片概念），
 * 改成主体细节 / 场景环境 / 构图视角 / 光线 / 风格色调 五个侦测槽 + 质量尾。
 * setting / style / lighting 沿用影片版侦测（语义媒体无关）。
 */
const IMAGE_SLOT_PATTERNS = {
  subject: /(texture|textures|textured|fur|hair|skin|fabric|surface|material|wearing|holding|carrying|detail(?:ed|s)?|pattern|eyes|paws|feathers|wings|scales)/i,
  setting: SLOT_PATTERNS.setting,
  composition: /(composition|composed|centered|centred|close-?up|wide|medium shot|overhead|from above|from below|eye level|profile|symmetr|rule of thirds|negative space|portrait|headshot|full body|macro|perspective|background|foreground|depth of field|bokeh|leading lines)/i,
  style: SLOT_PATTERNS.style,
  lighting: SLOT_PATTERNS.lighting,
};

/**
 * 图片 anti-slop：空形容词 → 具体可采样语汇。
 * 与影片版差异：不产生运动语汇（影片版的 fast-tracking / match-cut 是镜头语言）。
 */
const IMAGE_SLOP_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/beautiful/g, "striking detail"],
  [/stunning/g, "arresting composition"],
  [/amazing/g, "remarkable"],
  [/\bepic\b/g, "large-scale"],
  [/\bdynamic\b/g, "bold compositional flow"],
  [/\benergetic\b/g, "vigorous"],
  [/\bhigh quality\b/g, "sharp"],
  [/\bhigh-res\b/g, "sharp"],
];

/**
 * 情感标签 → 可见的静态身体特征（图片版）：模型 render 一个瞬间的形态，
 * 不写时间性语汇（builds / shifts / gradual 是影片语言）。
 */
const IMAGE_EMOTION_TO_PHYSICS: Record<string, string> = {
  scared: "widened eyes, clenched jaw, shoulders pulled inward",
  angry: "drawn brows, set jaw, expanded chest",
  sad: "settled posture, relaxed mouth, downcast gaze",
  surprised: "widened eyes, parted lips, a hand raised toward the chest",
  shocked: "widened eyes, parted lips, body held still",
  happy: "bright catchlights in the eyes, relaxed shoulders, a full smile",
  excited: "wide eyes, gesturing hands, weight forward on the feet",
  tired: "low settled posture, soft eyes, mouth relaxed open",
  nervous: "fingers pressed together, quick darting gaze, shallow chest breath visible",
  calm: "steady gaze, relaxed jaw, soft settled shoulders",
  tense: "locked shoulders, set jaw, gaze fixed and watchful",
  determined: "set jaw, locked gaze, hands steady",
  thoughtful: "drifting gaze, furrowed brow, head tilted, a hand at the chin",
};

/** 图片品质尾：静态画面适用的保底（绝不含镜头运动 / SFX / 剪辑 / 抖动 / 帧 语汇）。 */
const IMAGE_QUALITY_TAIL =
  "Sharp focus, detailed texture, no distortion, faithful proportions, clean edges.";

/** 图片品质锁：画面不发明 / 物件不复制（静态版，无 every cut 这类剪辑语）。 */
const IMAGE_POSITIVE_LOCKS =
  "The image contains only what is described — no extra people, no duplicated objects, background consistent with the setting.";

/** 分解泛情绪字（图片版）：只处理独立的情绪名词/形容词。 */
function decomposeGenericEmotionForImage(prompt: string): string {
  let out = prompt;
  for (const [emotion, physics] of Object.entries(IMAGE_EMOTION_TO_PHYSICS)) {
    const pattern = new RegExp(`\\b(?:looks?|feels?|seems?|is|gets?) (${emotion})\\b`, "gi");
    out = out.replace(pattern, (m) => {
      const subject = m.split(" ")[0];
      return `${subject} with ${physics}`;
    });
  }
  return out;
}

/** 侦测图片槽位缺漏，缺的补中性指令——不替用户决定具体构图。 */
function fillMissingImageSlots(
  subjectPresent: boolean,
  settingPresent: boolean,
  compositionPresent: boolean,
  stylePresent: boolean,
  lightingPresent: boolean,
): string[] {
  const additions: string[] = [];
  if (!subjectPresent) {
    additions.push("Subject: concrete physical detail — surface texture, form, and material.");
  }
  if (!settingPresent) {
    additions.push("Setting: a specific, believable environment with tangible background detail.");
  }
  if (!compositionPresent) {
    additions.push("Composition: balanced layout, one clear focal point, clean negative space.");
  }
  if (!stylePresent) {
    additions.push("Style: refined color grade with a named palette — muted shadows, warm highlights.");
  }
  if (!lightingPresent) {
    additions.push("Lighting: one motivated light source, consistent shadow direction, soft falloff.");
  }
  return additions;
}

/**
 * 优化一段图片 prompt。纯函数、无副作用、同步执行——零成本零延迟。
 * 输入已 trim 过。与 directVideoPrompt 同构：anti-slop → age-blind → 情感分解
 * → 正向化 → 补槽 → 质量尾 + 品质锁。注意：此函数的产物**绝不出现**影片语汇
 * （camera movement / SFX / cut / jitter / frame 等），也不做影片版同义词替换
 * （drawing / bolt / rock 在图片语境是常见静物名词，替换反而破坏语义）。
 * durationSeconds / generateAudio 属影片选项，此处忽略。
 */
export function directImagePrompt(rawPrompt: string, _options: DirectorOptions = {}): string {
  const user = rawPrompt.trim();
  if (!user) return user;

  const subjectPresent = IMAGE_SLOT_PATTERNS.subject.test(user);
  const settingPresent = IMAGE_SLOT_PATTERNS.setting.test(user);
  const compositionPresent = IMAGE_SLOT_PATTERNS.composition.test(user);
  const stylePresent = IMAGE_SLOT_PATTERNS.style.test(user);
  const lightingPresent = IMAGE_SLOT_PATTERNS.lighting.test(user);

  let enhanced = user;
  enhanced = replaceAll(enhanced, IMAGE_SLOP_WORDS);
  enhanced = enforceAgeBlind(enhanced);
  enhanced = decomposeGenericEmotionForImage(enhanced);
  enhanced = enforcePositivePhrasing(enhanced);

  const parts: string[] = [enhanced];
  parts.push(
    ...fillMissingImageSlots(subjectPresent, settingPresent, compositionPresent, stylePresent, lightingPresent),
  );

  if (!/(sharp focus|detailed texture|no distortion)/i.test(enhanced)) {
    parts.push(IMAGE_QUALITY_TAIL);
  }
  if (!/no extra people|no duplicated/i.test(enhanced)) {
    parts.push(IMAGE_POSITIVE_LOCKS);
  }

  return parts.join(" ");
}

export interface SixSlots {
  /** image: 主体细节 / video: 镜头语言 */
  subject: string;
  /** image: 场景环境 / video: 场景 */
  scene: string;
  /** image: 构图视角 / video: 动作（影片无构图槽，动作是时间轴概念） */
  composition: string;
  lighting: string;
  style: string;
  /** image: 质量锁 / video: 无质量槽，并入 style */
  quality: string;
}

const QUALITY_PATTERN = /(sharp focus|detailed texture|no distortion|faithful proportions|clean edges|no extra people|no duplicated|only what is described|sfx|no music|state change|action beat|visibly changed|measurably|environment or staging|visibly different state)/i;

/**
 * 从（优化后的）prompt 提取六槽结构化视图。免费层展示用——把长 prompt
 * 拆成六个语义槽位，让用户看到「专业结构」而不是一坨文字。
 * 纯函数：按句号/破折号切分短句，正则归类到槽位；归不进任何槽的短句
 * 并入主体（用户的原话几乎总是主体描述）。
 */
export function extractSixSlots(prompt: string, mediaType: "image" | "video"): SixSlots {
  const clauses = prompt
    .split(/[.。]|\s—\s/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const slots: SixSlots = { subject: "", scene: "", composition: "", lighting: "", style: "", quality: "" };
  const patterns =
    mediaType === "image"
      ? { subject: IMAGE_SLOT_PATTERNS.subject, scene: IMAGE_SLOT_PATTERNS.setting, composition: IMAGE_SLOT_PATTERNS.composition, lighting: IMAGE_SLOT_PATTERNS.lighting, style: IMAGE_SLOT_PATTERNS.style }
      : { subject: /\b(man|woman|cat|dog|person|people|figure|character|he|she|it|they)\b/i, scene: SLOT_PATTERNS.setting, composition: SLOT_PATTERNS.action, lighting: SLOT_PATTERNS.lighting, style: SLOT_PATTERNS.style };

  for (const clause of clauses) {
    if (QUALITY_PATTERN.test(clause)) {
      slots.quality = [slots.quality, clause].filter(Boolean).join(". ");
      continue;
    }
    let classified = false;
    for (const [slot, pattern] of Object.entries(patterns) as Array<[keyof typeof patterns, RegExp]>) {
      if (pattern.test(clause)) {
        // scene/composition/lighting/style 槽优先归类；subject 正则只是「细节词」提示，
        // 留到最后兜底，避免主体句抢走场景句。
        if (slot !== "subject") {
          slots[slot] = [slots[slot], clause].filter(Boolean).join(". ");
          classified = true;
          break;
        }
      }
    }
    if (!classified) slots.subject = [slots.subject, clause].filter(Boolean).join(". ");
  }

  const fallbacks =
    mediaType === "image"
      ? { scene: "（原始 prompt 未指定场景，建议补充）", composition: "（未指定构图，模型自由发挥）", lighting: "（未指定光线）", style: "（未指定风格）", quality: "（无质量锁）" }
      : { scene: "（未指定场景）", composition: "（未指定动作）", lighting: "（未指定光线）", style: "（未指定风格）", quality: "（无质量锁）" };
  for (const [slot, fallback] of Object.entries(fallbacks) as Array<[keyof SixSlots, string]>) {
    if (!slots[slot]) slots[slot] = fallback;
  }
  if (!slots.subject) slots.subject = prompt.slice(0, 120);
  return slots;
}

/**
 * 优化一段影片 prompt。纯函数、无副作用、同步执行——零成本零延迟。
 * 输入已 trim 过。
 */
export function directVideoPrompt(rawPrompt: string, options: DirectorOptions = {}): string {
  const user = rawPrompt.trim();
  if (!user) return user;

  const cameraPresent = SLOT_PATTERNS.camera.test(user);
  const actionPresent = SLOT_PATTERNS.action.test(user);
  const stylePresent = SLOT_PATTERNS.style.test(user);
  const lightingPresent = SLOT_PATTERNS.lighting.test(user);

  // sceneCard 感知规则（camera-trajectory-to-prompt）：会话存在 3D 场景卡＋轨迹时，
  // Camera 槽优先用轨迹翻译词覆盖用户模糊描述（只动 camera 槽；用户明示运镜则不干预）。
  // 无 sceneCard/cameraTrajectory → cameraRule 为 null → 以下全部分支与旧行为逐字一致。
  const cameraRule =
    options.sceneCard && options.cameraTrajectory
      ? resolveSceneCameraRule(options.cameraTrajectory, user, cameraPresent)
      : null;

  let enhanced = user;
  enhanced = replaceAll(enhanced, SLOP_WORDS);
  enhanced = replaceAll(enhanced, HOMOGRAPH_FIXES);
  enhanced = enforceAgeBlind(enhanced);
  enhanced = decomposeGenericEmotion(enhanced);
  enhanced = enforcePositivePhrasing(enhanced);

  const parts: string[] = [enhanced];
  parts.push(...fillMissingSlots(enhanced, cameraPresent || Boolean(cameraRule), stylePresent, lightingPresent));
  if (cameraRule) parts.push(cameraRule.directive);

  // 状态变化合同：不建立静态版式，开场即进入动作 beat，收尾时主体与场景都已改变。
  if (!/shot opens with the subject already advancing/i.test(enhanced)) {
    parts.push(
      "The shot opens with the subject already advancing an action beat; by the final frame the subject and the scene have visibly changed.",
    );
  }

  // 运动 + 状态变化合同：用户 prompt 已写明就不重复追加；音轨语义沿用旧逻辑。
  if (!/(state change|action beat|visibly changed|measurably|by the final frame)/i.test(enhanced)) {
    const audioClause = options.generateAudio ? "" : "SFX only, no music. ";
    parts.push(`${audioClause}${MOTION_CONTRACT}`);
  }
  if (!/(environment or staging|visibly different state|light or environment)/i.test(enhanced)) {
    parts.push(TRANSFORMATION_LOCK);
  }
  // 只有运镜、没有主体动作的提示词：补主体物理变化，禁止把相机运动当内容。
  if (!actionPresent && !/not the content of the shot/i.test(enhanced)) parts.push(CAMERA_ONLY_FIX);

  return parts.join(" ");
}