/* ============================================================================
   MYTHIC EXPANSE  -  a giant content mod for Sandboxels (written for v1.13.2)
   ----------------------------------------------------------------------------
   Only uses long-standing modding features: elements, behaviors, tick functions,
   reactions, tools, and a handful of core helpers (tryMove, createPixel,
   changePixel, deletePixel, isEmpty, explodeAt, pixelTempCheck, pixelMap).
   Every helper is guarded, so a missing one just disables that one effect.

   CATEGORIES ADDED
     metals, ores, gems, arcane, fluids, flora, critters, machines, bombs,
     flames, weather, spawners, sweets, building, chaos   (+ new TOOLS)
   ========================================================================== */
(function () {
"use strict";

/* ------------------------------------------------------------------ helpers */
var MX = { pads: {}, pool: null };
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];
var D8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
function rnd(n){ return Math.floor(Math.random()*n); }
function chance(p){ return Math.random() < p; }
function pick(a){ return a[rnd(a.length)]; }
function at(x,y){ var c = pixelMap[x]; return c ? c[y] : undefined; }
function live(p){ return !!p && !p.del && pixelMap[p.x] && pixelMap[p.x][p.y] === p; }
function put(el,x,y){
  if (elements[el] && isEmpty(x,y)) { createPixel(el,x,y); return at(x,y) || null; }
  return null;
}
function tickNow(){ return (typeof pixelTicks !== "undefined") ? pixelTicks : 0; }
function heat(p,d){
  if (!p) return;
  p.temp += d; if (p.temp < -273) p.temp = -273;
  if (typeof pixelTempCheck === "function") pixelTempCheck(p);
}
function heatTo(p,target,rate){
  if (!p) return;
  if (target > p.temp) { if (p.temp < target) heat(p, Math.min(rate, target - p.temp)); }
  else if (p.temp > target) heat(p, -Math.min(rate, p.temp - target));
}
function ignite(n){
  var e = elements[n.element];
  if (e && e.burn && !n.burning) { n.burning = true; n.burnStart = tickNow(); }
}
function neighbors(p,list){
  var out = [], l = list || D4;
  for (var i = 0; i < l.length; i++){ var n = at(p.x+l[i][0], p.y+l[i][1]); if (n) out.push(n); }
  return out;
}
function randNeighbor(p,list){ var l = neighbors(p,list); return l.length ? pick(l) : null; }
function emptySpot(p,list){
  var l = list || D8, s = rnd(l.length);
  for (var i = 0; i < l.length; i++){
    var d = l[(s+i) % l.length];
    if (isEmpty(p.x+d[0], p.y+d[1])) return d;
  }
  return null;
}
function movable(p){
  var e = elements[p.element];
  if (!e) return false;
  if (e.movable === false) return false;
  if (e.category === "machines" || e.category === "spawners") return false;
  if (typeof behaviors !== "undefined" && e.behavior === behaviors.WALL) return false;
  return true;
}
function eachInRadius(cx,cy,r,fn){
  for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++)
    if (dx*dx + dy*dy <= r*r) fn(cx+dx, cy+dy, dx, dy);
}
function blast(x,y,r,fire){
  if (typeof explodeAt === "function") { explodeAt(x,y,r,fire || "fire"); return; }
  eachInRadius(x,y,r,function(px,py){
    var t = at(px,py); if (t) deletePixel(px,py);
    if (fire && chance(0.3)) put(fire,px,py);
  });
}
function smash(t){
  var e = elements[t.element]; if (!e || !e.breakInto) return;
  var b = e.breakInto; if (Array.isArray(b)) b = pick(b);
  if (b && elements[b]) changePixel(t,b);
}
function hsv(h,s,v){
  var f = function(n){ var k=(n+h/60)%6; return v - v*s*Math.max(Math.min(k,4-k,1),0); };
  return "rgb("+Math.round(f(5)*255)+","+Math.round(f(3)*255)+","+Math.round(f(1)*255)+")";
}
function lighten(hex,a){
  var r=parseInt(hex.substr(1,2),16), g=parseInt(hex.substr(3,2),16), b=parseInt(hex.substr(5,2),16);
  var m=function(v){ return ("0"+Math.round(v+(255-v)*a).toString(16)).slice(-2); };
  return "#"+m(r)+m(g)+m(b);
}
function W(){ return pixelMap.length; }
function H(){ return pixelMap[0].length; }
function moveTo(p,x,y){            /* swim-friendly move: swaps with water */
  if (isEmpty(x,y)) return tryMove(p,x,y);
  var t = at(x,y);
  if (t && t.element === "water" && typeof swapPixels === "function") { swapPixels(p,t); return true; }
  return false;
}
function pull(c,r,sign,filter,prob){
  var list = [];
  eachInRadius(c.x,c.y,r,function(x,y,dx,dy){
    if (!dx && !dy) return;
    var t = at(x,y);
    if (!t || t === c || !movable(t)) return;
    if (filter && !filter(t)) return;
    if (!chance(prob || 0.5)) return;
    list.push([t, dx>0?-1:dx<0?1:0, dy>0?-1:dy<0?1:0]);
  });
  list.forEach(function(a){ if (live(a[0])) tryMove(a[0], a[0].x + a[1]*sign, a[0].y + a[2]*sign); });
}
function zap(p){
  D4.forEach(function(d){
    var n = at(p.x+d[0], p.y+d[1]);
    if (n && n.element !== p.element && elements[n.element] && elements[n.element].conduct && !n.charge) n.charge = 1;
  });
}
function randomElement(){
  if (!MX.pool) {
    MX.pool = Object.keys(elements).filter(function(k){
      var e = elements[k];
      return e && e.state && !e.hidden && e.category !== "tools" && e.category !== "bombs"
        && e.category !== "machines" && e.category !== "spawners" && e.category !== "weather"
        && k !== "chaos_dust" && k !== "chaos_rift" && k !== "gray_goo" && k !== "black_hole";
    });
  }
  return pick(MX.pool);
}
var WALL = behaviors.WALL, POWDER = behaviors.POWDER, LIQUID = behaviors.LIQUID, GAS = behaviors.GAS;

function mk(id,o){
  if (elements[id]) return null;                       /* never overwrite vanilla */
  if (!o.category) o.category = "mythic";
  if (!o.state) o.state = "solid";
  if (o.density === undefined) o.density = 1000;
  if (!o.behavior) o.behavior = WALL;
  elements[id] = o;
  return o;
}

/* ============================================================== 1. METALS */
function metal(id,color,melt,dens,cond,extra){
  mk(id, Object.assign({ color:color, behavior:WALL, category:"metals", state:"solid", density:dens,
    conduct:cond, tempHigh:melt, stateHigh:"molten_"+id, hardness:0.7 }, extra || {}));
  mk("molten_"+id, { color:["#ffb347","#ff8c1a","#ffd27a"], behavior:behaviors.MOLTEN, category:"metals",
    hidden:true, state:"liquid", density:dens*0.85, temp:melt+60, tempLow:melt-30, stateLow:id, conduct:cond*0.5 });
}
metal("titanium","#c3c8cf",1668,4500,0.4);
metal("cobalt","#2f5fa8",1495,8900,0.5);
metal("mithril","#9fe3ff",1300,2600,0.9);
metal("adamantite","#c2185b",2800,9000,0.3,{hardness:0.99});
metal("orichalcum","#ff9966",1150,7000,0.8);
metal("darksteel","#34344a",1750,7900,0.6);
metal("bronze","#cd7f32",950,8800,0.85);
metal("rose_gold","#e8a09a",1000,15000,0.9);
metal("electrum","#e6d27a",1000,13000,0.95);
metal("chromium","#d6dbe0",1900,7100,0.5);
metal("starmetal","#6a5acd",2200,6000,0.7);
metal("cryosteel","#8fe8ff",1500,7800,0.6,{ tick:function(p){
  if (chance(0.25)) { var n = randNeighbor(p); if (n && n.element !== p.element) heatTo(n,-60,6); } } });
metal("pyrosteel","#ff5a2a",1500,7800,0.6,{ tick:function(p){
  if (chance(0.25)) { var n = randNeighbor(p); if (n && n.element !== p.element) heatTo(n,700,8); } } });
