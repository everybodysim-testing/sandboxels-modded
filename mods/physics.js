/* ============================================================================
   SUBLEVEL PHYSICS v6  -  Sandboxels 1.13.x
   (rebased on v3 + the parts of v5 that were sound; everything behaves the way
   a player expects: no surprise names, no broken textures, bodies burn)

   * ALL solids in the Solids tab fall when unsupported: the whole connected
     chunk unhooks from the grid into a free rotating rigid body. Checked when
     something within 3 pixels of a solid breaks/changes (plus a slow sweep).
   * Every solid keeps its own physics numbers (density, bounce, friction,
     toughness) derived from the element itself + its name.
   * "Anchored" tab: copies of the solids that can never fall.
   * Bodies float by Archimedes (hollow cups/boats count their enclosed air,
     and carried water stays inside them), bounce, tumble, break on hard hits,
     and push water/sand aside. Sand/water barely overlapped by a rotated body
     stays where it is (no ugly gaps at the ragged edge).
   * Placing solids touching a body (also with big brushes, same stroke) adds
     them to it, and the body is held still while you build. Erasing cuts it.
   * Tools:  physkick (shove + spin), physspin (spin), physicsflip (flip gravity),
             physicsgrab (drag), physicsdisintegrate (body -> loose grains),
             physicsfreeze/unfreeze, physicsgrab (drag bodies),
             physicsdisintegrate (body -> loose physics_grain pixels),
             physicssnap (back to anchored grid blocks, as drawn),
             physicsalignedsnap (rotate to the grid first, then snap)
   * Vanilla interactions: acid dissolves, CH/DL behaviors convert/carve body cells,
     and body cells BURN like their grid twins (fire spreads in and out of the body);
     buoyancy is row-scan based so water on top no longer levitates boats.
   v6: anchored-tab blocks keep their plain names, painted glass keeps its real
       texture and outline, painting over a body repaints the cell (Replace mode
       no longer cuts the body), and the grab tool releases when the mouse goes up.
   ========================================================================== */
(function () {

var G = 0.09, MAXV = 3.0, MAXW = 0.22, HOLD = 25;
var BODIES = {}, FALL = {}, PC = {};
var PROXY = "sublevel_solid";
var baseId = Math.floor(Math.random()*1e8) * 100, idc = 1;
var NOJOIN = false, dirtyA = [], dirtyS = new Set();
var GRAB = null;                                  // grab tool state
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];
var D8 = D4.concat([[1,1],[1,-1],[-1,1],[-1,-1]]);   // all 8 neighbours connect a solid (diagonals no longer shatter)
var COV = 0.55;                                   // below this coverage a soft pixel stays put

function chance(p){ return Math.random() < p; }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
/* cell colour, exactly like the game picks it for a fresh pixel: pattern elements
   (glass, brick ...) sample their texture pattern, so painted-on glass keeps its
   streaks instead of turning into a flat ugly block */
function cellColor(E, cx, cy){
  if (E.colorPattern && cx !== undefined && E.colorPattern.length){
    var rows = E.colorPattern;
    var row = rows[((cy % rows.length) + rows.length) % rows.length];
    return row[((cx % row.length) + row.length) % row.length];
  }
  if (Array.isArray(E.color)) return pick(E.color);
  if (typeof E.color === "function"){ try { return E.color({ element: E }); } catch (err){ return "#999999"; } }
  return E.color || "#999999";
}
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
function mark(x,y){ var gk = GK(x,y); if (!dirtyS.has(gk)){ dirtyS.add(gk); dirtyA.push(gk); } }

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
    rest: 0, wet: 0, debris: [], dead: false, stuck: false, touch: false, plow: 0, hold: 0 };
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
/* 0 free, 1 terrain, 2 other body, 3 soft (plowed aside), 4 soft-graze (leave it) */
function blocker(b, gx, gy, speed, cov){
  if (outOfBounds(gx,gy)) return 1;
  var p = pixelMap[gx][gy];
  if (!p || p.sub === b.id) return 0;
  if (p.sub !== undefined) return BODIES[p.sub] ? 2 : 1;
  var e = elements[p.element];
  if (!e) return 1;
  if (e.state === "liquid" || e.state === "gas") return (cov !== undefined && cov < COV && speed <= 0.25) ? 4 : 0;
  if (e.movable === true && e.category !== "tools"){
    if (cov !== undefined && cov < COV) return 4;
    var avg = b.m / b.cells.size;
    if (speed > 1.2 || (avg > e.density*2 && speed > 0.5)) return 3;   // plow when fast, or when heavy enough to sink
    return 1;                                     // light/slow bodies rest on top of powders instead of cutting through
  }
  return 1;
}
/* collision raster: a grid cell counts if its unit square overlaps a body cell (not just its centre).
   cov[] estimates how much of the grid square the body actually covers (0..1, 5 subsamples). */
