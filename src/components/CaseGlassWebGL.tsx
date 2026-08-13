"use client";

/*
 * CaseGlassWebGL keeps the source image untouched across the readable core and
 * confines refraction to a thin, translucent liquid edge. The edge is derived
 * from a continuous squircle field, so no SDF branch lines can cross the image.
 */

import { useEffect, useRef, useState } from "react";

interface CaseGlassWebGLProps {
  enabled: boolean;
  imageSrc?: string;
  seed?: number;
  registerDraw?: (draw: ((tiltDeg: number) => void) | null) => void;
}

const SHELL = 0.025;
const BEVEL = 0.065;
const THICK = 0.062;
const IOR = 1.47;
const BOW = 0.018;
const WOBBLE = 0.010;
const MARGIN = 0.10;

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D u_texture;
uniform vec2 u_size;
uniform vec2 u_half;
uniform vec2 u_photoHalf;
uniform vec2 u_uvScale;
uniform float u_shell;
uniform float u_bevel;
uniform float u_thick;
uniform float u_bow;
uniform float u_wob;
uniform float u_ior;
uniform float u_seed;
uniform float u_tilt;
uniform float u_side;
varying vec2 v_uv;

vec2 liquidHalf(vec2 p) {
  vec2 n = p / max(u_half, vec2(1.0));
  float bowX = u_bow * cos(clamp(n.y, -1.0, 1.0) * 1.5707963);
  float bowY = u_bow * cos(clamp(n.x, -1.0, 1.0) * 1.5707963);
  float wx = sin(n.y * 2.7 + u_seed) * 0.58 + sin(n.y * 4.9 - u_seed * 1.7) * 0.42;
  float wy = sin(n.x * 3.1 - u_seed * 1.3) * 0.58 + sin(n.x * 5.3 + u_seed * 2.1) * 0.42;
  return u_half + vec2(bowX + u_wob * wx, bowY + u_wob * wy);
}

/* Continuous superellipse field: unlike a rounded-box SDF, it has no diagonal
   min/max branch whose derivative can show up as four lines in the texture. */
float squircleSD(vec2 p, vec2 h) {
  vec2 q = abs(p) / max(h, vec2(1.0));
  float power = 5.2;
  float field = pow(q.x, power) + pow(q.y, power);
  float scale = min(h.x, h.y) / power;
  return (pow(max(field, 0.00001), 1.0 / power) - 1.0) * scale * power;
}

float glassSD(vec2 p) {
  vec2 q = vec2(p.x - u_side * 0.5, p.y);
  return squircleSD(q, liquidHalf(q) + vec2(abs(u_side) * 0.5, 0.0));
}

float photoSD(vec2 p) {
  vec2 liquidInset = (liquidHalf(p) - u_half) * 0.35;
  return squircleSD(p, u_photoHalf + liquidInset);
}

vec3 edgeSample(vec2 uv, float radius) {
  vec2 x = vec2(radius, 0.0);
  vec2 y = vec2(0.0, radius);
  vec3 c = texture2D(u_texture, clamp(uv, 0.001, 0.999)).rgb * 0.50;
  c += texture2D(u_texture, clamp(uv + x, 0.001, 0.999)).rgb * 0.125;
  c += texture2D(u_texture, clamp(uv - x, 0.001, 0.999)).rgb * 0.125;
  c += texture2D(u_texture, clamp(uv + y, 0.001, 0.999)).rgb * 0.125;
  c += texture2D(u_texture, clamp(uv - y, 0.001, 0.999)).rgb * 0.125;
  return c;
}

