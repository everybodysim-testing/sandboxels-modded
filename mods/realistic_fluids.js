/* =====================================================================
 *  REALISTIC FLUIDS  -  a Sandboxels mod
 *
 *  Replaces the built-in "random sideways shuffle" liquid behaviour on
 *  EVERY liquid (including ones added by other mods / auto-generated
 *  molten_* liquids) with a velocity + pressure based fluid model.
 *
 *  What is simulated (per pixel, per tick):
 *   - Real gravity (acceleration, terminal velocity that depends on viscosity)
 *   - Hydrostatic pressure  (weight of the liquid column above each pixel)
 *   - Torricelli's law      (outflow speed v = sqrt(2 g h) through any opening)
 *   - Communicating vessels (pressure-driven levelling, U-tubes, siphon-ish flow)
 *   - Viscosity             (real cP values -> momentum diffusion + drag; honey != water)
 *   - Temperature-dependent viscosity (hot liquids flow easier)
 *   - Density stratification (oil floats, mercury sinks, rate set by density gap / viscosity)
 *   - Thermal convection    (hot liquid rises, cold sinks)
 *   - Water's density anomaly (densest at 4 C, so cold-ish water sinks below 0 C water)
 *   - Surface tension       (real mN/m values; cohesion at free surfaces)
 *   - Capillary action      (liquid climbs 1-2 px wide channels, h ~ surface tension / (rho * width))
 *   - Momentum transfer     (pressure waves, splashes, wall run-up)
 *
 *  Console API:  RealisticFluids.disable() / .enable() / .cfg  (tweak live)
 * ===================================================================== */
