/* =====================================================================
 *  REAL FLUIDS  -  a Sandboxels mod
 *
 *  Every liquid pixel becomes a fluid PARTICLE and the whole body of liquid
 *  is advanced with an actual incompressible Navier-Stokes solver
 *  (FLIP/PIC hybrid on a MAC grid, the same family of method used in film VFX):
 *
 *    1. particle -> grid   : scatter particle velocities onto cell faces
 *    2. body forces        : gravity
 *    3. viscosity          : implicit diffusion (real cP values per liquid)
 *    4. pressure projection: solve  div( (1/rho) grad p ) = div(u)/dt
 *                            -> makes the flow incompressible, produces
 *                            hydrostatic pressure, levels connected vessels,
 *                            drives jets (Torricelli), waves, splashes...
 *    5. grid -> particle   : FLIP update (keeps momentum / inertia)
 *    6. advection          : particles move through the grid
 *
 *  Multi-liquid:  the pressure solve uses a per-cell density, so oil really
 *  floats, mercury sinks, hot water rises (water density anomaly at 4 C included).
 *  Free surface:  air has p = 0 plus a curvature (Laplace) pressure -> surface tension.
 *
 *  Console:  RealFluids.cfg  (tweak live)   RealFluids.disable() / .enable()
 * ===================================================================== */