metal("voltium","#fff35c",1400,6800,1,{ tick:function(p){ if (chance(0.04)) zap(p); } });
metal("gravitite","#8e44ad",1900,9500,0.4,{ tick:function(p){
  if (chance(0.5)) pull(p,5,1,function(t){ return t.element !== p.element; },0.35); } });
metal("featherlite","#e8f6ff",900,200,0.5);

function ore(id,color,metalId,melt){
  mk(id,{ color:color, behavior:POWDER, category:"ores", state:"solid", density:3200, hardness:0.5,
    tempHigh:melt, stateHigh:"molten_"+metalId, breakInto:"gravel" });
}
ore("titanium_ore",["#8d96a0","#aab3bd"],"titanium",1668);
ore("cobalt_ore",["#3a4f7a","#5071b0"],"cobalt",1495);
ore("mithril_ore",["#6fc3e8","#4aa3c8"],"mithril",1300);
ore("adamantite_ore",["#8c1448","#c2185b"],"adamantite",2800);
ore("orichalcum_ore",["#c87a4e","#ff9966"],"orichalcum",1150);
ore("starmetal_ore",["#4b3fa0","#6a5acd"],"starmetal",2200);
ore("voltium_ore",["#d9c93a","#fff35c"],"voltium",1400);

/* ================================================================ 2. GEMS */
function gem(id,color,dens,extra){
  mk(id, Object.assign({ color:color, behavior:POWDER, category:"gems", state:"solid", density:dens,
    hardness:0.9, tempHigh:1700, stateHigh:"molten_glass", breakInto:id+"_dust" }, extra || {}));
  mk(id+"_dust",{ color:[lighten(color,0.35),lighten(color,0.55)], behavior:POWDER, category:"gems",
    state:"solid", density:dens*0.5, hidden:true });
}
gem("amethyst","#9b59d0",2650);
gem("topaz","#f5b942",3500);
gem("aquamarine","#7fdbda",2700);
gem("citrine","#f0c040",2650);
gem("onyx","#1c1c24",2900);
gem("jade","#3cb371",3300);
gem("tanzanite","#4d5bd6",3350);
gem("bloodstone","#7a1020",2600);
gem("pearl","#f4efe6",2700);
gem("star_sapphire","#2255cc",4000);
gem("fire_opal","#ff7043",2100);
gem("black_opal","#27263a",2100);
gem("aether_crystal","#b9a7ff",2000,{ tick:function(p){
  if (chance(0.002)) { var d = emptySpot(p,D4); if (d) put("mana",p.x+d[0],p.y+d[1]); } } });
gem("dragonstone","#d6322f",4200,{ tick:function(p){ if (chance(0.5)) { var n = randNeighbor(p); if (n) heatTo(n,300,5); } } });

/* elemental power stones: static blocks that DO something */
function stone(id,color,fn,extra){
  mk(id, Object.assign({ color:color, behavior:WALL, category:"gems", state:"solid", density:3000,
    hardness:0.9, tick:fn }, extra || {}));
}
stone("sunstone",["#ffcc33","#ffdd66"],function(p){ var n=randNeighbor(p); if(n&&n.element!==p.element) heatTo(n,150,4); });
stone("moonstone",["#c9d6ff","#e0e8ff"],function(p){ var n=randNeighbor(p); if(n&&n.element!==p.element) heatTo(n,-20,4); });
stone("emberstone",["#ff4d1a","#ff7a3a"],function(p){ if(chance(0.01)) put("fire",p.x,p.y-1); });
stone("tidestone",["#2e8bff","#5aa8ff"],function(p){ if(chance(0.03)){ var d=emptySpot(p,D4); if(d) put("water",p.x+d[0],p.y+d[1]); } });
stone("stormstone",["#7d6bff","#a396ff"],function(p){ if(chance(0.02)) zap(p); if(chance(0.001)) put("lightning",p.x,p.y-1); });
stone("lifestone",["#4cff7a","#7dffa0"],function(p){
  var n=randNeighbor(p,D8); if(n&&chance(0.2)){ if(n.element==="dirt"||n.element==="mud") changePixel(n,"grass");
  else if(n.element==="grass"&&chance(0.2)) put("plant",n.x,n.y-1); }
  if(n&&n.burning) n.burning=false; });
stone("voidstone",["#1a0033","#33006b"],function(p){
  if(chance(0.05)){ var n=randNeighbor(p); if(n&&n.element!==p.element&&movable(n)) deletePixel(n.x,n.y); } });
stone("windstone",["#c8fff5","#9ff0e4"],function(p){
  var a=at(p.x,p.y-1); if(a&&movable(a)&&chance(0.6)) tryMove(a,a.x,a.y-1); });
stone("earthstone",["#8b6b3e","#a98250"],function(p){ if(chance(0.01)){ var d=emptySpot(p,D4); if(d) put("gravel",p.x+d[0],p.y+d[1]); } });
stone("gravitystone",["#5b2c83","#7d3caf"],function(p){ if(chance(0.5)) pull(p,6,1,null,0.3); });
stone("repulsorstone",["#c0392b","#e74c3c"],function(p){ if(chance(0.5)) pull(p,6,-1,null,0.3); });
stone("philosophers_stone",["#d4001e","#ff3355"],function(p){
  var n=randNeighbor(p);
  if(n&&["iron","steel","copper","lead","tin","zinc","nickel","aluminum","brass","bronze"].indexOf(n.element)>-1&&chance(0.05)&&elements.gold) changePixel(n,"gold"); });

/* =============================================================== 3. ARCANE / FLUIDS */
function fluid(id,color,dens,extra){
  mk(id, Object.assign({ color:color, behavior:LIQUID, category:"fluids", state:"liquid", density:dens }, extra || {}));
}
fluid("mana",["#6a5cff","#8f7bff","#5a4bdc"],1010,{ category:"arcane", reactions:{
  "sand":{elem1:null,elem2:"aether_crystal",chance:0.003},
  "iron":{elem1:null,elem2:"mithril",chance:0.002},
  "copper":{elem1:null,elem2:"orichalcum",chance:0.002},
  "steel":{elem1:null,elem2:"darksteel",chance:0.002} } });
mk("aether",{ color:["#e0d4ff","#c7b5ff"], behavior:GAS, category:"arcane", state:"gas", density:0.3, tick:function(p){
  if (chance(0.01)){ var n=randNeighbor(p); if(n&&n.element==="water") changePixel(n,"mana"); }
  if (chance(0.002)) deletePixel(p.x,p.y); } });
mk("void_dust",{ color:["#120022","#2a0050"], behavior:POWDER, category:"arcane", density:1800, tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!=="void_dust"&&movable(n)&&chance(0.3)){ deletePixel(n.x,n.y); if(chance(0.3)) deletePixel(p.x,p.y); } } });
mk("nullstone",{ color:["#000000","#14002a"], category:"arcane", density:9999, tick:function(p){
  if(chance(0.03)){ var n=randNeighbor(p); if(n&&n.element!=="nullstone"&&elements[n.element].category!=="tools") deletePixel(n.x,n.y); } } });
mk("arcane_dust",{ color:["#b57bff","#ff7bf2","#7bc4ff"], behavior:POWDER, category:"arcane", density:900 });
mk("rune_stone",{ color:["#4a4a68","#5e5e80"], category:"arcane", density:2800, conduct:0.7, tick:function(p){
  if(p.charge&&chance(0.2)) { var d=emptySpot(p,D4); if(d) put("arcane_dust",p.x+d[0],p.y+d[1]); } } });
mk("mana_crystal",{ color:["#5d4fff","#9b8cff"], category:"arcane", density:2400, tick:function(p){
  if(chance(0.004)){ var d=emptySpot(p,D4); if(d) put("mana",p.x+d[0],p.y+d[1]); } },
  breakInto:"arcane_dust" });
fluid("holy_water",["#fff9c4","#fffde8"],1000,{ category:"arcane", tick:function(p){
  var n=randNeighbor(p); if(!n) return;
  if(n.element==="corruption"||n.element==="gray_goo"){ changePixel(n,"dirt"); if(chance(0.5)) changePixel(p,"water"); }
  if(n.burning) n.burning=false; } });
fluid("lumen",["#fffbd0","#fff7a8"],1000,{ category:"arcane", tick:function(p){
  var n=randNeighbor(p); if(n&&n.element==="corruption"&&chance(0.5)) changePixel(n,"dirt"); } });
