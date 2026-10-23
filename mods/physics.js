/* ============================================================================
   SUBLEVEL PHYSICS  -  true off-grid rotating rigid bodies for Sandboxels 1.13.x

   * Physics blocks are solid walls. POWER any pixel of a chunk (wire, shock,
     battery) -> the whole connected chunk unhooks from the grid into a
     "sublevel": a rigid body with a continuous position, ANGLE, velocity and
     spin. It is drawn rotated, off the grid.
   * Collision/contact with the grid uses impulses (normal + friction, bounce,
     torque), so bodies tumble, topple, roll off edges and come to rest.
   * Invisible proxy pixels follow the body inside the normal grid, so water,
     sand, fire, wires etc. treat it as a solid. Bodies push water/gas/loose
     sand out of the way, and displaced matter is conserved.
   * Buoyancy: Archimedes force + torque from the submerged volume, so wood
     floats upright on waves, steel sinks, foam bobs, boats can be built.
   * Place more physics material touching a body (even rotated) -> it joins the
     body on the body's own rotated grid. Erase part of a body -> cells vanish
     and disconnected pieces split into separate bodies that keep their motion.
   * Hard impacts snap cells off (debris) and can smash breakable terrain.
   * Normal grid pixels resting on a moving body are carried by it (cargo) and
     slide/fall off when it tilts.
   ========================================================================== */
(function () {

var G = 0.09, MAXV = 3.0, MAXW = 0.22;
var PHYS = {};                       // element id -> physics parameters
var BODIES = {};
var PROXY = "sublevel_solid", DEBRIS = "phys_debris";
var baseId = Math.floor(Math.random()*1e8) * 100, idc = 1;
var NOJOIN = false;
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
  var m = 0, cx = 0, cy = 0, bo = 0, fr = 0, hd = 0, gg = 0, thr = 0, n = b.cells.size;
  if (!n){ b.m = 0; return; }
  b.cells.forEach(function(c){
    var P = PHYS[c.e]; m += P.dens; cx += P.dens*c.x; cy += P.dens*c.y;
    bo += P.bounce; fr += P.fric; hd += P.hard; gg += P.g; if (P.thr) thr++;
  });
  var ncx = cx/m, ncy = cy/m;
  if (keepWorld){                      // keep every cell exactly where it is in the world
    var ow = toWorld(b, ncx, ncy), rx = ow.x - b.x, ry = ow.y - b.y;
    b.vx += -b.w*ry; b.vy += b.w*rx;
    b.x = ow.x; b.y = ow.y;
  }
  b.com.x = ncx; b.com.y = ncy;
  var I = 0, rad = 0;
  b.cells.forEach(function(c){
    var P = PHYS[c.e], dx = c.x - ncx, dy = c.y - ncy;
    I += P.dens*(dx*dx + dy*dy + 1/6);
    rad = Math.max(rad, Math.sqrt(dx*dx + dy*dy) + 0.75);
  });
  b.m = m; b.I = Math.max(I, 1e-3); b.bounce = bo/n; b.fric = fr/n; b.hard = hd/n;
  b.g = gg/n; b.hasThr = thr > 0; b.rad = rad;
}
function makeBody(cells, ang, vx, vy, w, gf){
  var b = { id: baseId + (idc++), cells: cells, x: 0, y: 0, a: ang || 0, vx: vx || 0, vy: vy || 0,
    w: w || 0, gf: gf || 1, com: { x:0, y:0 }, proxies: new Map(), dirty: false, sleep: 0, sleepT: 0,
    rest: 0, wet: 0, debris: [], dead: false, stuck: false, touch: false, plow: 0 };
  calc(b);
  BODIES[b.id] = b;
  return b;
}
function raster(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad, cm = b.com;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [], ck: [] };
  for (var gx = gx0; gx <= gx1; gx++){
    for (var gy = gy0; gy <= gy1; gy++){
      var dx = gx - x, dy = gy - y;
      var k = K(Math.round(dx*c + dy*s + cm.x), Math.round(-dx*s + dy*c + cm.y));
      if (b.cells.has(k)){ out.gx.push(gx); out.gy.push(gy); out.ck.push(k); }
    }
  }
  return out;
}