function rasterC(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad + 0.5, cm = b.com;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [], cov: [] };
  var offs = [[0,0],[0.27,0.27],[-0.27,-0.27]];    // 3 subsamples: same behaviour, ~40% cheaper (lag fix)
  for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++){
    var ins = 0;
    for (var i = 0; i < 3; i++){
      var dx = gx - x + offs[i][0], dy = gy - y + offs[i][1];
      var lx = dx*c + dy*s + cm.x, ly = -dx*s + dy*c + cm.y;
      if (b.cells.has(K(Math.round(lx), Math.round(ly)))) ins++;
    }
    if (ins > 0){ out.gx.push(gx); out.gy.push(gy); out.cov.push(ins/3); }
  }
  return out;
}
function contacts(b, x, y, a, speed){
  var R = rasterC(b, x, y, a), n = 0, sx = 0, sy = 0, hits = [], other = null, plow = 0;
  for (var i = 0; i < R.gx.length; i++){
    var t = blocker(b, R.gx[i], R.gy[i], speed, R.cov[i]);
    if (t === 0 || t === 4) continue;
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
    var t = blocker(b, gx0+dx, gy0+dy, speed, 1);
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
  for (var it = 0; it < 2 && c.n > 0; it++){
    var n = normalAt(b, c, spd), s = impulse(b, c, n);
    if (s > 0 && !damaged){ damaged = true; damage(b, c, s); if (!b.cells.size) return; }
    var moved = 0;
    while (c.n > 0 && moved < 8){ nx += n.x*0.08; ny += n.y*0.08; moved++; c = contacts(b, nx, ny, na, spd); }
    if (c.n === 0){ ok = true; break; }
  }
  if (ok){ b.x = nx; b.y = ny; b.a = na; b.w *= 0.995; } else b.stuck = true;
}
function escape(b){
  for (var r = 1; r <= 5; r++) for (var d = 0; d < 8; d++){
    var ang = d*Math.PI/4, x = b.x + Math.cos(ang)*r*0.4, y = b.y + Math.sin(ang)*r*0.4;
    if (contacts(b, x, y, b.a, 0).n === 0){ b.x = x; b.y = y; b.vx *= 0.3; b.vy *= 0.3; b.w *= 0.3; return true; }
  }
  return false;
}
/* buoyancy: submerged solid cells + enclosed dry air inside hollow hulls (cups, boats) */
function fluidInfo(b, R){
  var rows = {}, i, gx, gy, k, p, own = new Set();
  for (i = 0; i < R.gx.length; i++){
    gx = R.gx[i]; gy = R.gy[i]; own.add(GK(gx, gy));
    var r = rows[gy]; if (!r) rows[gy] = [gx,gx]; else { if (gx < r[0]) r[0] = gx; if (gx > r[1]) r[1] = gx; }
  }
  /* submersion is detected row by row (liquid level with the row's ends). Deliberately
     NOT column-based: liquid sitting on top of a floating hull used to mark whole
     columns as submerged and launch the body into the air. */
  var rw = {}, rho = 0, rn = 0;
  for (k in rows){ p = liq(rows[k][0]-1, +k) || liq(rows[k][1]+1, +k); if (p){ rw[k] = 1; rho += elements[p.element].density; rn++; } }
  var cnt = 0, sx = 0, sy = 0;
  for (i = 0; i < R.gx.length; i++) if (rw[R.gy[i]]){ cnt++; sx += R.gx[i]; sy += R.gy[i]; }
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
  var E0 = elements[o.element], isL = E0 && E0.state === "liquid";
  for (var pass = 0; pass < 2; pass++){            // pass 2 also allows upwards (better than destroying the pixel)
    for (var r = 1; r <= (isL ? 6 : 12); r++){
      var cand = [];
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++){
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (pass === 0 && dy < 0) continue;        // first choice: sideways or down, never lifted up
        var x = gx + dx, y = gy + dy;
        if (outOfBounds(x,y) || pixelMap[x][y] !== undefined || want.has(GK(x,y))) continue;
        if (rr && rr[y] && x > rr[y][0] && x < rr[y][1]) continue;          // never into a hull's dry interior
        cand.push([x,y]);
      }
      if (!cand.length) continue;
      if (isL){
        var wetc = cand.filter(function(q){        // displaced liquid goes next to other liquid
          for (var d = 0; d < 4; d++){ var n = pxAt(q[0] + D4[d][0], q[1] + D4[d][1]);
            if (n && n.sub === undefined && elements[n.element] && elements[n.element].state === "liquid") return true; }
          return false; });
        if (wetc.length) cand = wetc;
        cand.sort(function(a, c){                  // sideways or down first - displaced water is never lifted up
          var sa = Math.abs(a[0]-gx) + (a[1] < gy ? (gy-a[1])*2.5 : a[1]-gy);
          var sc = Math.abs(c[0]-gx) + (c[1] < gy ? (gy-c[1])*2.5 : c[1]-gy);
          return sa - sc;
        });
        var t = cand[0];
      }
      else var t = pick(cand);
      pixelMap[o.x][o.y] = undefined; o.x = t[0]; o.y = t[1]; pixelMap[t[0]][t[1]] = o; return true;
    }
  }
  return false;   // nowhere to go: the pixel stays where it is and the body just draws over it (no holes)
}
function syncProxies(b){
  /* bodies that have not moved since the last sync skip the whole raster pass (lag fix) */
  if (b._sx1 !== undefined && b._sx1 === b.x && b._sy1 === b.y && b._sa1 === b.a && !b.dirty) return;
  b._sx1 = b.x; b._sy1 = b.y; b._sa1 = b.a;
  var R = raster(b, b.x, b.y, b.a), RC = rasterC(b, b.x, b.y, b.a);
  var want = new Map(), cov = {}, i, spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  for (i = 0; i < RC.gx.length; i++) cov[GK(RC.gx[i], RC.gy[i])] = RC.cov[i];
  var rr = {};
  for (i = 0; i < R.gx.length; i++){
    want.set(GK(R.gx[i], R.gy[i]), i);
    var q = rr[R.gy[i]]; if (!q) rr[R.gy[i]] = [R.gx[i], R.gx[i]]; else { if (R.gx[i] < q[0]) q[0] = R.gx[i]; if (R.gx[i] > q[1]) q[1] = R.gx[i]; }
  }
  var spare = [];
  b.proxies.forEach(function(pix, gk){
    var valid = !pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix && pix.sub === b.id;
    if (valid && pix.element !== PROXY){
      /* the footprint pixel was replaced (a mod, a save edit, a stray effect):
         a painted solid becomes that cell's element, anything else replaces the
         cell - the painted pixel is never silently thrown away (that left holes) */
      var P2 = elements[pix.element], cell = b.cells.get(pix.ck);
      if (cell && P2 && !P2.tool && P2.canPlace !== false && (P2.state === "solid" || P2.state === undefined)){
        cell.e = pix.element; cell.c = cellColor(P2, cell.x, cell.y);
        b.pend = true; b.sleep = 0;
      } else if (cell) cellEject(b, pix, cell, pix.element);
      if (!cell || !b.cells.get(pix.ck)){ b.proxies.delete(gk); return; }
      pixelMap[pix.x][pix.y] = undefined;
      createPixel(PROXY, pix.x, pix.y);
      var np = pixelMap[pix.x][pix.y];
      if (np){ np.sub = b.id; np.ck = pix.ck; np.pe = cell.e; b.proxies.set(gk, np); }
      return;
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
      var bt = blocker(b, gx, gy, spd, cov[gk] !== undefined ? cov[gk] : 1);
      if (bt === 1 || bt === 2) return;           // terrain / another body: cell stays untracked
      if (bt === 4) return;                       // barely covered soft pixel: leave it, body draws over it
      if (!relocate(o, gx, gy, want, rr)) return; // nowhere to push it: leave the pixel (no holes)
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
/* 8-connected: all 9 pixels around a pixel count as touching, so 1-thick diagonal
   lines stay one body instead of shattering into single pixels */
function components(b){
  var seen = new Set(), out = [];
  b.cells.forEach(function(cell, k){
    if (seen.has(k)) return;
    var comp = [], q = [cell]; seen.add(k);
    while (q.length){
      var c = q.pop(); comp.push(K(c.x, c.y));
      for (var d = 0; d < 8; d++){
        var nk = K(c.x + D8[d][0], c.y + D8[d][1]), nc = b.cells.get(nk);
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
    nb.hold = b.hold; nb.frozen = b.frozen;
    created.push(nb);
  });
  killBody(b);
  var cx = 0, cy = 0; created.forEach(function(n){ cx += n.x; cy += n.y; });
  cx /= created.length; cy /= created.length;
  created.forEach(function(n){
    var dx = n.x - cx, dy = n.y - cy, l = Math.sqrt(dx*dx + dy*dy) || 1;
    if (pixelTicks >= n.hold){ n.vx += dx/l*0.08; n.vy += dy/l*0.08; }
    syncProxies(n);
  });
}

/* ------------------------------------------------------ the body stepper */
function stepBody(b){
  if (b.dead) return;
  if (b.dirty){ fixBody(b); if (b.dead) return; }
  if (b.pend){ b.pend = false; calc(b, true); }    // deferred mass recompute after painting on body cells
  if (b.frozen || pixelTicks < b.hold){ b.vx = 0; b.vy = 0; b.w = 0; return; }
  if (b.sleep){
    b.sleepT++; if (b.sleepT % 5 !== 0) return;
    var gs0 = (b.g*b.gf) >= 0 ? 1 : -1;
    if (contacts(b, b.x, b.y + 0.3*gs0, b.a, 0).n === 0) b.sleep = 0; else return;
  }
  if (b.stuck){ b.stuck = false; escape(b); }
  var R0 = raster(b, b.x, b.y, b.a);
  var grab = GRAB && GRAB.b === b && GRAB.down && !b.dead;
  var ay = b.g*b.gf*G, tq = 0;
  var fl = fluidInfo(b, R0); b.wet = grab ? 0 : fl.n;
  if (grab){                                       // grab tool: the body is dragged straight to the cursor
    var tgx = Math.max(0, Math.min(width, mousePos.x + GRAB.dx));
    var tgy = Math.max(0, Math.min(height, mousePos.y + GRAB.dy));
    b.vx = Math.max(-2.2, Math.min(2.2, (tgx - b.x)*0.5));
    b.vy = Math.max(-2.2, Math.min(2.2, (tgy - b.y)*0.5));
    b.w *= 0.7; b.sleep = 0;
  }
  else if (fl.n > 0){
    var Fb = fl.rho*fl.n*G, frac = Math.min(1, fl.n/b.cells.size);
    ay -= Fb/b.m; tq -= (fl.cx - b.x)*Fb;
    var sp = Math.sqrt(b.vx*b.vx + b.vy*b.vy), dk = Math.min(0.75, frac*(0.3 + 0.2*sp));   // heavy water drag: no bobbing
    b.vx *= 1 - dk; b.vy *= 1 - dk; b.w *= 1 - Math.min(0.6, 0.4*frac);
  }
  if (!grab){ b.vy += ay; b.w += tq/b.I; b.w *= 0.998; }
  if (b.vx > MAXV) b.vx = MAXV; else if (b.vx < -MAXV) b.vx = -MAXV;
  if (b.vy > MAXV) b.vy = MAXV; else if (b.vy < -MAXV) b.vy = -MAXV;
  if (b.w > MAXW) b.w = MAXW; else if (b.w < -MAXW) b.w = -MAXW;

  var rr = Math.sqrt(b.vx*b.vx + b.vy*b.vy) + Math.abs(b.w)*b.rad;
  var n = Math.min(6, Math.max(1, Math.ceil(rr/0.45))), h = 1/n;
  b.touch = false; b.plow = 0;
  for (var s = 0; s < n; s++){ moveSub(b, h); if (!b.cells.size){ b.dirty = true; break; } }
  if (b.plow > 0){ var d = Math.max(0.5, 1 - 0.05*b.plow/n); b.vx *= d; b.vy *= d; b.w *= d; }
  if (!b.cells.size){ killBody(b); return; }
  var spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  if (b.touch && b.wet === 0 && !grab){            // ground contact: settle instead of sliding forever
    b.vx *= 0.94; b.w *= 0.94;
    if (spd < 0.35){ b.vx *= 0.8; b.vy *= 0.5; }
    if (Math.abs(b.vx) < 0.03) b.vx = 0;
    if (Math.abs(b.w) < 0.005) b.w = 0;
    spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  }
  if (b.touch) b.lt2 = pixelTicks;
  syncProxies(b);
  if (b.debris.length){
    b.debris.forEach(function(dd){ if (isEmpty(dd[0], dd[1]) && elements[dd[2]]) createPixel(dd[2], dd[0], dd[1]); });
    b.debris.length = 0;
  }
  carry(b);
  if (!grab && pixelTicks - (b.lt2 || -99) < 8 && b.wet === 0 && spd < 0.12 && Math.abs(b.w) < 0.015 && !b.dirty) b.rest++; else b.rest = 0;
  if (b.rest > 30){ b.sleep = 1; b.sleepT = 0; b.vx = 0; b.vy = 0; b.w = 0; b.rest = 0; }
}
function carry(b){                                    // loose solids on top + water inside ride along
  if (Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.w)*b.rad < 0.03) return;
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
  if (Math.abs(b.vx) < 0.03 && b.vy >= -0.3) return;   // water follows the hull (only on real lifts, not gentle bobbing)
  var rows = {};
  b.proxies.forEach(function(pix){
    var r = rows[pix.y]; if (!r) rows[pix.y] = [pix.x, pix.x];
    else { if (pix.x < r[0]) r[0] = pix.x; if (pix.x > r[1]) r[1] = pix.x; }
  });
  b.proxies.forEach(function(pix){
    var r = rows[pix.y]; if (!r || r[1] - r[0] < 2) return;
    for (var x = r[0] + 1; x < r[1]; x++){
      if (b.proxies.has(GK(x, pix.y))) continue;
      var q = pxAt(x, pix.y); if (!q || q.sub !== undefined || q.del) continue;
      var e = elements[q.element]; if (!e || e.state !== "liquid") continue;
      q.cqx = (q.cqx || 0) + b.vx;
      if (Math.abs(q.cqx) >= 1){
        var dir = sign(q.cqx);
        if (isEmpty(q.x + dir, q.y)) movePixel(q, q.x + dir, q.y);
        q.cqx -= dir;
      }
      if (b.vy < -0.05){
        q.cqy = (q.cqy || 0) + b.vy;
        if (q.cqy <= -1){ if (isEmpty(q.x, q.y - 1)) movePixel(q, q.x, q.y - 1); q.cqy += 1; }
      }
    }
  });
}

/* ------------------------------------------- falling: support detection */
function isFaller(p){ return p && !p.del && p.sub === undefined && fallerOf(p.element) === true; }
function bodyFromPixels(list){
  var ax = list[0].x, ay = list[0].y, cells = new Map();
  list.forEach(function(q){ cells.set(K(q.x - ax, q.y - ay), { x: q.x - ax, y: q.y - ay, e: q.element, c: q.color, t: q.temp !== undefined ? q.temp : 20 }); });
  list.forEach(function(q){ if (pixelMap[q.x][q.y] === q) pixelMap[q.x][q.y] = undefined; q.del = true; });
  var b = makeBody(cells, 0, 0, 0, 0, 1);
  b.x = ax + b.com.x; b.y = ay + b.com.y;
  syncProxies(b);
  return b;
}
function checkSupport(p, checked){
  var comp = [p], seen = new Set([p]), q = [p], supported = false, host = null;
  while (q.length && !supported){
    var c = q.pop();
    for (var d = 0; d < 8; d++){
      var nx = c.x + D8[d][0], ny = c.y + D8[d][1];
      if (outOfBounds(nx, ny)){ supported = true; break; }
      var n = pixelMap[nx][ny];
      if (!n || n.del) continue;
      if (n.sub !== undefined){ if (!host && BODIES[n.sub]) host = BODIES[n.sub]; continue; }
      if (fallerOf(n.element) === true){ if (!seen.has(n)){ seen.add(n); comp.push(n); q.push(n); } continue; }
      var e = elements[n.element];
      if (e && (e.state === "liquid" || e.state === "gas")) continue;
      supported = true; break;
    }
    if (comp.length > 6000) supported = true;
  }
  comp.forEach(function(x){ checked.add(x); });
  if (host){                    // drawing that touches an existing body joins it: one object, not many
    comp.forEach(function(px){ if (!px.del && px.sub === undefined) joinPixel(host, px, true); });
    calc(host, true); syncProxies(host);
    return;
  }
  if (!supported) bodyFromPixels(comp);
}
function processSupport(){
  var checked = new Set(), n = 0, i;
  /* newest first: a busy sim never starves fresh placements out of the queue */
  while (n < 48 && dirtyA.length){
    var gk = dirtyA.pop(); dirtyS.delete(gk); n++;
    var x = Math.floor(gk/4096), y = gk % 4096;
    for (var dx = -3; dx <= 3; dx++) for (var dy = -3; dy <= 3; dy++){
      var p = pxAt(x + dx, y + dy);
      if (p && !checked.has(p) && isFaller(p)) checkSupport(p, checked);
    }
  }
  if (typeof currentPixels !== "undefined" && currentPixels.length){      // slow background sweep
    for (i = 0; i < 8; i++){
      var r = currentPixels[Math.floor(Math.random()*currentPixels.length)];
      if (r && !checked.has(r) && isFaller(r) && pixelMap[r.x] && pixelMap[r.x][r.y] === r) checkSupport(r, checked);
    }
  }
}

/* -------------------------------------------- joining / erasing / snapping */
function joinPixel(b, p, defer){
  var l = toLocal(b, p.x, p.y), lx = Math.round(l.x), ly = Math.round(l.y);
  if (b.cells.has(K(lx, ly))){
    /* the drawn pixel lands on a cell the body already owns (rotated overlap):
       tuck it into the nearest free neighbour cell instead of swallowing it -
       swallowing left random holes when you painted onto a body */
    /* nearest free local cell, spiralling outward: a painted pixel is never
       thrown away and never lands more than a couple of cells from where you
       drew it (the old version deleted them - that was the holes) */
    var bk = null;
    /* at most one cell away: tucking drawn pixels 2-3 cells out made them look
       like random extra pixels appearing somewhere else on the body */
    for (var r2 = 1; r2 <= 1 && bk === null; r2++){
      for (var sx = -r2; sx <= r2 && bk === null; sx++) for (var sy = -r2; sy <= r2 && bk === null; sy++){
        if (Math.max(Math.abs(sx), Math.abs(sy)) !== r2) continue;
        var sk = K(lx + sx, ly + sy);
        if (!b.cells.has(sk)) bk = sk;
      }
    }
    if (bk === null) return false;                // body is completely full here: pixel stays a normal grid pixel
    b._sx1 = undefined;
    lx = Math.floor(bk/4096) - 2048; ly = (bk % 4096) - 2048;
  }
  b.cells.set(K(lx, ly), { x: lx, y: ly, e: p.element, c: p.color, t: p.temp !== undefined ? p.temp : 20 });
  pixelMap[p.x][p.y] = undefined; p.del = true;
  b._sx1 = undefined;
  b.sleep = 0; b.vx = 0; b.vy = 0; b.w = 0; b.hold = pixelTicks + HOLD;   // hold still while building
  if (!defer){ calc(b, true); syncProxies(b); }
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
  var px0 = p.x, py0 = p.y, n0 = b.cells.size;
  if (!joinPixel(b, p, true)) return;
  var queue = [[px0, py0]];                      // pull in the rest of this same brush stroke that touches it
  while (queue.length){
    var pos = queue.pop();
    for (var d = 0; d < 4; d++){
      var m = pxAt(pos[0] + D4[d][0], pos[1] + D4[d][1]);
      if (m && isFaller(m) && m.pa === pixelTicks){
        var mx = m.x, my = m.y;
        if (joinPixel(b, m, true)) queue.push([mx, my]);
      }
    }
  }
  if (b.cells.size !== n0){ calc(b, true); syncProxies(b); }   // recompute once per stroke, not per pixel (lag fix)
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
      var p = pixelMap[R.gx[i]][R.gy[i]];
      if (p){ if (cell.c) p.color = cell.c; if (cell.t !== undefined) p.temp = cell.t; }
    }
  }
  NOJOIN = false;
}

/* ------------------------------------------------ elements: fallers + tab */
var ids = Object.keys(elements);
/* EVERY solid in the game can fall - blocks from every category and elements that
   other mods add too, decided live (one cached verdict per element).
   wall/border stay exactly where they are in the Solids tab - they just don't fall. */
function willMove(e){
  if (e.movable === true) return true;
  if (e.movable === false) return false;
  if (typeof e.behavior === "function") return true;      // custom tick element (moves itself)
  if (e.tick) return true;
  if (e.behavior && typeof e.behavior[0] === "object"){
    var bs = JSON.stringify(e.behavior);
    if (bs.indexOf("M1") !== -1 || bs.indexOf("M2") !== -1) return true;
  }
  return false;
}
function makeAnchoredVariant(id){
  if (elements["anchored_" + id]) return;
  var e = elements[id], a = Object.assign({}, e);
  if (Array.isArray(a.color)) a.color = a.color.slice();
  if (Array.isArray(a.behavior)) a.behavior = a.behavior.slice();
  if (a.reactions) a.reactions = JSON.parse(JSON.stringify(a.reactions));
  a.category = "anchored"; a.anchored = true; delete a.onPlace; delete a.hidden;
  /* the label stays the block's own name - players already know it's static,
     it is in the static tab */
  a.desc = "Identical to " + (e.name || id.replace(/_/g, " ")) + ", but never falls.";
  elements["anchored_" + id] = a;
}
function fallerOf(id){
  var f = FALL[id];
  if (f !== undefined) return f;
  f = false;
  var e = elements[id];
  if (e && !e.tool && !e.hidden && e.state === "solid" && e.canPlace !== false && !willMove(e)){
    if (id !== PROXY && !/^anchored_/.test(id) && id !== "wall" && id !== "border" && id !== "physics_grain" &&
        e.category !== "powders" && e.category !== "tools" && e.category !== "anchored") f = true;
  }
  FALL[id] = f;
  if (f && !e.__slOP){
    e.__slOP = true;
    var prev = e.onPlace;
    e.onPlace = function(p){ if (prev) prev(p); onPlaceFaller(p); };
    makeAnchoredVariant(id);
  }
  return f;
}
ids = Object.keys(elements);
ids.forEach(fallerOf);
elements[PROXY] = {
  color: "#8a8f98", behavior: behaviors.WALL, category: "anchored", state: "solid", density: 9999,
  hidden: true, hardness: 1, desc: "Invisible grid footprint of a moving physics body.",
  renderer: function(pixel, ctx){}, onDelete: onDeleteProxy,
  /* drawing onto a body cell (instead of next to it) now paints the cell itself:
     solids recolour the cell, liquids/gases carve it out and take its place */
  onClicked: function(p, cur){
    if (cur === PROXY) return;
    var E = elements[cur]; if (!E || E.tool || E.canPlace === false) return;
    var b = BODIES[p.sub]; if (!b || b.dead) return;
    var cell = b.cells.get(p.ck); if (!cell) return;
    if (E.state === "solid" || E.state === undefined){
      cell.e = cur; cell.c = cellColor(E, cell.x, cell.y);
      p.pe = cur; b.pend = true; b.sleep = 0;
      return;
    }
    cellEject(b, p, cell, cur);
  }
};

/* ---------------------------------------------------------------- tools */
function bodyOf(p){ return (p.sub !== undefined) ? (BODIES[p.sub] || null) : null; }
elements.physkick = { color: "#ffd24d", category: "tools", canPlace: false,
  desc: "Hits a physics body at that spot: shoves it and spins it.",
  tool: function(p){
    var b = bodyOf(p); if (!b || b.kt === pixelTicks) return; b.kt = pixelTicks;
    var dvx = (Math.random()*2 - 1)*0.9, dvy = -1.5*sign(b.gf), rx = p.x - b.x, ry = p.y - b.y;
    b.vx += dvx; b.vy += dvy; b.w += b.m*(rx*dvy - ry*dvx)/b.I; b.sleep = 0;
  } };
elements.physicsspin = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Gives a physics body a burst of spin.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.st !== undefined && pixelTicks - b.st < 10)) return;
    b.st = pixelTicks; b.w += (chance(0.5) ? 1 : -1)*0.08; b.sleep = 0;
  } };