fluid("cryofluid",["#a8f0ff","#7fe0ff"],1100,{ temp:-150, tempHigh:-60, stateHigh:"steam", reactions:{
  "water":{elem1:"cryofluid",elem2:"ice",chance:0.2} } });
fluid("toxic_sludge",["#6b8e23","#556b2f"],1250,{ category:"fluids", viscosity:300 });
fluid("pitch",["#1b1b1b","#262626"],1300,{ viscosity:5000, burn:40, burnTime:300 });
fluid("rainbow_liquid",["#ff0000","#00ff00","#0000ff"],1020,{ tick:function(p){ p.color = hsv((tickNow()*4 + p.x*3 + p.y*2)%360,0.8,1); } });
fluid("rainbow_slime",["#ff66cc","#66ccff"],1150,{ tick:function(p){ p.color = hsv((tickNow()*2 + p.x*5)%360,0.7,1); if(chance(0.01)) tryMove(p,p.x,p.y-1); } });
fluid("blue_magma",["#4ba3ff","#2e6fe0","#8fd0ff"],2400,{ temp:2000, tempLow:1100, stateLow:"rock", behavior:behaviors.MOLTEN, hidden:false, category:"fluids" });
fluid("liquid_midas",["#ffd700","#ffec6a"],1900,{ tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!=="liquid_midas"&&elements[n.element].state==="solid"&&n.element!=="gold"&&movable(n)&&elements.gold){ changePixel(n,"gold"); deletePixel(p.x,p.y);} } });
fluid("healing_potion",["#ff6f91","#ff9ab3"],1000,{ category:"arcane", tick:function(p){
  var n=randNeighbor(p,D8); if(n){ if(n.burning) n.burning=false; if(n.temp>60) heatTo(n,30,3);} } });
fluid("growth_potion",["#8aff6b","#5cd84a"],1000,{ category:"arcane", tick:function(p){
  var n=randNeighbor(p); if(n&&n.h!==undefined&&chance(0.3)){ n.h=0; n.done=false; } } });
fluid("lift_potion",["#e8ccff","#d1a8ff"],900,{ category:"arcane", behavior:behaviors.AGLIQUID });
fluid("antimatter_fluid",["#00ffe1","#ff00aa"],1000,{ category:"chaos", tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element&&elements[n.element].category!=="tools"){ var x=p.x,y=p.y; deletePixel(n.x,n.y); if(live(p)) deletePixel(p.x,p.y); blast(x,y,3,"fire"); } } });
fluid("soda_pop",["#5a2d0c","#7a3d12"],1030,{ category:"sweets", tick:function(p){
  if(chance(0.002)) put("carbon_dioxide",p.x,p.y-1); },
  reactions:{} });
fluid("melted_chocolate",["#4a2511","#5a2d16"],1300,{ category:"sweets", temp:50, tempLow:30, stateLow:"chocolate", viscosity:800 });
fluid("caramel",["#c68a2c","#d9a040"],1350,{ category:"sweets", temp:90, tempLow:40, stateLow:"hard_caramel", viscosity:1500 });
fluid("royal_jelly",["#fff0a0","#f7e07a"],1380,{ category:"sweets", viscosity:2000 });

/* ================================================================ 4. FLAMES */
function flame(id,color,temp,fn,extra){
  mk(id, Object.assign({ color:color, behavior:behaviors.DGAS, category:"flames", state:"gas", density:0.4,
    temp:temp, tick:fn }, extra || {}));
}
flame("arcane_fire",["#b44bff","#d98cff","#7a2cff"],900,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,700,20); ignite(n); if(chance(0.01)&&n.element==="water") changePixel(n,"mana"); } });
flame("frost_fire",["#74e8ff","#b8f4ff","#4dd2f0"],-60,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,-80,25); if(n.element==="water"&&chance(0.2)) changePixel(n,"ice"); } });
flame("soul_fire",["#3fe0d0","#8ff5ea","#20b8a8"],600,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ if(elements[n.element].category==="critters"&&chance(0.3)) deletePixel(n.x,n.y); else heatTo(n,500,15);} });
flame("hellfire",["#8b0000","#c40000","#ff2a00"],1500,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,1400,60); ignite(n); } });
flame("white_fire",["#ffffff","#fffbe0","#ffeaa0"],2500,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,2400,120); ignite(n); } });
flame("holy_fire",["#fff6b0","#ffe066","#ffffff"],700,function(p){
  var n=randNeighbor(p); if(n){ if(n.element==="corruption"||n.element==="gray_goo") changePixel(n,"ash"); else if(n.element!==p.element){ heatTo(n,400,10); ignite(n);} } });
flame("toxic_flame",["#7cff3a","#b6ff6b","#4fd11a"],650,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,600,15); ignite(n); if(chance(0.01)) put("toxic_sludge",p.x,p.y+1);} });
flame("rainbow_fire",["#ff0000","#00ff00","#0000ff"],800,function(p){
  p.color = hsv((tickNow()*10 + p.x*7)%360,0.9,1);
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,600,15); ignite(n);} });
flame("void_fire",["#150020","#2d0050","#000000"],300,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element&&movable(n)&&chance(0.15)) deletePixel(n.x,n.y); });
flame("blue_flame",["#3b82ff","#7fb2ff","#2559d6"],1300,function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,1200,50); ignite(n);} });
mk("greek_fire",{ color:["#ff9d00","#ffbf3a","#ff7a00"], behavior:LIQUID, category:"flames", state:"liquid", density:1050, temp:900,
  tick:function(p){ var n=randNeighbor(p); if(n&&n.element!==p.element){ heatTo(n,800,40); ignite(n);} if(chance(0.01)) put("fire",p.x,p.y-1); if(chance(0.0007)) deletePixel(p.x,p.y); } });

/* ================================================================ 5. FLORA */
var SOIL = { dirt:1, mud:1, grass:1, moss:1, fertile_soil:1 };
function growUp(p,maxh,el,prob,medium){
  if (p.done || !chance(prob)) return;
  var h = p.h || 0; if (h >= maxh) { p.done = true; return; }
  if (medium){
    var t = at(p.x,p.y-1);
    if (t && t.element === medium){ changePixel(t,el); var n=at(p.x,p.y-1); if(n) n.h=h+1; p.done = true; }
  } else if (isEmpty(p.x,p.y-1)){ var m = put(el,p.x,p.y-1); if (m){ m.h = h+1; p.done = true; } }
}
mk("fertile_soil",{ color:["#4b3320","#5a3d26"], behavior:POWDER, category:"flora", density:1250, burn:0 });
mk("bamboo",{ color:["#7cb342","#8bc34a","#689f38"], category:"flora", density:600, burn:20, burnTime:200, burnInto:"ash",
  tick:function(p){ growUp(p,22,"bamboo",0.05); } });
mk("kelp",{ color:["#2e7d32","#388e3c"], category:"flora", density:1002, burn:10, burnTime:150, burnInto:"ash",
  tick:function(p){ growUp(p,18,"kelp",0.04,"water"); } });
mk("hanging_vine",{ color:["#43a047","#2e7d32"], category:"flora", density:500, burn:25, burnTime:100, burnInto:"ash", tick:function(p){
  if(p.done||!chance(0.04)) return; var h=p.h||0; if(h>=14){p.done=true;return;}
  if(isEmpty(p.x,p.y+1)){ var m=put("hanging_vine",p.x,p.y+1); if(m){m.h=h+1;p.done=true;} } } });
mk("moss",{ color:["#4f7a2a","#5f8f33"], category:"flora", density:1500, tick:function(p){
  if(!chance(0.01)) return; var n=randNeighbor(p,D8);
  if(n&&(n.element==="rock"||n.element==="gravel"||n.element==="cobblestone")){
    var wet=neighbors(n,D8).some(function(q){ return q.element==="water"||q.element==="moss"; });
    if(wet) changePixel(n,"moss"); } } });
mk("spores",{ color:["#c6f0a0","#e0ffc0"], behavior:POWDER, category:"flora", density:20, tick:function(p){
  var b=at(p.x,p.y+1); if(b&&SOIL[b.element]&&chance(0.05)) changePixel(p,"glowshroom"); else if(chance(0.001)) deletePixel(p.x,p.y); } });