void main() {
  vec2 p = (v_uv - 0.5) * u_size;
  float sd = glassSD(p);
  if (sd > 1.5) { gl_FragColor = vec4(0.0); return; }

  vec2 originalBase = p / (u_photoHalf * 2.0);
  vec2 originalUv = originalBase * u_uvScale + 0.5;
  vec3 original = texture2D(u_texture, clamp(originalUv, 0.001, 0.999)).rgb;

  /* edgeT is zero throughout the readable core. Every optical effect below is
     multiplied by edgeMask, so the source image remains pixel-faithful there. */
  float edgeT = clamp(1.0 + sd / max(u_bevel, 1.0), 0.0, 1.0);
  float edgeMask = smoothstep(0.0, 1.0, edgeT);

  vec2 outward = normalize(vec2(
    glassSD(p + vec2(1.25, 0.0)) - glassSD(p - vec2(1.25, 0.0)),
    glassSD(p + vec2(0.0, 1.25)) - glassSD(p - vec2(0.0, 1.25))
  ) + 1e-6);

  /* Low-frequency flow follows the gesture angle and differs per card. It bends
     only the glass edge, never the readable image core. */
  float flow = sin(p.x * 0.010 + p.y * 0.007 + u_seed * 1.9 + u_tilt * 2.4);
  flow += sin(p.y * 0.014 - p.x * 0.004 - u_seed * 1.2 + u_tilt * 1.3) * 0.45;
  float flowEdge = flow * edgeMask;
  vec2 tangent = vec2(-outward.y, outward.x);
  vec2 liquidNormal = normalize(outward + tangent * flowEdge * 0.13);

  float theta = edgeMask * 1.32;
  vec3 normal = normalize(vec3(liquidNormal * sin(theta), cos(theta)));
  vec3 view = normalize(vec3(-sin(u_tilt) * 0.72, 0.0, cos(u_tilt)));
  vec3 bent = refract(-view, normal, 1.0 / u_ior);
  float depthT = max(abs(bent.z), 0.48);
  vec2 offset = bent.xy * min(u_thick / depthT, u_bevel * 0.52) * edgeMask;

  vec2 refractedBase = (p + offset) / (u_photoHalf * 2.0);
  vec2 refractedUv = refractedBase * u_uvScale + 0.5;
  float soft = mix(0.0, 0.0022, edgeMask * edgeMask);
  vec3 refracted = edgeSample(refractedUv, soft);

  float facing = max(dot(normal, view), 0.0);
  float fresnel = pow(1.0 - facing, 5.4) * edgeMask;
  vec3 tint = mix(vec3(0.66, 0.85, 0.96), vec3(0.96, 1.0, 1.0), liquidNormal.y * 0.5 + 0.5);

  vec3 lightDir = normalize(vec3(-0.48 - sin(u_tilt) * 0.32, 0.62, 0.78));
  vec3 halfway = normalize(lightDir + view);
  float nh = max(dot(normal, halfway), 0.0);
  float brokenHighlight = smoothstep(0.12, 0.82, 0.5 + 0.5 * sin(p.y * 0.022 + u_seed * 2.6));
  float spec = pow(nh, 54.0) * brokenHighlight * edgeMask * 0.42;
  float caustic = smoothstep(0.18, 0.72, edgeMask) * (1.0 - smoothstep(0.72, 1.0, edgeMask));
  caustic *= 0.5 + 0.5 * sin(p.x * 0.017 - p.y * 0.011 + u_seed + u_tilt * 1.8);

  vec3 glassColor = mix(refracted, tint, clamp(fresnel * 0.38, 0.0, 0.34));
  glassColor += spec;
  glassColor += max(caustic, 0.0) * vec3(0.08, 0.12, 0.15);
  vec3 color = mix(original, glassColor, edgeMask);

  float pd = photoSD(p);
  float shellA = mix(1.0, 0.18, smoothstep(0.0, u_shell * 0.96, pd));
  float alpha = shellA * clamp(0.55 - sd * 0.7, 0.0, 1.0);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "WebGL shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "WebGL program link failed");
  }
  return program;
}

function textureUrl(src: string) {
  return src.startsWith("/") ? `/_next/image?url=${encodeURIComponent(src)}&w=828&q=84` : src;
}

const UNIFORM_NAMES = [
  "u_texture", "u_size", "u_half", "u_photoHalf", "u_uvScale", "u_shell", "u_bevel",
  "u_thick", "u_bow", "u_wob", "u_ior", "u_seed", "u_tilt", "u_side",
];