(function () {
"use strict";

if (typeof window !== "undefined" && window.RealisticFluids) {
  console.warn("[RealisticFluids] already loaded");
  return;
}

/* ---------------------------------------------------------------- *
 *  Tunables (all live-editable through RealisticFluids.cfg)
 * ---------------------------------------------------------------- */
const CFG = {
  enabled: true,
  gravity: 0.35,          // px / tick^2
  maxFall: 6,             // terminal velocity for water (px / tick)
  maxSide: 5,             // max horizontal speed (px / tick)
  torricelli: 0.6,        // outflow speed scale:  v = k * sqrt(pressure)
  levelSpeed: 0.9,        // speed at which surface pixels run toward a drop
  scanDrop: 12,           // how far a surface pixel "looks" for lower ground
  liftRate: 0.05,         // pressure-equalisation rate between side-by-side columns
  maxScan: 60,            // max column height scanned by the equalisation rule
  bfsBudget: 150,         // max cells searched when connecting separated columns
  stratification: 12,     // density-swap strength
  tension: 1,             // surface tension strength (0 = off)
  capillary: true,
  capillaryHeight: 16,    // px of rise in a 1px channel for water
  capillaryRate: 0.3,
  splash: true,
  convection: true        // temperature affects density
};

/* ---------------------------------------------------------------- *
 *  Real-world liquid data (keyed by Sandboxels element id)
 * ---------------------------------------------------------------- */
// dynamic viscosity, centipoise (water @20C = 1)
const VISC = {
  water: 1, salt_water: 1.1, dirty_water: 1.4, pool_water: 1, sugar_water: 1.9, seltzer: 1,
  alcohol: 1.2, vinegar: 1.2, acid: 1.3, bleach: 1.1, milk: 2, juice: 1.5, soda: 1.2,
  blood: 4, ink: 2, oil: 60, honey: 5000, syrup: 2000, slime: 300, glue: 500,
  mercury: 1.5, magma: 50000, lava: 50000, tar: 10000, gloop: 800
};
// surface tension, mN/m (water = 72)
const TENSION = {
  water: 72, salt_water: 75, dirty_water: 70, pool_water: 72, seltzer: 70, alcohol: 22,
  oil: 32, blood: 56, honey: 75, milk: 50, mercury: 485, acid: 50, vinegar: 45,
  soda: 45, juice: 60, magma: 350, lava: 350
};
// volumetric thermal expansion, 1/K
const BETA = { alcohol: 1.1e-3, oil: 7e-4, mercury: 1.8e-4, acid: 5e-4 };
// liquids that show water's 4 C density maximum
const WATERY = new Set(["water", "dirty_water", "pool_water", "seltzer"]);
// liquids this mod should leave alone
const SKIP = new Set([]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const PROP_CACHE = {};
function props(name) {
  let p = PROP_CACHE[name];
  if (p) return p;
  const info = elements[name] || {};
  let cp = VISC[name];
  if (cp === undefined) {
    if (name.indexOf("molten_") === 0) {
      cp = /glass|slag|rock|basalt|obsidian|plastic|rubber|sugar|candy|caramel|wax|tar|asphalt|amber|stone|concrete|brick/.test(name) ? 5000 : 8;
    } else if (typeof info.viscosity === "number") {
      cp = info.viscosity;
    } else cp = 1;
  }
  // log-map real viscosity to a game "mu": water -> 1, honey -> ~10, lava -> 12
  const mu = clamp(1 + 2.5 * Math.log10(Math.max(1, cp)), 1, 12);
  let st = TENSION[name];
  if (st === undefined) st = name.indexOf("molten_") === 0 ? 500 : 45;
  p = {
    mu: mu,
    st: st / 72,
    beta: BETA[name] !== undefined ? BETA[name] : 5e-4,
    watery: WATERY.has(name)
  };
  PROP_CACHE[name] = p;
  return p;
}

/* ---------------------------------------------------------------- *
 *  Grid helpers
 * ---------------------------------------------------------------- */
const BORDER = { border: true };

function cellAt(x, y) {
  if (outOfBounds(x, y)) return BORDER;
  return pixelMap[x][y];            // undefined when empty
}
function isLiq(c) {
  if (!c || c === BORDER) return false;
  const i = elements[c.element];
  return !!i && i.state === "liquid";
}
function isSolidCell(c) {
  if (c === BORDER) return true;
  if (!c) return false;
  const i = elements[c.element];
  return !!i && i.state === "solid";
}
// can a liquid of density `dens` move into / displace this cell?
function freeFor(dens, c) {
  if (!c) return true;
  if (c === BORDER) return false;
  const ci = elements[c.element];
  if (!ci) return false;
  if (ci.state === "gas" || ci.state === "powder") {
    return dens > (ci.density === undefined ? 1 : ci.density);
  }
  return false;
}
function initPixel(p) {
  if (p.rvx === undefined) { p.rvx = 0; p.rvy = 0; p.rfx = 0; p.rfy = 0; p.rp = 0; }
}

/* Temperature dependent viscosity: ~ -2.2 % per degree, like water */
function tempFactor(pixel) {
  const t = pixel.temp === undefined ? 20 : pixel.temp;
  return clamp(Math.exp(-0.022 * (t - 20)), 0.25, 3);
}
/* Temperature dependent density (drives convection) */
function rho(pixel) {
  const d0 = elements[pixel.element].density || 1000;
  if (!CFG.convection) return d0;
  const pr = props(pixel.element);
  const t = pixel.temp === undefined ? 20 : pixel.temp;
  if (pr.watery) {                       // anomalous expansion, max density at 4 C
    const dt = clamp(t - 4, -30, 96);
    return d0 * (1 - 4.5e-6 * dt * dt);
  }
  return d0 * (1 - pr.beta * clamp(t - 20, -100, 300));
}

/* ---------------------------------------------------------------- *
 *  Surface levelling: how far is the nearest drop to the side?
 * ---------------------------------------------------------------- */
function scanDrop(x, y, dir) {
  for (let k = 1; k <= CFG.scanDrop; k++) {
    if (cellAt(x + dir * k, y)) return Infinity;   // something in the way
    if (!cellAt(x + dir * k, y + 1)) return k;     // empty below: water can fall here
  }
  return Infinity;
}

/* ---------------------------------------------------------------- *
 *  Landing: diagonal slip, splash, or come to rest
 * ---------------------------------------------------------------- */
function land(pixel, mu, rate, dn) {
  const x = pixel.x, y = pixel.y, vy = pixel.rvy;
  if (Math.random() < rate) {
    const first = pixel.rvx > 0.3 ? 1 : pixel.rvx < -0.3 ? -1 : (Math.random() < 0.5 ? -1 : 1);
    for (let i = 0; i < 2; i++) {
      const d = i ? -first : first;
      if (!cellAt(x + d, y + 1) && !cellAt(x + d, y)) {
        pixel.rvx += d * Math.min(vy, 4) * 0.35;
        pixel.rvy = vy * 0.5;
        pixel.rfy = 0;
        movePixel(pixel, x + d, y + 1);
        return true;
      }
    }
  }
  if (CFG.splash && mu < 4 && vy > 1.8 && Math.random() < (isLiq(dn) ? 0.3 : 0.55)) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    pixel.rvx += dir * vy * (0.3 + Math.random() * 0.35);
    pixel.rvy = -vy * 0.3 / (1 + 0.3 * (mu - 1));
  } else {
    pixel.rvy = 0;
  }
  pixel.rfy = 0;
  return false;
}

function wallHit(pixel, mu) {
  const sp = Math.abs(pixel.rvx);
  if (CFG.splash && mu < 4 && sp > 2.2 && Math.random() < 0.5 && !cellAt(pixel.x, pixel.y - 1)) {
    pixel.rvy = -sp * 0.35 / (1 + 0.3 * (mu - 1));      // run-up along the wall
  }
  pixel.rvx = -pixel.rvx * 0.15;
}

/* One cell of movement.  1 = moved, 0 = blocked by liquid, -1 = blocked by solid/border */
function step(pixel, dx, dy, dens) {
  const nx = pixel.x + dx, ny = pixel.y + dy;
  const c = cellAt(nx, ny);
  if (!c) { movePixel(pixel, nx, ny); return 1; }
  if (c === BORDER) return -1;
  if (isLiq(c)) {
    if (dx) {                      // momentum exchange -> pressure waves
      initPixel(c);
      const d = (pixel.rvx - c.rvx) * 0.45;
      pixel.rvx -= d; c.rvx += d;
    }
    return 0;
  }
  if (freeFor(dens, c)) { swapPixels(pixel, c); return 1; }
  return -1;
}

/* ---------------------------------------------------------------- *
 *  Pressure equalisation between neighbouring columns
 *  (the "communicating vessels" rule): the top pixel of the higher-
 *  pressure column is moved to the surface of the lower one.
 * ---------------------------------------------------------------- */
// Breadth-first search through connected liquid for the nearest free surface
// that sits lower than row `belowRow`. Returns the empty cell above it, or null.
function findSurface(sx, sy, belowRow) {
  const seen = new Set();
  const queue = [[sx, sy]];
  seen.add(sx * 10000 + sy);
  let head = 0;
  while (head < queue.length && queue.length < CFG.bfsBudget) {
    const q = queue[head++], cx = q[0], cy = q[1];
    if (cy - 1 > belowRow && !cellAt(cx, cy - 1)) return [cx, cy - 1];
    const nb = [[cx, cy - 1], [cx - 1, cy], [cx + 1, cy], [cx, cy + 1]];
    for (let i = 0; i < 4; i++) {
      const nx = nb[i][0], ny = nb[i][1], key = nx * 10000 + ny;
      if (seen.has(key) || !isLiq(cellAt(nx, ny))) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return null;
}

function equalise(pixel, mu) {
  const x = pixel.x, y = pixel.y;
  const first = Math.random() < 0.5 ? -1 : 1;
  for (let i = 0; i < 2; i++) {
    const dir = i ? -first : first;
    const n = cellAt(x + dir, y);
    if (!isLiq(n)) continue;
    const dp = (pixel.rp || 0) - (n.rp || 0);
    if (dp < 1.5) continue;
    if (Math.random() > Math.min(0.5, CFG.liftRate * dp / mu)) continue;

    let ty = y, g = 0;
    while (g++ < CFG.maxScan && isLiq(cellAt(x, ty - 1))) ty--;
    if (cellAt(x, ty - 1)) continue;                 // column capped -> stays pressurised
    let ey = y; g = 0;
    while (g++ < CFG.maxScan && isLiq(cellAt(x + dir, ey - 1))) ey--;
    let target = null;
    if (!cellAt(x + dir, ey - 1)) {
      if (ey - 1 > ty) target = [x + dir, ey - 1];
    } else {
      // neighbour column is capped (e.g. U-tube under a divider): search the connected liquid
      target = findSurface(x + dir, y, ty);
    }
    if (!target) continue;
    const T = pixelMap[x][ty];
    initPixel(T);
    T.rvx = 0; T.rvy = 0; T.rfx = 0; T.rfy = 0;
    movePixel(T, target[0], target[1]);
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------- *
 *  Capillary action
 * ---------------------------------------------------------------- */
function narrowW(x, y) {
  const l = cellAt(x - 1, y), r = cellAt(x + 1, y);
  const sl = isSolidCell(l), sr = isSolidCell(r);
  if (sl && sr) return 1;
  if (sl && !sr && isSolidCell(cellAt(x + 2, y))) return 2;
  if (sr && !sl && isSolidCell(cellAt(x - 2, y))) return 2;
  return 0;
}
function capillary(pixel, pr, mu, dens) {
  const x = pixel.x, y = pixel.y;
  if (cellAt(x, y - 1)) return false;                 // only the top pixel
  const w = narrowW(x, y - 1);
  if (!w) return false;
  const hcap = CFG.capillaryHeight * pr.st / (dens / 1000) / w;
  let c = 0, yy = y;                                  // c = liquid cells already inside the channel
  while (c <= hcap) {
    if (!isLiq(cellAt(x, yy)) || !narrowW(x, yy)) break;
    c++; yy++;
  }
  if (c >= hcap) return false;
  if (!isLiq(cellAt(x, yy))) return false;            // must be fed from a reservoir
  if (Math.random() > CFG.capillaryRate / mu) return false;
  // the hole left at the bottom of the shifted column is refilled from a neighbouring pixel
  let donor = null;
  const sd = Math.random() < 0.5 ? -1 : 1;
  for (let i = 0; i < 2 && !donor; i++) {
    const dir = i ? -sd : sd;
    for (let k = 1; k <= 6; k++) {                    // nearest liquid pixel along the row
      const c = cellAt(x + dir * k, yy);
      if (!c) continue;
      if (isLiq(c)) donor = c;
      break;
    }
  }
  if (!donor) return false;
  for (let i = y; i <= yy; i++) movePixel(pixelMap[x][i], x, i - 1);   // shift column up one
  movePixel(donor, x, yy);
  return true;
}

/* ---------------------------------------------------------------- *
 *  The fluid tick
 * ---------------------------------------------------------------- */
function fluidTick(pixel) {
  if (!CFG.enabled) return;
  initPixel(pixel);
  const info = elements[pixel.element];
  const pr = props(pixel.element);
  const mu = Math.max(0.25, pr.mu * tempFactor(pixel));
  const dens = info.density || 1000;
  const x = pixel.x, y = pixel.y;
  const up = cellAt(x, y - 1), dn = cellAt(x, y + 1), lf = cellAt(x - 1, y), rt = cellAt(x + 1, y);
  const rate = clamp(1.1 / Math.pow(mu, 0.6), 0.04, 1);

  /* 1. hydrostatic pressure (only counts weight that is actually resting) */
  if (isLiq(up) && Math.abs(up.rvy || 0) < 0.6) {
    let pp = (up.rp || 0) + (elements[up.element].density || 1000) / 1000;
    if (CFG.capillary) {                 // weight of a capillary column is carried by surface tension
      const w = narrowW(up.x, up.y);
      if (w) pp -= CFG.capillaryHeight * pr.st / w;
    }
    pixel.rp = pp > 0 ? Math.min(400, pp) : 0;
  } else pixel.rp = 0;

  /* 2. density stratification & convection */
  if (isLiq(dn)) {
    const ra = rho(pixel), rb = rho(dn);
    if (ra > rb && Math.random() < Math.min(1, CFG.stratification * (ra - rb) / rb / mu)) {
      swapPixels(pixel, dn);
      pixel.rvy = 0; pixel.rfy = 0;
      return;
    }
  }

  /* 3. gravity / landing */
  const fDn = freeFor(dens, dn);
  const eL = !lf, eR = !rt;
  const fL = freeFor(dens, lf), fR = freeFor(dens, rt);
  let vx = pixel.rvx, vy = pixel.rvy;
  if (fDn) {
    const g = CFG.gravity / (1 + 0.12 * (mu - 1));
    const vmax = CFG.maxFall / (1 + 0.4 * (mu - 1));
    vy = Math.min(vy + g, vmax);
  } else if (vy > 0) {
    pixel.rvx = vx; pixel.rvy = vy;
    if (land(pixel, mu, rate, dn)) return;
    vx = pixel.rvx; vy = pixel.rvy;
  }

  /* 4. Torricelli outflow: pressurised pixel next to an opening squirts out */
  if ((fL || fR) && pixel.rp > 0.8) {
    const dir = fL && fR ? (Math.random() < 0.5 ? -1 : 1) : (fL ? -1 : 1);
    const v = Math.min(CFG.maxSide, CFG.torricelli * Math.sqrt(pixel.rp)) / (1 + 0.25 * (mu - 1));
    if (dir * vx < v) vx += (dir * v - vx) * 0.5;
  }

  /* 5. surface levelling: supported pixel runs toward lower ground */
  if (!fDn && (eL || eR) && Math.random() < rate) {
    const kL = eL ? scanDrop(x, y, -1) : Infinity;
    const kR = eR ? scanDrop(x, y, 1) : Infinity;
    if (kL !== Infinity || kR !== Infinity) {
      const dir = kL < kR ? -1 : kR < kL ? 1 : (Math.random() < 0.5 ? -1 : 1);
      const s = CFG.levelSpeed / Math.sqrt(mu);
      if (dir * vx < s) vx = dir * s;
    }
  }

  /* 6. surface tension: exposed pixels are pulled toward their liquid neighbours */
  if (CFG.tension > 0 && (eL || eR)) {
    let sx = 0, n = 0;
    for (let ddy = -1; ddy <= 1; ddy++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        if ((ddx || ddy) && isLiq(cellAt(x + ddx, y + ddy))) { sx += ddx; n++; }
      }
    }
    if (n > 0) vx += CFG.tension * pr.st * 0.06 * sx / n;
  }

  /* 7. viscosity: momentum diffusion between neighbours + drag */
  let cnt = 0, sum = 0;
  if (isLiq(lf)) { sum += lf.rvx || 0; cnt++; }
  if (isLiq(rt)) { sum += rt.rvx || 0; cnt++; }
  if (cnt) vx += (sum / cnt - vx) * Math.min(0.5, 0.04 + 0.05 * mu);
  let fr = fDn ? 0.01 + 0.03 * (mu - 1) : 0.03 + 0.05 * (mu - 1) + 0.10;   // floor drag
  vx *= 1 - Math.min(0.92, fr);

  /* 8. capillary rise & column equalisation */
  if (CFG.capillary && capillary(pixel, pr, mu, dens)) return;
  if (!fDn && pixel.rp > 1.5 && (isLiq(lf) || isLiq(rt)) && equalise(pixel, mu)) return;

  /* 9. integrate motion cell by cell */
  vx = clamp(vx, -CFG.maxSide, CFG.maxSide);
  if (Math.abs(vx) < 0.04) vx = 0;
  pixel.rvx = vx; pixel.rvy = vy;
  pixel.rfx += vx; pixel.rfy += vy;
  let ix = pixel.rfx < 0 ? Math.ceil(pixel.rfx) : Math.floor(pixel.rfx);
  let iy = pixel.rfy < 0 ? Math.ceil(pixel.rfy) : Math.floor(pixel.rfy);
  pixel.rfx -= ix; pixel.rfy -= iy;

  let guard = 0;
  while ((ix !== 0 || iy !== 0) && guard++ < 10) {
    const alongY = iy !== 0 && (ix === 0 || Math.abs(iy) >= Math.abs(ix));
    if (alongY) {
      const sy = iy > 0 ? 1 : -1;
      if (step(pixel, 0, sy, dens) === 1) { iy -= sy; }
      else {
        iy = 0; pixel.rfy = 0;
        if (sy > 0) { if (land(pixel, mu, rate, cellAt(pixel.x, pixel.y + 1))) return; }
        else pixel.rvy = 0;
      }
    } else {
      const sx = ix > 0 ? 1 : -1;
      const r = step(pixel, sx, 0, dens);
      if (r === 1) { ix -= sx; }
      else {
        ix = 0; pixel.rfx = 0;
        if (r === -1) wallHit(pixel, mu);
      }
    }
  }
}

/* ---------------------------------------------------------------- *
 *  Installing / removing the model on every liquid
 * ---------------------------------------------------------------- */
const NOMOVE = ["XX|XX|XX", "XX|XX|XX", "XX|XX|XX"];
const managed = {};

// remove movement tokens (M1, M2, SW, BO) but keep everything else (fire, reactions, etc.)
function stripMovement(beh) {
  if (!Array.isArray(beh)) return NOMOVE;
  for (let i = 0; i < beh.length; i++) if (typeof beh[i] !== "string") return NOMOVE;
  return beh.map(function (row) {
    return row.split("|").map(function (cell) {
      const toks = cell.split(" AND ").filter(function (t) { return !/^(M1|M2|SW|BO)\b/.test(t.trim()); });
      return toks.length ? toks.join(" AND ") : "XX";
    }).join("|");
  });
}

function applyTo(name) {
  const info = elements[name];
  if (!info || info.state !== "liquid" || managed[name] || SKIP.has(name)) return;
  managed[name] = { behavior: info.behavior, tick: info.tick, movable: info.movable };
  info.behavior = stripMovement(info.behavior);
  const orig = info.tick;
  info.tick = function (pixel) {
    fluidTick(pixel);
    if (orig && !pixel.del) orig(pixel);
  };
  info.movable = true;
}
function applyAll() {
  for (const name in elements) applyTo(name);
}
function revertAll() {
  for (const name in managed) {
    const m = managed[name], info = elements[name];
    if (!info) continue;
    info.behavior = m.behavior;
    if (m.tick === undefined) delete info.tick; else info.tick = m.tick;
    if (m.movable === undefined) delete info.movable; else info.movable = m.movable;
    delete managed[name];
  }
}

const api = {
  cfg: CFG,
  props: props,
  enable: function () { CFG.enabled = true; applyAll(); console.log("[RealisticFluids] enabled"); },
  disable: function () { CFG.enabled = false; revertAll(); console.log("[RealisticFluids] disabled (vanilla liquids restored)"); },
  reapply: applyAll
};
if (typeof window !== "undefined") window.RealisticFluids = api;

runAfterLoad(function () {
  applyAll();
  console.log("[RealisticFluids] active on: " + Object.keys(managed).join(", "));
});
// catch liquids that other mods / melting rules register later
runEveryTick(function () {
  if (CFG.enabled && typeof pixelTicks !== "undefined" && pixelTicks % 90 === 0) applyAll();
});

})();