mk("glowshroom",{ color:["#39ffd0","#5cffe0","#20d9b0"], category:"flora", density:800, burn:30, burnTime:60, burnInto:"ash", tick:function(p){
  if(chance(0.0006)) put("spores",p.x,p.y-1);
  if(chance(0.08)) p.color = chance(0.5) ? "#7dffe6" : "#27c9a4"; } });
mk("fire_blossom",{ color:["#ff5722","#ff8a50"], category:"flora", density:700, burn:80, burnTime:40, tick:function(p){
  if(chance(0.004)) put("fire",p.x,p.y-1); } });
mk("frost_lily",{ color:["#b3e5fc","#e1f5fe"], category:"flora", density:700, tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element) heatTo(n,-20,2); } });
mk("moonbloom",{ color:["#e8e0ff","#cfc3ff"], category:"flora", density:700, tick:function(p){
  if(chance(0.1)) p.color = chance(0.5)?"#f4f0ff":"#bfb0ff"; } });
mk("money_plant",{ color:["#2e9e44","#3fbf5a"], category:"flora", density:700, tick:function(p){
  if(chance(0.0004)&&elements.gold_dust) put("gold_dust",p.x,p.y-1); } });
mk("gold_dust",{ color:["#ffd54a","#ffe27a"], behavior:POWDER, category:"flora", hidden:true, density:1900, tempHigh:1064, stateHigh:"molten_gold" });
mk("carnivorous_plant",{ color:["#d81b60","#ad1457"], category:"flora", density:700, burn:30, burnTime:80, tick:function(p){
  var n=randNeighbor(p,D8);
  if(n&&(elements[n.element].category==="critters"||n.element==="fly"||n.element==="ant"||n.element==="bee")&&chance(0.2)){ deletePixel(n.x,n.y); p.fed=(p.fed||0)+1; }
  if(p.fed>=4){ p.fed=0; var d=emptySpot(p,D4); if(d) put("carnivorous_plant",p.x+d[0],p.y+d[1]); } } });
mk("mushroom_ring",{ color:["#e57373","#ef9a9a"], category:"flora", density:700, tick:function(p){
  if(chance(0.001)){ var d=emptySpot(p,[[1,0],[-1,0]]); var b=d&&at(p.x+d[0],p.y+1); if(d&&b&&SOIL[b.element]) put("mushroom_ring",p.x+d[0],p.y); } } });

/* tree factory: seed -> trunk -> crown (everything hidden except the seed) */
function tree(name,seedColor,trunkColor,leafColor,minH,maxH,r,drop,dropRate,extra){
  var trunk = name+"_trunk", leaf = name+"_leaves";
  mk(name+"_seed",{ color:seedColor, behavior:POWDER, category:"flora", density:1100, tick:function(p){
    var b=at(p.x,p.y+1);
    if(b&&SOIL[b.element]&&chance(0.03)){ changePixel(p,trunk); var t=at(p.x,p.y); if(t){ t.h=0; t.maxh=minH+rnd(maxH-minH+1);} } } });
  function crown(p){
    p.done = true;
    eachInRadius(p.x,p.y-1,r,function(x,y){ if(isEmpty(x,y)) put(leaf,x,y); });
  }
  mk(trunk,{ color:trunkColor, category:"flora", hidden:true, density:700, burn:8, burnTime:300, burnInto:"charcoal", tick:function(p){
    if(p.done) return; if(p.maxh===undefined){ p.maxh=minH+rnd(maxH-minH+1); p.h=p.h||0; }
    if(!chance(0.25)) return;
    if(p.h<p.maxh){
      if(isEmpty(p.x,p.y-1)){ var n=put(trunk,p.x,p.y-1); if(n){ n.h=p.h+1; n.maxh=p.maxh; p.done=true; } }
      else crown(p);
    } else crown(p); } });
  mk(leaf,Object.assign({ color:leafColor, category:"flora", hidden:true, density:300, burn:25, burnTime:100, burnInto:"ash",
    tick:function(p){ if(drop&&chance(dropRate)) put(drop,p.x,p.y+1); } },extra||{}));
}
tree("mana",["#7d6bff","#a396ff"],["#5b4a8a","#6a5a9c"],["#8f7bff","#6a5cff","#b3a6ff"],8,14,3,"mana",0.0004);
tree("crystal",["#bfefff","#9fdcff"],["#7fc8e8","#a6dcf2"],["#c9f1ff","#aee6ff","#e6fbff"],7,12,3,"aquamarine_dust",0.0003);
tree("ember",["#ff7043","#ff5722"],["#4e2a1a","#3d1f12"],["#ff6a1a","#ff9a3d","#e8420a"],7,13,3,"fire",0.0004);
tree("frost",["#e3f2fd","#cfe8ff"],["#8fb8d8","#a6c8e0"],["#e8f6ff","#ffffff","#cde9ff"],8,13,3,"snow",0.0008);
tree("candy",["#ff80ab","#f48fb1"],["#8d6e63","#a1887f"],["#ff80ab","#ffd180","#b39ddb","#80d8ff"],6,10,3,"sprinkles",0.0007);
tree("golden",["#ffd54f","#ffca28"],["#8a6d1a","#a07f20"],["#ffd700","#ffec6a","#e6b800"],7,12,3,"gold_dust",0.0003);

/* ============================================================== 6. CRITTERS */
function flutter(p,upBias){
  var dx=rnd(3)-1, dy=rnd(3)-1; if(upBias&&chance(upBias)) dy=-1; tryMove(p,p.x+dx,p.y+dy);
}
function walk(p,speed){
  if(tryMove(p,p.x,p.y+1)) return;
  if(!chance(speed||0.3)) return;
  if(!p.dir) p.dir = chance(0.5)?1:-1;
  if(!tryMove(p,p.x+p.dir,p.y) && !tryMove(p,p.x+p.dir,p.y-1)) p.dir=-p.dir;
}
function critter(id,color,fn,extra){
  mk(id, Object.assign({ color:color, category:"critters", state:"solid", density:1050, tempHigh:120, stateHigh:"ash",
    tempLow:-50, stateLow:"ice", tick:fn, burn:40, burnTime:30, burnInto:"ash" }, extra || {}));
}
critter("firefly",["#fff59a","#d9d36a"],function(p){
  flutter(p,0.1); if(chance(0.1)) p.color = chance(0.5)?"#fff59a":"#8a8640"; });
critter("pixie",["#ff9ff3","#a29bfe","#74b9ff"],function(p){
  flutter(p,0.1); if(chance(0.04)){ var d=emptySpot(p,D8); if(d) put("arcane_dust",p.x+d[0],p.y+d[1]); } });
critter("wisp",["#9ffff0","#c8fff8"],function(p){
  if(chance(0.5)) flutter(p,0.3); if(chance(0.05)) p.color = chance(0.5)?"#9ffff0":"#5ad8c8";
  if(chance(0.001)) deletePixel(p.x,p.y); },{ tempHigh:1000 });
critter("bat",["#3b2f4a","#4e3d63"],function(p){
  flutter(p,0.2);
  var n=randNeighbor(p,D8); if(n&&n.element==="firefly"&&chance(0.3)) deletePixel(n.x,n.y); });
critter("frog",["#4caf50","#66bb6a"],function(p){
  if(tryMove(p,p.x,p.y+1)) return;
  if(chance(0.04)){ var dir=p.dir||(p.dir=chance(0.5)?1:-1);
    if(!tryMove(p,p.x+dir,p.y-1)) p.dir=-dir; else { tryMove(p,p.x+dir,p.y-1); } }
  var n=randNeighbor(p,D8); if(n&&(n.element==="firefly"||n.element==="fly")&&chance(0.3)) deletePixel(n.x,n.y); });
critter("snail",["#a1887f","#8d6e63"],function(p){ walk(p,0.04); });
critter("crab",["#e64a19","#ff7043"],function(p){ walk(p,0.5); });
critter("jellyfish",["#ff8ad8","#8ad8ff"],function(p){
  var wet=neighbors(p).some(function(n){ return n.element==="water"; });
  if(!wet){ if(chance(0.03)){ changePixel(p,"slime"); } return; }
  if(chance(0.05)) moveTo(p,p.x+rnd(3)-1,p.y-1); else if(chance(0.1)) moveTo(p,p.x,p.y+1);
  if(chance(0.08)) p.color = chance(0.5)?"#ff8ad8":"#8ad8ff"; },{ density:1000 });