elements.physicsfreeze = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Freezes a physics body in place (still rotated, still off-grid).",
  tool: function(p){ var b = bodyOf(p); if (b){ b.frozen = true; b.vx = 0; b.vy = 0; b.w = 0; b.sleep = 0; } } };
elements.physicsunfreeze = { color: "#ff9d7b", category: "tools", canPlace: false,
  desc: "Unfreezes a frozen physics body so it moves again.",
  tool: function(p){ var b = bodyOf(p); if (b){ b.frozen = false; b.sleep = 0; } } };
elements.physicsflip = { color: "#c792ff", category: "tools", canPlace: false,
  desc: "Flips the gravity direction of a physics body.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.ft !== undefined && pixelTicks - b.ft < 15)) return;
    b.ft = pixelTicks; b.gf = -b.gf; b.sleep = 0;
  } };
elements.physicsgrab = { color: "#7ee787", category: "tools", canPlace: false,
  desc: "Grab tool: holds a physics body and lets you drag it around.",
  tool: function(p){
    var b = bodyOf(p); if (!b || b.dead || b.frozen) return;
    if (!GRAB || GRAB.b !== b || !GRAB.down) GRAB = { b: b, dx: b.x - p.x, dy: b.y - p.y, down: true };
    b.sleep = 0;
  } };