(function () {
"use strict";

if (typeof window !== "undefined" && window.RealFluids) { console.warn("[RealFluids] already loaded"); return; }

const CFG = {
  enabled: true,
  gravity: 0.4,          // cells / tick^2
  substeps: 2,           // solver steps per game tick (higher = faster flow allowed, more CPU)
  iterations: 40,        // pressure solver sweeps per step (max)
  tolerance: 0.002,      // early-out residual
  omega: 1.6,            // SOR over-relaxation
  flip: 0.92,            // 1 = pure FLIP (lively), 0 = pure PIC (damped)
  tension: 1.5,          // surface tension strength
  viscosity: 1,          // global viscosity multiplier
  wallDrag: 1,           // friction against solids
  stratification: 6,     // extra buoyancy-instability seeding between stacked liquids
  convection: true       // temperature changes density
};

/* ---------------- real liquid data -------------------------------- */
const VISC = {   // dynamic viscosity, cP (water = 1)
  water: 1, salt_water: 1.1, dirty_water: 1.4, pool_water: 1, sugar_water: 1.9, seltzer: 1,
  alcohol: 1.2, vinegar: 1.2, acid: 1.3, bleach: 1.1, milk: 2, juice: 1.5, soda: 1.2,
  blood: 4, ink: 2, oil: 60, honey: 5000, syrup: 2000, slime: 300, glue: 500,
  mercury: 1.5, magma: 50000, lava: 50000, tar: 10000, gloop: 800
};
const TENSION = { // mN/m (water = 72)
  water: 72, salt_water: 75, dirty_water: 70, pool_water: 72, seltzer: 70, alcohol: 22,
  oil: 32, blood: 56, honey: 75, milk: 50, mercury: 485, acid: 50, vinegar: 45,
  soda: 45, juice: 60, magma: 350, lava: 350
};
const BETA = { alcohol: 1.1e-3, oil: 7e-4, mercury: 1.8e-4, acid: 5e-4 };   // thermal expansion 1/K
const WATERY = new Set(["water", "dirty_water", "pool_water", "seltzer"]);
const SKIP = new Set([]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const PROP_CACHE = {};
function props(name) {
  let p = PROP_CACHE[name];
  if (p) return p;
  const info = elements[name] || {};
  let cp = VISC[name];
  if (cp === undefined) {
    if (name.indexOf("molten_") === 0)
      cp = /glass|slag|rock|basalt|obsidian|plastic|rubber|sugar|candy|caramel|wax|tar|asphalt|amber|stone|concrete|brick/.test(name) ? 5000 : 8;
    else cp = typeof info.viscosity === "number" ? info.viscosity : 1;
  }
  let st = TENSION[name];
  if (st === undefined) st = name.indexOf("molten_") === 0 ? 500 : 45;
  p = { mu: clamp(1 + 2.5 * Math.log10(Math.max(1, cp)), 1, 12), st: st / 72,
        beta: BETA[name] !== undefined ? BETA[name] : 5e-4, watery: WATERY.has(name) };
  PROP_CACHE[name] = p;
  return p;
}
function tempFactor(pixel) {   // viscosity falls ~2.2 % per degree
  const t = pixel.temp === undefined ? 20 : pixel.temp;
  return clamp(Math.exp(-0.022 * (t - 20)), 0.25, 3);
}
function rho(pixel) {          // kg/m3, temperature dependent (drives convection)
  const d0 = elements[pixel.element].density || 1000;
  if (!CFG.convection) return d0;
  const pr = props(pixel.element);
  const t = pixel.temp === undefined ? 20 : pixel.temp;
  if (pr.watery) { const dt = clamp(t - 4, -30, 96); return d0 * (1 - 4.5e-6 * dt * dt); }
  return d0 * (1 - pr.beta * clamp(t - 20, -100, 300));
}

/* ---------------- grid storage ------------------------------------- */
let G = null;
function ensureGrid() {
  const w = width + 1, h = height + 1;
  if (G && G.w === w && G.h === h) return G;
  const n = w * h, nu = (w + 1) * h, nv = w * (h + 1);
  G = {
    w: w, h: h, n: n,
    type: new Uint8Array(n),        // 0 air, 1 liquid, 2 solid
    px: new Array(n),               // pixel at cell
    kOf: new Int32Array(n),         // cell -> compact liquid index
    Pc: new Float32Array(n),        // pressure memory (warm start)
    was: new Uint8Array(n),
    u: new Float32Array(nu), u0: new Float32Array(nu), uS: new Float32Array(nu), uC: new Uint8Array(nu), uV: new Uint8Array(nu),
    v: new Float32Array(nv), v0: new Float32Array(nv), vS: new Float32Array(nv), vC: new Uint8Array(nv), vV: new Uint8Array(nv),
    liq: new Int32Array(n), parts: new Array(n), order: new Int32Array(n),
    pk: new Float32Array(n), rhoK: new Float32Array(n), nuK: new Float32Array(n), sgK: new Float32Array(n),
    sbK: new Float32Array(n), rhs: new Float32Array(n),
    bw: new Float32Array(n * 4), nbk: new Int32Array(n * 4), gh: new Float32Array(n * 4)
  };
  return G;
}

// curvature (Laplace) pressure of an air cell next to liquid; solids count half (wetting)
function ghost(g, ax, ay, sigma) {
  const w = g.w, h = g.h, type = g.type;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = ax + dx, y = ay + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) { n += 0.5; continue; }
      const t = type[y * w + x];
      if (t === 1) n += 1; else if (t === 2) n += 0.5;
    }
  }
  return clamp(sigma * (3 - n) / 3, -sigma, sigma);
}

const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];

