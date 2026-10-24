/* ============================================================================
   SUBLEVEL PHYSICS v2  -  Sandboxels 1.13.x

   * Ordinary solids (rock, glass, iron, wood, brick ...) that are NOT connected
     to anything fall: the whole floating connected chunk unhooks from the grid
     into a free rotating rigid body. Checked whenever something within 3 pixels
     of a solid is removed / changed / moved (plus a slow background sweep).
   * Every solid gets its own physics numbers (density, bounce, friction,
     toughness) derived from the element itself + its name.
   * "Anchored" tab: copies of the solids that can never fall.
   * Bodies float by Archimedes (hollow cups/boats count their enclosed air),
     bounce, tumble, break on hard hits, push water/sand aside.
   * Placing solids touching a body (also with big brushes) adds them to it, and
     the body is held still while you build. Erasing cuts/splits it.
   * Tools:  physlock (freeze / unfreeze a body in place),
             physicssnap (turn the body back into anchored grid blocks, as drawn),
             physicsalignedsnap (rotate to the grid first, then snap, no deformation)
   ========================================================================== */
(function () {

var G = 0.09, MAXV = 3.0, MAXW = 0.22, HOLD = 25;
var BODIES = {}, FALL = {}, PC = {};
var PROXY = "sublevel_solid";
var baseId = Math.floor(Math.random()*1e8) * 100, idc = 1;
var NOJOIN = false, dirty = new Set();
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];

function chance(p){ return Math.random() < p; }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
function sign(v){ return v > 0 ? 1 : v < 0 ? -1 : 0; }
function K(lx,ly){ return (lx+2048)*4096 + (ly+2048); }
function GK(x,y){ return x*4096 + y; }
function pxAt(x,y){
  if (outOfBounds(x,y)) return undefined;
  var c = pixelMap[x]; return c ? c[y] : undefined;
}
function liq(x,y){
  if (outOfBounds(x,y)) return null;
  var p = pixelMap[x][y]; if (!p || p.sub !== undefined) return null;
  var e = elements[p.element]; return (e && e.state === "liquid") ? p : null;
}
function mark(x,y){ dirty.add(GK(x,y)); }

/* ------------------------------------- per-element physics characteristics */
function hash(s){ var h = 2166136261; for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function physOf(id){
  var P = PC[id]; if (P) return P;
  var e = elements[id] || {}, h = hash(id);
  var r1 = (h & 255)/255, r2 = ((h >>> 8) & 255)/255, r3 = ((h >>> 16) & 255)/255;
  var dens = Math.max(30, Math.min(9000, e.density || 1500));
  var hard = e.hardness !== undefined ? e.hardness : 0.3 + 0.6*r1;
  var bounce = 0.03 + 0.27*r2, fric = 0.25 + 0.55*r3;
  if (/rubber|slime|jelly|gummy|tire|ball|bounc/.test(id)){ bounce = 0.7 + 0.25*r2; fric = 0.85; hard = Math.max(hard, 0.7); }
  else if (/ice/.test(id)){ bounce = 0.25 + 0.1*r2; fric = 0.03; hard = Math.min(hard, 0.35); }
  else if (/glass|porcelain|crystal|ceramic|pyrite|ruby|sapphire|quartz/.test(id)){ bounce = 0.05 + 0.15*r2; hard *= 0.45; fric = 0.35 + 0.2*r3; }
  else if (/iron|steel|copper|gold|silver|lead|zinc|tin|nickel|alumin|brass|bronze|titan|tungsten|platin|metal|cobalt|chrom/.test(id)){ bounce = 0.02 + 0.08*r2; fric = 0.28 + 0.2*r3; hard = Math.max(hard, 0.8); }
  else if (/wood|plank|bamboo|board|paper|cork|foam|sponge|bone/.test(id)){ bounce = 0.12 + 0.12*r2; fric = 0.55 + 0.15*r3; hard = Math.min(Math.max(hard, 0.35), 0.55); }
  hard = Math.max(0.05, Math.min(0.98, hard));
  var br = e.breakInto; if (Array.isArray(br)) br = br[0];
  var debris = (br && elements[br]) ? br : (elements.gravel ? "gravel" : null);
  P = PC[id] = { dens: dens, bounce: bounce, fric: fric, hard: hard, g: 1, debris: debris };
  return P;
}

/* ------------------------------------------------------------ transforms */
function toWorld(b,lx,ly){
  var u = lx - b.com.x, v = ly - b.com.y, c = Math.cos(b.a), s = Math.sin(b.a);
  return { x: b.x + u*c - v*s, y: b.y + u*s + v*c };
}
function toLocal(b,wx,wy){
  var dx = wx - b.x, dy = wy - b.y, c = Math.cos(b.a), s = Math.sin(b.a);
  return { x: dx*c + dy*s + b.com.x, y: -dx*s + dy*c + b.com.y };
}

/* ---------------------------------------------------------- body building */
function calc(b, keepWorld){
  var m = 0, cx = 0, cy = 0, bo = 0, fr = 0, hd = 0, n = b.cells.size;
  if (!n){ b.m = 0; return; }
  b.cells.forEach(function(c){
    var P = physOf(c.e); m += P.dens; cx += P.dens*c.x; cy += P.dens*c.y; bo += P.bounce; fr += P.fric; hd += P.hard;
  });
  var ncx = cx/m, ncy = cy/m;
  if (keepWorld){
    var ow = toWorld(b, ncx, ncy), rx = ow.x - b.x, ry = ow.y - b.y;
    b.vx += -b.w*ry; b.vy += b.w*rx; b.x = ow.x; b.y = ow.y;
  }
  b.com.x = ncx; b.com.y = ncy;
  var I = 0, rad = 0;
  b.cells.forEach(function(c){
    var P = physOf(c.e), dx = c.x - ncx, dy = c.y - ncy;
    I += P.dens*(dx*dx + dy*dy + 1/6); rad = Math.max(rad, Math.sqrt(dx*dx + dy*dy) + 0.75);
  });
  b.m = m; b.I = Math.max(I, 1e-3); b.bounce = bo/n; b.fric = fr/n; b.hard = hd/n; b.g = 1; b.rad = rad;
}
function makeBody(cells, ang, vx, vy, w, gf){
  var b = { id: baseId + (idc++), cells: cells, x: 0, y: 0, a: ang || 0, vx: vx || 0, vy: vy || 0,
    w: w || 0, gf: gf || 1, com: { x:0, y:0 }, proxies: new Map(), dirty: false, sleep: 0, sleepT: 0,
    rest: 0, wet: 0, debris: [], dead: false, stuck: false, touch: false, plow: 0, frozen: false, hold: 0 };
  calc(b); BODIES[b.id] = b; return b;
}
function raster(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad, cm = b.com;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [], ck: [] };
  for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++){
    var dx = gx - x, dy = gy - y;
    var k = K(Math.round(dx*c + dy*s + cm.x), Math.round(-dx*s + dy*c + cm.y));
    if (b.cells.has(k)){ out.gx.push(gx); out.gy.push(gy); out.ck.push(k); }
  }
  return out;
}