/* loose non-sticking grains left by disintegration: every grain is its own little
   physics particle - it flies with real velocity, bounces, rolls down slopes and
   sinks through water - but it never re-forms a body */
function grainTick(p){
  if (p.start === pixelTicks) return;
  if (typeof doDefaults === "function"){ doDefaults(p); if (p.del) return; }
  function isLiq(q){ return q && !q.del && q.sub === undefined && elements[q.element] && elements[q.element].state === "liquid"; }
  var vx = p.gvx || 0, vy = (p.gvy || 0) + G;
  if (isLiq(pxAt(p.x, p.y - 1)) || isLiq(pxAt(p.x, p.y + 1))){ vx *= 0.9; vy *= 0.9; }   // water drag
  if (vy > 2.5) vy = 2.5; else if (vy < -2.5) vy = -2.5;
  var dn0 = pxAt(p.x, p.y + 1);
  var grounded = dn0 && !isLiq(dn0);
  if (grounded) vy = 0;
  p.gvy = vy;
  var gay = (p.gay || 0) + vy, steps = 0;
  while (Math.abs(gay) >= 1 && steps < 4 && !p.del){
    steps++;
    var d = sign(gay);
    if (isEmpty(p.x, p.y + d)){ movePixel(p, p.x, p.y + d); gay -= d; continue; }
    if (d > 0 && isLiq(pxAt(p.x, p.y + 1)) && chance(0.3)){ movePixel(p, p.x, p.y + 1); gay -= d; continue; }  // sinks through liquid
    if (Math.abs(vy) > 0.7) vy = -vy * 0.3;      // bounces
    else vy = 0;                                 // rests
    p.gvy = vy; p.gay = 0; break;
  }
  if (p.del) return;
  p.gay = grounded ? 0 : gay;
  vx = grounded ? vx * 0.86 : vx * 0.995;        // friction on the ground
  if (Math.abs(vx) < 0.04) vx = 0;
  p.gvx = vx;
  var gax = (p.gax || 0) + vx;
  while (Math.abs(gax) >= 1 && !p.del){
    var dx = sign(gax);
    if (isEmpty(p.x + dx, p.y)){ movePixel(p, p.x + dx, p.y); }
    else if (grounded && isEmpty(p.x + dx, p.y + 1)){ movePixel(p, p.x + dx, p.y + 1); }   // rolls down slopes
    else { p.gax = 0; p.gvx = vx = Math.abs(vx) > 0.5 ? -vx * 0.4 : 0; break; }            // wall: bounce or stop
    gax -= dx;
  }
  if (p.del) return;
  p.gax = gax;
  if (grounded && p.gvx === 0 && p.gvy === 0){   // settled: trickles like sand so piles settle properly
    if (isEmpty(p.x, p.y + 1)) p.gvy = 0.01;
    else {
      var dl = chance(0.5) ? 1 : -1;
      if (isEmpty(p.x + dl, p.y + 1) && isEmpty(p.x + dl, p.y)) movePixel(p, p.x + dl, p.y + 1);
    }
  }
}
elements.physics_grain = {
  name: "Physics Grain",
  color: (elements.gravel && Array.isArray(elements.gravel.color)) ? elements.gravel.color.slice() : "#8a8f98",
  tick: grainTick, category: "powders", state: "solid", movable: true,
  density: 1600, hardness: 0.2,
  desc: "Loose grains left behind when a physics object disintegrates. They fly, bounce, roll and sink. Never re-forms a body."
};
elements.physicsdisintegrate = { color: "#ff6ec7", category: "tools", canPlace: false,
  desc: "Disintegrates a physics body into loose physics grains.",
  tool: function(p){
    var b = bodyOf(p); if (!b || b.dead || b.dit === pixelTicks) return;
    b.dit = pixelTicks;
    releaseProxies(b);                            // free the footprint first so grains can land on it
    b.cells.forEach(function(cell){
      var w = toWorld(b, cell.x, cell.y), gx = Math.round(w.x), gy = Math.round(w.y);
      if (!outOfBounds(gx, gy) && pixelMap[gx][gy] === undefined){
        createPixel("physics_grain", gx, gy);
        var q = pixelMap[gx][gy];
        if (q){
          if (cell.c) q.color = cell.c; if (cell.t !== undefined) q.temp = cell.t;
          q.gvx = b.vx * 0.6 + (Math.random() - 0.5) * 1.4;   // grains scatter with the body's velocity
          q.gvy = b.vy * 0.6 + (Math.random() - 0.5) * 0.8 - 0.25;
          q.gax = 0; q.gay = 0;
        }
      }
    });
    killBody(b);
  } };
