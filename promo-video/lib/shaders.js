import * as THREE from "three";

// ---------- 无限画布表面：珍珠白 + 点阵 + 蓝粉光池；可切换到暗色预演舞台 ----------
export function surfaceMaterial() {
  const c = s => new THREE.Color(s);
  return new THREE.ShaderMaterial({
    uniforms: {
      uPearl: { value: c("#eef1f6") }, uDot: { value: c("#c9d0dc") },
      uBlue: { value: c("#b9d4ff") }, uPink: { value: c("#f7cfe3") }, uTeal: { value: c("#c6ecfb") },
      uStage: { value: c("#101217") }, uStageLine: { value: c("#2a303c") }, uStageLine2: { value: c("#1b1f27") },
      uWarm: { value: c("#ffb45e") },
      uFog: { value: c("#f1f3f7") },
      uLight: { value: 1 }, uStageMix: { value: 0 }, uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() }, uFogNear: { value: 16 }, uFogFar: { value: 46 },
      uWarmPos: { value: new THREE.Vector2(0, 0) }, uWarmAmt: { value: 0 },
      uPoolShift: { value: new THREE.Vector2(0, 0) }, uDots: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uPearl, uDot, uBlue, uPink, uTeal, uStage, uStageLine, uStageLine2, uWarm, uFog, uCam;
      uniform float uLight, uStageMix, uTime, uFogNear, uFogFar, uWarmAmt, uDots;
      uniform vec2 uWarmPos, uPoolShift;
      varying vec3 vW;
      float pool(vec2 p, vec2 c, float r){ vec2 d = p - c; return exp(-dot(d,d)/(r*r)); }
      void main(){
        vec2 p = vW.xz;
        float dist = length(vW - uCam);
        // 珍珠画布
        vec3 col = uPearl;
        vec2 ps = uPoolShift;
        col = mix(col, uBlue, .55 * pool(p, vec2(-12., -5.) + ps, 9.));
        col = mix(col, uPink, .50 * pool(p, vec2(4., 5.5) + ps, 8.5));
        col = mix(col, uTeal, .45 * pool(p, vec2(-4., -9.) + ps, 7.));
        col = mix(col, uPink, .35 * pool(p, vec2(18., -6.) + ps, 9.));
        col = mix(col, uBlue, .40 * pool(p, vec2(22., 6.) + ps, 10.));
        vec2 g = fract(p / .25) - .5;
        float d = length(g) * .25;
        float aa = fwidth(d) * 1.2 + 1e-4;
        float dotA = 1. - smoothstep(.0105, .0105 + aa, d);
        dotA *= 1. - smoothstep(9., 26., dist);
        col = mix(col, uDot, dotA * .7 * uDots);
        // 预演舞台：深色 + 网格线
        vec2 q = p;
        vec2 f = fract(q); vec2 fd = min(f, 1. - f); float lm = min(fd.x, fd.y);
        float wm = fwidth(lm) * 1.2 + 1e-4;
        float lineMaj = 1. - smoothstep(.008, .008 + wm, lm);
        vec2 f2 = fract(q * 4.); vec2 fd2 = min(f2, 1. - f2); float lm2 = min(fd2.x, fd2.y) / 4.;
        float wm2 = fwidth(lm2) * 1.2 + 1e-5;
        float lineMin = 1. - smoothstep(.003, .003 + wm2, lm2);
        float fadeL = 1. - smoothstep(8., 24., dist);
        vec3 st = uStage;
        st = mix(st, uStageLine2, lineMin * fadeL * .8);
        st = mix(st, uStageLine, lineMaj * fadeL);
        st += uWarm * .22 * uWarmAmt * pool(p, uWarmPos, 2.2);
        st += vec3(.02,.03,.05) * pool(p, uWarmPos + vec2(0.,-4.), 6.);
        col = mix(col, st, uStageMix);
        col *= uLight;
        float fg = smoothstep(uFogNear, uFogFar, dist);
        col = mix(col, uFog * uLight, fg);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
}

// ---------- 图像/贴花材质：圆角遮罩 + 左→右揭示 + 光带扫过 + 灰度/暗化 ----------
export function imageMaterial({ map, w, h, radius = 0, transparent = true, opaque = false } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map }, uSize: { value: new THREE.Vector2(w, h) }, uRadius: { value: radius },
      uOpacity: { value: 1 }, uReveal: { value: 1 }, uSoft: { value: .06 }, uSweep: { value: -1 }, uSweepAmt: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) }, uGray: { value: 0 }, uBright: { value: 1 },
      uUvScale: { value: new THREE.Vector2(1, 1) }, uUvOffset: { value: new THREE.Vector2(0, 0) },
      uShim: { value: 0 }, uShimPos: { value: 0 }, uBase: { value: new THREE.Color("#e4e8ef") }, uClear: { value: 0 }, uPremul: { value: 0 },
    },
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform vec2 uSize, uUvScale, uUvOffset; uniform float uRadius, uOpacity, uReveal, uSoft, uSweep, uSweepAmt, uGray, uBright, uShim, uShimPos, uClear, uPremul;
      uniform vec3 uTint, uBase; varying vec2 vUv;
      float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q,0.)) + min(max(q.x,q.y),0.) - r; }
      void main(){
        vec2 p = (vUv - .5) * uSize;
        float d = sdRound(p, uSize * .5, uRadius);
        float aa = fwidth(d) * .9 + 1e-5;
        float mask = 1. - smoothstep(-aa, aa, d);
        vec2 uv = (vUv - .5) * uUvScale + .5 + uUvOffset;
        vec4 tex = texture2D(uMap, uv);
        vec3 col = uPremul > .5 ? tex.rgb / max(tex.a, 1e-4) : tex.rgb;
        float lum = dot(col, vec3(.2126,.7152,.0722));
        col = mix(col, vec3(lum), uGray) * uBright * uTint;
        // 揭示：从左到右，软边
        float rv = smoothstep(uReveal - uSoft, uReveal, vUv.x * (1. - uSoft) + uSoft * .5);
        float reveal = 1. - rv;
        // 骨架 shimmer（未揭示部分显示浅灰底 + 移动高光）
        float sh = exp(-pow((vUv.x - uShimPos) * 4., 2.)) * uShim;
        vec3 base = uBase + sh * .35;
        col = mix(base, col, uClear > .5 ? 1. : reveal);
        // 光带
        float band = exp(-pow((vUv.x + vUv.y * .35 - uSweep) * 9., 2.)) * uSweepAmt;
        col += band;
        float a = mask * uOpacity * (${transparent ? "tex.a" : "1."}) * (uClear > .5 ? reveal : 1.);
        ${opaque ? "if (a < .02) discard; gl_FragColor = vec4(col, a);" : "gl_FragColor = vec4(col, a);"}
      }`,
    transparent: !opaque, depthWrite: opaque, alphaToCoverage: opaque,
  });
  return m;
}

// ---------- 发光连线：沿管长绘制 + 脉冲光点（HDR，交给 bloom） ----------
export function threadMaterial(color, len) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uDraw: { value: 0 }, uLen: { value: len },
      uCore: { value: 1.1 }, uPulse: { value: new THREE.Vector3(-9, -9, -9) }, uPulseAmt: { value: 7 },
      uOpacity: { value: 1 }, uHead: { value: 5 }, uBack: { value: 0 },
    },
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor, uPulse; uniform float uDraw, uLen, uCore, uPulseAmt, uOpacity, uHead, uBack; varying vec2 vUv;
      float g(float x, float w){ return exp(-(x*x)/(w*w)); }
      void main(){
        float s = vUv.x;
        if (s > uDraw || s < uBack) discard;
        float pl = 0.;
        pl += g((s - uPulse.x) * uLen, .22);
        pl += g((s - uPulse.y) * uLen, .22);
        pl += g((s - uPulse.z) * uLen, .22);
        float head = g((uDraw - s) * uLen, .12) * step(uDraw, .999);
        vec3 col = uColor * (uCore + pl * uPulseAmt + head * uHead);
        gl_FragColor = vec4(col, uOpacity);
      }`,
    transparent: true, depthWrite: false,
  });
}