/* ----------------------------------------------------- grid obstacle test */
/* 0 free, 1 terrain, 2 other body, 3 soft (plowed aside) */
function blocker(b, gx, gy, speed){
  if (outOfBounds(gx,gy)) return 1;
  var p = pixelMap[gx][gy];
  if (!p || p.sub === b.id) return 0;
  if (p.sub !== undefined) return BODIES[p.sub] ? 2 : 1;
  var e = elements[p.element];
  if (!e) return 1;
  if (e.state === "liquid" || e.state === "gas") return 0;
  if (e.movable === true && e.category !== "tools"){
    if (b.m / b.cells.size > e.density*1.5 || speed > 1.0) return 3;
    return 1;
  }
  return 1;
}
/* collision raster: a grid cell counts if its unit square overlaps a body cell (not just its centre) */
function rasterC(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad + 0.5, cm = b.com, E = 1e-6;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [] };
  for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++){
    var dx = gx - x, dy = gy - y, lx = dx*c + dy*s + cm.x, ly = -dx*s + dy*c + cm.y;
    var k0 = Math.ceil(lx - 1 + E), k1 = Math.floor(lx + 1 - E), l0 = Math.ceil(ly - 1 + E), l1 = Math.floor(ly + 1 - E), hit = false;
    for (var kx = k0; kx <= k1 && !hit; kx++) for (var ky = l0; ky <= l1; ky++) if (b.cells.has(K(kx, ky))){ hit = true; break; }
    if (hit){ out.gx.push(gx); out.gy.push(gy); }
  }
  return out;
}
function contacts(b, x, y, a, speed){
  var R = rasterC(b, x, y, a), n = 0, sx = 0, sy = 0, hits = [], other = null, plow = 0;
  for (var i = 0; i < R.gx.length; i++){
    var t = blocker(b, R.gx[i], R.gy[i], speed);
    if (t === 0) continue;
    if (t === 3){ plow++; continue; }
    n++; sx += R.gx[i]; sy += R.gy[i];
    if (hits.length < 12) hits.push([R.gx[i], R.gy[i]]);
    if (t === 2 && !other){ var p = pixelMap[R.gx[i]][R.gy[i]]; other = BODIES[p.sub] || null; }
  }
  return { n:n, cx: n ? sx/n : x, cy: n ? sy/n : y, hits:hits, other:other, plow:plow };
}
function normalAt(b, c, speed){
  var gx0 = Math.round(c.cx), gy0 = Math.round(c.cy), sx = 0, sy = 0;
  for (var dx = -2; dx <= 2; dx++) for (var dy = -2; dy <= 2; dy++){
    var t = blocker(b, gx0+dx, gy0+dy, speed);
    if (t === 1 || t === 2){ sx += gx0 + dx - c.cx; sy += gy0 + dy - c.cy; }
  }
  var nx = -sx, ny = -sy, len = Math.sqrt(nx*nx + ny*ny);
  var tx = b.x - c.cx, ty = b.y - c.cy;
  if (len < 1e-3){ nx = tx; ny = ty; len = Math.sqrt(nx*nx + ny*ny); }
  if (len < 1e-3){ nx = 0; ny = -1; len = 1; }
  nx /= len; ny /= len;
  if (nx*tx + ny*ty < -0.2){ nx = -nx; ny = -ny; }
  /* snap near-axis normals: stray pixels no longer push bodies sideways forever */
  if (Math.abs(nx) < 0.38){ nx = 0; ny = sign(ny) || -1; }
  else if (Math.abs(ny) < 0.38){ ny = 0; nx = sign(nx); }
  else { len = Math.sqrt(nx*nx + ny*ny); nx /= len; ny /= len; }
  return { x:nx, y:ny };
}