elements.physicssnap = { color: "#ffb347", category: "tools", canPlace: false,
  desc: "Snaps a physics body onto the grid as anchored blocks, exactly as its rotated shape rasterises.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, false); } };
elements.physicsalignedsnap = { color: "#6be08a", category: "tools", canPlace: false,
  desc: "Rotates a physics body to the grid perfectly, then snaps it as anchored blocks without deforming it.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, true); } };

/* -------------------------------------------- finalise the elements we add */
/* when the mod is enabled at boot the game runs this pass itself; when it loads
   late (mod manager reload, injected copy) the new elements never got it, and
   createPixel then crashed on their missing colorObject - which killed the tick
   hook and made bodies fall apart. Give them the same pass whenever we load. */
function finalizeAdded(list){
  var i;
  for (i = 0; i < list.length; i++){
    var key = list[i];
    if (!elements[key]) continue;
    if (typeof finalizeColor === "function"){ try { finalizeColor(elements[key]); } catch(e){} }
  }
  for (i = 0; i < list.length; i++){
    var key = list[i];
    if (!elements[key]) continue;
    if (typeof finalizeElementAfter === "function"){ try { finalizeElementAfter(key); } catch(e){} }
  }
}
finalizeAdded([PROXY, "physkick", "physicsspin", "physicsfreeze", "physicsunfreeze", "physicsflip",
  "physicsgrab", "physicsdisintegrate", "physicssnap", "physicsalignedsnap", "physics_grain"].concat(
  Object.keys(elements).filter(function(k){ return /^anchored_/.test(k); })));

/* -------------------------------------- body cells behave like real pixels */
/* Each cell keeps its temperature: it conducts heat with adjacent grid pixels
   (through its footprint proxy, which game mechanisms can heat or cool), melts,
   burns or freezes at its element's limits, and reacts with adjacent pixels
   exactly like the normal grid version would. */
function tempOk(t, R){
  if (R.tempMin !== undefined && t < R.tempMin) return false;
  if (R.tempMax !== undefined && t > R.tempMax) return false;
  return true;
}
function cellEject(b, pix, cell, result){
  removeCell(b, pix.ck, false);
  var p = b.proxies.get(GK(pix.x, pix.y));
  if (p === pix){ pixelMap[pix.x][pix.y] = undefined; pix.del = true; b.proxies.delete(GK(pix.x, pix.y)); }
  if (isEmpty(pix.x, pix.y)){
    createPixel(result, pix.x, pix.y);
    var np = pixelMap[pix.x][pix.y];
    if (np){
      np.temp = cell.t;
      var T = elements[result];
      if (T && T.color) np.color = cellColor(T, pix.x, pix.y);
    }
  }
}
function cellConvert(b, pix, cell, result){
  if (result === null || result === undefined || !elements[result]){ removeCell(b, pix.ck, false); return; }
  var T = elements[result];
  if (T.state === "solid"){
    cell.e = result;
    cell.c = cellColor(T, cell.x, cell.y);
    pix.pe = result;
  } else cellEject(b, pix, cell, result);
}
function applyCellReaction(b, pix, cell, R, other){
  if (R.elem1 !== undefined){
    var r1 = Array.isArray(R.elem1) ? pick(R.elem1) : R.elem1;
    cellConvert(b, pix, cell, r1);
    if (!b.cells.get(pix.ck)) return;
  }
  if (R.elem2 !== undefined && other && !other.del){
    var r2 = Array.isArray(R.elem2) ? pick(R.elem2) : R.elem2;
    if (r2 === null) deletePixel(other.x, other.y);
    else if (elements[r2]) changePixel(other, r2);
  }
}
/* vanilla behavior ops (acid's DB dissolve, DL carve, CH conversions) applied to the
   real cell element: vanilla pixels now eat/convert physics bodies exactly like grid
   pixels. The proxy element itself stays inert (hardness 1) so nothing double-applies. */
function emulateVanilla(b, pix, cell){
  var E1 = elements[cell.e];
  var hard = E1.hardness !== undefined ? E1.hardness : 0;
  for (var d = 0; d < 4; d++){
    var q = pxAt(pix.x + D4[d][0], pix.y + D4[d][1]);
    if (!q || q.sub !== undefined || q.del) continue;
    var E2 = elements[q.element];
    var beh = E2 && E2.behavior;
    if (!beh || !beh.length || typeof beh === "function" || typeof beh[0] === "string") continue;
    var row = beh[-D4[d][1] + 1]; if (!row || typeof row === "string") continue;
    var toks = row[-D4[d][0] + 1]; if (!toks || toks === "XX") continue;
    var parts = toks.indexOf(" AND ") !== -1 ? toks.split(" AND ") : [toks];
    for (var i = 0; i < parts.length; i++){
      var t = parts[i], arg = null, ch = 100;
      if (t.indexOf(":") !== -1){
        arg = t.split(":")[1].split(/[\:%]/)[0];
        if (t.indexOf("%") === -1) t = t.split(/[\:%]/)[0];
      }
      if (t.indexOf("%") !== -1){ ch = parseFloat(t.split("%")[1]); t = t.split(/[\:%]/)[0]; }
      if (ch !== 100 && Math.random()*100 >= ch) continue;
      if (t !== "DB" && t !== "DL" && t !== "CH") continue;
      if (E2.ignore && E2.ignore.indexOf(cell.e) !== -1) continue;
      if (hard && Math.random() <= hard) continue;
      if (t === "CH"){
        if (arg === null || !elements[arg] || arg === cell.e) continue;
        cellConvert(b, pix, cell, arg);
      } else {
        removeCell(b, pix.ck, false);
        if (t === "DB" && pixelMap[q.x] && pixelMap[q.x][q.y] === q) deletePixel(q.x, q.y);
      }
      return;
    }
  }
}
function cellTick(b){
  if (b.dead) return 0;
  var n = 0;
  b.proxies.forEach(function(pix){
    if (b.dead) return;
    var cell = b.cells.get(pix.ck); if (!cell) return;
    var E = elements[cell.e]; if (!E){ removeCell(b, pix.ck, false); return; }
    if (pix.temp !== undefined && Math.abs(pix.temp - cell.t) > 0.4){   // vanilla doHeat wrote to the proxy pixel
      cell.t = (cell.t + pix.temp)/2; pix.temp = undefined;
    }
    var d, i;
    /* conduction: exchange heat with ordinary neighbouring pixels */
    for (d = 0; d < 4; d++){
      var q = pxAt(pix.x + D4[d][0], pix.y + D4[d][1]);
      if (!q || q.sub !== undefined) continue;
      var rate = 0.3 * (E.conduct === undefined ? 0.4 : E.conduct);
      var delta = (q.temp - cell.t) * rate;
      if (delta > 0.01 || delta < -0.01){ cell.t += delta; q.temp -= delta*0.5; pixelTempCheck(q); }
    }
    /* heat spreads within the body itself */
    for (d = 0; d < 4; d++){
      var nc = b.cells.get(K(cell.x + D4[d][0], cell.y + D4[d][1]));
      if (!nc || nc.e === cell.e && Math.abs(nc.t - cell.t) < 1) continue;
      var dr = 0.25 * 0.3 * ((elements[nc.e] ? elements[nc.e].conduct : undefined) === undefined ? 0.4 : elements[nc.e].conduct);
      var dl = (nc.t - cell.t) * dr;
      if (dl > 0.01 || dl < -0.01){ cell.t += dl; nc.t -= dl*0.5; }
    }
    cell.t += (airTemp - cell.t) * 0.003;
    if (cell.t < absoluteZero) cell.t = absoluteZero;
    var done = false;
    if (E.tempHigh !== undefined && cell.t >= E.tempHigh){
      var result = E.stateHigh;
      if (E.extraTempHigh) for (var et in E.extraTempHigh) if (cell.t >= +et) result = E.extraTempHigh[et];
      if (Array.isArray(result)) result = pick(result);
      cellConvert(b, pix, cell, result); done = true;
    } else if (E.tempLow !== undefined && cell.t <= E.tempLow){
      var result2 = E.stateLow;
      if (E.extraTempLow) for (var el in E.extraTempLow) if (cell.t <= +el) result2 = E.extraTempLow[el];
      if (Array.isArray(result2)) result2 = pick(result2);
      cellConvert(b, pix, cell, result2); done = true;
    }
    if (!done && E.reactions){
      for (d = 0; d < 4; d++){
        var q2 = pxAt(pix.x + D4[d][0], pix.y + D4[d][1]);
        if (!q2 || q2.sub !== undefined || q2.del) continue;
        var R = E.reactions[q2.element];
        if (R && tempOk(cell.t, R) && Math.random() < (R.chance !== undefined ? R.chance : 1)){
          applyCellReaction(b, pix, cell, R, q2);
          if (b.dead || !b.cells.get(pix.ck)) return;
        }
        var E2 = elements[q2.element], R2 = E2 && E2.reactions && E2.reactions[cell.e];
        if (R2 && tempOk(q2.temp, R2) && Math.random() < (R2.chance !== undefined ? R2.chance : 1)){
          var r2 = Array.isArray(R2.elem2) ? pick(R2.elem2) : R2.elem2;
          if (R2.elem2 !== undefined){
            var T3 = r2 !== null ? elements[r2] : null;
            if (T3 && T3.state === "solid"){
              cell.e = r2; cell.c = cellColor(T3, cell.x, cell.y); pix.pe = r2;
            } else if (r2 === null || !T3){ removeCell(b, pix.ck, false); return; }
            else { cellEject(b, pix, cell, r2); return; }
          }
          if (R2.elem1 !== undefined && q2 && !q2.del){
            var r3 = Array.isArray(R2.elem1) ? pick(R2.elem1) : R2.elem1;
            if (r3 === null) deletePixel(q2.x, q2.y);
            else if (elements[r3]) changePixel(q2, r3);
          }
          if (b.dead || !b.cells.get(pix.ck)) return;
        }
      }
    }
    /* burning, exactly like doBurning for a grid pixel: a burning neighbour
       ignites the cell by the element's burn chance, the cell heats while it
       burns, sets neighbouring grid pixels on fire, spits fire above itself,
       and after its burnTime turns into its burnInto elements (embers/charcoal
       stay part of the body, fire pops out). This is what made physics objects
       refuse to burn. */
    if (!b.dead && b.cells.get(pix.ck) && !done){
      if (cell.burning){
        if (typeof settings === "undefined" || settings.burn !== 0){
          if (cell.burnStart === undefined) cell.burnStart = pixelTicks;
          if (E.insulate !== true) cell.t += 1;
          if (cell.t < 0){ cell.burning = undefined; cell.burnStart = undefined; }
          else {
            for (d = 0; d < 4; d++){
              var q3 = pxAt(pix.x + D4[d][0], pix.y + D4[d][1]);
              if (!q3 || q3.sub !== undefined || q3.del) continue;
              var E3 = elements[q3.element];
              if (E3 && E3.burn !== undefined && q3.burning !== true && Math.floor(Math.random()*100) < E3.burn) burnPixel(q3);
            }
            if (pixelTicks - cell.burnStart > (E.burnTime || 200) && Math.floor(Math.random()*100) < (E.burn || 10) && !(E.burnTime === undefined && E.hardness >= 1)){
              var into = E.burnInto === undefined ? "fire" : (Array.isArray(E.burnInto) ? pick(E.burnInto) : E.burnInto);
              cell.burning = undefined; cell.burnStart = undefined;
              cellConvert(b, pix, cell, into);
              if (!b.cells.get(pix.ck)) return;
            } else if (Math.random() < 0.1 && isEmpty(pix.x, pix.y - 1)){
              createPixel(E.fireElement || "fire", pix.x, pix.y - 1);
            }
          }
        }
      } else {
        for (d = 0; d < 4; d++){
          var q4 = pxAt(pix.x + D4[d][0], pix.y + D4[d][1]);
          if (!q4 || q4.sub !== undefined || q4.del || q4.burning !== true) continue;
          if (E.burn !== undefined && Math.floor(Math.random()*100) < E.burn){ cell.burning = true; cell.burnStart = pixelTicks; break; }
        }
      }
    }
    if (!b.dead && b.cells.get(pix.ck)) emulateVanilla(b, pix, cell);   // acid, carve and convert behaviors
    if (b.dead || !b.cells.get(pix.ck)) return;
    pix.temp = cell.t;                    // the world sees the cell through its footprint
    n++;
  });
  return n;
}

/* --------------------------------------------------- change notifications */
function wrap(name, make){
  var o = globalThis[name];
  if (typeof o === "function" && !o.__sl){ var w = make(o); w.__sl = true; globalThis[name] = w; }
}
function quiet(p){ var e = p && elements[p.element]; return !p || p.element === PROXY || p.element === "physics_grain" || (e && (e.state === "liquid" || e.state === "gas")); }
/* Painting straight onto a body: a placeable solid recolours that cell (exactly
   like clicking it) and liquids/gases/powders carve the cell out and take its
   place. Nothing gets overwritten into a ghost pixel, so adding to a body no
   longer leaves holes. */
wrap("createPixel", function(o){ return function(el, x, y){
  var prev = pixelMap[x] && pixelMap[x][y];
  if (prev && prev.sub !== undefined && el !== PROXY){
    var b = BODIES[prev.sub], E = elements[el];
    if (b && !b.dead && E && !E.tool && E.canPlace !== false && !E.hidden){
      var cell = b.cells.get(prev.ck);
      if (cell){
        if (E.state === "solid"){
          cell.e = el; cell.c = cellColor(E, cell.x, cell.y);
          prev.pe = el; b.pend = true; b.sleep = 0; b._sx1 = undefined;
          return;
        }
        if (E.state === "liquid" || E.state === "gas" || E.movable === true){
          cellEject(b, prev, cell, el); b._sx1 = undefined;
          return;
        }
      }
    }
  }
  var r = o(el, x, y);
  if (el !== PROXY && fallerOf(el)) mark(x, y);
  if (prev && prev.sub !== undefined){ var bb = BODIES[prev.sub]; if (bb) bb._sx1 = undefined; }
  return r; }; });
wrap("deletePixel", function(o){ return function(x, y){
  var p = pixelMap[x] && pixelMap[x][y], q = quiet(p);
  /* Replace-mode paint-over must not delete a body cell: the createPixel that
     follows repaints the cell instead. Erasing (a tool) still cuts the body. */
  if (p && p.sub !== undefined && BODIES[p.sub]){
    var cur = elements[currentElement];
    if (cur && !cur.tool && cur.canPlace !== false && !cur.hidden) return;
  }
  o(x, y); if (!q) mark(x, y); }; });
wrap("changePixel", function(o){ return function(pixel){
  var q = quiet(pixel), sub = pixel.sub; o.apply(this, arguments);
  if (sub !== undefined){ var bb = BODIES[sub]; if (bb) bb._sx1 = undefined; }   // footprint pixel converted: rebuild it
  if (!q || !quiet(pixel)) mark(pixel.x, pixel.y); }; });
wrap("movePixel", function(o){ return function(pixel, x, y){
  var q = quiet(pixel), ox = pixel.x, oy = pixel.y; o.apply(this, arguments); if (!q){ mark(ox, oy); mark(x, y); } }; });
wrap("swapPixels", function(o){ return function(a, b){
  var q = quiet(a) && quiet(b), ax = a.x, ay = a.y, bx = b.x, by = b.y; o(a, b); if (!q){ mark(ax, ay); mark(bx, by); } }; });
/* cursor over a physics body shows the real block it is standing in */
wrap("updateStats", function(o){ return function(){
  o.apply(this, arguments);
  try{
    var p = pixelMap[mousePos.x] && pixelMap[mousePos.x][mousePos.y];
    if (p && p.sub !== undefined && p.pe && elements[p.pe]){
      var el = document.getElementById("stat-element");
      if (el){ var s = el.getElementsByTagName("span")[0]; if (s) s.textContent = (elements[p.pe].name || p.pe).toUpperCase(); }
    }
  }catch(e){}
}; });
/* explosions knock physics bodies around and blow cells off them */
wrap("explodeAt", function(o){ return function(x, y, radius, fire){
  o.apply(this, arguments);
  var keys = Object.keys(BODIES);
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b || b.dead) continue;
    var dx = b.x - x, dy = b.y - y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
    if (dist > radius + b.rad) continue;
    var f = Math.max(0, 1 - dist/(radius + b.rad));
    var accel = radius * 0.09 * f * Math.min(4, 1500/(b.m/b.cells.size));
    b.vx += dx/dist*accel; b.vy += dy/dist*accel - accel*0.3;
    b.w += (Math.random() - 0.5) * 0.08 * f;
    b.sleep = 0;
    b.cells.forEach(function(cell, k){
      if (physOf(cell.e).hard >= 0.99) return;    // indestructible bodies (physics_wall) only get knocked around
      var w = toWorld(b, cell.x, cell.y);
      var dd = Math.sqrt((w.x-x)*(w.x-x) + (w.y-y)*(w.y-y));
      if (dd < radius && chance(0.55*(1 - dd/radius))) removeCell(b, k, true);
    });
    b.dirty = true;
  }
}; });