critter("piranha",["#b71c1c","#e53935"],function(p){
  var wet=neighbors(p).some(function(n){ return n.element==="water"; });
  if(!wet){ tryMove(p,p.x,p.y+1); return; }
  moveTo(p,p.x+rnd(3)-1,p.y+rnd(3)-1);
  var n=randNeighbor(p,D8);
  if(n&&n.element!==p.element&&(elements[n.element].category==="critters"||n.element==="fish"||n.element==="meat")&&chance(0.4)){
    deletePixel(n.x,n.y); p.fed=(p.fed||0)+1;
    if(p.fed>=3){ p.fed=0; var d=emptySpot(p,D8); if(d){ var w=at(p.x+d[0],p.y+d[1]); if(!w) put("piranha",p.x+d[0],p.y+d[1]); } } } },{ density:1000 });
critter("dragon_egg",["#6a1b9a","#8e24aa","#ce93d8"],function(p){
  tryMove(p,p.x,p.y+1);
  if(p.temp>80&&chance(0.02)) changePixel(p,"baby_dragon"); },{ tempHigh:3000, stateHigh:"dragon_egg", density:1400 });
critter("baby_dragon",["#43a047","#66bb6a"],function(p){
  p.age=(p.age||0)+1; walk(p,0.4);
  if(chance(0.01)) put("fire",p.x+(p.dir||1),p.y);
  if(p.age>1800) changePixel(p,"dragon"); },{ tempHigh:2500, stateHigh:"baby_dragon" });
critter("dragon",["#b71c1c","#d32f2f","#ff8f00"],function(p){
  flutter(p,0.15);
  if(chance(0.06)){ var dx=chance(0.5)?1:-1; for(var k=1;k<=4;k++){ if(!put("fire",p.x+dx*k,p.y)) break; } }
  var n=randNeighbor(p,D8); if(n&&n.element==="gold"&&chance(0.1)){ deletePixel(n.x,n.y); p.hoard=(p.hoard||0)+1; }
  if(p.hoard>=5){ p.hoard=0; put("dragon_egg",p.x,p.y+1); } },{ tempHigh:4000, stateHigh:"dragon", density:900 });
critter("phoenix",["#ff6f00","#ffab00","#ff3d00"],function(p){
  flutter(p,0.25); p.age=(p.age||0)+1;
  if(chance(0.05)) put("fire",p.x,p.y+1);
  if(chance(0.1)) p.color = chance(0.5)?"#ffab00":"#ff3d00";
  if(p.age>900||p.temp<-20){ changePixel(p,"phoenix_ash"); } },{ tempHigh:5000, stateHigh:"phoenix", burn:0, density:800 });
mk("phoenix_ash",{ color:["#757575","#9e9e9e","#ffab40"], behavior:POWDER, category:"critters", density:900, tick:function(p){
  if(p.temp>400&&chance(0.02)) changePixel(p,"phoenix"); } });

/* ============================================================ 7. MACHINES */
function belt(id,color,dx,speed){
  mk(id,{ color:color, category:"machines", tick:function(p){
    var a=at(p.x,p.y-1); if(!a||!movable(a)) return;
    for(var i=0;i<(speed||1);i++) if(!tryMove(a,a.x+dx,a.y)) break; } });
}
belt("conveyor_right",["#555a63","#6a707a"],1,1);
belt("conveyor_left",["#555a63","#6a707a"],-1,1);
belt("turbo_conveyor_right",["#7a4b00","#a86400"],1,3);
belt("turbo_conveyor_left",["#7a4b00","#a86400"],-1,3);
function fan(id,color,dx,dy){
  mk(id,{ color:color, category:"machines", tick:function(p){
    for(var k=9;k>=1;k--){ var t=at(p.x+dx*k,p.y+dy*k); if(t&&movable(t)&&chance(0.7)) tryMove(t,t.x+dx,t.y+dy); } } });
}
fan("wind_up",["#8ecae6","#a9d9ee"],0,-1); fan("wind_down",["#8ecae6","#a9d9ee"],0,1);
fan("wind_left",["#8ecae6","#a9d9ee"],-1,0); fan("wind_right",["#8ecae6","#a9d9ee"],1,0);
mk("bounce_pad",{ color:["#ff4081","#ff80ab"], category:"machines", tick:function(p){
  var a=at(p.x,p.y-1); if(a&&movable(a)) for(var i=0;i<12;i++) if(!tryMove(a,a.x,a.y-1)) break; } });
mk("slam_pad",{ color:["#455a64","#607d8b"], category:"machines", tick:function(p){
  var a=at(p.x,p.y+1); if(a&&movable(a)) for(var i=0;i<4;i++) if(!tryMove(a,a.x,a.y+1)) break; } });
mk("crusher",{ color:["#616161","#757575"], category:"machines", tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element&&chance(0.3)) smash(n); } });
mk("drain_block",{ color:["#212121","#37474f"], category:"machines", tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element&&movable(n)&&chance(0.5)) deletePixel(n.x,n.y); } });
mk("forge_core",{ color:["#ff6d00","#ff9100"], category:"machines", temp:1300, tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element) heatTo(n,1300,40); p.temp=1300; } });
mk("cryo_core",{ color:["#40c4ff","#80d8ff"], category:"machines", temp:-200, tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!==p.element) heatTo(n,-200,40); p.temp=-200; } });
mk("super_conductor",{ color:["#ffe082","#ffd54f"], category:"machines", conduct:1, tick:function(p){ if(p.charge&&chance(0.5)) zap(p); } });
mk("insulator_foam",{ color:["#fff8e1","#ffecb3"], category:"machines", conduct:0, insulate:true, density:80, burn:20, burnTime:100 });
/* sensors / logic-ish */
mk("pressure_plate",{ color:["#9e9e9e","#bdbdbd"], category:"machines", conduct:1, tick:function(p){
  var a=at(p.x,p.y-1); if(a&&a.element!==p.element) zap(p); } });
mk("heat_sensor",{ color:["#e53935","#ef5350"], category:"machines", conduct:1, tick:function(p){ if(p.temp>150) zap(p); } });
mk("cold_sensor",{ color:["#1e88e5","#42a5f5"], category:"machines", conduct:1, tick:function(p){ if(p.temp<-10) zap(p); } });
mk("water_sensor",{ color:["#26c6da","#4dd0e1"], category:"machines", conduct:1, tick:function(p){
  if(neighbors(p).some(function(n){ return n.element==="water"; })) zap(p); } });
mk("clock_block",{ color:["#fdd835","#fbc02d"], category:"machines", conduct:1, tick:function(p){
  p.t=(p.t||0)+1; if(p.t>=60){ p.t=0; zap(p); p.color="#fff59d"; } else if(p.t===5) p.color=["#fdd835","#fbc02d"][rnd(2)]; } });
mk("fast_clock_block",{ color:["#ff9800","#fb8c00"], category:"machines", conduct:1, tick:function(p){
  p.t=(p.t||0)+1; if(p.t>=15){ p.t=0; zap(p); } } });
["red","blue","green","pink","cyan","amber"].forEach(function(c){
  var map={red:"#ff1744",blue:"#2979ff",green:"#00e676",pink:"#ff4081",cyan:"#18ffff",amber:"#ffab00"};
  mk("neon_"+c,{ color:map[c], category:"machines", conduct:0.6, tick:function(p){
    p.color = p.charge ? lighten(map[c],0.6) : map[c]; if(p.charge&&chance(0.1)) zap(p); } });
});
/* cannons + bolts */
mk("plasma_bolt",{ color:["#ff7bff","#7bffff"], category:"machines", hidden:true, density:1, tick:function(p){
  var dx=p.dx||0, dy=p.dy||0; if(!dx&&!dy){ deletePixel(p.x,p.y); return; }
  p.life=(p.life===undefined?150:p.life)-1; if(p.life<=0){ deletePixel(p.x,p.y); return; }
  var nx=p.x+dx, ny=p.y+dy;
  if(isEmpty(nx,ny)) { tryMove(p,nx,ny); }
  else { var t=at(nx,ny); if(t){ heat(t,400); if(chance(0.5)) smash(t); } var x=p.x,y=p.y; if(live(p)) deletePixel(x,y); blast(x,y,2,"fire"); } } });