/* -------------------------------------------------------------- impulses */
function impulse(b, c, n){
  var rx = c.cx - b.x, ry = c.cy - b.y;
  var vcx = b.vx - b.w*ry, vcy = b.vy + b.w*rx;
  var o = c.other, invm2 = 0, invI2 = 0, orx = 0, ory = 0, ovx = 0, ovy = 0;
  if (o){
    orx = c.cx - o.x; ory = c.cy - o.y; ovx = o.vx - o.w*ory; ovy = o.vy + o.w*orx; invm2 = 1/o.m; invI2 = 1/o.I;
  }
  var vn = (vcx - ovx)*n.x + (vcy - ovy)*n.y;
  if (vn >= 0) return 0;
  var e = Math.abs(vn) < 0.12 ? 0 : (o ? Math.min(b.bounce, o.bounce) : b.bounce);
  var rn = rx*n.y - ry*n.x, orn = orx*n.y - ory*n.x;
  var j = -(1+e)*vn/(1/b.m + rn*rn/b.I + invm2 + orn*orn*invI2);
  b.vx += j*n.x/b.m; b.vy += j*n.y/b.m; b.w += rn*j/b.I;
  if (o){ o.vx -= j*n.x*invm2; o.vy -= j*n.y*invm2; o.w -= orn*j*invI2; o.sleep = 0; }
  var tx = -n.y, ty = n.x;
  vcx = b.vx - b.w*ry; vcy = b.vy + b.w*rx;
  if (o){ ovx = o.vx - o.w*ory; ovy = o.vy + o.w*orx; }
  var vt = (vcx - ovx)*tx + (vcy - ovy)*ty;
  var rt = rx*ty - ry*tx, ort = orx*ty - ory*tx;
  var jt = -vt/(1/b.m + rt*rt/b.I + invm2 + ort*ort*invI2), mx = (o ? Math.sqrt(b.fric*o.fric) : b.fric)*1.6*j;
  if (jt > mx) jt = mx; else if (jt < -mx) jt = -mx;
  b.vx += jt*tx/b.m; b.vy += jt*ty/b.m; b.w += rt*jt/b.I;
  if (o){ o.vx -= jt*tx*invm2; o.vy -= jt*ty*invm2; o.w -= ort*jt*invI2; }
  return -vn;
}
function smash(p){
  var e = elements[p.element]; if (!e || !e.breakInto) return;
  var t = e.breakInto; if (Array.isArray(t)) t = pick(t);
  if (t && elements[t]) changePixel(p, t);
}
function removeCell(b, k, debris){
  var cell = b.cells.get(k); if (!cell) return;
  b.cells.delete(k); b.dirty = true; b.sleep = 0;
  if (debris && chance(0.55)){
    var w = toWorld(b, cell.x, cell.y), d = physOf(cell.e).debris;
    if (d) b.debris.push([Math.round(w.x), Math.round(w.y), d]);
  }
}
function damage(b, c, s){
  if (s < 1.0) return;
  var power = s - 1.0, tH = 0.6, i;
  var mf = Math.max(0.2, Math.min(3, (b.m/b.cells.size)/1500 * (0.4 + Math.min(1.2, b.cells.size/40))));
  for (i = 0; i < c.hits.length && i < 6; i++){
    var p = pxAt(c.hits[i][0], c.hits[i][1]);
    if (!p || p.sub !== undefined) continue;
    var e = elements[p.element];
    var hard = (e && e.hardness !== undefined) ? e.hardness : 0.6; tH = hard;
    if (e && e.breakInto && hard < 0.95 && chance(Math.min(0.7, power*0.25*mf*(1-hard)))) smash(p);
  }
  var lc = toLocal(b, c.cx, c.cy);
  b.cells.forEach(function(cell, k){
    var dx = cell.x - lc.x, dy = cell.y - lc.y;
    if (dx*dx + dy*dy > 2.9) return;
    if (chance(Math.min(0.75, power*0.22) * (1 - physOf(cell.e).hard) * (0.4 + tH))) removeCell(b, k, true);
  });
}