/* ----------------------------------------------------- grid obstacle test */
/* 0 free, 1 terrain (hard), 2 other body (hard), 3 soft (plowed aside) */
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
function contacts(b, x, y, a, speed){
  var R = raster(b, x, y, a), n = 0, sx = 0, sy = 0, hits = [], other = null, plow = 0;
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
  if (nx*tx + ny*ty < -0.2) { nx = -nx; ny = -ny; }       // always point obstacle -> body
  return { x:nx, y:ny };
}

/* -------------------------------------------------------------- impulses */
function impulse(b, c, n){
  var rx = c.cx - b.x, ry = c.cy - b.y;
  var vcx = b.vx - b.w*ry, vcy = b.vy + b.w*rx;
  var o = c.other, invm2 = 0, invI2 = 0, orx = 0, ory = 0, ovx = 0, ovy = 0;
  if (o){
    orx = c.cx - o.x; ory = c.cy - o.y;
    ovx = o.vx - o.w*ory; ovy = o.vy + o.w*orx;
    invm2 = 1/o.m; invI2 = 1/o.I;
  }
  var rvx = vcx - ovx, rvy = vcy - ovy, vn = rvx*n.x + rvy*n.y;
  if (vn >= 0) return 0;
  var e = Math.abs(vn) < 0.12 ? 0 : (o ? Math.min(b.bounce, o.bounce) : b.bounce);
  var rn = rx*n.y - ry*n.x, orn = orx*n.y - ory*n.x;
  var den = 1/b.m + rn*rn/b.I + invm2 + orn*orn*invI2;
  var j = -(1+e)*vn/den;
  b.vx += j*n.x/b.m; b.vy += j*n.y/b.m; b.w += rn*j/b.I;
  if (o){ o.vx -= j*n.x*invm2; o.vy -= j*n.y*invm2; o.w -= orn*j*invI2; o.sleep = 0; }
  // friction along the surface
  var tx = -n.y, ty = n.x;
  vcx = b.vx - b.w*ry; vcy = b.vy + b.w*rx;
  if (o){ ovx = o.vx - o.w*ory; ovy = o.vy + o.w*orx; } 
  var vt = (vcx - ovx)*tx + (vcy - ovy)*ty;
  var rt = rx*ty - ry*tx, ort = orx*ty - ory*tx;
  var dent = 1/b.m + rt*rt/b.I + invm2 + ort*ort*invI2;
  var jt = -vt/dent, mu = o ? Math.sqrt(b.fric*o.fric) : b.fric, mx = mu*j;
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
    var w = toWorld(b, cell.x, cell.y);
    b.debris.push([Math.round(w.x), Math.round(w.y), PHYS[cell.e].debris]);
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
    var pb = Math.min(0.75, power*0.22) * (1 - PHYS[cell.e].hard) * (0.4 + tH);
    if (chance(pb)) removeCell(b, k, true);
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
    var n = normalAt(b, c, spd);
    var s = impulse(b, c, n);
    if (s > 0 && !damaged){ damaged = true; damage(b, c, s); if (!b.cells.size){ return; } }
    var moved = 0;
    while (c.n > 0 && moved < 12){
      nx += n.x*0.15; ny += n.y*0.15; moved++;
      c = contacts(b, nx, ny, na, spd);
    }
    if (c.n === 0){ ok = true; break; }
    c = contacts(b, nx, ny, na, spd);
  }
  if (ok){ b.x = nx; b.y = ny; b.a = na; b.w *= 0.995; }
  else { b.stuck = true; }                               // stay on the last valid pose
}
function escape(b){
  for (var r = 1; r <= 8; r++){
    for (var d = 0; d < 8; d++){
      var ang = d*Math.PI/4, x = b.x + Math.cos(ang)*r*0.5, y = b.y + Math.sin(ang)*r*0.5;
      if (contacts(b, x, y, b.a, 0).n === 0){ b.x = x; b.y = y; return true; }
    }
  }
  return false;
}
function fluidInfo(b, R){
  var rows = {}, cols = {}, i, gx, gy, k, p;
  for (i = 0; i < R.gx.length; i++){
    gx = R.gx[i]; gy = R.gy[i];
    var r = rows[gy]; if (!r) rows[gy] = [gx,gx]; else { if (gx < r[0]) r[0] = gx; if (gx > r[1]) r[1] = gx; }
    var c = cols[gx]; if (!c) cols[gx] = [gy,gy]; else { if (gy < c[0]) c[0] = gy; if (gy > c[1]) c[1] = gy; }
  }
  var rw = {}, cw = {}, rho = 0, rn = 0;
  for (k in rows){ p = liq(rows[k][0]-1, +k) || liq(rows[k][1]+1, +k); if (p){ rw[k] = 1; rho += elements[p.element].density; rn++; } }
  for (k in cols){ p = liq(+k, cols[k][0]-1); if (p){ cw[k] = 1; rho += elements[p.element].density; rn++; } }
  var cnt = 0, sx = 0, sy = 0;
  for (i = 0; i < R.gx.length; i++) if (rw[R.gy[i]] || cw[R.gx[i]]){ cnt++; sx += R.gx[i]; sy += R.gy[i]; }
  return { n:cnt, cx: cnt ? sx/cnt : b.x, cy: cnt ? sy/cnt : b.y, rho: rn ? rho/rn : 1000 };
}