/* ---------------- one solver step ---------------------------------- */
function substep(dt) {
  const g = ensureGrid();
  const w = g.w, h = g.h, n = g.n, type = g.type, px = g.px, kOf = g.kOf;
  const u = g.u, v = g.v, u0 = g.u0, v0 = g.v0;
  const gdt = CFG.gravity * dt;

  /* classify cells */
  type.fill(0);
  const cp = currentPixels;
  for (let i = 0; i < cp.length; i++) {
    const p = cp[i];
    if (!p || p.del) continue;
    const info = elements[p.element];
    if (!info) continue;
    const idx = p.y * w + p.x;
    if (managed[p.element]) { type[idx] = 1; px[idx] = p; }
    else if (info.state !== "gas" && info.state !== "plasma") type[idx] = 2;
  }
  let nL = 0;
  const liq = g.liq;
  for (let idx = 0; idx < n; idx++) {
    if (type[idx] === 1) { liq[nL] = idx; kOf[idx] = nL; g.parts[nL] = px[idx]; nL++; } else kOf[idx] = -1;
  }
  if (nL === 0) { g.was.fill(0); return; }

  /* per-cell properties */
  const rhoK = g.rhoK, nuK = g.nuK, sgK = g.sgK;
  let maxNu = 0;
  for (let k = 0; k < nL; k++) {
    const p = g.parts[k];
    if (p.rvx === undefined) { p.rvx = 0; p.rvy = 0; p.rfx = 0; p.rfy = 0; }
    const pr = props(p.element);
    const mu = Math.max(0.25, pr.mu * tempFactor(p));
    rhoK[k] = rho(p) / 1000;
    nuK[k] = CFG.viscosity * 0.015 * mu * mu;
    if (nuK[k] > maxNu) maxNu = nuK[k];
    sgK[k] = CFG.tension * clamp(pr.st, 0.3, 4) * rhoK[k] * CFG.gravity;
  }

  /* 1. particle -> grid */
  g.uS.fill(0); g.uC.fill(0); g.vS.fill(0); g.vC.fill(0);
  g.u.fill(0); g.v.fill(0); g.uV.fill(0); g.vV.fill(0);
  const uS = g.uS, uC = g.uC, vS = g.vS, vC = g.vC, uV = g.uV, vV = g.vV;
  for (let k = 0; k < nL; k++) {
    const idx = liq[k], x = idx % w, y = (idx / w) | 0, p = g.parts[k];
    const fl = y * (w + 1) + x, fr = fl + 1, ft = y * w + x, fb = ft + w;
    uS[fl] += p.rvx; uC[fl]++; uS[fr] += p.rvx; uC[fr]++;
    vS[ft] += p.rvy; vC[ft]++; vS[fb] += p.rvy; vC[fb]++;
  }
  for (let k = 0; k < nL; k++) {
    const idx = liq[k], x = idx % w, y = (idx / w) | 0;
    const fl = y * (w + 1) + x, fr = fl + 1, ft = y * w + x, fb = ft + w;
    if (!(x === 0 || type[idx - 1] === 2)) { u[fl] = uS[fl] / uC[fl]; uV[fl] = 1; }
    if (!(x === w - 1 || type[idx + 1] === 2)) { u[fr] = uS[fr] / uC[fr]; uV[fr] = 1; }
    if (!(y === 0 || type[idx - w] === 2)) { v[ft] = vS[ft] / vC[ft]; vV[ft] = 1; }
    if (!(y === h - 1 || type[idx + w] === 2)) { v[fb] = vS[fb] / vC[fb]; vV[fb] = 1; }
  }
  u0.set(u); v0.set(v);

  /* 2. gravity */
  for (let k = 0; k < nL; k++) {
    const idx = liq[k], x = idx % w, y = (idx / w) | 0;
    const ft = y * w + x, fb = ft + w;
    if (vV[fb]) v[fb] += gdt;
    if (vV[ft] && type[idx - w] !== 1) v[ft] += gdt;
  }

  /* 3. viscosity (implicit diffusion of face velocities, a few Gauss-Seidel sweeps) */
  if (maxNu > 0.04) {
    for (let it = 0; it < 3; it++) {
      for (let k = 0; k < nL; k++) {
        const idx = liq[k], x = idx % w, y = (idx / w) | 0;
        const kc = nuK[k] * dt;
        if (kc < 0.02) continue;
        const fl = y * (w + 1) + x, fr = fl + 1, ft = y * w + x, fb = ft + w;
        for (let s = 0; s < 2; s++) {                     // u faces
          const f = s ? fr : fl;
          if (!uV[f]) continue;
          let sum = 0, c = 0;
          if (x + s > 0 && uV[f - 1]) { sum += u[f - 1]; c++; }
          if (x + s < w && uV[f + 1]) { sum += u[f + 1]; c++; }
          if (y > 0 && uV[f - (w + 1)]) { sum += u[f - (w + 1)]; c++; }
          if (y < h - 1 && uV[f + (w + 1)]) { sum += u[f + (w + 1)]; c++; }
          u[f] = (u0[f] * 0 + u[f] + kc * sum) / (1 + kc * c);
        }
        for (let s = 0; s < 2; s++) {                     // v faces
          const f = s ? fb : ft;
          if (!vV[f]) continue;
          let sum = 0, c = 0;
          if (x > 0 && vV[f - 1]) { sum += v[f - 1]; c++; }
          if (x < w - 1 && vV[f + 1]) { sum += v[f + 1]; c++; }
          if (vV[f - w] && f - w >= 0) { sum += v[f - w]; c++; }
          if (f + w < v.length && vV[f + w]) { sum += v[f + w]; c++; }
          v[f] = (v[f] + kc * sum) / (1 + kc * c);
        }
      }
    }
  }

  /* 4. pressure projection ------------------------------------------- */
  const bw = g.bw, nbk = g.nbk, gh = g.gh, sbK = g.sbK, rhs = g.rhs, pk = g.pk;
  for (let k = 0; k < nL; k++) {
    const idx = liq[k], x = idx % w, y = (idx / w) | 0;
    const fl = y * (w + 1) + x, fr = fl + 1, ft = y * w + x, fb = ft + w;
    const rc = rhoK[k];
    let sb = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      let beta = 0, nb = -1, gv = 0;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
        const ni = ny * w + nx, tn = type[ni];
        if (tn === 1) { nb = kOf[ni]; beta = 2 / (rc + rhoK[nb]); }
        else if (tn === 0) { beta = 1 / rc; gv = ghost(g, nx, ny, sgK[k]); }
      }
      bw[k * 4 + d] = beta; nbk[k * 4 + d] = nb; gh[k * 4 + d] = gv; sb += beta;
    }
    sbK[k] = sb;
    rhs[k] = (u[fr] - u[fl] + v[fb] - v[ft]) / dt;
    // warm start: remembered pressure, or a hydrostatic guess for fresh cells
    if (g.was[idx]) pk[k] = g.Pc[idx];
    else {
      const ka = (y > 0 && type[idx - w] === 1) ? kOf[idx - w] : -1;
      pk[k] = (ka >= 0 ? pk[ka] : 0) + rc * CFG.gravity;
    }
  }
  const omega = CFG.omega, tol = CFG.tolerance;
  for (let it = 0; it < CFG.iterations; it++) {
    let maxd = 0;
    const fwd = (it & 1) === 0;
    for (let kk = 0; kk < nL; kk++) {
      const k = fwd ? kk : nL - 1 - kk, k4 = k * 4, sb = sbK[k];
      if (sb === 0) { pk[k] = 0; continue; }
      let s = 0;
      for (let d = 0; d < 4; d++) {
        const b = bw[k4 + d];
        if (b > 0) { const nb = nbk[k4 + d]; s += b * (nb >= 0 ? pk[nb] : gh[k4 + d]); }
      }
      const diff = (s - rhs[k]) / sb - pk[k];
      pk[k] += omega * diff;
      const ad = diff < 0 ? -diff : diff;
      if (ad > maxd) maxd = ad;
    }
    if (maxd < tol) break;
  }
  // subtract pressure gradient from face velocities
  g.was.fill(0);
  for (let k = 0; k < nL; k++) {
    const idx = liq[k], x = idx % w, y = (idx / w) | 0, k4 = k * 4;
    const fl = y * (w + 1) + x, fr = fl + 1, ft = y * w + x, fb = ft + w;
    const pc = pk[k];
    g.Pc[idx] = pc; g.was[idx] = 1;
    let b, nb;
    b = bw[k4]; if (b > 0 && nbk[k4] < 0) u[fl] -= dt * b * (pc - gh[k4]);
    b = bw[k4 + 1]; if (b > 0) { nb = nbk[k4 + 1]; u[fr] -= dt * b * ((nb >= 0 ? pk[nb] : gh[k4 + 1]) - pc); }
    b = bw[k4 + 2]; if (b > 0 && nbk[k4 + 2] < 0) v[ft] -= dt * b * (pc - gh[k4 + 2]);
    b = bw[k4 + 3]; if (b > 0) { nb = nbk[k4 + 3]; v[fb] -= dt * b * ((nb >= 0 ? pk[nb] : gh[k4 + 3]) - pc); }
  }

  /* 5. grid -> particle (FLIP / PIC blend) */
  const a = CFG.flip, vmax = 1 / dt;
  for (let k = 0; k < nL; k++) {
    const idx = liq[k], x = idx % w, y = (idx / w) | 0, p = g.parts[k];
    const fl = y * (w + 1) + x, fr = fl + 1, ft = y * w + x, fb = ft + w;
    const picx = 0.5 * (u[fl] + u[fr]), picy = 0.5 * (v[ft] + v[fb]);
    const dxv = 0.5 * ((u[fl] - u0[fl]) + (u[fr] - u0[fr]));
    const dyv = 0.5 * ((v[ft] - v0[ft]) + (v[fb] - v0[fb]));
    p.rvx = clamp(a * (p.rvx + dxv) + (1 - a) * picx, -vmax, vmax);
    p.rvy = clamp(a * (p.rvy + dyv) + (1 - a) * picy, -vmax, vmax);
  }

  /* 6. advect particles through the grid ------------------------------ */
  const order = g.order;
  for (let k = 0; k < nL; k++) order[k] = k;
  for (let k = nL - 1; k > 0; k--) { const j = (Math.random() * (k + 1)) | 0, t = order[k]; order[k] = order[j]; order[j] = t; }
  for (let m = 0; m < nL; m++) {
    const p = g.parts[order[m]];
    if (p.del) continue;
    const pr = props(p.element);
    const mu = Math.max(0.25, pr.mu * tempFactor(p));

    // wall friction (solid below or beside)
    if (CFG.wallDrag > 0) {
      const sb = cellAt(p.x, p.y + 1), sl = cellAt(p.x - 1, p.y), sr = cellAt(p.x + 1, p.y);
      if (isSolidCell(sb) || isSolidCell(sl) || isSolidCell(sr)) {
        const f = clamp(CFG.wallDrag * (0.01 + 0.04 * (mu - 1)) * dt, 0, 0.9);
        p.rvx *= 1 - f; p.rvy *= 1 - f;
      }
    }

    // buoyancy (Rayleigh-Taylor): a heavier liquid over a lighter one swaps down, and
    // a lighter liquid under a heavier one bubbles up, so oil/water separate in both
    // directions instead of only waiting for the heavy pixel above to push down.
    if (CFG.stratification > 0) {
      const below = cellAt(p.x, p.y + 1);
      if (below && below !== BORDER && isLiq(below)) {
        const ra = rho(p), rb = rho(below);
        if (ra > rb * 1.001 && Math.random() < Math.min(1, CFG.stratification * dt * (ra - rb) / rb / mu)) {
          swapPixels(p, below);
          p.rfy = 0; below.rfy = 0;
          continue;
        }
      }
      const above = cellAt(p.x, p.y - 1);
      if (above && above !== BORDER && isLiq(above)) {
        const ra = rho(p), rb = rho(above);
        if (rb > ra * 1.001 && Math.random() < Math.min(1, CFG.stratification * dt * (rb - ra) / ra / mu)) {
          swapPixels(p, above);
          p.rfy = 0; above.rfy = 0;
          continue;
        }
      }
    }

    p.rfx += p.rvx * dt; p.rfy += p.rvy * dt;
    if (p.rfy >= 1) { if (tryMove(p, 0, 1)) p.rfy -= 1; else { p.rfy = 0; } }
    else if (p.rfy <= -1) { if (tryMove(p, 0, -1)) p.rfy += 1; else { p.rfy = 0; } }
    if (p.rfx >= 1) { if (tryMove(p, 1, 0)) p.rfx -= 1; else { p.rfx = 0; } }
    else if (p.rfx <= -1) { if (tryMove(p, -1, 0)) p.rfx += 1; else { p.rfx = 0; } }
    // never let sub-cell displacement pile up while sitting still
    p.rfx *= 0.9; p.rfy *= 0.9;
  }
}