/* ------------------------------------------------------------ integration */
function moveSub(b, h){
  var nx = b.x + b.vx*h, ny = b.y + b.vy*h, na = b.a + b.w*h;
  var spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  var c = contacts(b, nx, ny, na, spd);
  if (c.plow) b.plow += c.plow;
  if (c.n === 0){ b.x = nx; b.y = ny; b.a = na; return; }
  b.touch = true;
  var damaged = false, ok = false;
  for (var it = 0; it < 3 && c.n > 0; it++){
    var n = normalAt(b, c, spd), s = impulse(b, c, n);
    if (s > 0 && !damaged){ damaged = true; damage(b, c, s); if (!b.cells.size) return; }
    var moved = 0;
    while (c.n > 0 && moved < 12){ nx += n.x*0.15; ny += n.y*0.15; moved++; c = contacts(b, nx, ny, na, spd); }
    if (c.n === 0){ ok = true; break; }
  }
  if (ok){ b.x = nx; b.y = ny; b.a = na; b.w *= 0.995; } else b.stuck = true;
}
function escape(b){
  for (var r = 1; r <= 8; r++) for (var d = 0; d < 8; d++){
    var ang = d*Math.PI/4, x = b.x + Math.cos(ang)*r*0.5, y = b.y + Math.sin(ang)*r*0.5;
    if (contacts(b, x, y, b.a, 0).n === 0){ b.x = x; b.y = y; return true; }
  }
  return false;
}
/* buoyancy: submerged solid cells + enclosed dry air inside hollow hulls (cups, boats) */
function fluidInfo(b, R){
  var rows = {}, cols = {}, i, gx, gy, k, p, own = new Set();
  for (i = 0; i < R.gx.length; i++){
    gx = R.gx[i]; gy = R.gy[i]; own.add(GK(gx, gy));
    var r = rows[gy]; if (!r) rows[gy] = [gx,gx]; else { if (gx < r[0]) r[0] = gx; if (gx > r[1]) r[1] = gx; }
    var c = cols[gx]; if (!c) cols[gx] = [gy,gy]; else { if (gy < c[0]) c[0] = gy; if (gy > c[1]) c[1] = gy; }
  }
  var rw = {}, cw = {}, rho = 0, rn = 0;
  for (k in rows){ p = liq(rows[k][0]-1, +k) || liq(rows[k][1]+1, +k); if (p){ rw[k] = 1; rho += elements[p.element].density; rn++; } }
  for (k in cols){ p = liq(+k, cols[k][0]-1); if (p){ cw[k] = 1; rho += elements[p.element].density; rn++; } }
  var cnt = 0, sx = 0, sy = 0;
  for (i = 0; i < R.gx.length; i++) if (rw[R.gy[i]] || cw[R.gx[i]]){ cnt++; sx += R.gx[i]; sy += R.gy[i]; }
  for (k in rw){                                   // dry air pockets between the walls also displace water
    var row = rows[k];
    for (var x = row[0] + 1; x < row[1]; x++){
      if (own.has(GK(x, +k))) continue;
      var q = outOfBounds(x, +k) ? null : pixelMap[x][+k];
      if (!q || (q.sub === undefined && elements[q.element] && elements[q.element].state === "gas")){ cnt++; sx += x; sy += +k; }
    }
  }
  return { n:cnt, cx: cnt ? sx/cnt : b.x, cy: cnt ? sy/cnt : b.y, rho: rn ? rho/rn : 1000 };
}