/* ------------------------------------------------------------- proxies */
function relocate(o, gx, gy, want){
  for (var r = 1; r <= 8; r++){
    var cand = [];
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++){
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = gx + dx, y = gy + dy;
      if (outOfBounds(x,y) || pixelMap[x][y] !== undefined || want.has(GK(x,y))) continue;
      cand.push([x,y]);
    }
    if (cand.length){
      var t = pick(cand);
      pixelMap[o.x][o.y] = undefined; o.x = t[0]; o.y = t[1]; pixelMap[t[0]][t[1]] = o;
      return true;
    }
  }
  pixelMap[o.x][o.y] = undefined; o.del = true;            // nowhere to go (extremely rare)
  return false;
}
function syncProxies(b){
  var R = raster(b, b.x, b.y, b.a), want = new Map(), i, spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  for (i = 0; i < R.gx.length; i++) want.set(GK(R.gx[i], R.gy[i]), i);
  var spare = [];
  b.proxies.forEach(function(pix, gk){
    var valid = !pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix && pix.sub === b.id;
    if (valid && pix.element !== PROXY){                  // something transformed it (acid, fire...)
      b.cells.delete(pix.ck); b.dirty = true; pix.sub = undefined; b.proxies.delete(gk); return;
    }
    if (valid && want.has(gk)){
      pix.ck = R.ck[want.get(gk)]; want.delete(gk);
      if (pix.charge){ var cl = b.cells.get(pix.ck); if (cl) cl.pw = 6; }
    } else {
      b.proxies.delete(gk);
      if (valid){ pixelMap[pix.x][pix.y] = undefined; spare.push(pix); }
    }
  });
  want.forEach(function(idx, gk){
    var gx = R.gx[idx], gy = R.gy[idx], o = pixelMap[gx][gy];
    if (o){
      if (blocker(b, gx, gy, spd) === 1 || blocker(b, gx, gy, spd) === 2) return;  // overlap tolerated
      relocate(o, gx, gy, want);
    }
    var pix = spare.pop();
    if (pix){ pix.x = gx; pix.y = gy; pix.del = false; pixelMap[gx][gy] = pix; }
    else { createPixel(PROXY, gx, gy); pix = pixelMap[gx][gy]; if (!pix) return; }
    pix.sub = b.id; pix.ck = R.ck[idx];
    var cell = b.cells.get(pix.ck); pix.pe = cell ? cell.e : undefined;
    if (cell && pix.charge) cell.pw = 6;
    b.proxies.set(gk, pix);
  });
  for (i = 0; i < spare.length; i++){ spare[i].sub = undefined; spare[i].del = true; }
}
function releaseProxies(b){
  b.proxies.forEach(function(pix){
    if (!pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix) pixelMap[pix.x][pix.y] = undefined;
    pix.sub = undefined; pix.del = true;
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
  if (comps.length === 1){ calc(b, true); b.sleep = 0; return; }
  var created = [];
  comps.forEach(function(keys){
    var cells = new Map();
    keys.forEach(function(k){ cells.set(k, b.cells.get(k)); });
    var nb = makeBody(cells, b.a, b.vx, b.vy, b.w, b.gf);
    var w = toWorld(b, nb.com.x, nb.com.y), rx = w.x - b.x, ry = w.y - b.y;
    nb.x = w.x; nb.y = w.y; nb.vx = b.vx - b.w*ry; nb.vy = b.vy + b.w*rx;
    created.push(nb);
  });
  killBody(b);
  var cx = 0, cy = 0; created.forEach(function(n){ cx += n.x; cy += n.y; });
  cx /= created.length; cy /= created.length;
  created.forEach(function(n){                              // pieces drift apart slightly
    var dx = n.x - cx, dy = n.y - cy, l = Math.sqrt(dx*dx + dy*dy) || 1;
    n.vx += dx/l*0.08; n.vy += dy/l*0.08;
    syncProxies(n);
  });
}

/* ------------------------------------------------------ the body stepper */
function stepBody(b){
  if (b.dead) return;
  if (b.dirty){ fixBody(b); if (b.dead) return; }
  if (b.sleep){
    b.sleepT++; if (b.sleepT % 5 !== 0) return;
    var gs0 = (b.g*b.gf) >= 0 ? 1 : -1;
    if (contacts(b, b.x, b.y + 0.3*gs0, b.a, 0).n === 0) b.sleep = 0; else return;
  }
  if (b.stuck){ b.stuck = false; escape(b); }
  var R0 = raster(b, b.x, b.y, b.a);
  var ax = 0, ay = b.g*b.gf*G, tq = 0, thrusting = false;
  var fl = fluidInfo(b, R0); b.wet = fl.n;
  if (fl.n > 0){
    var Fb = fl.rho*fl.n*G, frac = fl.n/b.cells.size;
    ay -= Fb/b.m; tq -= (fl.cx - b.x)*Fb;
    b.vx *= 1 - 0.05*frac; b.vy *= 1 - 0.05*frac; b.w *= 1 - 0.1*frac;
  }
  if (b.hasThr){
    var ca = Math.cos(b.a), sa = Math.sin(b.a);
    b.cells.forEach(function(cell){
      var P = PHYS[cell.e]; if (!P.thr) return;
      if (cell.pw > 0){
        cell.pw--; thrusting = true;
        var dx = P.thr[0]*ca - P.thr[1]*sa, dy = P.thr[0]*sa + P.thr[1]*ca;
        var Fx = dx*P.force, Fy = dy*P.force, w = toWorld(b, cell.x, cell.y);
        ax += Fx/b.m; ay += Fy/b.m; tq += (w.x - b.x)*Fy - (w.y - b.y)*Fx;
        var ex = Math.round(w.x - dx*1.4), ey = Math.round(w.y - dy*1.4);
        if (chance(0.5) && isEmpty(ex, ey)) createPixel("fire", ex, ey);
      }
    });
  }
  b.vx += ax; b.vy += ay; b.w += tq/b.I; b.w *= 0.998;
  if (b.vx > MAXV) b.vx = MAXV; else if (b.vx < -MAXV) b.vx = -MAXV;
  if (b.vy > MAXV) b.vy = MAXV; else if (b.vy < -MAXV) b.vy = -MAXV;
  if (b.w > MAXW) b.w = MAXW; else if (b.w < -MAXW) b.w = -MAXW;

  var rr = Math.sqrt(b.vx*b.vx + b.vy*b.vy) + Math.abs(b.w)*b.rad;
  var n = Math.min(8, Math.max(1, Math.ceil(rr/0.45))), h = 1/n;
  b.touch = false; b.plow = 0;
  for (var s = 0; s < n; s++){ moveSub(b, h); if (!b.cells.size){ b.dirty = true; break; } }
  if (b.plow > 0){ var d = Math.max(0.6, 1 - 0.015*b.plow/n); b.vx *= d; b.vy *= d; b.w *= d; }
  if (!b.cells.size){ killBody(b); return; }
  syncProxies(b);
  if (b.debris.length){
    b.debris.forEach(function(d){ if (isEmpty(d[0], d[1]) && elements[d[2]]) createPixel(d[2], d[0], d[1]); });
    b.debris.length = 0;
  }
  carry(b);
  var spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  if (b.touch && b.wet === 0 && !b.hasThr && spd < 0.05 && Math.abs(b.w) < 0.01 && !b.dirty) b.rest++;
  else b.rest = 0;
  if (b.rest > 30){ b.sleep = 1; b.sleepT = 0; b.vx = 0; b.vy = 0; b.w = 0; b.rest = 0; }
}
/* cargo: loose solid pixels resting on the body ride along with it */
function carry(b){
  if (Math.abs(b.vx) + Math.abs(b.w)*b.rad < 0.03) return;
  b.proxies.forEach(function(pix, gk){
    var p = pxAt(pix.x, pix.y - 1);
    if (!p || p.sub !== undefined || p.del) return;
    var e = elements[p.element];
    if (!e || e.state !== "solid" || e.movable !== true) return;
    var vs = b.vx - b.w*(pix.y - b.y);
    p.rq = (p.rq || 0) + vs;
    if (Math.abs(p.rq) >= 1){
      var dir = sign(p.rq);
      if (isEmpty(p.x + dir, p.y)) movePixel(p, p.x + dir, p.y);
      p.rq -= dir;
    }
  });
}

/* --------------------------------------------- unhook / lock / join / erase */
function activate(p){
  var list = [p], seen = new Set([p]), q = [p];
  while (q.length){
    var c = q.pop();
    for (var d = 0; d < 4; d++){
      var n = pxAt(c.x + D4[d][0], c.y + D4[d][1]);
      if (n && n.sub === undefined && !n.del && PHYS[n.element] && !seen.has(n)){ seen.add(n); list.push(n); q.push(n); }
    }
  }
  var ax = p.x, ay = p.y, cells = new Map();
  list.forEach(function(q2){
    cells.set(K(q2.x - ax, q2.y - ay), { x: q2.x - ax, y: q2.y - ay, e: q2.element, c: q2.color, pw: q2.charge ? 6 : 0 });
  });
  list.forEach(function(q2){ if (pixelMap[q2.x][q2.y] === q2) pixelMap[q2.x][q2.y] = undefined; q2.del = true; });
  var b = makeBody(cells, 0, 0, 0, 0, 1);
  b.x = ax + b.com.x; b.y = ay + b.com.y;
  syncProxies(b);
  return b;
}
function lockBody(b){
  var R = raster(b, b.x, b.y, b.a), cells = b.cells;
  killBody(b);
  NOJOIN = true;
  for (var i = 0; i < R.gx.length; i++){
    var cell = cells.get(R.ck[i]);
    if (cell && isEmpty(R.gx[i], R.gy[i])){
      createPixel(cell.e, R.gx[i], R.gy[i]);
      var p = pixelMap[R.gx[i]][R.gy[i]]; if (p && cell.c) p.color = cell.c;
    }
  }
  NOJOIN = false;
}
function onPlacePhys(pixel){
  if (NOJOIN || pixel.sub !== undefined) return;
  var b = null, d, x, y;
  for (x = -1; x <= 1 && !b; x++) for (y = -1; y <= 1 && !b; y++){
    if (!x && !y) continue;
    var n = pxAt(pixel.x + x, pixel.y + y);
    if (n && n.sub !== undefined && BODIES[n.sub]) b = BODIES[n.sub];
  }
  if (!b) return;
  var l = toLocal(b, pixel.x, pixel.y), lx = Math.round(l.x), ly = Math.round(l.y);
  if (b.cells.has(K(lx, ly))){                          // seam case: nearest free neighbouring cell
    var best = null, bd = 1e9;
    for (d = 0; d < 4; d++){
      var cx = lx + D4[d][0], cy = ly + D4[d][1];
      if (b.cells.has(K(cx, cy))) continue;
      var dd = (cx - l.x)*(cx - l.x) + (cy - l.y)*(cy - l.y);
      if (dd < bd){ bd = dd; best = [cx, cy]; }
    }
    if (!best) return;
    lx = best[0]; ly = best[1];
  }
  b.cells.set(K(lx, ly), { x: lx, y: ly, e: pixel.element, c: pixel.color, pw: 0 });
  pixelMap[pixel.x][pixel.y] = undefined; pixel.del = true;
  b.dirty = true; b.sleep = 0;
}
function onDeleteProxy(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub]; if (!b) return;
  b.cells.delete(p.ck); b.dirty = true; b.sleep = 0;
}

/* ------------------------------------------------------------- elements */
function phys(id, color, p, desc, extra){
  PHYS[id] = p;
  elements[id] = Object.assign({
    color: color, behavior: behaviors.WALL, category: "physics", state: "solid",
    density: p.dens, conduct: 0.9, hardness: p.hard, desc: desc, onPlace: onPlacePhys
  }, extra || {});
}
elements[PROXY] = {
  color: "#8a8f98", behavior: behaviors.WALL, category: "physics", state: "solid", density: 9999,
  hidden: true, conduct: 0.9, hardness: 1, desc: "Invisible grid footprint of a moving physics body.",
  renderer: function(pixel, ctx){}, onDelete: onDeleteProxy
};
elements[DEBRIS] = {
  color: ["#8a8f98","#6f747c","#a3a8b0"], behavior: behaviors.POWDER, category: "physics",
  state: "solid", density: 1800, hidden: true, desc: "Broken bits of physics blocks."
};
phys("phys_block", ["#5c7fa8","#6a8db5"], { dens:1500, bounce:0.15, hard:0.6, g:1, fric:0.5, debris:DEBRIS },
  "Solid wall. Power it with electricity and the whole chunk becomes a free, rotating physics object.");
phys("phys_rubber", ["#e0405a","#c9344d"], { dens:900, bounce:0.85, hard:0.8, g:1, fric:0.8, debris:DEBRIS },
  "Very bouncy and tough.");
phys("phys_superball", ["#b050ff","#c77dff"], { dens:1100, bounce:0.97, hard:0.9, g:1, fric:0.3, debris:DEBRIS },
  "Almost perfectly elastic. Bounces practically forever.");
phys("phys_jelly", ["#5fe08a","#4ed17a"], { dens:1050, bounce:0.55, hard:0.7, g:1, fric:0.9, debris:DEBRIS },
  "Medium bounce, very grippy.");
phys("phys_steel", ["#9aa3ad","#8a939d"], { dens:7800, bounce:0.05, hard:0.95, g:1, fric:0.4, debris:DEBRIS },
  "Very heavy, nearly unbreakable. Sinks in water and smashes things.");
phys("phys_stone", ["#8c8478","#7d766b"], { dens:2600, bounce:0.08, hard:0.8, g:1, fric:0.7, debris:DEBRIS },
  "Heavy and strong, hardly bounces.");
phys("phys_glass", ["#9fe8f2","#b9f3fa"], { dens:2500, bounce:0.1, hard:0.15, g:1, fric:0.4, debris:"glass_shard" },
  "Brittle. Shatters on hard impacts.");
phys("phys_wood", ["#b5823f","#a67537"], { dens:650, bounce:0.2, hard:0.5, g:1, fric:0.6, debris:DEBRIS },
  "Floats on water, rides waves. Flammable while static.", { burn: 15, burnTime: 300, burnInto: "ash" });
phys("phys_foam", ["#ffe36b","#ffd84a"], { dens:150, bounce:0.25, hard:0.3, g:1, fric:0.5, debris:DEBRIS },
  "Super light. Floats high on liquids, breaks easily.");
phys("phys_ice", ["#bfeaff","#d6f2ff"], { dens:920, bounce:0.3, hard:0.35, g:1, fric:0.02, debris:DEBRIS },
  "Floats, slides almost without friction. Melts while static.", { tempHigh: 5, stateHigh: "water" });
phys("phys_balloon", ["#ff5252","#ff7070"], { dens:40, bounce:0.6, hard:0.3, g:-0.45, fric:0.4, debris:DEBRIS },
  "Lighter than air. Falls UP.");
function thruster(id, tx, ty, label){
  phys(id, ["#ff8a3d","#ff9d5c"], { dens:3000, bounce:0.05, hard:0.85, g:1, fric:0.5, debris:DEBRIS, thr:[tx,ty], force:6 },
    "Rocket engine pushing " + label + " (in the body's own rotated frame) while electrically powered. Off-centre engines make it spin.");
}
thruster("phys_thruster_up", 0, -1, "up");
thruster("phys_thruster_down", 0, 1, "down");
thruster("phys_thruster_left", -1, 0, "left");
thruster("phys_thruster_right", 1, 0, "right");

/* ---------------------------------------------------------------- tools */
function bodyOf(p){ return (p.sub !== undefined) ? (BODIES[p.sub] || null) : null; }
elements.phys_release = { color: "#4dd2ff", category: "tools", canPlace: false,
  desc: "Unhooks a physics chunk from the grid without needing electricity.",
  tool: function(p){ if (PHYS[p.element] && p.sub === undefined) activate(p); } };
elements.phys_lock = { color: "#ff6b6b", category: "tools", canPlace: false,
  desc: "Snaps a moving physics body back onto the grid as static blocks.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) lockBody(b); } };
elements.phys_kick = { color: "#ffd24d", category: "tools", canPlace: false,
  desc: "Hits a physics body at that spot: shoves it up and sideways and spins it.",
  tool: function(p){
    var b = bodyOf(p); if (!b || b.kt === pixelTicks) return; b.kt = pixelTicks;
    var dvx = (Math.random()*2 - 1)*0.9, dvy = -1.5*sign(b.gf), rx = p.x - b.x, ry = p.y - b.y;
    b.vx += dvx; b.vy += dvy; b.w += b.m*(rx*dvy - ry*dvx)/b.I; b.sleep = 0;
  } };
elements.phys_spin = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Gives a physics body a burst of spin.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.st !== undefined && pixelTicks - b.st < 10)) return;
    b.st = pixelTicks; b.w += (chance(0.5) ? 1 : -1)*0.08; b.sleep = 0;
  } };