export function CaseGlassWebGL({ enabled, imageSrc, seed = 0, registerDraw }: CaseGlassWebGLProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"pending" | "ready" | "fallback">("pending");
  const registerRef = useRef(registerDraw);
  registerRef.current = registerDraw;

  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (enabled) setArmed(true);
  }, [enabled]);

  useEffect(() => {
    if (!armed || !imageSrc) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const slab = host.parentElement;
    if (!slab) return;

    const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      nav.connection?.saveData === true ||
      (nav.deviceMemory !== undefined && nav.deviceMemory <= 2)
    ) {
      setStatus("fallback");
      return;
    }

    let gl: WebGLRenderingContext;
    try {
      const context = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
      }) ?? (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
      if (!context) throw new Error("WebGL unavailable");
      gl = context;
    } catch {
      setStatus("fallback");
      return;
    }

    let disposed = false;
    let textured = false;
    let program: WebGLProgram | null = null;
    let texture: WebGLTexture | null = null;
    let buffer: WebGLBuffer | null = null;
    let uniforms: Record<string, WebGLUniformLocation | null> = {};
    let imageAspect = 1;
    let lastTilt = Number.NaN;

    const fail = () => {
      if (!disposed) setStatus("fallback");
    };

    const draw = (tiltDeg = lastTilt) => {
      if (disposed || !program || !textured) return;
      const tilt = Number.isFinite(tiltDeg) ? tiltDeg : 0;
      lastTilt = tilt;

      const w = host.offsetWidth;
      const h = host.offsetHeight;
      const cardW = slab.offsetWidth;
      const cardH = slab.offsetHeight;
      if (w < 2 || h < 2 || cardW < 2 || cardH < 2) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      gl.viewport(0, 0, pw, ph);

      const inset = cardW * (BOW + WOBBLE);
      const halfX = cardW * 0.5 - inset;
      const halfY = cardH * 0.5 - inset;
      const photoX = halfX - cardW * SHELL;
      const photoY = halfY - cardW * SHELL;
      const boxAspect = photoX / Math.max(photoY, 1);
      const cover = boxAspect > imageAspect
        ? [1, imageAspect / boxAspect]
        : [boxAspect / imageAspect, 1];

      const tiltRad = (tilt * Math.PI) / 180;
      const sideMag = Math.min(Math.abs(Math.tan(tiltRad)) * THICK, MARGIN * 0.86) * cardW;

      gl.useProgram(program);
      gl.uniform2f(uniforms.u_size!, w, h);
      gl.uniform2f(uniforms.u_half!, halfX, halfY);
      gl.uniform2f(uniforms.u_photoHalf!, photoX, photoY);
      gl.uniform2f(uniforms.u_uvScale!, cover[0], cover[1]);
      gl.uniform1f(uniforms.u_shell!, cardW * SHELL);
      gl.uniform1f(uniforms.u_bevel!, cardW * BEVEL);
      gl.uniform1f(uniforms.u_thick!, cardW * THICK);
      gl.uniform1f(uniforms.u_bow!, cardW * BOW);
      gl.uniform1f(uniforms.u_wob!, cardW * WOBBLE);
      gl.uniform1f(uniforms.u_ior!, IOR);
      gl.uniform1f(uniforms.u_seed!, seed);
      gl.uniform1f(uniforms.u_tilt!, tiltRad);
      gl.uniform1f(uniforms.u_side!, tiltRad > 0 ? -sideMag : sideMag);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniforms.u_texture!, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    try {
      program = createProgram(gl);
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } catch {
      fail();
      return;
    }

    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (disposed) return;
      try {
        imageAspect = image.naturalWidth / Math.max(image.naturalHeight, 1);
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        textured = true;
        draw(0);
        setStatus("ready");
        slab.dataset.glass = "on";
      } catch {
        fail();
      }
    };
    image.onerror = fail;
    image.src = textureUrl(imageSrc);

    const onLost = (event: Event) => {
      event.preventDefault();
      textured = false;
      fail();
    };
    canvas.addEventListener("webglcontextlost", onLost, false);

    const observer = new ResizeObserver(() => draw());
    observer.observe(host);
    registerRef.current?.(draw);

    return () => {
      disposed = true;
      delete slab.dataset.glass;
      registerRef.current?.(null);
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      if (texture) gl.deleteTexture(texture);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      uniforms = {};
    };
  }, [armed, imageSrc, seed]);

  return (
    <div
      ref={hostRef}
      className="case-glass-webgl"
      data-ready={status === "ready" ? "true" : status === "fallback" ? "false" : "pending"}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
      <div className="case-glass-webgl-fallback" />
    </div>
  );
}