/* ------------------------------------------------------------- proxies */
function relocate(o, gx, gy, want, rr){
  for (var r = 1; r <= 8; r++){
    var cand = [];
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++){
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = gx + dx, y = gy + dy;
      if (outOfBounds(x,y) || pixelMap[x][y] !== undefined || want.has(GK(x,y))) continue;
      if (rr && rr[y] && x > rr[y][0] && x < rr[y][1]) continue;          // inside the body's hollow
      cand.push([x,y]);
    }
    if (cand.length){
      if (elements[o.element] && elements[o.element].state === "liquid"){   // displaced liquid goes next to other liquid, never into a hull's dry interior
        var wetc = cand.filter(function(q){
          for (var d = 0; d < 4; d++){ var n = pxAt(q[0] + D4[d][0], q[1] + D4[d][1]);
            if (n && n.sub === undefined && elements[n.element] && elements[n.element].state === "liquid") return true; }
          return false; });
        if (wetc.length) cand = wetc;
      }
      var t = pick(cand);
      pixelMap[o.x][o.y] = undefined; o.x = t[0]; o.y = t[1]; pixelMap[t[0]][t[1]] = o; return true;
    }
  }
  if (rr) return relocate(o, gx, gy, want, null);
  pixelMap[o.x][o.y] = undefined; o.del = true; return false;
}
function syncProxies(b){
  var R = raster(b, b.x, b.y, b.a), want = new Map(), i, spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  var rr = {};
  for (i = 0; i < R.gx.length; i++){
    want.set(GK(R.gx[i], R.gy[i]), i);
    var q = rr[R.gy[i]]; if (!q) rr[R.gy[i]] = [R.gx[i], R.gx[i]]; else { if (R.gx[i] < q[0]) q[0] = R.gx[i]; if (R.gx[i] > q[1]) q[1] = R.gx[i]; }
  }
  var spare = [];
  b.proxies.forEach(function(pix, gk){
    var valid = !pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix && pix.sub === b.id;
    if (valid && pix.element !== PROXY){
      b.cells.delete(pix.ck); b.dirty = true; pix.sub = undefined; b.proxies.delete(gk); return;
    }
    if (valid && want.has(gk)){ pix.ck = R.ck[want.get(gk)]; want.delete(gk); }
    else {
      b.proxies.delete(gk);
      if (valid){ pixelMap[pix.x][pix.y] = undefined; spare.push(pix); mark(pix.x, pix.y); }
    }
  });
  want.forEach(function(idx, gk){
    var gx = R.gx[idx], gy = R.gy[idx], o = pixelMap[gx][gy];
    if (o){
      var bt = blocker(b, gx, gy, spd);
      if (bt === 1 || bt === 2) return;
      relocate(o, gx, gy, want, rr);
    }
    var pix = spare.pop();
    if (pix){ pix.x = gx; pix.y = gy; pix.del = false; pixelMap[gx][gy] = pix; }
    else { createPixel(PROXY, gx, gy); pix = pixelMap[gx][gy]; if (!pix) return; }
    pix.sub = b.id; pix.ck = R.ck[idx];
    var cell = b.cells.get(pix.ck); pix.pe = cell ? cell.e : undefined;
    b.proxies.set(gk, pix);
  });
  for (i = 0; i < spare.length; i++){ spare[i].sub = undefined; spare[i].del = true; }
}
function releaseProxies(b){
  b.proxies.forEach(function(pix){
    if (!pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix) pixelMap[pix.x][pix.y] = undefined;
    pix.sub = undefined; pix.del = true; mark(pix.x, pix.y);
  });
  b.proxies.clear();
}
function killBody(b){ releaseProxies(b); b.dead = true; delete BODIES[b.id]; }

/* ---------------------------------------------------- dirty / splitting */
function components(b){
  var seen = new Set(), out = [];
  b.cells.forEach(function(cell, k){
    if (seen.has(k)) return;
    var comp = [], q = [cell]; seen.add(k);
    while (q.length){
      var c = q.pop(); comp.push(K(c.x, c.y));
      for (var d = 0; d < 4; d++){
        var nk = K(c.x + D4[d][0], c.y + D4[d][1]), nc = b.cells.get(nk);
        if (nc && !seen.has(nk)){ seen.add(nk); q.push(nc); }
      }
    }
    out.push(comp);
  });
  return out;
}
function fixBody(b){
  b.dirty = false;
  if (!b.cells.size){ killBody(b); return; }
  var comps = components(b);
  if (comps.length === 1){ calc(b, true); b.sleep = 0; syncProxies(b); return; }
  var created = [];
  comps.forEach(function(keys){
    var cells = new Map();
    keys.forEach(function(k){ cells.set(k, b.cells.get(k)); });
    var nb = makeBody(cells, b.a, b.vx, b.vy, b.w, b.gf);
    var w = toWorld(b, nb.com.x, nb.com.y), rx = w.x - b.x, ry = w.y - b.y;
    nb.x = w.x; nb.y = w.y; nb.vx = b.vx - b.w*ry; nb.vy = b.vy + b.w*rx;
    nb.frozen = b.frozen; nb.hold = b.hold;
    created.push(nb);
  });
  killBody(b);
  var cx = 0, cy = 0; created.forEach(function(n){ cx += n.x; cy += n.y; });
  cx /= created.length; cy /= created.length;
  created.forEach(function(n){
    var dx = n.x - cx, dy = n.y - cy, l = Math.sqrt(dx*dx + dy*dy) || 1;
    if (!n.frozen && pixelTicks >= n.hold){ n.vx += dx/l*0.08; n.vy += dy/l*0.08; }
    syncProxies(n);
  });
}

