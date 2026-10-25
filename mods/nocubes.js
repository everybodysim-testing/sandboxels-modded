// nocubes.js v2 — "no pixels ever" renderer for Sandboxels (WebGL2)
//
// Every frame the game draws its normal pixels, then this mod:
//   1. copies that canvas to the GPU (so heat glow / textures / presets keep their colors),
//   2. rebuilds the whole picture with shaders and paints it back over the canvas.
//
// SOLIDS / LIQUIDS / POWDERS
//   - Silhouette = a gaussian-blurred occupancy field thresholded at 0.5, sampled with a
//     bicubic B-spline. That gives true smooth curves at ANY angle (not 0/45/90 steps).
//     Three blur scales are blended: thin features (1-2 cells) stay small and round,
//     big bodies get long smooth curves.
//   - Material seams use a local per-material weight vote, so two materials never mix
//     colors into mud, and the seam itself is anti-aliased.
//   - Colors are smoothed per material (same-material neighbors only), so grainy/noisy
//     textures become soft gradients — no visible cells inside shapes either.
//   - Pixels touching the world edge stay flush with it.
// GASES / FIRE / PLASMA / GLOW / CHARGE
//   - Rendered as a density field with animated fractal noise, soft top-left lighting,
//     and an emissive path for fire/plasma/charge. Nearby gas pixels merge into one cloud.
//
// This mod is VISUAL ONLY: it never changes elements, renderers, pixels or behaviors.
// It only reads currentPixels and draws on the pixel layer. Load it LAST in your mod list
// (it repaints the whole pixel layer, so anything another post-pixel mod drew there is replaced).
//
// Console: noCubes.enabled = false   -> back to vanilla squares instantly.
// Needs WebGL2. Thermal/other special views are left untouched.