function cannon(id,color,dx,dy){
  mk(id,{ color:color, category:"machines", conduct:1, tick:function(p){
    if(p.cd) { p.cd--; return; }
    if(p.charge){ var b=put("plasma_bolt",p.x+dx,p.y+dy); if(b){ b.dx=dx; b.dy=dy; b.life=150; } p.cd=15; } } });
}
cannon("cannon_up",["#37474f","#546e7a"],0,-1); cannon("cannon_down",["#37474f","#546e7a"],0,1);
cannon("cannon_left",["#37474f","#546e7a"],-1,0); cannon("cannon_right",["#37474f","#546e7a"],1,0);
mk("spray_turret",{ color:["#4e342e","#6d4c41"], category:"machines", conduct:1, tick:function(p){
  if(p.cd){ p.cd--; return; }
  if(p.charge){ var d=pick(D8), b=put("plasma_bolt",p.x+d[0],p.y+d[1]); if(b){ b.dx=d[0]; b.dy=d[1]; b.life=100; } p.cd=4; } } });
/* teleport pads */
function warp(id,color,chan){
  MX.pads[chan] = new Set();
  mk(id,{ color:color, category:"machines", tick:function(p){
    var S=MX.pads[chan]; S.add(p);
    var a=at(p.x,p.y-1); if(!a||!movable(a)||a.element===id) return;
    if(a.tpUntil&&Date.now()<a.tpUntil) return;
    var list=[]; S.forEach(function(q){ if(!live(q)) S.delete(q); else if(q!==p) list.push(q); });
    if(!list.length) return;
    var q=pick(list); if(!isEmpty(q.x,q.y-1)) return;
    a.tpUntil=Date.now()+1200;
    if(typeof movePixel==="function") movePixel(a,q.x,q.y-1); else tryMove(a,q.x,q.y-1); } });
}
warp("warp_pad_red",["#ff1744","#ff616f"],"red"); warp("warp_pad_blue",["#2979ff","#6ea6ff"],"blue");
warp("warp_pad_green",["#00e676","#69f0ae"],"green"); warp("warp_pad_gold",["#ffd600","#ffea00"],"gold");
/* forces */
mk("gravity_well",{ color:["#4a148c","#6a1b9a"], category:"machines", tick:function(p){ pull(p,8,1,null,0.4); } });
mk("repulsor",{ color:["#b71c1c","#d32f2f"], category:"machines", tick:function(p){ pull(p,8,-1,null,0.4); } });
mk("magnet",{ color:["#c62828","#1565c0"], category:"machines", tick:function(p){
  pull(p,9,1,function(t){ return ["iron","steel","nickel","cobalt","darksteel","titanium","chromium"].indexOf(t.element)>-1; },0.6); } });
mk("black_hole",{ color:["#000000","#1a0033"], category:"chaos", density:99999, tick:function(p){
  p.mass=(p.mass||0); var r=Math.min(14,4+Math.floor(p.mass/25));
  pull(p,r,1,null,0.6);
  neighbors(p,D8).forEach(function(n){ if(n.element!=="black_hole"){ deletePixel(n.x,n.y); p.mass++; } });
  if(p.mass>600){ var x=p.x,y=p.y; deletePixel(x,y); blast(x,y,12,"plasma"); } } });
mk("tornado",{ color:["#b0bec5","#cfd8dc"], category:"weather", state:"gas", density:0.2, tick:function(p){
  if(!tryMove(p,p.x,p.y+1)&&chance(0.3)) tryMove(p,p.x+(p.dir||(p.dir=chance(0.5)?1:-1)),p.y);
  if(chance(0.02)) p.dir=-(p.dir||1);
  var lifted=[];
  for(var dy=1;dy<=12;dy++) for(var dx=-2;dx<=2;dx++){ var t=at(p.x+dx,p.y-dy); if(t&&t!==p&&t.element!=="tornado"&&movable(t)&&chance(0.4)) lifted.push([t,dx]); }
  lifted.forEach(function(a){ var t=a[0]; if(live(t)) { if(!tryMove(t,t.x+(a[1]>=0?-1:1),t.y-1)) tryMove(t,t.x,t.y-1); } });
  if(chance(0.002)) deletePixel(p.x,p.y); } });
mk("earthquake_block",{ color:["#6d4c41","#795548"], category:"weather", tick:function(){
  for(var i=0;i<40;i++){ var t=at(rnd(W()),rnd(H())); if(t&&movable(t)){ var d=pick(D8); tryMove(t,t.x+d[0],t.y+d[1]); } } } });

/* ============================================================== 8. SPAWNERS */
function emitter(id,color,el,rate,dirs){
  mk(id,{ color:color, category:"spawners", tick:function(p){
    if(!chance(rate)) return;
    var d=emptySpot(p,dirs||D4); if(d) put(el,p.x+d[0],p.y+d[1]); } });
}
emitter("water_fountain",["#3b8bff","#5aa5ff"],"water",0.3);
emitter("lava_vent",["#ff3d00","#bf360c"],"magma",0.15);
emitter("oil_derrick",["#212121","#3e2723"],"oil",0.25);
emitter("sand_dispenser",["#d7b66a","#e6c97f"],"sand",0.3);
emitter("snow_machine",["#e3f2fd","#bbdefb"],"snow",0.3);
emitter("acid_tap",["#9ccc65","#7cb342"],"acid",0.2);
emitter("steam_vent",["#cfd8dc","#b0bec5"],"steam",0.3);
emitter("smoke_stack",["#455a64","#37474f"],"smoke",0.3);
emitter("mana_spring",["#6a5cff","#8f7bff"],"mana",0.2);
emitter("chocolate_fountain",["#5d4037","#4e342e"],"melted_chocolate",0.2);
emitter("slime_pit",["#76ff03","#64dd17"],"slime",0.2);
emitter("firefly_jar",["#fff176","#fdd835"],"firefly",0.01);
emitter("frog_pond",["#2e7d32","#1b5e20"],"frog",0.004);
emitter("dragon_nest",["#4a148c","#6a1b9a"],"dragon_egg",0.0008);
emitter("spore_pod",["#aed581","#9ccc65"],"spores",0.04);
emitter("confetti_cannon",["#ff4081","#ffeb3b"],"confetti",0.5);
emitter("gem_geode",["#ab47bc","#ce93d8"],"amethyst",0.02);
emitter("ore_vein",["#795548","#8d6e63"],"titanium_ore",0.05);
emitter("mithril_vein",["#4fc3f7","#81d4fa"],"mithril_ore",0.02);
emitter("holy_spring",["#fff59d","#fff9c4"],"holy_water",0.2);

/* ============================================================ 9. WEATHER */
function beacon(id,color,fn,rate){
  mk(id,{ color:color, category:"weather", tick:function(p){ if(chance(rate)) fn(p); } });
}
function sky(el){ return function(){ put(el,1+rnd(Math.max(1,W()-2)),1); }; }
beacon("rain_beacon",["#4fc3f7","#0288d1"],sky("water"),1);
beacon("downpour_beacon",["#0277bd","#01579b"],function(){ for(var i=0;i<4;i++) put("water",1+rnd(W()-2),1); },1);
beacon("snow_beacon",["#eceff1","#cfd8dc"],sky("snow"),1);
beacon("acid_rain_beacon",["#9ccc65","#689f38"],sky("acid"),0.5);
beacon("ash_beacon",["#757575","#616161"],sky("ash"),0.8);
beacon("meteor_beacon",["#ff7043","#bf360c"],sky("meteor"),0.01);
beacon("confetti_beacon",["#ff4081","#448aff"],sky("confetti"),1);
beacon("stardust_beacon",["#ffd54f","#ffe082"],sky("stardust"),0.6);
beacon("sandstorm_beacon",["#d7b66a","#bf9b4a"],function(){ put("sand",1,1+rnd(Math.max(1,H()-2))); put("sand",W()-2,1+rnd(Math.max(1,H()-2))); },0.9);
beacon("lightning_storm_beacon",["#7e57c2","#512da8"],function(){ put("lightning",1+rnd(W()-2),1); },0.02);
beacon("aurora_beacon",["#00e5ff","#76ff03"],function(){ put("aurora",1+rnd(W()-2),1+rnd(4)); },0.3);
beacon("heatwave_beacon",["#ff6e40","#dd2c00"],function(){ var t=at(rnd(W()),rnd(H())); if(t) heat(t,25); },1);
beacon("cold_snap_beacon",["#80deea","#26c6da"],function(){ var t=at(rnd(W()),rnd(H())); if(t) heat(t,-25); },1);
beacon("volcano_beacon",["#d84315","#bf360c"],function(){ put("magma",1+rnd(W()-2),H()-2); },0.15);
beacon("flood_beacon",["#1565c0","#0d47a1"],function(){ for(var i=0;i<10;i++) put("water",1+rnd(W()-2),1); },1);
beacon("firefly_beacon",["#fff176","#fbc02d"],function(){ put("firefly",rnd(W()),rnd(H())); },0.05);
beacon("tornado_beacon",["#90a4ae","#78909c"],function(){ put("tornado",1+rnd(W()-2),1); },0.003);
beacon("fireball_beacon",["#ff6d00","#e65100"],function(){ put("fire",1+rnd(W()-2),1); },0.4);
mk("stardust",{ color:["#ffe082","#fff8e1","#b39ddb"], behavior:POWDER, category:"weather", density:700, tick:function(p){
  if(chance(0.1)) p.color = pick(["#ffe082","#fff8e1","#b39ddb"]); } });