/* ------------------------------------------------------ the body stepper */
function stepBody(b){
  if (b.dead) return;
  if (b.dirty){ fixBody(b); if (b.dead) return; }
  if (b.frozen || pixelTicks < b.hold){ b.vx = 0; b.vy = 0; b.w = 0; return; }
  if (b.sleep){
    b.sleepT++; if (b.sleepT % 5 !== 0) return;
    var gs0 = (b.g*b.gf) >= 0 ? 1 : -1;
    if (contacts(b, b.x, b.y + 0.3*gs0, b.a, 0).n === 0) b.sleep = 0; else return;
  }
  if (b.stuck){ b.stuck = false; escape(b); }
  var R0 = raster(b, b.x, b.y, b.a);
  var ay = b.g*b.gf*G, tq = 0;
  var fl = fluidInfo(b, R0); b.wet = fl.n;
  if (fl.n > 0){
    var Fb = fl.rho*fl.n*G, frac = Math.min(1, fl.n/b.cells.size);
    ay -= Fb/b.m; tq -= (fl.cx - b.x)*Fb;
    var sp = Math.sqrt(b.vx*b.vx + b.vy*b.vy), dk = Math.min(0.6, frac*(0.14 + 0.16*sp));
    b.vx *= 1 - dk; b.vy *= 1 - dk; b.w *= 1 - Math.min(0.5, 0.28*frac);
  }
  b.vy += ay; b.w += tq/b.I; b.w *= 0.998;
  if (b.vx > MAXV) b.vx = MAXV; else if (b.vx < -MAXV) b.vx = -MAXV;
  if (b.vy > MAXV) b.vy = MAXV; else if (b.vy < -MAXV) b.vy = -MAXV;
  if (b.w > MAXW) b.w = MAXW; else if (b.w < -MAXW) b.w = -MAXW;

  var rr = Math.sqrt(b.vx*b.vx + b.vy*b.vy) + Math.abs(b.w)*b.rad;
  var n = Math.min(8, Math.max(1, Math.ceil(rr/0.45))), h = 1/n;
  b.touch = false; b.plow = 0;
  for (var s = 0; s < n; s++){ moveSub(b, h); if (!b.cells.size){ b.dirty = true; break; } }
  if (b.plow > 0){ var d = Math.max(0.6, 1 - 0.015*b.plow/n); b.vx *= d; b.vy *= d; b.w *= d; }
  if (!b.cells.size){ killBody(b); return; }
  var spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  if (b.touch && b.wet === 0){                     // ground contact: settle instead of sliding forever
    b.vx *= 0.97; b.w *= 0.97;
    if (spd < 0.3){ b.vx *= 0.85; b.vy *= 0.5; }
    if (Math.abs(b.vx) < 0.02) b.vx = 0;
    if (Math.abs(b.w) < 0.004) b.w = 0;
    spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  }
  if (b.touch) b.lt2 = pixelTicks;
  syncProxies(b);
  if (b.debris.length){
    b.debris.forEach(function(dd){ if (isEmpty(dd[0], dd[1]) && elements[dd[2]]) createPixel(dd[2], dd[0], dd[1]); });
    b.debris.length = 0;
  }
  carry(b);
  if (pixelTicks - (b.lt2 || -99) < 8 && b.wet === 0 && spd < 0.12 && Math.abs(b.w) < 0.015 && !b.dirty) b.rest++; else b.rest = 0;
  if (b.rest > 30){ b.sleep = 1; b.sleepT = 0; b.vx = 0; b.vy = 0; b.w = 0; b.rest = 0; }
}
function carry(b){                                    // loose solids resting on the body ride along
  if (Math.abs(b.vx) + Math.abs(b.w)*b.rad < 0.03) return;
  b.proxies.forEach(function(pix){
    var p = pxAt(pix.x, pix.y - 1);
    if (!p || p.sub !== undefined || p.del) return;
    var e = elements[p.element];
    if (!e || e.state !== "solid" || e.movable !== true) return;
    p.rq = (p.rq || 0) + (b.vx - b.w*(pix.y - b.y));
    if (Math.abs(p.rq) >= 1){
      var dir = sign(p.rq);
      if (isEmpty(p.x + dir, p.y)) movePixel(p, p.x + dir, p.y);
      p.rq -= dir;
    }
  });
}

/* ------------------------------------------- falling: support detection */
function isFaller(p){ return p && !p.del && p.sub === undefined && FALL[p.element] === true; }
function bodyFromPixels(list){
  var ax = list[0].x, ay = list[0].y, cells = new Map();
  list.forEach(function(q){ cells.set(K(q.x - ax, q.y - ay), { x: q.x - ax, y: q.y - ay, e: q.element, c: q.color }); });
  list.forEach(function(q){ if (pixelMap[q.x][q.y] === q) pixelMap[q.x][q.y] = undefined; q.del = true; });
  var b = makeBody(cells, 0, 0, 0, 0, 1);
  b.x = ax + b.com.x; b.y = ay + b.com.y;
  syncProxies(b);
  return b;
}
function checkSupport(p, checked){
  var comp = [p], seen = new Set([p]), q = [p], supported = false;
  while (q.length && !supported){
    var c = q.pop();
    for (var d = 0; d < 4; d++){
      var nx = c.x + D4[d][0], ny = c.y + D4[d][1];
      if (outOfBounds(nx, ny)){ supported = true; break; }
      var n = pixelMap[nx][ny];
      if (!n || n.sub !== undefined || n.del) continue;
      if (FALL[n.element] === true){ if (!seen.has(n)){ seen.add(n); comp.push(n); q.push(n); } continue; }
      var e = elements[n.element];
      if (e && (e.state === "liquid" || e.state === "gas")) continue;
      supported = true; break;
    }
    if (comp.length > 2500) supported = true;
  }
  comp.forEach(function(x){ checked.add(x); });
  if (!supported) bodyFromPixels(comp);
}
function processSupport(){
  var checked = new Set(), n = 0, i;
  var it = dirty.values();
  while (n < 80){
    var nx = it.next(); if (nx.done) break;
    var gk = nx.value; dirty.delete(gk); n++;
    var x = Math.floor(gk/4096), y = gk % 4096;
    for (var dx = -3; dx <= 3; dx++) for (var dy = -3; dy <= 3; dy++){
      var p = pxAt(x + dx, y + dy);
      if (p && !checked.has(p) && isFaller(p)) checkSupport(p, checked);
    }
  }
  if (typeof currentPixels !== "undefined" && currentPixels.length){      // slow background sweep
    for (i = 0; i < 25; i++){
      var r = currentPixels[Math.floor(Math.random()*currentPixels.length)];
      if (r && !checked.has(r) && isFaller(r) && pixelMap[r.x] && pixelMap[r.x][r.y] === r) checkSupport(r, checked);
    }
  }
}

