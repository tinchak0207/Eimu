import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHOWCASE_CASES } from "@/lib/showcase-cases";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 只看声明，不看注释 —— 本文件里几条 doesNotMatch 断言的正是注释里解释过的反面做法。 */
function declarations(relPath: string) {
  return read(relPath).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("homepage wires case showcase prompts into the prompt input", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  const promptInput = read("src/components/PromptInput.tsx");
  const showcase = read("src/components/CaseShowcase.tsx");
  assert.match(playground, /CaseShowcase/);
  assert.match(playground, /setCasePrompt/);
  assert.match(promptInput, /externalPrompt/);
  assert.match(showcase, /精品案例库/);
  assert.match(showcase, /min-h-11/);
  assert.match(showcase, /带入生成器/);
  assert.match(showcase, /<details/);
  assert.doesNotMatch(showcase, /lg-card/);
});

test("the case ring is a per-card flattened 3D ring, not a shared preserve-3d subtree", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  assert.match(css, /perspective: \d+px/);
  assert.match(showcase, /rotateY\(/);
  // 共享 3D 上下文会让 Safari 拍平带 filter 的子节点并让旋转后的文字重采样发虚。
  // 每张卡各自 flatten + 共用同一 perspective 消失点是刻意选择，别改回来。
  assert.doesNotMatch(declarations("src/components/case-showcase.css"), /preserve-3d/);
  // 层序因此必须由 JS 算（flatten 后浏览器不再按 z 排序）。
  assert.match(showcase, /zIndex = String/);
});

test("the ring never hijacks vertical page scroll", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  // 纵向：只读 scrollY 增量的 passive 监听，全程不 preventDefault。
  assert.match(showcase, /addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
  // 横向：React 的 onWheel 是 passive 注册，preventDefault 会被忽略。
  assert.match(showcase, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  // 且只有横向分量占优时才接管，纵向一律放行。
  assert.match(showcase, /Math\.abs\(event\.deltaX\) <= Math\.abs\(event\.deltaY\)\) return/);
  // 触屏同理：横向手势归组件，纵向滚动归用户。
  assert.match(css, /touch-action: pan-y/);
});

