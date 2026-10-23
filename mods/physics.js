/* ============================================================================
   RIGID-BODY PHYSICS BLOCKS  -  Sandboxels mod (written against v1.13.2 source)

   HOW IT WORKS
   - Physics blocks are solid walls. Power ANY pixel of a chunk (wire, shock
     tool, battery...) and the whole connected chunk "unhooks" from the grid
     and becomes a rigid body with velocity, gravity, bounce and friction.
   - Bodies use the game's built-in group system (`_r` / currentRelations), so
     they save/load, can be dragged with the Drag tool, and work with Ungroup.
   - Place more physics material touching a moving body -> it joins the body.
   - Erase part of a body -> it splits into separate bodies if disconnected.
   - Hard impacts snap pixels off (they turn into debris or vanish) and can
     smash breakable things they hit.
   - Bodies float/sink by density in liquids, plow through sand/gas, push
     loose powder, collide with each other (momentum exchange).

   Bodies do NOT rotate (they stay grid-aligned). Everything else is simulated.
   ========================================================================== */
(function () {

var GRAV = 0.09;     // cells/tick^2
var VMAX = 3.2;      // cells/tick (max speed)
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];
var PHYS = {};       // element id -> physics parameters

function chance(p){ return Math.random() < p; }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
function sign(v){ return v > 0 ? 1 : v < 0 ? -1 : 0; }
function px(x,y){
  if (outOfBounds(x,y)) return undefined;
  var c = pixelMap[x]; return c ? c[y] : undefined;
}
function isFluid(p){
  if (!p || p._r !== undefined) return false;
  var e = elements[p.element]; return !!e && (e.state === "liquid" || e.state === "gas");
}
function isLiquid(p){
  if (!p || p._r !== undefined) return false;
  var e = elements[p.element]; return !!e && e.state === "liquid";
}

/* ------------------------------------------------------------ relations */
function newBody(pixels, vx, vy){
  var id = currentRelations._id; currentRelations._id++;
  currentRelations[id] = { p: pixels, mx: true, vx: vx||0, vy: vy||0, qx: 0, qy: 0,
    sleep: 0, contact: 0, dirty: false, st: null, stamp: pixelTicks, lastMove: pixelTicks };
  for (var i = 0; i < pixels.length; i++) pixels[i]._r = id;
  return id;
}
function liveMembers(id, rel){
  var out = [], src = rel.p || [];
  for (var i = 0; i < src.length; i++){
    var p = src[i];
    if (p.del || p._r !== id) continue;
    if (!PHYS[p.element]) { delete p._r; continue; }     // melted/changed -> leaves the body
    out.push(p);
  }
  return out;
}
function stats(mem){
  var n = mem.length, d = 0, b = 0, h = 0, g = 0, f = 0, thr = 0;
  for (var i = 0; i < n; i++){
    var P = PHYS[mem[i].element];
    d += P.dens; b += P.bounce; h += P.hard; g += P.g; f += P.fric; if (P.thr) thr++;
  }
  return { n:n, dens:d/n, mass:d/1000, bounce:b/n, hard:h/n, g:g/n, fric:f/n, thr:thr };
}
function components(mem, id){
  var set = new Set(mem), seen = new Set(), out = [];
  for (var i = 0; i < mem.length; i++){
    var s = mem[i]; if (seen.has(s)) continue;
    var comp = [s], q = [s]; seen.add(s);
    while (q.length){
      var c = q.pop();
      for (var d = 0; d < 4; d++){
        var n = px(c.x + D4[d][0], c.y + D4[d][1]);
        if (n && n._r === id && set.has(n) && !seen.has(n)){ seen.add(n); comp.push(n); q.push(n); }
      }
    }
    out.push(comp);
  }
  return out;
}
function centroid(list){
  var x = 0, y = 0; for (var i = 0; i < list.length; i++){ x += list[i].x; y += list[i].y; }
  return { x:x/list.length, y:y/list.length };
}
function splitBody(id, rel, mem){
  var comps = components(mem, id);
  if (comps.length <= 1){ rel.p = mem; return; }
  comps.sort(function(a,b){ return b.length - a.length; });
  var main = comps[0], cm = centroid(main);
  rel.p = main; rel.st = null; rel.sleep = 0;
  for (var i = 1; i < comps.length; i++){
    var c = centroid(comps[i]);
    var nid = newBody(comps[i], rel.vx, rel.vy);
    var nr = currentRelations[nid];
    nr.gf = rel.gf;
    nr.vx += sign(c.x - cm.x) * 0.15;              // pieces drift apart a little
    nr.vy += sign(c.y - cm.y) * 0.1;
  }
}
/* connected static physics pixels -> new moving body */
function activate(p){
  var list = [p], seen = new Set([p]), q = [p];
  while (q.length){
    var c = q.pop();
    for (var d = 0; d < 4; d++){
      var n = px(c.x + D4[d][0], c.y + D4[d][1]);
      if (n && n._r === undefined && !n.del && PHYS[n.element] && !seen.has(n)){ seen.add(n); list.push(n); q.push(n); }
    }
  }
  newBody(list, 0, 0);
}
function mergeInto(toId, fromId){
  var rt = currentRelations[toId], rf = currentRelations[fromId];
  if (!rt || !rf || toId === fromId) return;
  var ma = (rt.st ? rt.st.mass : 1), mb = (rf.st ? rf.st.mass : 1);
  rt.vx = ((rt.vx||0)*ma + (rf.vx||0)*mb) / (ma+mb);
  rt.vy = ((rt.vy||0)*ma + (rf.vy||0)*mb) / (ma+mb);
  var src = rf.p || [];
  for (var i = 0; i < src.length; i++){ src[i]._r = toId; rt.p.push(src[i]); }
  delete currentRelations[fromId];
  rt.st = null; rt.sleep = 0;
}

/* --------------------------------------------------------- element hooks */
function onPlacePhys(pixel){
  if (pixel._r !== undefined) return;
  var ids = [];
  for (var d = 0; d < 4; d++){
    var n = px(pixel.x + D4[d][0], pixel.y + D4[d][1]);
    if (n && n !== pixel && n._r !== undefined && PHYS[n.element]){
      var r = currentRelations[n._r];
      if (r && r.mx && ids.indexOf(n._r) === -1) ids.push(n._r);
    }
  }
  if (!ids.length) return;
  var id = ids[0], rel = currentRelations[id];
  if (!rel.p) rel.p = [];
  rel.p.push(pixel); pixel._r = id; rel.st = null; rel.sleep = 0;
  for (var i = 1; i < ids.length; i++) mergeInto(id, ids[i]);
}
function onDeletePhys(pixel){
  if (pixel._r === undefined) return;
  var r = currentRelations[pixel._r];
  if (r) { r.dirty = true; r.sleep = 0; r.st = null; }
}

/* ------------------------------------------------------- body simulation */
function environment(mem){
  var rows = {}, cols = {}, i, m;
  for (i = 0; i < mem.length; i++){
    m = mem[i];
    var r = rows[m.y], c = cols[m.x];
    if (!r) rows[m.y] = { min:m.x, max:m.x }; else { if (m.x < r.min) r.min = m.x; if (m.x > r.max) r.max = m.x; }
    if (!c) cols[m.x] = { min:m.y, max:m.y }; else { if (m.y < c.min) c.min = m.y; if (m.y > c.max) c.max = m.y; }
  }
  var rowWet = {}, colWet = {}, rho = 0, rn = 0, k, a, b;
  for (k in rows){
    a = px(rows[k].min - 1, +k); b = px(rows[k].max + 1, +k);
    var fl = isLiquid(a) ? a : isLiquid(b) ? b : null;
    if (fl){ rowWet[k] = true; rho += elements[fl.element].density; rn++; }
  }
  for (k in cols){
    a = px(+k, cols[k].min - 1); b = px(+k, cols[k].max + 1);
    var fl2 = isLiquid(a) ? a : isLiquid(b) ? b : null;
    if (fl2){ colWet[k] = true; rho += elements[fl2.element].density; rn++; }
  }
  var wet = 0;
  for (i = 0; i < mem.length; i++){ m = mem[i]; if (rowWet[m.y] || colWet[m.x]) wet++; }
  return { f: wet / mem.length, rho: rn ? rho / rn : 1000 };
}
/* can the body move one step without any resistance? (used by resting bodies) */
function freeToMove(id, mem, rho, dx, dy){
  for (var i = 0; i < mem.length; i++){
    var m = mem[i], nx = m.x + dx, ny = m.y + dy;
    if (outOfBounds(nx,ny)) return false;
    var t = pixelMap[nx][ny];
    if (!t || t._r === id) continue;
    var e = elements[t.element];
    if (isFluid(t)) continue;
    if (e && e.movable && !PHYS[t.element] && t._r === undefined && e.density < rho*0.8) continue;  // would sink
    return false;
  }
  return true;
}
function tryStep(id, rel, mem, dx, dy, speed){
  var disp = [], contacts = [], blocked = false, body = null, rho = rel.st.dens, i, m;
  for (i = 0; i < mem.length; i++){
    m = mem[i];
    var nx = m.x + dx, ny = m.y + dy;
    if (outOfBounds(nx,ny)){ blocked = true; contacts.push([m,null]); continue; }
    var t = pixelMap[nx][ny];
    if (!t || t._r === id) continue;
    if (t._r !== undefined){
      blocked = true; contacts.push([m,t]);
      var ob = currentRelations[t._r]; if (ob && ob.mx && !body) body = ob;
      continue;
    }
    var te = elements[t.element];
    if (te && (te.state === "liquid" || te.state === "gas")){ disp.push(t); continue; }
    if (te && te.movable && !PHYS[t.element]){           // loose powder / critters
      var push = (dx !== 0) || (dy < 0) || speed >= 1.3 || (te.density < rho*0.8 && chance(0.2));
      if (push){ disp.push(t); continue; }
    }
    blocked = true; contacts.push([m,t]);
  }
  if (blocked) return { ok:false, contacts:contacts, body:body };

  var spots = [];
  if (disp.length){
    var now = {}; 
    for (i = 0; i < mem.length; i++) now[(mem[i].x+dx) + "," + (mem[i].y+dy)] = true;
    for (i = 0; i < mem.length; i++) if (!now[mem[i].x + "," + mem[i].y]) spots.push([mem[i].x, mem[i].y]);
    if (disp.length > spots.length) return { ok:false, contacts:[], body:null };
    for (i = spots.length-1; i > 0; i--){ var j = Math.floor(Math.random()*(i+1)); var tmp = spots[i]; spots[i] = spots[j]; spots[j] = tmp; }
  }
  for (i = 0; i < mem.length; i++) pixelMap[mem[i].x][mem[i].y] = undefined;
  for (i = 0; i < mem.length; i++){ mem[i].x += dx; mem[i].y += dy; }
  for (i = 0; i < mem.length; i++) pixelMap[mem[i].x][mem[i].y] = mem[i];
  for (i = 0; i < disp.length; i++){
    var d2 = disp[i], s = spots[i];
    d2.x = s[0]; d2.y = s[1]; pixelMap[s[0]][s[1]] = d2;
  }
  return { ok:true };
}
function breakMember(rel, m){
  var P = PHYS[m.element];
  delete m._r; rel.dirty = true; rel.st = null; rel.sleep = 0;
  if (chance(0.55) && P.debris && elements[P.debris]) changePixel(m, P.debris);
  else deletePixel(m.x, m.y);
}
function smashTarget(t){
  var e = elements[t.element]; if (!e || !e.breakInto) return;
  var b = e.breakInto; if (Array.isArray(b)) b = pick(b);
  if (b && elements[b]) changePixel(t, b);
}
function collide(id, rel, mem, axis, res){
  var st = rel.st, v = axis === "y" ? rel.vy : rel.vx, s = Math.abs(v), nv;
  var ob = res.body;
  if (ob && ob.st){
    var v2 = axis === "y" ? (ob.vy||0) : (ob.vx||0);
    var e2 = Math.min(st.bounce, ob.st.bounce), m1 = st.mass, m2 = ob.st.mass;
    nv = ((m1 - e2*m2)*v + (1+e2)*m2*v2) / (m1+m2);
    var nv2 = ((m2 - e2*m1)*v2 + (1+e2)*m1*v) / (m1+m2);
    if (axis === "y") ob.vy = nv2; else ob.vx = nv2;
    ob.sleep = 0; s = Math.abs(v - v2);
  } else {
    nv = -v * st.bounce;
    if (Math.abs(nv) < 0.2) nv = 0;
  }
  if (axis === "y") rel.vy = nv; else rel.vx = nv;
  rel.sleep = 0;

  if (s > 1.1){                                         // hard impact -> damage
    var power = s - 1.1, cs = res.contacts, tries = Math.min(cs.length, 10);
    var mf = Math.max(0.2, Math.min(3, st.dens/1500 * (0.4 + Math.min(1.2, st.n/40))));
    for (var i = 0; i < tries; i++){
      var c = cs[Math.floor(Math.random()*cs.length)], m = c[0], t = c[1];
      if (m.del || m._r !== id) continue;
      var tHard = 0.9;
      if (t){ var te = elements[t.element]; tHard = (te && te.hardness !== undefined) ? te.hardness : 0.6; }
      var pBreak = Math.min(0.75, power*0.22) * (1 - PHYS[m.element].hard) * (0.4 + tHard);
      if (chance(pBreak)) breakMember(rel, m);
      if (t && !t.del && t._r === undefined && tHard < 0.95){
        var pt = Math.min(0.7, power*0.25*mf*(1 - tHard));
        if (chance(pt)) smashTarget(t);
      }
    }
  }
}
function stepBody(id, rel){
  var mem = liveMembers(id, rel), i;
  if (!mem.length){ delete currentRelations[id]; return; }
  if (mem.length !== (rel.p||[]).length){ rel.dirty = true; rel.st = null; }
  rel.p = mem;
  for (i = 0; i < mem.length; i++) if (mem[i].drag){ rel.vx = 0; rel.vy = 0; rel.qx = 0; rel.qy = 0; rel.sleep = 0; return; }
  rel.lastMove = pixelTicks;                              // makes the built-in group gravity skip this body
  if (rel.dirty){ rel.dirty = false; splitBody(id, rel, mem); mem = rel.p; if (!mem.length) return; }
  var st = rel.st || (rel.st = stats(mem));
  rel.vx = rel.vx || 0; rel.vy = rel.vy || 0; rel.qx = rel.qx || 0; rel.qy = rel.qy || 0;
  rel.sleep = rel.sleep || 0; rel.contact = rel.contact || 0;
  var gf = (rel.gf || 1) * st.g, gs = gf >= 0 ? 1 : -1;

  if (rel.sleep > 12 && !st.thr){                         // resting: only probe for lost support
    if ((pixelTicks + id) % 3 !== 0) return;
    if (freeToMove(id, mem, st.dens, 0, gs)){ rel.sleep = 0; rel.vy = 0.3*gs; } else return;
  }

  var env = environment(mem);
  var ay = GRAV * gf, ax = 0, thrusting = false;
  if (gf > 0 && env.f > 0) ay = GRAV * gf * (1 - (env.rho / st.dens) * env.f);   // buoyancy
  if (st.thr){
    var Fx = 0, Fy = 0;
    for (i = 0; i < mem.length; i++){
      var P = PHYS[mem[i].element]; if (!P.thr) continue;
      var m = mem[i];
      if (m.charge) m.tt = 6;
      if (m.tt > 0){
        m.tt--; thrusting = true; Fx += P.thr[0]*P.force; Fy += P.thr[1]*P.force;
        var ex = m.x - P.thr[0], ey = m.y - P.thr[1];
        if (chance(0.5) && isEmpty(ex,ey)) createPixel("fire", ex, ey);
      }
    }
    ax = Fx / st.mass; ay += Fy / st.mass;
  }
  rel.vx += ax; rel.vy += ay;
  var drag = (1 - 0.12*env.f) * 0.999;
  rel.vx *= drag; rel.vy *= drag;
  if (rel.vx > VMAX) rel.vx = VMAX; else if (rel.vx < -VMAX) rel.vx = -VMAX;
  if (rel.vy > VMAX) rel.vy = VMAX; else if (rel.vy < -VMAX) rel.vy = -VMAX;
  if (rel.contact > 0){                                   // sliding friction while touching ground
    rel.contact--; rel.vx *= (1 - st.fric*0.2);
    if (Math.abs(rel.vx) < 0.03) rel.vx = 0;
  }

  var moved = false, n, dir, r, k;
  rel.qy += rel.vy; rel.qx += rel.vx;
  n = Math.trunc(rel.qy);
  if (n !== 0){
    dir = sign(n);
    for (k = 0; k < Math.abs(n); k++){
      r = tryStep(id, rel, mem, 0, dir, Math.abs(rel.vy));
      if (r.ok){ rel.qy -= dir; moved = true; if (dir === gs) rel.contact = 0; }
      else { collide(id, rel, mem, "y", r); rel.qy = 0; if (dir === gs) rel.contact = 14; break; }
    }
  }
  n = Math.trunc(rel.qx);
  if (n !== 0 && rel.p.length){
    dir = sign(n);
    for (k = 0; k < Math.abs(n); k++){
      r = tryStep(id, rel, mem, dir, 0, Math.abs(rel.vx));
      if (r.ok){ rel.qx -= dir; moved = true; }
      else { collide(id, rel, mem, "x", r); rel.qx = 0; break; }
    }
  }
  if (!moved && !thrusting && rel.contact > 0 && Math.abs(rel.vx) < 0.05) rel.sleep++;
  else rel.sleep = 0;
}

/* ------------------------------------------------------------- elements */
function phys(id, color, p, desc, extra){
  PHYS[id] = p;
  elements[id] = Object.assign({
    color: color, behavior: behaviors.WALL, category: "physics", state: "solid",
    density: p.dens, conduct: 0.9, hardness: p.hard, desc: desc,
    onPlace: onPlacePhys, onDelete: onDeletePhys
  }, extra || {});
}
elements.phys_debris = {
  color: ["#8a8f98","#6f747c","#a3a8b0"], behavior: behaviors.POWDER, category: "physics",
  state: "solid", density: 1800, hidden: true, desc: "Broken bits of physics blocks."
};
var DEB = "phys_debris";
phys("phys_block", ["#5c7fa8","#6a8db5"], { dens:1500, bounce:0.15, hard:0.6, g:1, fric:0.3, debris:DEB },
  "Solid wall. Power it with electricity and the whole chunk becomes a falling physics object.");
phys("phys_rubber", ["#e0405a","#c9344d"], { dens:900, bounce:0.85, hard:0.8, g:1, fric:0.5, debris:DEB },
  "Very bouncy and tough physics block.");
phys("phys_superball", ["#b050ff","#c77dff"], { dens:1100, bounce:0.97, hard:0.9, g:1, fric:0.2, debris:DEB },
  "Almost perfectly elastic. Bounces practically forever.");
phys("phys_jelly", ["#5fe08a","#4ed17a"], { dens:1050, bounce:0.55, hard:0.7, g:1, fric:0.6, debris:DEB },
  "Medium bounce, grippy.");
phys("phys_steel", ["#9aa3ad","#8a939d"], { dens:7800, bounce:0.05, hard:0.95, g:1, fric:0.2, debris:DEB },
  "Very heavy and nearly unbreakable. Smashes things on impact.");
phys("phys_stone", ["#8c8478","#7d766b"], { dens:2600, bounce:0.08, hard:0.8, g:1, fric:0.5, debris:DEB },
  "Heavy and strong, hardly bounces.");
phys("phys_glass", ["#9fe8f2","#b9f3fa"], { dens:2500, bounce:0.1, hard:0.15, g:1, fric:0.3, debris:"glass_shard" },
  "Brittle. Shatters on hard impacts.");
phys("phys_wood", ["#b5823f","#a67537"], { dens:650, bounce:0.2, hard:0.5, g:1, fric:0.45, debris:DEB },
  "Floats on water. Flammable.", { burn: 15, burnTime: 300, burnInto: "ash" });
phys("phys_foam", ["#ffe36b","#ffd84a"], { dens:150, bounce:0.25, hard:0.3, g:1, fric:0.4, debris:DEB },
  "Super light. Floats high on liquids, breaks easily.");
phys("phys_ice", ["#bfeaff","#d6f2ff"], { dens:920, bounce:0.3, hard:0.35, g:1, fric:0.02, debris:DEB },
  "Floats, slides almost without friction, melts when warm.", { tempHigh: 5, stateHigh: "water" });
phys("phys_balloon", ["#ff5252","#ff7070"], { dens:40, bounce:0.6, hard:0.3, g:-0.45, fric:0.3, debris:DEB },
  "Lighter than air. Falls UP.");
function thruster(id, color, tx, ty, label){
  phys(id, color, { dens:3000, bounce:0.05, hard:0.85, g:1, fric:0.3, debris:DEB, thr:[tx,ty], force:4 },
    "Rocket engine pushing " + label + " while powered. Attach to a physics body, then power it. (Pulses with the electric signal.)");
}
thruster("phys_thruster_up", ["#ff8a3d","#ff9d5c"], 0, -1, "up");
thruster("phys_thruster_down", ["#ff8a3d","#ff9d5c"], 0, 1, "down");
thruster("phys_thruster_left", ["#ff8a3d","#ff9d5c"], -1, 0, "left");
thruster("phys_thruster_right", ["#ff8a3d","#ff9d5c"], 1, 0, "right");

/* ---------------------------------------------------------------- tools */
function bodyOf(pixel){
  if (pixel._r === undefined) return null;
  var r = currentRelations[pixel._r]; return (r && r.mx) ? r : null;
}
elements.phys_release = {
  color: "#4dd2ff", category: "tools", canPlace: false,
  desc: "Unhooks a physics chunk without needing electricity.",
  tool: function(pixel){ if (pixel._r === undefined && PHYS[pixel.element]) activate(pixel); }
};
elements.phys_lock = {
  color: "#ff6b6b", category: "tools", canPlace: false,
  desc: "Locks a moving physics body back onto the grid as static blocks.",
  tool: function(pixel){
    var r = bodyOf(pixel); if (!r) return;
    var id = pixel._r, src = r.p || [];
    for (var i = 0; i < src.length; i++) if (src[i]._r === id) delete src[i]._r;
    delete currentRelations[id];
  }
};
elements.phys_kick = {
  color: "#ffd24d", category: "tools", canPlace: false,
  desc: "Kicks a physics body upward with a random sideways shove.",
  tool: function(pixel){
    var r = bodyOf(pixel); if (!r || r.kickT === pixelTicks) return;
    r.kickT = pixelTicks; r.vy = (r.vy||0) - 1.6; r.vx = (r.vx||0) + (Math.random()*2.4 - 1.2); r.sleep = 0;
  }
};
elements.phys_flip = {
  color: "#c792ff", category: "tools", canPlace: false,
  desc: "Flips the gravity direction of a physics body.",
  tool: function(pixel){
    var r = bodyOf(pixel); if (!r) return;
    if (r.flipT !== undefined && pixelTicks - r.flipT < 15) return;
    r.flipT = pixelTicks; r.gf = -(r.gf || 1); r.sleep = 0;
  }
};

/* ------------------------------------------------------ simulation hook */
runPerPixel(function(p){
  var rid = p._r;
  if (rid !== undefined){
    var rel = currentRelations[rid];
    if (rel && rel.mx === true && rel.stamp !== pixelTicks){ rel.stamp = pixelTicks; stepBody(rid, rel); }
  }
  else if (p.charge && PHYS[p.element]) activate(p);
});

if (typeof logMessage === "function") logMessage("Physics Blocks loaded - see the Physics category.");
})();