/* ---------------- grid helpers ------------------------------------- */
const BORDER = { border: true };
function cellAt(x, y) { return outOfBounds(x, y) ? BORDER : pixelMap[x][y]; }
function isLiq(c) {
  if (!c || c === BORDER) return false;
  const i = elements[c.element];
  return !!i && i.state === "liquid" && managed[c.element] !== undefined;
}
function isSolidCell(c) {
  if (c === BORDER) return true;
  if (!c) return false;
  const i = elements[c.element];
  return !!i && i.state !== "gas" && i.state !== "plasma" && !(i.state === "liquid" && managed[c.element] !== undefined);
}
// Move one cell through the game's own tryMove, so reactions (water + acid, ...),
// density swaps (oil over water), onCollide/onMoveInto and relation moves keep
// working for the liquids the solver drives. A blocked move feeds back into the
// particle velocity instead of silently pressing against the wall.
function tryMove(p, dx, dy) {
  const nx = p.x + dx, ny = p.y + dy;
  if (outOfBounds(nx, ny)) { if (dx) p.rvx = 0; else p.rvy = 0; return false; }
  if (window.tryMove(p, nx, ny)) return true;
  if (!isLiq(cellAt(nx, ny))) { if (dx) p.rvx = 0; else p.rvy = 0; }
  return false;
}