(function () {
	"use strict";

	if (typeof renderPostPixel !== "function" || typeof currentPixels === "undefined" || typeof elements !== "object") {
		console.warn("nocubes.js: game runtime not found — mod not loaded.");
		return;
	}

	// ---- Tuning (cell units unless noted) ---------------------------------
	var CFG = {
		sigmaFine: 0.8,      // outline smoothing for the most rigid materials
		sigmaSmooth: 1.6,    // outline smoothing for medium materials
		sigmaBulk: 2.6,      // outline smoothing for the softest materials (sand, water...)
		thinBoost: 0.15,     // keeps lone grains visible
		colorSigma: 0.35,    // color averaging between neighbors (keep low: textures stay crisp)
		grain: 0.3,          // extra sub-cell sparkle on smooth materials
		structuredLevel: 0.1, // smoothing for rigid things (wood, metal, plants, walls); 0 = pixel exact, 1 = fully smooth
		smoothOverrides: {},  // per-element override, e.g. { sand: 1, wood: 0, water: 1 }
		circleRadius: 0.42,  // invisible minimum circle around every pixel (cells): how small the outline may ever get around a pixel
		looseGrow: 0.06,     // free-falling grains are drawn this much bigger than the circle
		seamSigma: 1.0,      // smoothness of boundaries between two materials
		cloudSigma: 1.3,     // size of one gas pixel's puff
		cloudOpacity: 0.55,  // base opacity of one gas pixel
		cloudNoise: 0.5,     // 0 = smooth blobs, 1 = very wispy
		cloudScale: 0.62     // noise feature size (higher = finer detail)
	};
	var DSCALE = 6.0;        // cloud density is stored /6 in 8 bits

	var API = window.noCubes = { enabled: true };

	// ---- GL setup ---------------------------------------------------------
	var glc = document.createElement("canvas");
	var gl = glc.getContext("webgl2", {
		alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
		stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance"
	});
	if (!gl) {
		console.warn("nocubes.js: WebGL2 not available — mod not loaded.");
		return;
	}
	var FLOAT_OK = !!gl.getExtension("EXT_color_buffer_float");
	if (!FLOAT_OK) console.warn("nocubes.js: float render targets unavailable — outlines will be lower quality.");
	var ready = false;
	var P = {}, T = {}, FB = {};
	var gameTex = null;
	var prof = null, idLevel = new Uint8Array(32768), cand = null, cellW = 0, cellH = 0, ids = null, cloudArr = null, cloudDirty = false;

	function F(x) { var s = String(x); return /[.e]/.test(s) ? s : s + ".0"; }

	var HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp usampler2D;\n";
	var VS = "#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }";

	var RB = Math.ceil(3 * CFG.sigmaBulk);
	var LOOSE = 32768; // id flag: pixel is a free-falling grain, drawn as its own round dot
	var SIGV = "vec4(" + F(CFG.sigmaFine) + "," + F(CFG.sigmaSmooth) + "," + F(CFG.sigmaBulk) + "," + F(CFG.sigmaSmooth) + ")";

	// Pass 1: horizontal blur of "is there matter here" at three scales, plus the
	// smoothing level of that matter (4th channel), at cell resolution
	var FS_OCC_H = HEAD + [
		"uniform usampler2D uId; uniform sampler2D uProf; uniform ivec2 uN; out vec4 o;",
		"const vec4 SIG = " + SIGV + ";",
		"const int R = " + RB + ";",
		"void main(){",
		"  ivec2 c = ivec2(gl_FragCoord.xy);",
		"  vec4 acc = vec4(0.0), ws = vec4(0.0);",
		"  for (int k = -R; k <= R; k++) {",
		"    int x = clamp(c.x + k, 0, uN.x - 1);",   // clamp = edge replicate => flush with world edge
		"    uint r = texelFetch(uId, ivec2(x, c.y), 0).r;",
		"    float v = (r > 0u && r < 32768u) ? 1.0 : 0.0;",
		"    float lv = texelFetch(uProf, ivec2(x, c.y), 0).r;",
		"    vec4 w = exp(-float(k*k) / (2.0*SIG*SIG));",
		"    acc += vec4(v, v, v, v*lv) * w; ws += w;",
		"  }",
		"  o = acc / ws;",
		"}"
	].join("\n");

	// Pass 2: vertical blur
	var FS_OCC_V = HEAD + [
		"uniform sampler2D uTmp; uniform ivec2 uN; out vec4 o;",
		"const vec4 SIG = " + SIGV + ";",
		"const int R = " + RB + ";",
		"void main(){",
		"  ivec2 c = ivec2(gl_FragCoord.xy);",
		"  vec4 acc = vec4(0.0), ws = vec4(0.0);",
		"  for (int k = -R; k <= R; k++) {",
		"    int y = clamp(c.y + k, 0, uN.y - 1);",
		"    vec4 v = texelFetch(uTmp, ivec2(c.x, y), 0);",
		"    vec4 w = exp(-float(k*k) / (2.0*SIG*SIG));",
		"    acc += v*w; ws += w;",
		"  }",
		"  o = acc / ws;",
		"}"
	].join("\n");

	// Pass 3: per-cell color, averaged over same-material neighbors only (cell resolution)
	var CR = Math.ceil(2 * CFG.colorSigma);
	var FS_COL = HEAD + [
		"uniform usampler2D uId; uniform sampler2D uGame; uniform ivec2 uN; uniform float uPS; out vec4 o;",
		"const float SC = " + F(CFG.colorSigma) + ";",
		"const int CR = " + CR + ";",
		"void main(){",
		"  ivec2 c = ivec2(gl_FragCoord.xy);",
		"  uint id = texelFetch(uId, c, 0).r;",
		"  if (id == 0u || id >= 32768u) { o = vec4(0.0); return; }",
		"  vec4 sA = vec4(0.0); float wA = 0.0; vec4 sB = vec4(0.0);",
		"  for (int dy = -CR; dy <= CR; dy++) {",
		"    for (int dx = -CR; dx <= CR; dx++) {",
		"      ivec2 q = c + ivec2(dx, dy);",
		"      if (q.x < 0 || q.y < 0 || q.x >= uN.x || q.y >= uN.y) continue;",
		"      uint qi = texelFetch(uId, q, 0).r;",
		"      if (qi == 0u || qi >= 32768u) continue;",
		"      vec4 g = texelFetch(uGame, ivec2((vec2(q) + 0.5) * uPS), 0);",
		"      if (g.a < 0.04) continue;",
		"      float w = exp(-float(dx*dx + dy*dy) / (2.0*SC*SC));",
		"      vec4 pm = vec4(g.rgb * g.a, g.a) * w;",
		"      sB += pm;",
		"      if (qi == id) { sA += pm; wA += w; }",
		"    }",
		"  }",
		"  if (sA.a > 1e-4) o = vec4(sA.rgb / sA.a, clamp(sA.a / wA, 0.0, 1.0));",
		"  else if (sB.a > 1e-4) o = vec4(sB.rgb / sB.a, 1.0);",
		"  else o = vec4(0.5, 0.5, 0.5, 1.0);",
		"}"
	].join("\n");

	// Cloud passes (cell resolution)
	var CLR = Math.ceil(2.4 * CFG.cloudSigma);
	var CLOUD_DEC = [
		"float a = floor(t.a * 255.0 + 0.5);",
		"float em = a >= 128.0 ? 1.0 : 0.0;",
		"float amp = (a - 128.0 * em) / 127.0;"
	].join("\n");
	var FS_CLOUD_D = HEAD + [
		"uniform sampler2D uCloud; uniform ivec2 uN; out vec4 o;",
		"const float SG = " + F(CFG.cloudSigma) + ";",
		"const int CL = " + CLR + ";",
		"void main(){",
		"  ivec2 c = ivec2(gl_FragCoord.xy);",
		"  float d = 0.0, e = 0.0;",
		"  for (int dy = -CL; dy <= CL; dy++) {",
		"    for (int dx = -CL; dx <= CL; dx++) {",
		"      ivec2 q = c + ivec2(dx, dy);",
		"      if (q.x < 0 || q.y < 0 || q.x >= uN.x || q.y >= uN.y) continue;",
		"      vec4 t = texelFetch(uCloud, q, 0);",
		CLOUD_DEC,
		"      if (amp <= 0.0) continue;",
		"      float w = exp(-float(dx*dx + dy*dy) / (2.0*SG*SG)) * amp;",
		"      d += w; e += w * em;",
		"    }",
		"  }",
		"  o = vec4(d / " + F(DSCALE) + ", e / " + F(DSCALE) + ", 0.0, 1.0);",
		"}"
	].join("\n");
	var FS_CLOUD_C = HEAD + [
		"uniform sampler2D uCloud; uniform ivec2 uN; out vec4 o;",
		"const float SG = " + F(CFG.cloudSigma) + ";",
		"const int CL = " + CLR + ";",
		"void main(){",
		"  ivec2 c = ivec2(gl_FragCoord.xy);",
		"  vec3 s = vec3(0.0); float w0 = 0.0;",
		"  for (int dy = -CL; dy <= CL; dy++) {",
		"    for (int dx = -CL; dx <= CL; dx++) {",
		"      ivec2 q = c + ivec2(dx, dy);",
		"      if (q.x < 0 || q.y < 0 || q.x >= uN.x || q.y >= uN.y) continue;",
		"      vec4 t = texelFetch(uCloud, q, 0);",
		CLOUD_DEC,
		"      if (amp <= 0.0) continue;",
		"      float w = exp(-float(dx*dx + dy*dy) / (2.0*SG*SG)) * amp;",
		"      s += w * t.rgb; w0 += w;",
		"    }",
		"  }",
		"  o = vec4(w0 > 0.0 ? s / w0 : vec3(0.0), 1.0);",
		"}"
	].join("\n");

	// Shared: bicubic B-spline sampling (4 bilinear taps) => C2-smooth contours, no cell-grid kinks
	var GLSL_CUBIC = [
		// bicubic B-spline via 4 bilinear taps: C2-smooth contours, no cell-grid kinks
		"vec4 cubicSample(sampler2D t, vec2 p, vec2 N){",
		"  vec2 c = p - 0.5; vec2 i = floor(c); vec2 f = c - i;",
		"  vec2 f2 = f*f, f3 = f2*f;",
		"  vec2 w0 = (1.0-f)*(1.0-f)*(1.0-f)/6.0;",
		"  vec2 w1 = (3.0*f3 - 6.0*f2 + 4.0)/6.0;",
		"  vec2 w2 = (-3.0*f3 + 3.0*f2 + 3.0*f + 1.0)/6.0;",
		"  vec2 w3 = f3/6.0;",
		"  vec2 g0 = w0 + w1, g1 = w2 + w3;",
		"  vec2 h0 = w1/g0 - 1.0, h1 = w3/g1 + 1.0;",
		"  vec2 t0 = (i + h0 + 0.5)/N, t1 = (i + h1 + 0.5)/N;",
		"  return g0.y * (g0.x * textureLod(t, vec2(t0.x, t0.y), 0.0) + g1.x * textureLod(t, vec2(t1.x, t0.y), 0.0))",
		"       + g1.y * (g0.x * textureLod(t, vec2(t0.x, t1.y), 0.0) + g1.x * textureLod(t, vec2(t1.x, t1.y), 0.0));",
		"}",
		""
	].join("\n");

	// Final pass: full-resolution composite
	var FS_FINAL = HEAD + [
		"uniform usampler2D uId;",
		"uniform sampler2D uField, uCol, uCD, uCC, uGame;",
		"uniform ivec2 uN;",
		"uniform float uPS, uCanvasH, uTime;",
		"uniform int uCloudOn;",
		"out vec4 outColor;",
		"const float THIN = " + F(CFG.thinBoost) + ";",
		"const float SS = " + F(CFG.seamSigma) + ";",
		"const float NOISE = " + F(CFG.cloudNoise) + ";",
		"const float NSCALE = " + F(CFG.cloudScale) + ";",
		"const float DSC = " + F(DSCALE) + ";",
		"const float GRAIN = " + F(CFG.grain) + ";",
		"const float RHO = " + F(CFG.circleRadius) + ";",
		"const float LG = " + F(CFG.looseGrow) + ";",
		"float gContrast = 0.0;",
		"uint idAt(ivec2 q){ uint r = texelFetch(uId, q, 0).r; return r >= 32768u ? 0u : r; }",
		"",
		"float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }",
		"float vnoise(vec2 p){",
		"  vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);",
		"  float a = hash(i), b = hash(i + vec2(1.0,0.0)), c = hash(i + vec2(0.0,1.0)), d = hash(i + vec2(1.0,1.0));",
		"  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);",
		"}",
		"float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p*2.03 + vec2(17.1, 9.7); a *= 0.5; } return s / 0.875; }",
		"",
		GLSL_CUBIC,
		"",
		// smoothed color of material `id` at p, bilinear over the 4 nearest cells of that material
		"vec4 colFor(uint id, vec2 p, float soft){",
		"  gContrast = 0.0;",
		"  vec2 q = p - 0.5; ivec2 b = ivec2(floor(q)); vec2 f = q - floor(q);",
		"  vec2 fs = vec2(smoothstep(0.5 - soft, 0.5 + soft, f.x), smoothstep(0.5 - soft, 0.5 + soft, f.y));",
		"  vec4 acc = vec4(0.0); float ws = 0.0; float lmin = 1.0, lmax = 0.0;",
		"  for (int k = 0; k < 4; k++) {",
		"    int dx = k & 1, dy = k >> 1;",
		"    ivec2 cc = clamp(b + ivec2(dx, dy), ivec2(0), uN - ivec2(1));",
		"    if (idAt(cc) != id) continue;",
		"    float w = (dx == 0 ? 1.0 - fs.x : fs.x) * (dy == 0 ? 1.0 - fs.y : fs.y);",
		"    vec4 cv = texelFetch(uCol, cc, 0);",
		"    float l = dot(cv.rgb, vec3(0.299, 0.587, 0.114));",
		"    lmin = min(lmin, l); lmax = max(lmax, l);",
		"    acc += w * cv; ws += w;",
		"  }",
		"  if (ws > 1e-3) { gContrast = max(lmax - lmin, 0.0); return acc / ws; }",
		"  ivec2 c0 = ivec2(floor(p)); float bd = 1e9; vec4 r = vec4(0.5, 0.5, 0.5, 1.0);",
		"  for (int dy = -2; dy <= 2; dy++) {",
		"    for (int dx = -2; dx <= 2; dx++) {",
		"      ivec2 cc = clamp(c0 + ivec2(dx, dy), ivec2(0), uN - ivec2(1));",
		"      if (idAt(cc) != id) continue;",
		"      float d = distance(vec2(cc) + 0.5, p);",
		"      if (d < bd) { bd = d; r = texelFetch(uCol, cc, 0); }",
		"    }",
		"  }",
		"  return r;",
		"}",
		"",
		// outline field: every material gets a smooth blur; rigid ones a light one, soft ones a heavy one
		"float levelField(vec4 Fd){",
		"  float lvl = clamp(Fd.w / max(Fd.y, 0.02), 0.0, 1.0);",
		"  float a = clamp(lvl * 2.0, 0.0, 1.0), b = clamp(lvl * 2.0 - 1.0, 0.0, 1.0);",
		"  return mix(mix(Fd.x, Fd.y, a), Fd.z, b);",
		"}",
		"float shapeG(vec2 p){",
		"  vec2 N = vec2(uN);",
		"  return levelField(cubicSample(uField, clamp(p, vec2(0.0), N - 0.001), N));",
		"}",
		"float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h*h*k*0.25; }",
		"",
		"void main(){",
		"  vec2 N = vec2(uN);",
		"  vec2 p = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y) / uPS;",
		"  float inside = (p.x < N.x && p.y < N.y) ? 1.0 : 0.0;",
		"  vec2 pc = clamp(p, vec2(0.0), N - 0.001);",
		// silhouette = ONE smooth contour (blurred occupancy -> distance-like field) for everything.
		// The per-pixel circle is only a floor: it is smooth-unioned in so the line can never
		// shrink below it, but it is never the shape itself.
		"  vec4 Fd = cubicSample(uField, pc, N);",
		"  float lvl = clamp(Fd.w / max(Fd.y, 0.02), 0.0, 1.0);",
		"  float G = levelField(Fd);",
		"  float onePx = 1.0 / uPS;",
		"  float t = 0.0;",
		"  ivec2 c = clamp(ivec2(floor(pc)), ivec2(0), uN - ivec2(1));",
		"  uint nb[9] = uint[9](0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);",
		"  bool nearM = (Fd.x > 0.004) || (Fd.y > 0.02);",
		"  uint c0 = 0u; bool uni = false;",
		"  if (nearM) {",
		"    c0 = idAt(c); uni = (c0 != 0u);",
		"    for (int k = 0; k < 9; k++) {",
		"      nb[k] = idAt(clamp(c + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), uN - ivec2(1)));",
		"      if (nb[k] != c0) uni = false;",
		"    }",
		// signed distance (cells, + outside) of the smooth contour, from the field gradient
		"    float e = 0.35;",
		"    float gx = shapeG(pc + vec2(e, 0.0)) - shapeG(pc - vec2(e, 0.0));",
		"    float gy = shapeG(pc + vec2(0.0, e)) - shapeG(pc - vec2(0.0, e));",
		"    float gl = length(vec2(gx, gy)) / (2.0 * e);",
		"    float dS = clamp((0.5 - G) / max(gl, 0.03), -2.0, 2.0);",
		// minimum size: nearest pixel circle (rigid materials: the pixel square)
		"    float dprot = 9.0;",
		"    for (int k = 0; k < 9; k++) {",
		"      if (nb[k] == 0u) continue;",
		"      vec2 u = abs(pc - (vec2(c + ivec2(k % 3 - 1, k / 3 - 1)) + 0.5));",
		"      float sdB = length(max(u - 0.46, 0.0)) - 0.04;",
		"      float sdC = length(u) - RHO;",
		"      dprot = min(dprot, mix(sdB, sdC, lvl));",
		"    }",
		"    float d = smin(dS, dprot, mix(0.06, 0.3, lvl));",
		"    t = clamp(0.5 - d / onePx, 0.0, 1.0);",
		"    t = t*t*(3.0 - 2.0*t);",
		"  }",
		"  vec4 res = vec4(0.0);",
		"  if (t > 0.0) {",
		"    float soft = mix(0.03, 0.2, lvl);",
		"    float warp = mix(0.0, 0.3, lvl);",
		"    float ss = mix(0.4, SS, lvl);",
		"    vec2 pw = pc + warp * (vec2(vnoise(p * 1.9), vnoise(p * 1.9 + 7.7)) - 0.5) * 2.0;",
		"    pw = clamp(pw, vec2(0.0), N - 0.001);",
		"    vec4 col = vec4(0.0);",
		"    if (uni) {",
		"      col = colFor(c0, pw, soft);",
		"    } else {",
		"      uint mids[4] = uint[4](0u, 0u, 0u, 0u);",
		"      float ws[4] = float[4](0.0, 0.0, 0.0, 0.0);",
		"      int n = 0;",
		"      for (int dy = -2; dy <= 2; dy++) {",
		"        for (int dx = -2; dx <= 2; dx++) {",
		"          ivec2 q = clamp(c + ivec2(dx, dy), ivec2(0), uN - ivec2(1));",
		"          uint qi = idAt(q);",
		"          if (qi == 0u) continue;",
		"          vec2 d = vec2(q) + 0.5 - pc;",
		"          float w = exp(-dot(d, d) / (2.0*ss*ss));",
		"          bool placed = false;",
		"          for (int k = 0; k < 4; k++) { if (k < n && mids[k] == qi) { ws[k] += w; placed = true; } }",
		"          if (!placed && n < 4) { mids[n] = qi; ws[n] = w; n++; }",
		"        }",
		"      }",
		"      if (n > 0) {",
		"        int i1 = 0;",
		"        for (int k = 1; k < 4; k++) { if (k < n && ws[k] > ws[i1]) i1 = k; }",
		"        int i2 = -1; float w2 = 0.0;",
		"        for (int k = 0; k < 4; k++) { if (k < n && k != i1 && ws[k] > w2) { w2 = ws[k]; i2 = k; } }",
		"        col = colFor(mids[i1], pw, soft);",
		"        if (i2 >= 0) {",
		"          vec4 cb = colFor(mids[i2], pw, soft);",
		"          float mn = (ws[i1] - w2) / (ws[i1] + w2);",
		"          float kk = max(0.9 / uPS, 0.03);",
		"          col = mix(cb, col, smoothstep(-kk, kk, mn));",
		"        }",
		"      }",
		"    }",
		"    float gn = vnoise(p * 2.2) * 0.6 + vnoise(p * 5.1 + 3.7) * 0.4;",
		"    col.rgb = clamp(col.rgb + (gn - 0.5) * 2.0 * gContrast * GRAIN * lvl, 0.0, 1.0);",
		"    res = vec4(col.rgb * col.a, col.a) * t;",
		"  }",
		// free-falling grains / droplets: stable round dots in their own raw color
		"  {",
		"    ivec2 lc = ivec2(floor(pc));",
		"    float onePx = 1.0 / uPS;",
		"    for (int dy = -1; dy <= 1; dy++) {",
		"      for (int dx = -1; dx <= 1; dx++) {",
		"        ivec2 q = lc + ivec2(dx, dy);",
		"        if (q.x < 0 || q.y < 0 || q.x >= uN.x || q.y >= uN.y) continue;",
		"        if (texelFetch(uId, q, 0).r < 32768u) continue;",
		"        float sdl = length(pc - (vec2(q) + 0.5)) - (RHO + LG);",
		"        float cov = clamp(0.5 - sdl / onePx, 0.0, 1.0);",
		"        if (cov <= 0.0) continue;",
		"        cov = cov*cov*(3.0 - 2.0*cov);",
		"        vec4 g = texelFetch(uGame, ivec2((vec2(q) + 0.5) * uPS), 0);",
		"        vec3 gc = g.a < 0.04 ? vec3(0.7) : g.rgb;",
		"        float ga = g.a < 0.04 ? 1.0 : g.a;",
		"        vec4 pm = vec4(gc * ga, ga) * cov;",
		"        res = pm + res * (1.0 - pm.a);",
		"      }",
		"    }",
		"  }",
		// clouds: gas / fire / plasma / glow / charge
		"  if (uCloudOn == 1) {",
		"    vec4 dE = cubicSample(uCD, pc, N);",
		"    float D = dE.r * DSC, E = dE.g * DSC;",
		"    if (D > 0.004) {",
		"      vec2 np = vec2(p.x, p.y + uTime * 0.6) * NSCALE;",
		"      float n1 = fbm(np);",
		"      float n2 = fbm(np * 1.9 + vec2(7.3, 3.1 - uTime * 0.25));",
		"      float dn = D * (1.0 - NOISE + NOISE * 2.0 * n1);",
		"      float dd = max(dn - 0.04, 0.0);",
		"      float a = min(1.0 - exp(-dd * 1.8), 0.96);",
		"      vec2 e1 = vec2(0.9, 0.0);",
		"      float gx = textureLod(uCD, (pc + e1) / N, 0.0).r - textureLod(uCD, (pc - e1) / N, 0.0).r;",
		"      float gy = textureLod(uCD, (pc + e1.yx) / N, 0.0).r - textureLod(uCD, (pc - e1.yx) / N, 0.0).r;",
		"      vec2 gr = vec2(gx, gy) * DSC;",
		"      float lit = clamp(dot(-gr, vec2(-0.45, -0.9)) * 1.5, -1.0, 1.0);",
		"      vec3 base = textureLod(uCC, pc / N, 0.0).rgb;",
		"      vec3 gasC = clamp(base * (0.88 + 0.2*n2) * (0.9 + 0.18*lit) + vec3(0.06) * max(lit, 0.0), 0.0, 1.0);",
		"      float em = clamp(E / max(D, 1e-3), 0.0, 1.0);",
		"      vec3 fireC = clamp(mix(base * (1.1 + 0.35*n2), vec3(1.0, 0.94, 0.78), clamp(dd * 0.25, 0.0, 0.4)), 0.0, 1.0);",
		"      float aE = a * 0.85;",
		"      float pa = mix(a, aE, em);",
		"      vec3 pcol = mix(gasC * a, fireC * aE, em);",
		"      res = vec4(pcol, pa) + res * (1.0 - pa);",
		"    }",
		"  }",
		"  outColor = res * inside;",
		"}"
	].join("\n");

	// ---- GL helpers -------------------------------------------------------
	function compile(type, src) {
		var s = gl.createShader(type);
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			throw new Error("shader: " + gl.getShaderInfoLog(s));
		}
		return s;
	}
	function program(fs) {
		var p = gl.createProgram();
		gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
		gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
		p.u = {};
		return p;
	}
	function U(p, name) {
		var l = p.u[name];
		if (l === undefined) { l = gl.getUniformLocation(p, name); p.u[name] = l; }
		return l;
	}
	function mkTex(w, h, internal, format, type, filter) {
		var t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		if (w > 0) gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
		return t;
	}
	function mkFTex(w, h, filter) {
		return FLOAT_OK ? mkTex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filter)
		                : mkTex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, filter);
	}
	function mkFbo(tex) {
		var f = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, f);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		return f;
	}
	function freeCells() {
		for (var k in T) if (T[k]) gl.deleteTexture(T[k]);
		for (var k2 in FB) if (FB[k2]) gl.deleteFramebuffer(FB[k2]);
		T = {}; FB = {};
	}
	function allocCells(W, H) {
		freeCells();
		cellW = W; cellH = H;
		T.id = mkTex(W, H, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, gl.NEAREST);
		T.prof = mkTex(W, H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST);
		T.cloud = mkTex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
		T.tmp = mkFTex(W, H, gl.NEAREST);
		T.field = mkFTex(W, H, gl.LINEAR);
		T.col = mkTex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
		T.cd = mkTex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
		T.cc = mkTex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
		FB.tmp = mkFbo(T.tmp); FB.field = mkFbo(T.field); FB.col = mkFbo(T.col);
		FB.cd = mkFbo(T.cd); FB.cc = mkFbo(T.cc);
		ids = new Uint16Array(W * H);
		cand = new Int32Array(W * H);
		prof = new Uint8Array(W * H);
		cloudArr = new Uint8Array(W * H * 4);
		cloudDirty = false;
	}
	function buildGL() {
		P.occH = program(FS_OCC_H);
		P.occV = program(FS_OCC_V);
		P.col = program(FS_COL);
		P.cloudD = program(FS_CLOUD_D);
		P.cloudC = program(FS_CLOUD_C);
		P.final = program(FS_FINAL);
		gameTex = mkTex(0, 0, 0, 0, 0, gl.NEAREST);
		cellW = 0; cellH = 0; T = {}; FB = {};
		ready = true;
	}
	function pass(prog, fbo, w, h, texs, setU) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, w, h);
		gl.useProgram(prog);
		for (var i = 0; i < texs.length; i++) {
			gl.activeTexture(gl.TEXTURE0 + i);
			gl.bindTexture(gl.TEXTURE_2D, texs[i][1]);
			gl.uniform1i(U(prog, texs[i][0]), i);
		}
		gl.uniform2i(U(prog, "uN"), cellW, cellH);
		if (setU) setU(prog);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	try { buildGL(); }
	catch (err) { console.error("nocubes.js: GL init failed —", err); return; }

	glc.addEventListener("webglcontextlost", function (e) { e.preventDefault(); ready = false; });
	glc.addEventListener("webglcontextrestored", function () {
		try { buildGL(); } catch (err) { console.error("nocubes.js: GL restore failed —", err); }
	});

	// ---- Color parsing (cached; only gas/halo pixels need it) -------------
	var colorCache = new Map();
	function c255(v) { v = Math.round(v); return v < 0 ? 0 : (v > 255 ? 255 : v); }
	function hslInt(h, s, l) {
		h = (((h % 360) + 360) % 360) / 360; s /= 100; l /= 100;
		var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
		function f(t) {
			if (t < 0) t += 1; if (t > 1) t -= 1;
			return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
		}
		return (c255(f(h + 1 / 3) * 255) << 16) | (c255(f(h) * 255) << 8) | c255(f(h - 1 / 3) * 255);
	}
	function parseRGB(c) {
		if (Array.isArray(c)) c = c[0];
		if (typeof c !== "string") return 0xB4B4B4;
		var v = colorCache.get(c);
		if (v !== undefined) return v;
		v = 0xB4B4B4;
		var ch = c.charCodeAt(0);
		if (ch === 35) {
			var h = c.slice(1);
			if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
			if (h.length >= 6) { var n = parseInt(h.slice(0, 6), 16); if (!isNaN(n)) v = n; }
		} else {
			var m = c.match(/[\d.]+/g);
			if (m && m.length >= 3) {
				if (ch === 104) v = hslInt(+m[0], +m[1], +m[2]);
				else v = (c255(+m[0]) << 16) | (c255(+m[1]) << 8) | c255(+m[2]);
			}
		}
		if (colorCache.size > 4000) colorCache.clear();
		colorCache.set(c, v);
		return v;
	}

	// ---- Per-frame work ---------------------------------------------------
	var idMap = Object.create(null), nextId = 1;
	// How much a material may be smoothed: 1 = fluid/pile (sand, water...), 0 = rigid (wood, metal...)
	var RIGID_CATS = { solids: 1, life: 1, machines: 1, weapons: 1, food: 1, tools: 1 };
	var RIGID_NAMES = /wood|tree|leaf|plant|grass|vine|flower|bush|branch|root|brick|wall|glass|steel|iron|paper|wire|fiber|bone|cloth|metal|copper|gold|silver/;
	function levelFor(name, info) {
		var o = CFG.smoothOverrides[name];
		if (typeof o === "number") return o;
		var cat = info.category;
		var beh = info.behavior;
		var fluidBeh = typeof behaviors === "object" && beh && (beh === behaviors.POWDER || beh === behaviors.POWDER_OLD ||
			beh === behaviors.LIQUID || beh === behaviors.LIQUID_OLD || beh === behaviors.SUPERFLUID || beh === behaviors.MOLTEN);
		var fluid = info.state === "liquid" || info.isGas === true || info.movable === true || fluidBeh ||
			cat === "liquids" || cat === "powders";
		if (fluid) return 1;
		if (info.movable === false || RIGID_CATS[cat] || RIGID_NAMES.test(name)) return CFG.structuredLevel;
		return 0.5;
	}
	function idFor(name, info) {
		var v = idMap[name];
		if (v === undefined) {
			v = nextId < 32767 ? nextId++ : 32767;
			idMap[name] = v;
			idLevel[v] = Math.round(Math.max(0, Math.min(1, levelFor(name, info))) * 255);
		}
		return v;
	}

	var cloudCount = 0, gridW = 0;
	function putCloud(gi, color, amp, emissive) {
		var rgb = parseRGB(color), o = gi * 4;
		cloudArr[o] = (rgb >> 16) & 255;
		cloudArr[o + 1] = (rgb >> 8) & 255;
		cloudArr[o + 2] = rgb & 255;
		cloudArr[o + 3] = (emissive ? 128 : 0) + Math.round((amp > 1 ? 1 : amp) * 127);
		cloudCount++;
	}

	function smoothPost(ctx) {
		if (!ready || !API.enabled) return;
		if (view !== 1 && view !== 3) return;
		if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) return;
		var W = width + 1, H = height + 1, PS = pixelSize;
		if (!PS || PS < 2) return;
		var canvas = ctx.canvas, cw = canvas.width, ch = canvas.height;
		if (cw < W * PS || ch < H * PS) return; // mid-resize safety

		try {
			if (W !== cellW || H !== cellH) allocCells(W, H);
			if (glc.width !== cw || glc.height !== ch) { glc.width = cw; glc.height = ch; }

			// 1) classify pixels (one linear pass, typed-array writes only)
			ids.fill(0);
			if (cloudDirty) { cloudArr.fill(0); cloudDirty = false; }
			cloudCount = 0;
			var nCand = 0;
			var normalView = (view === 1);
			var texturesOn = (settings.textures !== 0);
			for (var i = 0; i < currentPixels.length; i++) {
				var pixel = currentPixels[i];
				if (!pixel || pixel.del === true) continue;
				var x = pixel.x, y = pixel.y;
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				var host = pixel;
				if (pixel.con && elements[host.element] && elements[host.element].canContain === true && elements[pixel.con.element]) pixel = pixel.con; // read-only
				var info = elements[pixel.element];
				if (!info) continue;
				if (pixel.alpha === 0 && (view === 3 || texturesOn)) continue;
				var gi = y * W + x;
				var cloudy = normalView && pixel.glow !== false && (info.isGas === true || info.category === "energy");
				if (cloudy) {
					var al = pixel.alpha === undefined ? 1 : pixel.alpha;
					if (info.category === "energy") putCloud(gi, pixel.color, 1, true);
					else putCloud(gi, pixel.color, CFG.cloudOpacity * al, false);
					cloudDirty = true;
					continue;
				}
				var idn = idFor(pixel.element, info);
				ids[gi] = idn;
				var lvb = idLevel[idn];
				prof[gi] = lvb;
				if (lvb >= 128) { // only soft materials can become free-falling grains
					cand[nCand++] = gi * 2 + ((info.movable === true || info.state === "liquid") ? 1 : 0);
				}
				if (normalView) { // soft halos replace the game's blocky charge / glow squares
					if (pixel.charge && !info.colorOn) { putCloud(gi, "rgb(255,255,0)", 0.9, true); cloudDirty = true; }
					else if (info.glow || pixel.glow) { putCloud(gi, pixel.color, 0.6, true); cloudDirty = true; }
				}
			}

			// 1b) free-falling grains/droplets (few neighbors) become stable round dots
			//     instead of merging into blobs that pop in and out as they move
			for (var ci = 0; ci < nCand; ci++) {
				var cg = cand[ci] >> 1, cm = cand[ci] & 1;
				var cx = cg % W, cy = (cg / W) | 0, cnt = 0;
				for (var oy = -1; oy <= 1; oy++) {
					var ny = cy + oy;
					if (ny < 0 || ny >= H) continue;
					for (var ox = -1; ox <= 1; ox++) {
						if (ox === 0 && oy === 0) continue;
						var nx = cx + ox;
						if (nx >= 0 && nx < W && ids[ny * W + nx] !== 0) cnt++;
					}
				}
				if (cnt <= (cm ? CFG.looseMax : 1)) ids[cg] |= LOOSE;
			}

			// 2) upload
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, T.id);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ids);
			gl.bindTexture(gl.TEXTURE_2D, T.prof);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, prof);
			gl.activeTexture(gl.TEXTURE0);
			if (cloudCount) {
				gl.bindTexture(gl.TEXTURE_2D, T.cloud);
				gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, cloudArr);
			}
			gl.bindTexture(gl.TEXTURE_2D, gameTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);

			// 3) cell-resolution passes (tiny: one fragment per cell)
			gl.disable(gl.BLEND);
			pass(P.occH, FB.tmp, W, H, [["uId", T.id], ["uProf", T.prof]]);
			pass(P.occV, FB.field, W, H, [["uTmp", T.tmp]]);
			pass(P.col, FB.col, W, H, [["uId", T.id], ["uGame", gameTex]], function (p) {
				gl.uniform1f(U(p, "uPS"), PS);
			});
			if (cloudCount) {
				pass(P.cloudD, FB.cd, W, H, [["uCloud", T.cloud]]);
				pass(P.cloudC, FB.cc, W, H, [["uCloud", T.cloud]]);
			}

			// 4) final full-resolution composite
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.clearColor(0, 0, 0, 0);
			gl.viewport(0, 0, cw, ch);
			gl.clear(gl.COLOR_BUFFER_BIT);
			pass(P.final, null, cw, ch,
				[["uId", T.id], ["uField", T.field], ["uCol", T.col], ["uCD", T.cd], ["uCC", T.cc], ["uGame", gameTex]],
				function (p) {
					gl.uniform1f(U(p, "uPS"), PS);
					gl.uniform1f(U(p, "uCanvasH"), ch);
					gl.uniform1f(U(p, "uTime"), (performance.now() * 0.001) % 3600);
					gl.uniform1i(U(p, "uCloudOn"), cloudCount ? 1 : 0);
				});

			// 5) replace the game's squares with the smooth render
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalAlpha = 1;
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, cw, ch);
			ctx.drawImage(glc, 0, 0);
			ctx.restore();
		} catch (err) {
			// Fail safe: leave the vanilla frame alone and stop trying.
			console.error("nocubes.js: render failed, falling back to vanilla —", err);
			ready = false;
		}
	}

	renderPostPixel(smoothPost);
	console.log("nocubes.js v2 loaded (WebGL2). Toggle with noCubes.enabled = false/true");
})();