elements.phys_flip = { color: "#c792ff", category: "tools", canPlace: false,
  desc: "Flips the gravity direction of a physics body.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.ft !== undefined && pixelTicks - b.ft < 15)) return;
    b.ft = pixelTicks; b.gf = -b.gf; b.sleep = 0;
  } };

/* --------------------------------------------------------------- hooks */
runEveryTick(function(){
  var list = Object.keys(BODIES);
  for (var i = 0; i < list.length; i++){ var b = BODIES[list[i]]; if (b) stepBody(b); }
});
runPerPixel(function(p){
  if (p.sub !== undefined){                 // orphan proxy (after a save/load): becomes a normal static block
    var b = BODIES[p.sub];
    if (!b || b.proxies.get(GK(p.x, p.y)) !== p){
      p.sub = undefined;
      if (p.pe && elements[p.pe]) { NOJOIN = true; changePixel(p, p.pe); NOJOIN = false; }
      else p.del = true;
    }
  }
  else if (p.charge && PHYS[p.element]) activate(p);
});
runAfterReset(function(){ BODIES = {}; });
renderPostPixel(function(ctx){
  var ps = pixelSize, ids = Object.keys(BODIES);
  for (var i = 0; i < ids.length; i++){
    var b = BODIES[ids[i]]; if (!b) continue;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.translate((b.x + 0.5)*ps, (b.y + 0.5)*ps);
    ctx.rotate(b.a);
    var cm = b.com, size = ps + 0.7;
    b.cells.forEach(function(c){
      ctx.fillStyle = c.pw > 0 ? "#fff3a0" : (c.c || "#999999");
      ctx.fillRect((c.x - cm.x - 0.5)*ps - 0.35, (c.y - cm.y - 0.5)*ps - 0.35, size, size);
    });
    ctx.restore();
  }
});

if (typeof globalThis !== "undefined" && globalThis.__SUBLEVEL_TEST__){
  globalThis.__SUBLEVEL_TEST__ = { BODIES: function(){ return BODIES; }, makeBody: makeBody, syncProxies: syncProxies,
    PHYS: PHYS, activate: activate, stepBody: stepBody, K: K, toLocal: toLocal, toWorld: toWorld, calc: calc, lockBody: lockBody };
}
if (typeof logMessage === "function") logMessage("Sublevel Physics loaded - see the Physics category.");
})();