/* -------------------------------------------- joining / erasing / snapping */
function joinPixel(b, p){
  var l = toLocal(b, p.x, p.y), lx = Math.round(l.x), ly = Math.round(l.y);
  if (b.cells.has(K(lx, ly))){
    var best = null, bd = 1e9;
    for (var d = 0; d < 4; d++){
      var cx = lx + D4[d][0], cy = ly + D4[d][1];
      if (b.cells.has(K(cx, cy))) continue;
      var dd = (cx - l.x)*(cx - l.x) + (cy - l.y)*(cy - l.y);
      if (dd < bd){ bd = dd; best = [cx, cy]; }
    }
    if (!best) return false;
    lx = best[0]; ly = best[1];
  }
  b.cells.set(K(lx, ly), { x: lx, y: ly, e: p.element, c: p.color });
  pixelMap[p.x][p.y] = undefined; p.del = true;
  b.dirty = true; b.sleep = 0; b.vx = 0; b.vy = 0; b.w = 0; b.hold = pixelTicks + HOLD;   // hold still while building
  syncProxies(b);
  return true;
}
function onPlaceFaller(p){
  if (NOJOIN || p.sub !== undefined) return;
  p.pa = pixelTicks;
  var b = null, x, y;
  for (x = -1; x <= 1 && !b; x++) for (y = -1; y <= 1 && !b; y++){
    if (!x && !y) continue;
    var n = pxAt(p.x + x, p.y + y);
    if (n && n.sub !== undefined && BODIES[n.sub]) b = BODIES[n.sub];
  }
  if (!b) return;
  var px0 = p.x, py0 = p.y;
  if (!joinPixel(b, p)) return;
  var queue = [[px0, py0]];                      // also pull in pixels of the same brush stroke that are touching
  while (queue.length){
    var pos = queue.pop();
    for (var d = 0; d < 4; d++){
      var m = pxAt(pos[0] + D4[d][0], pos[1] + D4[d][1]);
      if (m && isFaller(m) && m.pa !== undefined && m.pa >= pixelTicks - 2){
        var mx = m.x, my = m.y;
        if (joinPixel(b, m)) queue.push([mx, my]);
      }
    }
  }
}
function onDeleteProxy(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub]; if (!b) return;
  b.cells.delete(p.ck); b.dirty = true; b.sleep = 0;
}
function snapBody(b, aligned){
  if (aligned){
    var q = Math.PI/2; b.a = Math.round(b.a/q)*q;
    var first = b.cells.values().next().value, w = toWorld(b, first.x, first.y);
    b.x += Math.round(w.x) - w.x; b.y += Math.round(w.y) - w.y;
  }
  var R = raster(b, b.x, b.y, b.a), cells = b.cells;
  killBody(b);
  NOJOIN = true;
  for (var i = 0; i < R.gx.length; i++){
    var cell = cells.get(R.ck[i]);
    if (cell && isEmpty(R.gx[i], R.gy[i])){
      var id = elements["anchored_" + cell.e] ? "anchored_" + cell.e : cell.e;
      createPixel(id, R.gx[i], R.gy[i]);
      var p = pixelMap[R.gx[i]][R.gy[i]]; if (p && cell.c) p.color = cell.c;
    }
  }
  NOJOIN = false;
}

/* ------------------------------------------------ elements: fallers + tab */
var ids = Object.keys(elements);
ids.forEach(function(id){
  var e = elements[id];
  if (!e || e.state !== "solid" || e.tick || e.tool || e.behavior !== behaviors.WALL) return;
  if (e.category !== "solids" && e.category !== "land") return;
  if (id === "wall" || id === "border" || id === "sublevel_solid" || /^anchored_/.test(id)) return;
  FALL[id] = true;
});
Object.keys(FALL).forEach(function(id){
  var e = elements[id], a = Object.assign({}, e);
  if (Array.isArray(a.color)) a.color = a.color.slice();
  if (Array.isArray(a.behavior)) a.behavior = a.behavior.slice();
  if (a.reactions) a.reactions = JSON.parse(JSON.stringify(a.reactions));
  a.category = "anchored"; a.anchored = true; delete a.onPlace; delete a.hidden;
  a.desc = "Anchored " + id.replace(/_/g, " ") + ": identical, but never falls.";
  elements["anchored_" + id] = a;
  var prev = e.onPlace;
  e.onPlace = function(p){ if (prev) prev(p); onPlaceFaller(p); };
});
elements[PROXY] = {
  color: "#8a8f98", behavior: behaviors.WALL, category: "anchored", state: "solid", density: 9999,
  hidden: true, hardness: 1, desc: "Invisible grid footprint of a moving physics body.",
  renderer: function(pixel, ctx){}, onDelete: onDeleteProxy
};