/* --------------------------------------------------------------- hooks */
runEveryTick(function(){
  if (GRAB && (GRAB.b.dead || (typeof mouseIsDown !== "undefined" && mouseIsDown === false))) GRAB = null;
  processSupport();
  var list = Object.keys(BODIES);
  var cap = Math.min(list.length, 100);           // perf: at most 100 bodies simulated per tick
  for (var i = 0; i < cap; i++){ var b = BODIES[list[i]]; if (b) stepBody(b); }
  /* body cells live like real pixels: conduct heat, melt/burn/freeze, react */
  var budget = 900;
  for (i = 0; i < list.length && budget > 0; i++){
    var b2 = BODIES[list[i]];
    if (!b2 || b2.dead) continue;
    if (pixelTicks % 2 === (b2.id % 2)) continue;  // each body's cells update every other tick
    budget -= cellTick(b2);
  }
});
runPerPixel(function(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub];
  if (pixelMap[p.x] === undefined || pixelMap[p.x][p.y] !== p){
    /* off the map (something overwrote the cell without a proper delete): clean
       the ghost up and let the body rebuild its footprint - leftover ghosts used
       to hide painted pixels and punch holes into bodies */
    var reg = b && b.proxies.get(GK(p.x, p.y)) === p;
    p.del = true;
    if (reg && b) b._sx1 = undefined;
    else if (p.pe && elements[p.pe]){ NOJOIN = true; changePixel(p, p.pe); NOJOIN = false; }
    return;
  }
  if (!b || b.proxies.get(GK(p.x, p.y)) !== p){  // orphan proxy (e.g. after load): becomes a normal block again
    p.sub = undefined;
    if (p.pe && elements[p.pe]){ NOJOIN = true; changePixel(p, p.pe); NOJOIN = false; } else p.del = true;
  }
});
runAfterReset(function(){ BODIES = {}; dirtyA.length = 0; dirtyS.clear(); });
renderPostPixel(function(ctx){
  var ps = pixelSize, keys = Object.keys(BODIES);
  var bord = (typeof renderPresets !== "undefined") ? renderPresets.BORDER : null;
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b) continue;
    ctx.save(); ctx.globalAlpha = 1;
    ctx.translate((b.x + 0.5)*ps, (b.y + 0.5)*ps); ctx.rotate(b.a);
    var cm = b.com, size = ps + 0.7;
    b.cells.forEach(function(c){
      ctx.fillStyle = c.c || "#999999";
      ctx.fillRect((c.x - cm.x - 0.5)*ps - 0.35, (c.y - cm.y - 0.5)*ps - 0.35, size, size);
      var el = elements[c.e];
      /* BORDER elements (glass etc.): vanilla draws the outline only where the
         neighbour is empty or a different movability - matching that exactly, the
         old "any non-body neighbour" test outlined cells that vanilla left clean */
      if (bord && el && el.renderer === bord){
        var w2 = toWorld(b, c.x, c.y), edge = false;
        for (var d = 0; d < 4 && !edge; d++){
          var qx = Math.round(w2.x) + D4[d][0], qy = Math.round(w2.y) + D4[d][1];
          var qp = pxAt(qx, qy);
          if (!qp || !qp.del || (qp.sub === undefined && elements[qp.element].movable !== el.movable)) edge = true;
        }
        if (edge){ ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect((c.x - cm.x - 0.5)*ps - 0.35, (c.y - cm.y - 0.5)*ps - 0.35, size, size); }
      }
    });
    if (b.frozen){ ctx.strokeStyle = "rgba(123,220,255,0.9)"; ctx.lineWidth = 1; ctx.strokeRect(-ps*b.rad, -ps*b.rad, ps*2*b.rad, ps*2*b.rad); }
    ctx.restore();
  }
});

if (typeof globalThis !== "undefined" && globalThis.__SUBLEVEL_TEST__){
  globalThis.__SUBLEVEL_TEST__ = { BODIES: function(){ return BODIES; }, FALL: FALL, physOf: physOf, processSupport: processSupport,
    stepBody: stepBody, K: K, snapBody: snapBody, bodyFromPixels: bodyFromPixels, syncProxies: syncProxies,
    cellTick: cellTick, emulateVanilla: emulateVanilla, fluidInfo: fluidInfo, blocker: blocker };
}
if (typeof logMessage === "function") logMessage("Sublevel Physics v6 loaded: bodies burn and dissolve like normal blocks, painted glass keeps its texture, anchored blocks keep their plain names.");
})();