test("the ring animates off refs, never per-frame react state", () => {
  const showcase = read("src/components/CaseShowcase.tsx");

  assert.match(showcase, /requestAnimationFrame\(tick\)/);
  assert.match(showcase, /cardRefs\.current\[i\]/);
  assert.match(showcase, /\bs\.transform = `translate3d\(/);
  // 每帧 setState 会把 6 张卡的 React 树重算 60 次/秒；角度只活在 ref 里。
  assert.doesNotMatch(showcase, /setAngle\(/);
  assert.match(showcase, /const angleRef = useRef/);
  // 首帧/无 JS 的静态环与逐帧公式共用一份实现，不靠 nth-child 手抄一遍。
  assert.match(showcase, /STATIC_FRAMES/);
  assert.doesNotMatch(declarations("src/components/case-showcase.css"), /nth-child/);
});

test("every rotation entry point is reachable without hover or a mouse", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  assert.match(showcase, /aria-roledescription="轮播"/);
  assert.match(showcase, /上一个案例/);
  assert.match(showcase, /下一个案例/);
  assert.match(showcase, /aria-current=\{index === front\}/);
  assert.match(showcase, /"ArrowRight"/);
  assert.match(showcase, /"ArrowLeft"/);
  assert.match(showcase, /aria-live="polite"/);
  // 箭头与圆点常显（触屏没有 hover），不藏在 :hover 后面。
  assert.doesNotMatch(css, /opacity: 0;[\s\S]{0,120}\.case-arrow/);

  // 全站踩过的坑：:focus-visible 只写在窄屏 media query 里，桌面端键盘焦点全隐形。
  const focusAt = css.indexOf(".case-stage:focus-visible");
  const firstMediaAt = css.indexOf("@media");
  assert.ok(focusAt !== -1);
  assert.ok(focusAt < firstMediaAt, ":focus-visible 必须在无条件作用域，不能锁在 media query 里");
});

test("the ring degrades honestly for reduced motion and stays inside the viewport", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(showcase, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  // 减弱动效时取消逐帧积分：点箭头/圆点是瞬时到位，滚动不再驱动旋转。
  assert.match(showcase, /draggingRef\.current \|\| reduceRef\.current\) return;/);
  assert.match(showcase, /if \(reduceRef\.current\) \{[\s\S]{0,200}velRef\.current = 0;/);
  // 边卡故意溢出到视口边缘，但不能产生横向滚动条。
  assert.match(css, /overflow-x: clip/);
});

test("each showcase case carries an ambient glow colour for the ring", () => {
  assert.equal(SHOWCASE_CASES.length, 6);
  assert.equal(SHOWCASE_CASES.every((item) => /^#[0-9A-Fa-f]{6}$/.test(item.glow)), true);
  assert.match(read("src/components/case-showcase.css"), /--case-glow-rgb/);
  assert.match(read("src/components/CaseShowcase.tsx"), /rgbTriple\(SHOWCASE_CASES\[frontIndex\]\.glow\)/);
});

test("motion is a dt-integrated second-order spring, not frame-coupled lerp", () => {
  const showcase = declarations("src/components/CaseShowcase.tsx");

  // 二阶弹簧：加速度 = −k·位移 − c·速度，c 由阻尼比推出。lerp 数学上永远不会 overshoot，
  // 做不出苹果那一下「吻上去」的停靠，所以它不该再出现。
  assert.match(showcase, /const c = 2 \* ratio \* Math\.sqrt\(k\)/);
  assert.match(showcase, /-k \* \(angle - target\) - c \* vel/);
  assert.doesNotMatch(showcase, /\bLERP\b/);

  // 按真实 dt 积分并夹住上限：120Hz 屏不会转两倍快，切后台回来也不会瞬移。
  assert.match(showcase, /const dt = Math\.min\(\(now - lastTsRef\.current\) \/ 1000, MAX_DT\)/);
  assert.match(showcase, /vel \+= \(-k \* \(angle - target\) - c \* vel\) \* dt/);
  assert.match(showcase, /angle \+= vel \* dt/);

  // 收敛判据必须同时看位移和速度：只看位移会在过冲的最高点被判定「到了」，
  // 于是过冲被砍断 —— 那正是「停靠生硬」的手感。
  assert.match(showcase, /Math\.abs\(target - angle\) < [\d.]+ && Math\.abs\(vel\) < [\d.]+/);

  // 连续输入用高刚度近直驱，放手后换低刚度低阻尼做那一下过冲。
  assert.match(showcase, /SPRING_TRACK\s*=\s*\{\s*k:\s*\d+/);
  assert.match(showcase, /SPRING_SETTLE\s*=\s*\{\s*k:\s*\d+/);
});

test("dragging writes the angle directly so the card never lags the finger", () => {
  const showcase = declarations("src/components/CaseShowcase.tsx");

  // 拖曳期间手指就是位置本身：取消在飞的 rAF、清零速度、直接写角度并立刻 paint。
  // 若拖曳也走 target→插值，无论参数怎么调都存在一帧以上的跟手延迟。
  assert.match(showcase, /const dragBy = useCallback\(\(deltaDeg: number\) => \{/);
  assert.match(showcase, /rawRef\.current \+= deltaDeg/);
  assert.match(showcase, /angleRef\.current = warped/);
  assert.match(showcase, /paint\(warped\)/);
  assert.match(showcase, /dragBy\(-dx \* dragDegPerPxRef\.current\)/);
});

test("every input路径 goes through detent + commit —— 磁力不能只装在其中一条上", () => {
  const showcase = declarations("src/components/CaseShowcase.tsx");

  // 手感数学在 carousel-detent.ts 里被真的单测钉住；组件只负责接线。
  assert.match(showcase, /from "@\/lib\/carousel-detent"/);

  // 原始角度与屏幕角度是两个量：rawRef 累加输入，画出去的是 detent() 拧过的版本。
  // 少了这一层，环在格间是匀速的 —— 那就是「感觉不到卡位」。
  assert.match(showcase, /rawRef/);
  assert.match(showcase, /targetRef\.current = detent\(rawRef\.current, STEP\)/);

  // 落格一律走 commit()（按手势起点算格数），不再 round 到最近的一格。
  assert.match(showcase, /const steps = commitSteps\(travel, flickSteps\)/);
  assert.doesNotMatch(showcase, /snap\(Math\.round\(projected/);

  // 拖曳与滚动共用同一套落格：只给其中一条装磁力，另一条立刻暴露。
  assert.match(showcase, /commit\(flickSteps\)/);
  assert.match(showcase, /commit\(0\)/);

  // 半空中按下要把屏幕角度换算回原始角度，否则手指一按就跳一下。
  assert.match(showcase, /rawRef\.current = undetent\(angleRef\.current, STEP\)/);
});

test("thickness comes from side faces outside the front plane, not paint inside it", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  /* ── 為什麼側壁必須長在卡面外面 ──
     一塊厚 T 的板轉 θ 之後，投影輪廓寬 = W·cosθ + T·sinθ。側面出現在正面投影
     **之外**，輪廓因此變寬。舊版把側面畫在卡面裡（inset:0 + scaleX），輪廓永遠
     等於正面投影 —— 於是不管漸層怎麼調，側看都是一張紙。這是幾何，不是材質。 */
  assert.match(css, /\.case-side-l\s*\{[\s\S]*?right: 100%/);
  assert.match(css, /\.case-side-r\s*\{[\s\S]*?left: 100%/);
  assert.doesNotMatch(css, /\.case-bevel-l\s*\{[\s\S]*?scaleX/);

  // 寬度給 T·tanθ：帶子和卡面一起吃 cosθ 壓縮，給 tan 才投影出 sin。
  assert.match(showcase, /Math\.tan\(tiltRad\)[\s\S]{0,40}\* GLASS/);
  assert.match(showcase, /sideLF: tilt > 0 \? wall : 0/);

  /* 側壁必須是 .case-face 的兄弟：filter 會裁掉溢出的子節點，
     而景深模糊掛在 .case-face 上。順序寫死在這裡，換回去就會被裁掉。 */
  const sideBeforeFace = showcase.indexOf('className="case-side case-side-l"');
  const faceIndex = showcase.indexOf('className="case-face"');
  assert.ok(sideBeforeFace > 0 && faceIndex > sideBeforeFace);
  assert.match(css, /\.case-face\s*\{[\s\S]*?filter: blur\(var\(--case-blur/);

  // 高光、亮边、视差仍由 tilt 推出 —— 固定角度的 CSS 渐变是「假」的根因。
  assert.match(showcase, /sheen = [\s\S]{0,80}Math\.pow\(align, 3\)/);
  assert.match(showcase, /parallaxF: -Math\.sin\(tiltRad\) \* GLASS/);

  // 幾何厚度的比例常數必須和 CSS 的 --case-bevel-w 一致。
  const glass = showcase.match(/const GLASS = ([\d.]+)/);
  const bevelW = css.match(/--case-bevel-w: calc\(var\(--case-card-w\) \* ([\d.]+)\)/);
  assert.ok(glass && bevelW);
  assert.equal(glass![1], bevelW![1]);
});

test("移除 SVG 位移濾鏡：矩形結構元素侵蝕圓角矩形會留下硬邊直角框", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  /* feMorphology 的結構元素是**矩形**。用它 erode 一個圓角矩形，得到的遮罩帶
     方角；再把這塊「銳利核心」用 feMerge 蓋回一份 feDisplacementMap 位移過的
     副本上，兩者交界就是使用者截圖裡那個硬邊直角框（stdDeviation="3" 遠不足以
     糊掉）。邊緣折射改由 CaseGlassWebGL 算真 Snell 折射，它天生跟著圓角走。 */
  assert.doesNotMatch(showcase, /<feMorphology/);
  assert.doesNotMatch(showcase, /<feDisplacementMap/);
  assert.doesNotMatch(showcase, /id="case-liquid-edge"/);
  assert.doesNotMatch(css, /filter: url\(#case-liquid-edge\)/);
});

test("厚度來自折射擠壓畫面，不是不透明白框 —— 照片必須滿版", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");
  const webgl = read("src/components/CaseGlassWebGL.tsx");

  /* 使用者：「很粗製濫造」。上一版讓照片內縮 8.2%，再在讓出來的空間裡塗一圈不透明
     白 —— 那是塑膠相框，不是玻璃。厚玻璃壓在照片上時，邊緣看到的是**同一張照片被
     折射擠壓後的樣子**，一個像素的白邊都沒有。所以照片必須滿版。 */
  const media = css.match(/\.case-media\s*\{[\s\S]*?\n\}/);
  assert.ok(media);
  assert.match(media![0], /inset: 0/);
  assert.doesNotMatch(css, /--case-glass-w/);
  assert.doesNotMatch(showcase, /className="case-glass"/);
  assert.doesNotMatch(showcase, /className="case-inner"/);

  // 倒邊與 CSS 的 --case-band-w 同值；Round 8 刻意縮薄，避免把透明邊讀成塑膠框。
  const wall = webgl.match(/const BEVEL = ([\d.]+)/);
  const bandW = css.match(/--case-band-w: calc\(var\(--case-card-w\) \* ([\d.]+)\)/);
  assert.ok(wall && bandW);
  assert.equal(Number(wall![1]), Number(bandW![1]));
  assert.ok(Number(wall![1]) <= 0.07);

  // 帶子裡不准 mix 一層均勻的白 —— 那會把它變回不透明相框。
  assert.doesNotMatch(webgl, /mix\(color, vec3\(1\.0\), 0\.[1-9]/);

  // 外緣的白只剩兩條 1px 的線，沒有任何面積。
  const edge = css.match(/\.case-edge\s*\{[\s\S]*?\n\}/);
  assert.ok(edge);
  assert.match(edge![0], /inset 0 0 0 1px rgba\(255, 255, 255/);
  assert.doesNotMatch(edge![0], /--case-band-w/);

  // 視差錯開量必須小於照片的 scale 餘量。
  const parallax = showcase.match(/parallaxF: -Math\.sin\(tiltRad\) \* GLASS \* ([\d.]+)/);
  const zoom = css.match(/scale\((1\.\d+)\)/);
  assert.ok(parallax && zoom);
  const glassDepth = Number(showcase.match(/const GLASS = ([\d.]+)/)![1]);
  assert.ok(Number(zoom![1]) >= 1 + 2 * glassDepth * Number(parallax![1]));
});

test("側壁不得伸出圓角：兩端收在直邊範圍內並淡出", () => {
  const css = read("src/components/case-showcase.css");

  /* 卡片圓角是卡寬 ~9%（卡高 ~12%），右緣真正是直的只有中間那段。上一版給
     top/bottom: 2%，帶子在圓角處直接伸出輪廓，兩端各多一個突兀的白角。 */
  /* 必須錨在行首：`.case-slab[data-glass="on"] > .case-side {` 也含 `.case-side {`，
     不錨的話會抓到那條隱藏規則。 */
  const side = css.match(/^\.case-side\s*\{[\s\S]*?\n\}/m);
  assert.ok(side);
  const top = side![0].match(/top: (\d+)%/);
  assert.ok(top);
  assert.ok(Number(top![1]) >= 8);
  assert.match(side![0], /mask-image: linear-gradient\(\s*180deg,\s*transparent/);
});

test("拖動途中不得整片發灰：opacity 是平台加斷崖，不是單調衰減", () => {
  const showcase = read("src/components/CaseShowcase.tsx");

  /* pow(depth, 7) 在 30° 就掉到 0.64，拖動時兩張卡同時半透明疊在淺色背景上 →
     整片慘白。smoothstep 兩端導數為 0，所以 0~30° 幾乎不掉，60° 才準時交棒。 */
  assert.match(showcase, /opacity: 0\.07 \+ 0\.93 \* smoothstep\(0\.34, 1, Math\.max\(0, 2 \* depth - 1\)\)/);
  assert.match(showcase, /function smoothstep\(edge0: number, edge1: number, x: number\)/);
  assert.doesNotMatch(showcase, /Math\.pow\(depth, 7\)/);

  // 原始需求的靜止值必須保住：正面 1、相鄰 ±60° 落在 0.15~0.25、背面 ≤0.1。
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const op = (deg: number) => {
    const depth = (Math.cos((deg * Math.PI) / 180) + 1) / 2;
    return 0.07 + 0.93 * ss(0.34, 1, Math.max(0, 2 * depth - 1));
  };
  assert.ok(op(0) > 0.99);
  assert.ok(op(60) >= 0.15 && op(60) <= 0.25);
  assert.ok(op(120) <= 0.1);
  // 拖到一半（30°）主卡必須還是實的，否則就是使用者截圖裡那張慘白的卡。
  assert.ok(op(30) >= 0.85);
});

test("the doubled ring radius, dramatic fade, and thin glass depth stay in sync", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  // 半徑只放大環，不放大卡：JS 實測與 SSR/mobile fallback 必須同時翻倍。
  assert.match(showcase, /const RADIUS_SCALE = 2/);
  assert.match(showcase, /const radius = cardW \* \(compact \? 0\.84 : 0\.78\) \* RADIUS_SCALE/);
  assert.match(css, /--case-radius: 812px/);
  assert.match(css, /--case-radius: calc\(var\(--case-card-w\) \* 1\.68\)/);

  // 正面維持 1；相鄰 ±60° 約 0.21，背面則落到 0.07，不再與主卡搶鏡頭。
  // 曲線形狀（平台加斷崖）由「拖動途中不得整片發灰」那條測試守。
  assert.match(showcase, /opacity: 0\.07 \+ 0\.93 \* smoothstep\(/);

  // 幾何厚度保持薄而可透，且 TS 光學模型與 CSS 側切面用同一數值。
  const glass = showcase.match(/const GLASS = ([\d.]+)/);
  const bevelW = css.match(/--case-bevel-w: calc\(var\(--case-card-w\) \* ([\d.]+)\)/);
  assert.ok(glass && bevelW);
  assert.equal(glass![1], bevelW![1]);
  assert.ok(Number(glass![1]) >= 0.05 && Number(glass![1]) <= 0.07);
});

test("the focused card uses real WebGL refraction with an honest fallback", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const webgl = read("src/components/CaseGlassWebGL.tsx");
  const css = read("src/components/case-showcase.css");

  assert.match(showcase, /<CaseGlassWebGL/);
  assert.match(showcase, /index === front/);
  assert.match(webgl, /getContext\("webgl"/);
  assert.match(webgl, /refract\(/);
  assert.match(webgl, /Fresnel/i);
  assert.match(webgl, /webglcontextlost/);
  assert.match(webgl, /prefers-reduced-motion: reduce/);
  assert.match(webgl, /saveData|deviceMemory/);
  assert.match(css, /\.case-glass-webgl\[data-ready="true"\]/);
  assert.match(css, /\.case-glass-webgl-fallback/);
  assert.match(css, /pointer-events: none/);
});

test("正對鏡頭保持透明：體積只由薄邊法線、局部高光與邊緣折射表達", () => {
  const webgl = read("src/components/CaseGlassWebGL.tsx");

  // 中央不再做穹頂桶形位移；只有 edgeMask 把外緣法線轉向側面。
  assert.match(webgl, /float theta = edgeMask \* 1\.32/);
  assert.match(webgl, /vec3 normal = normalize\(vec3\(liquidNormal \* sin\(theta\), cos\(theta\)\)\)/);
  assert.doesNotMatch(webgl, /float dome =/);
  assert.doesNotMatch(webgl, /vec2 barrel =/);
  assert.match(webgl, /vec3 lightDir = normalize/);
  assert.match(webgl, /float spec = pow\(nh, 54\.0\)/);
  assert.match(webgl, /vec2 offset = bent\.xy \* min\(u_thick \/ depthT, u_bevel \* 0\.52\) \* edgeMask/);
});

test("液態輪廓：不是完美圓角矩形 —— 外凸 + 起伏 + 每張卡不同相位", () => {
  const webgl = read("src/components/CaseGlassWebGL.tsx");
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  /* 使用者：「目前的感覺依然很死板僵硬。」死板的根因是輪廓，不是材質參數：
     一個數學上完美的圓角矩形，不管折射算得多準，都會先被讀成「UI 卡片」。
     所以外緣半尺寸必須是位置的函數 —— 桶形外凸 + 低頻起伏。 */
  assert.match(webgl, /vec2 liquidHalf\(vec2 p\)/);
  assert.match(webgl, /float bowX = u_bow \* cos\(/);
  assert.match(webgl, /sin\(n\.y \* 2\.7 \+ u_seed\)/);
  const bow = webgl.match(/const BOW = ([\d.]+)/);
  const wob = webgl.match(/const WOBBLE = ([\d.]+)/);
  assert.ok(bow && wob);
  assert.ok(Number(bow![1]) >= 0.015, "外凸要看得出來");
  assert.ok(Number(wob![1]) >= 0.005, "起伏要看得出來");

  // 法線取自**加了起伏的**連續距離場的有限差分，光才會跟著波動走。
  assert.match(webgl, /glassSD\(p \+ vec2\(1\.25, 0\.0\)\) - glassSD\(p - vec2\(1\.25, 0\.0\)\)/);

  // 六張卡不能是同一個模子：每張給不同相位。
  assert.match(showcase, /seed=\{index \* 1\.7 \+ 0\.35\}/);

  /* 輪廓要伸出卡框（外凸、起伏、側壁全在框外），所以宿主必須是負 inset 且
     不裁切。overflow: hidden 會把凸出來的部分切成直邊 —— 又變回矩形。 */
  const hostCss = css.match(/\.case-glass-webgl\s*\{[\s\S]*?\n\}/);
  assert.ok(hostCss);
  assert.match(hostCss![0], /inset: calc\(var\(--case-card-w, 520px\) \* -0\.10\)/);
  assert.match(hostCss![0], /overflow: visible/);
  const margin = webgl.match(/const MARGIN = ([\d.]+)/);
  assert.ok(margin);
  assert.equal(Number(margin![1]), 0.10, "MARGIN 必須與 CSS 的負 inset 同值");

  /* 照片嵌在玻璃裡，四周留一圈**半透明**的薄玻璃殼，頁面底色透上來。 */
  assert.match(webgl, /const SHELL = ([\d.]+)/);
  assert.match(webgl, /float shellA = mix\(1\.0, 0\.18, smoothstep\(0\.0, u_shell \* 0\.96, pd\)\)/);

  /* 焦散：折射位移的散度 = 能量密度變化，倒邊把光聚到內緣。
     參考圖標註明寫「具有焦散和折射效果」。 */
  assert.match(webgl, /float caustic = smoothstep\(0\.18, 0\.72, edgeMask\)/);

  /* 圖片核心保持銳利，只有邊緣用小半徑的等向取樣柔化。 */
  assert.match(webgl, /vec3 edgeSample\(vec2 uv, float radius\)/);
  assert.match(webgl, /float soft = mix\(0\.0, 0\.0022, edgeMask \* edgeMask\)/);
});

test("正面圖片核心保持原圖直出，液態折射只能存在於透明薄邊", () => {
  const webgl = read("src/components/CaseGlassWebGL.tsx");
  const css = read("src/components/case-showcase.css");

  // 中央 84% 區域必須直接讀原始貼圖；文字與人物不能再經桶形位移、色散或多 tap 模糊。
  assert.match(webgl, /vec3 original = texture2D\(u_texture, clamp\(originalUv, 0\.001, 0\.999\)\)\.rgb/);
  assert.match(webgl, /float edgeMask = smoothstep\(0\.0, 1\.0, edgeT\)/);
  assert.match(webgl, /vec3 color = mix\(original, glassColor, edgeMask\)/);
  assert.doesNotMatch(webgl, /vec2 barrel =/);
  assert.doesNotMatch(webgl, /vec3 sampleSoft\(/);

  // 四條線來自 roundedBox SDF 的梯度折角；連續 squircle 場才能讓圖片內部完全乾淨。
  assert.doesNotMatch(webgl, /float roundedBox\(/);
  assert.match(webgl, /float squircleSD\(/);
  assert.doesNotMatch(webgl, /u_radii/);

  // 液態感由手勢角度與每卡 seed 驅動，只擾動邊緣法線，不得改動原圖核心。
  assert.match(webgl, /float flow = sin\([^;]*u_seed[^;]*u_tilt/);
  assert.match(webgl, /flow \* edgeMask/);

  // 玻璃必須是薄而透明，不是 11.5% 卡寬的奶白塑膠框。
  assert.match(webgl, /const SHELL = 0\.025/);
  assert.match(webgl, /const BEVEL = 0\.065/);
  assert.match(webgl, /const THICK = 0\.062/);
  assert.match(webgl, /float shellA = mix\(1\.0, 0\.18/);
  assert.match(css, /--case-band-w: calc\(var\(--case-card-w\) \* 0\.065\)/);
});

test("GL 就緒後矩形 HTML 圖層必須退場，否則硬直邊壓在有機輪廓上", () => {
  const webgl = read("src/components/CaseGlassWebGL.tsx");
  const showcase = read("src/components/CaseShowcase.tsx");
  const css = read("src/components/case-showcase.css");

  /* shader 現在畫整張卡（照片＋玻璃殼＋倒邊）。HTML 的 <img> 是矩形、
     .case-surface 的 inset box-shadow 是矩形、.case-side 是矩形 —— 任何一個
     留著，硬直邊都會贏，整張卡又讀成「圓角矩形貼了效果」。 */
  assert.match(webgl, /slab\.dataset\.glass = "on"/);
  assert.match(webgl, /delete slab\.dataset\.glass/);
  assert.match(css, /\.case-slab\[data-glass="on"\] > \.case-face/);
  assert.match(css, /\.case-slab\[data-glass="on"\] > \.case-side/);
  // visibility 而非 display：版面尺寸要留著（GL 靠 slab.offsetWidth 定尺）。
  const hide = css.match(/\.case-slab\[data-glass="on"\] > \.case-face,[\s\S]*?\n\}/);
  assert.ok(hide);
  assert.match(hide![0], /visibility: hidden/);
  assert.doesNotMatch(hide![0], /display: none/);

  /* GL 層必須是 .case-slab 的直接子節點：掛進帶 filter 的 .case-face 會被裁掉，
     而且元件靠 host.parentElement 讀卡片版面尺寸。 */
  const glIndex = showcase.indexOf("<CaseGlassWebGL");
  const faceIndex = showcase.indexOf('className="case-face"');
  assert.ok(glIndex > 0 && faceIndex > glIndex, "GL 層必須在 .case-face 之前");
  assert.match(webgl, /const slab = host\.parentElement/);

  // 六張卡都要走 shader，但其餘五張等空閒再點火，不壓首屏。
  assert.match(showcase, /enabled=\{index === front \|\| glassAll\}/);
  assert.match(showcase, /requestIdleCallback/);
});

test("玻璃上的光跟著轉動走：由父層手勢迴圈驅動，GL 不自己開 rAF", () => {
  const webgl = read("src/components/CaseGlassWebGL.tsx");
  const showcase = read("src/components/CaseShowcase.tsx");

  /* 玻璃是靜物，但玻璃上的**光**不是。時間驅動的重畫 = 呼吸 = 閃爍（已修）；
     傾角驅動的重畫是事件驅動的，手不動就不畫。 */
  assert.match(webgl, /registerDraw\?: \(draw: \(\(tiltDeg: number\) => void\) \| null\) => void/);
  assert.match(webgl, /uniform float u_tilt/);
  assert.match(webgl, /vec3 view = normalize\(vec3\(-sin\(u_tilt\)/);
  // 傾角改變才推，且只推看得見的那兩三張。
  assert.match(showcase, /f\.depth > 0\.5 && Math\.abs\(f\.tilt - \(glTiltRefs\.current\[i\] \?\? 999\)\) > 0\.4/);
  // registerDraw 進 ref：它每次 render 都是新 identity，直接進依賴會重建 context。
  assert.match(webgl, /const registerRef = useRef\(registerDraw\)/);
});

test("WebGL 輸出預乘 alpha，context 必須同意 —— 否則羽化帶塌向黑長出深色描邊", () => {
  const webgl = read("src/components/CaseGlassWebGL.tsx");

  /* 使用者：「邊框奇奇怪怪的」。shader 輸出 vec4(color * alpha, alpha)，而 context
     宣告 premultipliedAlpha: false 時，瀏覽器會把已預乘的 RGB 當直通值再乘一次
     alpha → 實際亮度 color·alpha²，在 alpha 由 0 爬到 1 的羽化帶上顏色塌向黑，
     沿著圓角長出一條約 4px 的深色環。兩者必須一致。 */
  assert.match(webgl, /premultipliedAlpha: true/);
  assert.doesNotMatch(webgl, /premultipliedAlpha: false/);
  assert.match(webgl, /gl_FragColor = vec4\(color \* alpha, alpha\)/);
  assert.match(webgl, /blendFunc\(gl\.ONE, gl\.ONE_MINUS_SRC_ALPHA\)/);

  // alpha 趨 0 的位置不准再乘暗化係數，那是深色環的幫兇。
  assert.doesNotMatch(webgl, /color \*= 1\.0 - [\d.]+ \* exp/);

  // CSS 圓角只負責 HTML fallback；GL 使用連續場，不再把四個分支半徑帶進 shader。
  assert.doesNotMatch(webgl, /const RADIUS = /);
});

test("玻璃層不閃爍：不混色疊全幅、不逐帧重畫、不隨 transform 重設畫布", () => {
  const showcase = read("src/components/CaseShowcase.tsx");
  const webgl = read("src/components/CaseGlassWebGL.tsx");
  const css = read("src/components/case-showcase.css");

  /* ① 「重疊/散光」的根因：拿 screen 把一份全幅扭曲影像疊回原圖 = 雙重曝光。
     真玻璃中央無損，折射只發生在磨邊 —— 所以這一層不准有混色模式。 */
  assert.doesNotMatch(css, /^\s*mix-blend-mode\s*:/m);

  /* 註解裡會提到這些名字（說明為什麼不能用），所以要對「去掉註解後的程式碼」斷言。 */
  const code = webgl.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /* ② 「閃爍」根因之一：時間驅動的漣漪/焦散每帧重畫整張卡。玻璃是靜物。 */
  assert.doesNotMatch(code, /requestAnimationFrame/);
  assert.doesNotMatch(code, /u_time/);

  /* ③ 「閃爍」根因之二：畫布尺寸取自 getBoundingClientRect()，而卡片帶 rotateY，
     rect 每帧都在變 → 每帧重設畫布尺寸 → 每帧清空畫布。必須用版面尺寸。 */
  assert.doesNotMatch(code, /getBoundingClientRect/);
  assert.match(code, /host\.offsetWidth/);

  /* ④ alpha 由 shader 決定（牆內 1、平面 0），不靠容器 opacity 半透明整層。 */
  const host = css.match(/\.case-glass-webgl\s*\{[\s\S]*?\}/);
  assert.ok(host);
  assert.doesNotMatch(host![0], /opacity/);

  /* ⑤ 模糊改走 CSS 變數，filter 常駐在 .case-face 上：在 "" 與 blur() 之間
     切換會反覆建立/銷毀合成層，而變數只改一個數值，宣告本身永遠在。 */
  assert.match(showcase, /--case-blur/);
  assert.doesNotMatch(showcase, /f\.blur > 0 \? `blur/);
});

test("corner radius and ring geometry scale with the measured card width", () => {
  const css = read("src/components/case-showcase.css");

  // 不对称是用户明确要保留的那一点手工感。
  const slab = css.slice(css.indexOf(".case-slab {"), css.indexOf(".case-slab::before"));
  const radii = slab.match(/calc\(var\(--case-card-w, 520px\) \* ([\d.]+)\)/g) ?? [];
  assert.equal(radii.length, 4, "四个角各自独立");
  assert.equal(new Set(radii).size > 1, true, "四角不能收敛成同一个值");

  // 手机端必须覆盖卡片尺寸与舞台高度，否则水合前用桌面默认值撑出高度跳变。
  const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
  assert.match(mobile, /--case-card-w:/);
  assert.match(mobile, /--case-radius:/);
  assert.match(mobile, /height:/);
});