/* ---------------------------------------------------------------- tools */
function bodyOf(p){ return (p.sub !== undefined) ? (BODIES[p.sub] || null) : null; }
elements.physlock = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Freezes a physics body in place (use again to unfreeze). It stays off-grid and rotated.",
  tool: function(p){
    var b = bodyOf(p); if (!b || b.lt === pixelTicks || (b.lt !== undefined && pixelTicks - b.lt < 20)) return;
    b.lt = pixelTicks; b.frozen = !b.frozen; b.vx = 0; b.vy = 0; b.w = 0; b.sleep = 0;
  } };
elements.physicssnap = { color: "#ffb347", category: "tools", canPlace: false,
  desc: "Snaps a physics body onto the grid as anchored blocks, exactly as its rotated shape rasterises.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, false); } };
elements.physicsalignedsnap = { color: "#6be08a", category: "tools", canPlace: false,
  desc: "Rotates a physics body to the grid perfectly, then snaps it as anchored blocks without deforming it.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, true); } };

/* --------------------------------------------------- change notifications */
function wrap(name, make){
  var o = globalThis[name];
  if (typeof o === "function" && !o.__sl){ var w = make(o); w.__sl = true; globalThis[name] = w; }
}
function quiet(p){ var e = p && elements[p.element]; return !p || p.element === PROXY || (e && (e.state === "liquid" || e.state === "gas")); }
wrap("createPixel", function(o){ return function(el, x, y){ o(el, x, y); if (el !== PROXY) mark(x, y); }; });
wrap("deletePixel", function(o){ return function(x, y){
  var p = pixelMap[x] && pixelMap[x][y], q = quiet(p); o(x, y); if (!q) mark(x, y); }; });
wrap("changePixel", function(o){ return function(pixel){
  var q = quiet(pixel); o.apply(this, arguments); if (!q || !quiet(pixel)) mark(pixel.x, pixel.y); }; });
wrap("movePixel", function(o){ return function(pixel, x, y){
  var q = quiet(pixel), ox = pixel.x, oy = pixel.y; o.apply(this, arguments); if (!q){ mark(ox, oy); mark(x, y); } }; });
wrap("swapPixels", function(o){ return function(a, b){
  var q = quiet(a) && quiet(b), ax = a.x, ay = a.y, bx = b.x, by = b.y; o(a, b); if (!q){ mark(ax, ay); mark(bx, by); } }; });

/* --------------------------------------------------------------- hooks */
runEveryTick(function(){
  processSupport();
  var list = Object.keys(BODIES);
  for (var i = 0; i < list.length; i++){ var b = BODIES[list[i]]; if (b) stepBody(b); }
});
runPerPixel(function(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub];                       // orphan proxy (e.g. after load): becomes a normal block again
  if (!b || b.proxies.get(GK(p.x, p.y)) !== p){
    p.sub = undefined;
    if (p.pe && elements[p.pe]){ NOJOIN = true; changePixel(p, p.pe); NOJOIN = false; } else p.del = true;
  }
});
runAfterReset(function(){ BODIES = {}; dirty.clear(); });
renderPostPixel(function(ctx){
  var ps = pixelSize, keys = Object.keys(BODIES);
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b) continue;
    ctx.save(); ctx.globalAlpha = 1;
    ctx.translate((b.x + 0.5)*ps, (b.y + 0.5)*ps); ctx.rotate(b.a);
    var cm = b.com, size = ps + 0.7;
    b.cells.forEach(function(c){
      ctx.fillStyle = c.c || "#999999";
      ctx.fillRect((c.x - cm.x - 0.5)*ps - 0.35, (c.y - cm.y - 0.5)*ps - 0.35, size, size);
    });
    if (b.frozen){ ctx.strokeStyle = "rgba(123,220,255,0.9)"; ctx.lineWidth = 1; ctx.strokeRect(-ps*b.rad, -ps*b.rad, ps*2*b.rad, ps*2*b.rad); }
    ctx.restore();
  }
});

if (typeof globalThis !== "undefined" && globalThis.__SUBLEVEL_TEST__){
  globalThis.__SUBLEVEL_TEST__ = { BODIES: function(){ return BODIES; }, FALL: FALL, physOf: physOf, processSupport: processSupport,
    stepBody: stepBody, K: K, snapBody: snapBody, bodyFromPixels: bodyFromPixels };
}
if (typeof logMessage === "function") logMessage("Sublevel Physics v2 loaded: solids now fall when unsupported. See the Anchored tab and physlock / physicssnap / physicsalignedsnap tools.");
})();