mk("aurora",{ color:["#00e5ff","#76ff03"], category:"weather", state:"gas", density:0.05, tick:function(p){
  p.life=(p.life||0)+1; p.color=hsv(120+((p.x*2+p.life)%140),0.7,1);
  if(chance(0.3)) tryMove(p,p.x+rnd(3)-1,p.y+(chance(0.2)?1:0));
  if(p.life>500) deletePixel(p.x,p.y); } });

/* =============================================================== 10. SWEETS */
mk("chocolate",{ color:["#5d3a1f","#6b4226"], category:"sweets", density:1300, tempHigh:35, stateHigh:"melted_chocolate", breakInto:"sprinkles" });
mk("hard_caramel",{ color:["#c68a2c","#e0a244"], category:"sweets", density:1400, tempHigh:80, stateHigh:"caramel" });
mk("rock_candy",{ color:["#ff80ab","#ea80fc","#80d8ff"], category:"sweets", density:1500, breakInto:"sprinkles" });
mk("candy_cane",{ color:["#ffffff","#e53935"], category:"sweets", density:1500, breakInto:"sprinkles" });
mk("sprinkles",{ color:["#ff4081","#ffeb3b","#448aff","#69f0ae"], behavior:POWDER, category:"sweets", density:900 });
mk("confetti",{ color:["#ff4081","#ffeb3b","#448aff","#69f0ae","#e040fb"], behavior:POWDER, category:"sweets", density:50 });
mk("cotton_candy",{ color:["#ffb3d9","#b3d9ff"], behavior:POWDER, category:"sweets", density:60, tempHigh:150, stateHigh:"caramel" });
mk("marshmallow",{ color:["#fff5f5","#ffe9ec"], behavior:behaviors.STURDYPOWDER, category:"sweets", density:400, burn:30, burnTime:60, burnInto:"toasted_marshmallow", tempHigh:200, stateHigh:"toasted_marshmallow" });
mk("toasted_marshmallow",{ color:["#c68642","#a0642a"], behavior:behaviors.STURDYPOWDER, category:"sweets", hidden:true, density:400, burn:60, burnTime:80, burnInto:"ash" });
mk("popcorn_kernel",{ color:["#e8c547","#d4b038"], behavior:POWDER, category:"sweets", density:1200, tempHigh:180, stateHigh:"popcorn" });
mk("popcorn",{ color:["#fff8dc","#fffaf0"], behavior:POWDER, category:"sweets", density:150, burn:50, burnTime:50, burnInto:"ash" });
mk("ice_cream",{ color:["#fff1c9","#ffd6e8"], behavior:POWDER, category:"sweets", density:1100, tempHigh:8, stateHigh:"milk" });
mk("gummy",{ color:["#ff5252","#69f0ae","#ffd740"], category:"sweets", density:1250, burn:20, burnTime:200, burnInto:"caramel" });
mk("cookie_dough",{ color:["#d7b98a","#c9a870"], behavior:behaviors.STURDYPOWDER, category:"sweets", density:1100, tempHigh:150, stateHigh:"cookie" });
mk("cookie",{ color:["#a9742f","#8f5f22"], category:"sweets", hidden:true, density:700, burn:30, burnTime:100, burnInto:"ash", breakInto:"sprinkles" });
mk("mentos",{ color:["#f5f5f5","#e0e0e0"], behavior:POWDER, category:"sweets", density:1600, reactions:{
  "soda_pop":{elem1:null,elem2:"foam",chance:0.5} } });

/* ============================================================ 11. BUILDING */
function block(id,color,dens,extra){
  mk(id,Object.assign({ color:color, category:"building", density:dens, hardness:0.8, breakInto:"gravel" },extra||{}));
}
block("marble",["#f5f5f0","#e8e8e0","#dcdcd4"],2700);
block("obsidian_brick",["#1a1a24","#242434"],2600,{ hardness:0.95 });
block("castle_stone",["#8d8d93","#7a7a80","#9a9aa0"],2500);
block("terracotta",["#c8714a","#b8643f"],1900);
block("reinforced_concrete",["#9e9e9e","#8a8a8a"],2400,{ hardness:0.97 });
block("asphalt",["#2c2c30","#35353a"],2300);
block("sandstone_tile",["#e0c58a","#d4b676"],2200);
block("ice_brick",["#bde7ff","#d6f1ff"],900,{ tempHigh:2, stateHigh:"water" });
block("cloud_block",["#ffffff","#f2f6fa"],200);
block("glowing_moss_block",["#3d8f3a","#6fd36a"],1400);
["ruby","azure","emerald","amber","violet","clear"].forEach(function(c){
  var m={ruby:"#e5393577",azure:"#2979ff77",emerald:"#00c85377",amber:"#ffab0077",violet:"#aa00ff77",clear:"#d0f0ff55"};
  block("stained_glass_"+c,m[c],2500,{ hardness:0.3, tempHigh:1400, stateHigh:"molten_glass", breakInto:"glass_shard" });
});

/* ============================================================== 12. BOMBS */
function bomb(id,color,trigTemp,boom,extra){
  mk(id,Object.assign({ color:color, behavior:POWDER, category:"bombs", density:1500, conduct:0.4, tick:function(p){
    if(p.temp>trigTemp||p.charge){ var x=p.x,y=p.y; deletePixel(x,y); boom(x,y); } } },extra||{}));
}
bomb("mini_bomb",["#6d6d6d","#8a8a8a"],200,function(x,y){ blast(x,y,3,"fire"); });
bomb("mega_bomb",["#b71c1c","#d32f2f"],200,function(x,y){ blast(x,y,18,"fire"); });
bomb("plasma_bomb",["#ab47bc","#ce93d8"],200,function(x,y){ blast(x,y,10,"plasma"); });
bomb("cluster_bomb",["#455a64","#78909c"],200,function(x,y){
  blast(x,y,3,"fire"); for(var i=0;i<7;i++) put("mini_bomb",x+rnd(11)-5,y-1-rnd(5)); });
bomb("confetti_bomb",["#ff80ab","#ffd740"],150,function(x,y){
  eachInRadius(x,y,9,function(px,py){ if(chance(0.5)) put("confetti",px,py); }); });
bomb("freeze_bomb",["#4fc3f7","#b3e5fc"],150,function(x,y){
  eachInRadius(x,y,11,function(px,py){ var t=at(px,py); if(t) heat(t,-300); }); });
bomb("napalm_bomb",["#ff6f00","#e65100"],150,function(x,y){
  eachInRadius(x,y,7,function(px,py){ if(chance(0.6)) put("fire",px,py); var t=at(px,py); if(t){ heat(t,300); ignite(t);} }); });
bomb("acid_bomb",["#8bc34a","#689f38"],150,function(x,y){
  eachInRadius(x,y,6,function(px,py){ if(chance(0.7)) put("acid",px,py); }); });
bomb("mana_bomb",["#7c4dff","#b388ff"],150,function(x,y){
  eachInRadius(x,y,8,function(px,py){ var t=at(px,py); if(t&&t.element==="water") changePixel(t,"mana"); else if(chance(0.4)) put("mana",px,py); }); });
bomb("lightning_bomb",["#fff176","#ffee58"],150,function(x,y){
  for(var i=0;i<6;i++) put("lightning",x+rnd(15)-7,y-1-rnd(6)); });