/* ---------------- installing on every liquid ----------------------- */
const managed = {};

// The engine turns a function `behavior` into `tick` while the elements are built,
// so a liquid's movement lives in `tick` (its `behavior` is already gone by then).
// Replace the tick with one that keeps everything except movement: heat, burning,
// electricity, staining and reactions still run; the solver decides where liquid goes.
function liquidTick(pixel) {
  if (pixel.del === true || pixel.start === pixelTicks) return;
  doDefaults(pixel);
}
function applyTo(name) {
  const info = elements[name];
  if (!info || info.state !== "liquid" || SKIP.has(name)) return;
  if (info.tick === liquidTick) return;          // already solver-driven
  // The engine finalizes every element a second time after the load hooks run,
  // which puts the original tick back; keep the vanilla tick so disable() can
  // restore it and install ours again whenever it has been replaced.
  if (!managed[name]) managed[name] = { tick: info.tick };
  info.tick = liquidTick;
}
function applyAll() { for (const name in elements) applyTo(name); }
function revertAll() {
  for (const name in managed) {
    const m = managed[name], info = elements[name];
    if (info) info.tick = m.tick;
    delete managed[name];
  }
}

const api = {
  cfg: CFG, props: props, reapply: applyAll,
  enable: function () { CFG.enabled = true; applyAll(); console.log("[RealFluids] enabled"); },
  disable: function () { CFG.enabled = false; revertAll(); console.log("[RealFluids] disabled"); }
};
if (typeof window !== "undefined") window.RealFluids = api;

runAfterLoad(function () {
  applyAll();
  console.log("[RealFluids] solver active on: " + Object.keys(managed).join(", "));
});
runEveryTick(function () {
  if (!CFG.enabled) return;
  // install on the first ticks (the engine re-finalizes elements after load) and
  // refresh now and then so liquids added by later mods are picked up too
  if (typeof pixelTicks !== "undefined" && (pixelTicks < 3 || pixelTicks % 90 === 0)) applyAll();
  if (typeof currentPixels === "undefined") return;
  const dt = 1 / CFG.substeps;
  for (let s = 0; s < CFG.substeps; s++) substep(dt);
});

})();