// ---------- 电影调色（OutputPass 之后，显示空间）：颗粒 / 暗角 / 色散 / 淡入淡出 ----------
export const FilmShader = {
  uniforms: {
    tDiffuse: { value: null }, uSeed: { value: 0 }, uGrain: { value: .035 }, uVig: { value: .35 }, uCA: { value: .6 },
    uFade: { value: 0 }, uFadeCol: { value: new THREE.Color(0, 0, 0) }, uRes: { value: new THREE.Vector2(1920, 1080) },
    uContrast: { value: 1 }, uLift: { value: 0 }, uSat: { value: 1 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uSeed, uGrain, uVig, uCA, uFade, uContrast, uLift, uSat; uniform vec3 uFadeCol; uniform vec2 uRes;
    varying vec2 vUv;
    float h(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main(){
      vec2 c = vUv - .5;
      float r2 = dot(c * vec2(1.7778, 1.), c * vec2(1.7778, 1.));
      vec2 off = c * r2 * uCA * .012;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float l = dot(col, vec3(.2126,.7152,.0722));
      col = mix(vec3(l), col, uSat);
      col = (col - .5) * uContrast + .5 + uLift;
      float v = smoothstep(1.15, .25, length(c * vec2(1., .82)) * 1.35);
      col *= mix(1., v, uVig);
      float n = h(floor(vUv * uRes) + uSeed * 37.13) - .5;
      col += n * uGrain * (.55 + .45 * (1. - l));
      col = mix(col, uFadeCol, uFade);
      gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
    }`,
};