bomb("gravity_bomb",["#311b92","#4527a0"],150,function(x,y){
  var c={x:x,y:y}; for(var i=0;i<4;i++) pull(c,13,1,null,0.9); blast(x,y,3,"fire"); });
bomb("black_hole_bomb",["#000000","#212121"],150,function(x,y){ put("black_hole",x,y); });
bomb("midas_bomb",["#ffd700","#ffeb3b"],150,function(x,y){
  eachInRadius(x,y,7,function(px,py){ var t=at(px,py); if(t&&elements[t.element].state==="solid"&&movable(t)&&elements.gold&&chance(0.6)) changePixel(t,"gold"); }); });
bomb("dragon_bomb",["#d84315","#ff7043"],150,function(x,y){
  put("dragon",x,y); blast(x,y,2,"fire"); });
mk("timer_bomb",{ color:["#212121","#d32f2f"], category:"bombs", density:2000, tick:function(p){
  p.t=(p.t||0)+1; tryMove(p,p.x,p.y+1);
  p.color=(p.t%20<10)?"#d32f2f":"#212121";
  if(p.t>300){ var x=p.x,y=p.y; deletePixel(x,y); blast(x,y,12,"fire"); } } });

/* ============================================================== 13. CHAOS */
mk("corruption",{ color:["#2b0a3d","#4a148c","#1a0029"], behavior:POWDER, category:"chaos", density:1300, tick:function(p){
  if(!chance(0.2)) return; var n=randNeighbor(p);
  if(!n||n.element==="corruption") return;
  var e=elements[n.element], cat=e&&e.category;
  if(["dirt","mud","grass","plant","wood","water","sand","moss"].indexOf(n.element)>-1||cat==="flora"||cat==="critters"||cat==="life") changePixel(n,"corruption"); } });
mk("purity_crystal",{ color:["#fffde7","#fff9c4"], category:"arcane", density:2500, tick:function(p){
  eachInRadius(p.x,p.y,3,function(x,y){ var t=at(x,y); if(t&&(t.element==="corruption"||t.element==="gray_goo")) changePixel(t,"dirt"); }); } });
mk("gray_goo",{ color:["#9e9e9e","#757575"], behavior:LIQUID, state:"liquid", category:"chaos", density:1100, tick:function(p){
  if(!chance(0.15)) return; var n=randNeighbor(p);
  if(n&&n.element!=="gray_goo"&&n.element!=="goo_killer"&&movable(n)&&elements[n.element].category!=="tools") changePixel(n,"gray_goo"); } });
mk("goo_killer",{ color:["#00e5ff","#18ffff"], behavior:LIQUID, state:"liquid", category:"chaos", density:1050, tick:function(p){
  var n=randNeighbor(p); if(n&&n.element==="gray_goo"){ deletePixel(n.x,n.y); if(chance(0.5)) deletePixel(p.x,p.y); } } });
mk("chaos_dust",{ color:["#ff00ff","#00ffff","#ffff00"], behavior:POWDER, category:"chaos", density:1000, tick:function(p){
  var n=randNeighbor(p); if(n&&n.element!=="chaos_dust"&&movable(n)){ changePixel(n,randomElement()); deletePixel(p.x,p.y); } } });
mk("chaos_rift",{ color:["#ff00ff","#00ffff"], category:"chaos", density:9999, tick:function(p){
  p.color=hsv((tickNow()*12)%360,1,1);
  if(chance(0.05)){ var d=emptySpot(p,D8); if(d) put(randomElement(),p.x+d[0],p.y+d[1]); } } });
mk("glitch_pixel",{ color:["#00ff00","#ff00ff"], category:"chaos", density:1000, tick:function(p){
  p.color="rgb("+rnd(256)+","+rnd(256)+","+rnd(256)+")"; if(chance(0.3)) tryMove(p,p.x+rnd(3)-1,p.y+rnd(3)-1); } });
mk("rainbow_sand",{ color:["#ff0000","#00ff00","#0000ff"], behavior:POWDER, category:"chaos", density:1600, tick:function(p){
  p.color=hsv((tickNow()*3+p.x*4+p.y*2)%360,0.8,1); } });
mk("antimatter",{ color:["#00ffe1","#ff00aa"], behavior:GAS, state:"gas", category:"chaos", density:0.5, tick:function(p){
  var n=randNeighbor(p,D8); if(n&&n.element!=="antimatter"&&elements[n.element].category!=="tools"){ var x=p.x,y=p.y; deletePixel(n.x,n.y); if(live(p)) deletePixel(x,y); blast(x,y,4,"fire"); } } });

/* ================================================================== TOOLS */
function tool(id,color,fn){ mk(id,{ color:color, category:"tools", tool:fn, behavior:WALL, density:1 }); }
tool("midas_touch","#ffd700",function(p){ var e=elements[p.element]; if(e&&e.state!=="gas"&&p.element!=="gold"&&elements.gold) changePixel(p,"gold"); });
tool("petrify","#8d8d8d",function(p){ var e=elements[p.element]; if(e&&elements.rock){ if(e.state==="gas") deletePixel(p.x,p.y); else changePixel(p,"rock"); } });
tool("inferno_wand","#ff3d00",function(p){ heat(p,800); ignite(p); });
tool("deep_freeze","#40c4ff",function(p){ heat(p,-400); });
tool("growth_wand","#76ff03",function(p){
  if(p.element==="dirt"||p.element==="mud") changePixel(p,"grass");
  else if(p.element==="grass"&&chance(0.3)) put("plant",p.x,p.y-1);
  else if(p.h!==undefined){ p.h=0; p.done=false; } });
tool("corrupt_wand","#6a1b9a",function(p){ var e=elements[p.element]; if(e&&e.category!=="tools") changePixel(p,"corruption"); });
tool("purify_wand","#fff59d",function(p){
  if(p.element==="corruption"||p.element==="gray_goo") changePixel(p,"dirt");
  if(p.burning) p.burning=false; });
tool("clone_brush","#00bcd4",function(p){ var d=emptySpot(p,D8); if(d){ var n=put(p.element,p.x+d[0],p.y+d[1]); if(n) n.temp=p.temp; } });
tool("lightning_wand","#ffee58",function(p){ if(!put("lightning",p.x,p.y-1)) heat(p,300); });
tool("age_wand","#8d6e63",function(p){
  var m={iron:"rust",steel:"rust",wood:"sawdust",plant:"dead_plant",grass:"dirt",bamboo:"dead_plant"};
  var t=m[p.element]; if(t&&elements[t]) changePixel(p,t); });
tool("youth_wand","#aed581",function(p){
  var m={rust:"iron",dead_plant:"plant",sawdust:"wood",dirt:"grass"};
  var t=m[p.element]; if(t&&elements[t]) changePixel(p,t); });
tool("charge_wand","#fff176",function(p){ if(elements[p.element]&&elements[p.element].conduct) p.charge=1; });
tool("transmute_wand","#e040fb",function(p){
  var e=elements[p.element]; if(!e||e.category==="tools") return;
  if(!MX.byState){ MX.byState={}; Object.keys(elements).forEach(function(k){ var q=elements[k];
    if(q.state&&!q.hidden&&q.category!=="tools"&&q.category!=="bombs"&&q.category!=="chaos"&&q.category!=="spawners"&&q.category!=="weather"&&q.category!=="machines")
      (MX.byState[q.state]=MX.byState[q.state]||[]).push(k); }); }
  var l=MX.byState[e.state]; if(l&&l.length) changePixel(p,pick(l)); });
tool("levitate_wand","#b39ddb",function(p){ for(var i=0;i<4;i++) if(!tryMove(p,p.x,p.y-1)) break; });
tool("slam_wand","#607d8b",function(p){ for(var i=0;i<6;i++) if(!tryMove(p,p.x,p.y+1)) break; });
tool("blast_wand","#ff7043",function(p){ blast(p.x,p.y,3,"fire"); });
tool("rainbow_brush","#ff4081",function(p){ p.color=hsv(rnd(360),0.85,1); });
tool("smelt_wand","#ff9100",function(p){ var e=elements[p.element]; if(e&&e.tempHigh) heat(p,Math.max(0,e.tempHigh-p.temp)+30); });

if (typeof logMessage === "function") logMessage("Mythic Expanse loaded: new metals, gems, critters, machines, weather, bombs & tools!");
})();
