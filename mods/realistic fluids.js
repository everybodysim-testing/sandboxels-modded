// realistic fluids.js — particle-based liquid flow for Sandboxels
//
// What it does
//   Every simulated liquid pixel becomes one fluid particle. Each tick the
//   particles are stepped with gravity, incompressibility (pair separation),
//   velocity exchange (viscosity) and pressure-driven sideways flow, and the
//   result is written back to the world as liquid pixels. Liquids keep all of
//   their own properties: reactions, temperature changes, state changes and
//   density swaps (oil floating on water) still run through the game itself.
//   This mod only decides WHERE a liquid moves.
//
// Based on the approach in Erkaman's gl-water2d (SPH / Clavet et al. 2005,
// "Particle-based Viscoelastic Fluid Simulation"): double-density-style
// separation, viscosity impulses and momentum, quantised back onto the grid.
//
// Only liquids that use the standard liquid behaviour are simulated, so mods
// with their own custom liquid behaviour are left completely alone.
//
// Toggle:  realisticFluids.enabled = false   -> vanilla liquid flow comes back
// Tune:    realisticFluids.CFG.gravity = 0.5
//          realisticFluids.perElement.honey = { flow: 0.05, viscosity: 2 }
// Info:    realisticFluids.elements          -> simulated element names
//
// Load order: works anywhere; other liquids added by later mods are picked up
// automatically (the element list refreshes itself).

(function () {
	"use strict";

	if (typeof elements !== "object" || typeof behaviors !== "object" ||
		typeof runAfterAutogen !== "function" || typeof runEveryTick !== "function") {
		console.warn("realistic fluids.js: game runtime not found — mod not loaded.");
		return;
	}

	// ---- tuning (cell units, per tick) ------------------------------------
	var CFG = {
		enabled: true,
		gravity: 0.40,      // downward acceleration
		maxSpeed: 1.05,     // speed cap (one cell per tick)
		damping: 0.994,     // velocity kept per tick
		radius: 1.45,       // particle interaction radius
		rest: 0.92,         // resting spacing between two particles
		stiffness: 0.55,    // share of an overlap removed per substep
		viscosity: 0.16,    // neighbour velocity exchange (base)
		flow: 0.60,         // sideways pressure flow
		substeps: 2,        // solver passes per tick
		maxParticles: 3200, // safety cap for huge pools
		perElement: {}      // overrides, e.g. { oil: { flow: 0.5 } }
	};

	var API = window.realisticFluids = {
		CFG: CFG,
		perElement: CFG.perElement,
		elements: [],
		refresh: refreshElements,
		get enabled() { return CFG.enabled; },
		set enabled(v) { CFG.enabled = !!v; },
		emergencyStop: emergencyStop
	};

	// ---- element registration ---------------------------------------------
	var PARAMS = Object.create(null);  // element -> { g, flow, visc, mass }
	var SIM = Object.create(null);     // element -> true
	var simCount = 0;

	function fluidTick(pixel) {
		// Liquids no longer move themselves; the fluid solver moves them.
		// Everything else a liquid does (heat, fire, electricity, stain) still runs.
		if (pixel.start === pixelTicks) return;
		if (typeof doDefaults === "function") doDefaults(pixel);
	}

	function paramFor(name, e) {
		var over = CFG.perElement[name] || {};
		var v = (typeof e.viscosity === "number" && e.viscosity > 0) ? e.viscosity : 1;
		// same scale the game's liquid behaviour uses: honey (10000) ~ 0.1, water ~ 1
		var fluidity = Math.min(1, Math.max(0.05, Math.pow(v, -0.25)));
		var mass = (typeof e.density === "number" && e.density > 0) ? e.density / 1000 : 1;
		return {
			g: (over.gravity !== undefined ? over.gravity : CFG.gravity),
			flow: (over.flow !== undefined ? over.flow : fluidity),
			visc: (over.viscosity !== undefined ? over.viscosity : CFG.viscosity * (2 - fluidity)),
			mass: Math.max(0.2, mass)
		};
	}

	function refreshElements() {
		simCount = 0;
		var names = Object.keys(elements);
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			var e = elements[name];
			if (!e || e.tool || e.canPlace === false) continue;
			// standard liquid: our tick stub, or the game's liquid behaviour itself
			if (!(e._rfPatched === true || e.tick === behaviors.LIQUID)) continue;
			if (e.category !== "liquids") continue;
			if (e._rfPatched !== true) {
				e._rfPatched = true;
				e._rfPrevTick = e.tick;
				e.tick = fluidTick;
			}
			SIM[name] = true;
			PARAMS[name] = paramFor(name, e);
			simCount++;
		}
		API.elements = Object.keys(SIM);
	}

	function emergencyStop() {
		CFG.enabled = false;
		var names = Object.keys(elements);
		for (var i = 0; i < names.length; i++) {
			var e = elements[names[i]];
			if (e && e._rfPatched === true) {
				e.tick = e._rfPrevTick;
				delete e._rfPatched;
				delete e._rfPrevTick;
			}
		}
		SIM = Object.create(null);
		PARAMS = Object.create(null);
		simCount = 0;
		API.elements = [];
	}

	// ---- solver storage ----------------------------------------------------
	var VEL = new WeakMap();     // pixel -> { x, y }
	var MAXP = Math.max(64, CFG.maxParticles);
	var PX = new Float32Array(MAXP), PY = new Float32Array(MAXP);
	var VX = new Float32Array(MAXP), VY = new Float32Array(MAXP);
	var PP = new Array(MAXP), REF = new Array(MAXP);

	var gW = 0, gH = 0;          // world size
	var bucketW = 0, bucketH = 0, bucketSize = CFG.radius;
	var head = null, next = null;

	var cnt = 0;
	var tickCounter = 0;

	function allocWorld(W, H) {
		gW = W; gH = H;
		bucketSize = CFG.radius;
		bucketW = Math.ceil(W / bucketSize) + 2;
		bucketH = Math.ceil(H / bucketSize) + 2;
		head = new Int32Array(bucketW * bucketH);
		next = new Int32Array(MAXP);
	}

	// ---- world queries -----------------------------------------------------
	function cellPixel(x, y) {
		if (x < 0 || y < 0 || x >= gW || y >= gH) return null;
		var p = pixelMap[x][y];
		if (p === undefined || p.del === true) return null;
		return p;
	}

	function isLiquid(p) {
		return p !== null && SIM[p.element] !== undefined;
	}

	// a cell a fluid particle may occupy: empty, gas, or another simulated liquid
	function isOpen(x, y) {
		if (x < 0 || y < 0 || x >= gW || y >= gH) return false;
		var p = cellPixel(x, y);
		if (p === null) return true;
		if (isLiquid(p)) return true;
		var info = elements[p.element];
		return !!(info && info.state === "gas");
	}

	// a cell the fluid can fall through without touching anything
	function isFree(x, y) {
		if (x < 0 || y < 0 || x >= gW || y >= gH) return false;
		var p = cellPixel(x, y);
		if (p === null) return true;
		if (isLiquid(p)) return false;
		var info = elements[p.element];
		return !!(info && info.state === "gas");
	}

	// a cell the fluid cannot enter at all
	function isBlocked(x, y) {
		if (x < 0 || y < 0 || x >= gW || y >= gH) return true;
		var p = cellPixel(x, y);
		if (p === null || isLiquid(p)) return false;
		var info = elements[p.element];
		return !(info && info.state === "gas");   // gases never block a liquid
	}

	// How attractive a sideways cell is for a supported particle.
	// Only a cell whose SURFACE is lower than ours counts, so a level pool
	// (neighbour cell at the same height is liquid) never drifts sideways.
	function sideScore(x, y) {
		if (x < 0 || y < 0 || x >= gW || y >= gH) return -1;
		if (isBlocked(x, y)) return -1;
		var here = cellPixel(x, y);
		if (here !== null && isLiquid(here)) return 0;   // already liquid at our level
		for (var d = 1; d <= 6 && y + d < gH; d++) {
			var p = cellPixel(x, y + d);
			if (p === null) continue;
			return isLiquid(p) ? 2 : 1;          // liquid = lower water surface, solid = a pocket to fill
		}
		return 3;                                 // open all the way down
	}

	// ---- one tick of fluid ------------------------------------------------
	function simulate() {
		if (!CFG.enabled) return;
		if (typeof width !== "number" || typeof height !== "number" || width < 2 || height < 2) return;
		if (typeof pixelMap === "undefined" || !pixelMap) return;

		if (gW !== width || gH !== height) allocWorld(width, height);

		tickCounter++;
		if (tickCounter % 60 === 1) refreshElements();
		if (simCount === 0) return;

		// 1) gather particles from the current liquid pixels
		cnt = 0;
		var list = currentPixels;
		for (var i = 0; i < list.length && cnt < MAXP; i++) {
			var p = list[i];
			if (!p || p.del === true) continue;
			var par = PARAMS[p.element];
			if (par === undefined) continue;
			var v = VEL.get(p);
			if (v === undefined) { v = { x: 0, y: 0 }; VEL.set(p, v); }
			PX[cnt] = p.x + 0.5; PY[cnt] = p.y + 0.5;
			VX[cnt] = v.x; VY[cnt] = v.y;
			PP[cnt] = par; REF[cnt] = p;
			cnt++;
		}
		if (cnt === 0) return;

		// 2) solve
		var dt = 1 / CFG.substeps;
		for (var s = 0; s < CFG.substeps; s++) substep(dt);

		// 3) write the fluid back into the world as pixels
		writeBack();

		// 4) remember velocities for the next tick
		for (i = 0; i < cnt; i++) {
			var pix = REF[i];
			if (!pix) continue;
			var vel = VEL.get(pix);
			if (vel === undefined) { vel = { x: 0, y: 0 }; VEL.set(pix, vel); }
			vel.x = VX[i]; vel.y = VY[i];
		}
	}

	var maxSpeed2 = 1;

	function substep(dt) {
		var i, j, P;
		var R = CFG.radius, R2 = R * R, REST = CFG.rest;
		maxSpeed2 = CFG.maxSpeed * CFG.maxSpeed;

		// integrate
		for (i = 0; i < cnt; i++) {
			P = PP[i];
			VY[i] += P.g * dt;
			VX[i] *= CFG.damping; VY[i] *= CFG.damping;
			var sp2 = VX[i] * VX[i] + VY[i] * VY[i];
			if (sp2 > maxSpeed2) {
				var sc = CFG.maxSpeed / Math.sqrt(sp2);
				VX[i] *= sc; VY[i] *= sc;
			}
			PX[i] += VX[i] * dt;
			PY[i] += VY[i] * dt;
		}

		// bucket the particles
		head.fill(-1);
		for (i = 0; i < cnt; i++) {
			var bx = Math.min(bucketW - 1, Math.max(0, Math.floor(PX[i] / bucketSize)));
			var by = Math.min(bucketH - 1, Math.max(0, Math.floor(PY[i] / bucketSize)));
			var bi = by * bucketW + bx;
			next[i] = head[bi];
			head[bi] = i;
		}

		// pair separation (incompressibility) + viscosity impulses
		for (i = 0; i < cnt; i++) {
			var bx2 = Math.min(bucketW - 1, Math.max(0, Math.floor(PX[i] / bucketSize)));
			var by2 = Math.min(bucketH - 1, Math.max(0, Math.floor(PY[i] / bucketSize)));
			var Pi = PP[i];
			for (var oy = -1; oy <= 1; oy++) {
				var ry = by2 + oy;
				if (ry < 0 || ry >= bucketH) continue;
				for (var ox = -1; ox <= 1; ox++) {
					var rx = bx2 + ox;
					if (rx < 0 || rx >= bucketW) continue;
					j = head[ry * bucketW + rx];
					while (j !== -1) {
						if (j > i) {
							var dx = PX[j] - PX[i], dy = PY[j] - PY[i];
							var r2 = dx * dx + dy * dy;
							if (r2 < R2) {
								var Pj = PP[j];
								if (r2 < 1e-6) {
									// perfectly stacked: split them apart vertically with a nudge
									dx = ((i * 0.37 + j * 0.11) % 1 - 0.5) * 0.02;
									dy = (i % 2 === 0 ? -1 : 1) * 0.02;
									r2 = dx * dx + dy * dy;
								}
								var r = Math.sqrt(r2);
								if (r < REST) {
									var mi = 1 / Pi.mass, mj = 1 / Pj.mass, msum = mi + mj;
									var push = (REST - r) / r * CFG.stiffness * 0.5;
									var sx = dx * push, sy = dy * push;
									PX[i] -= sx * (mi / msum) * 2;
									PY[i] -= sy * (mi / msum) * 2;
									PX[j] += sx * (mj / msum) * 2;
									PY[j] += sy * (mj / msum) * 2;
								}
								// viscosity: exchange velocity with nearby neighbours
								var vis = (Pi.visc + Pj.visc) * 0.5 * (1 - r / R) * 0.5;
								if (vis > 0) {
									var dvx = VX[j] - VX[i], dvy = VY[j] - VY[i];
									VX[i] += dvx * vis; VY[i] += dvy * vis;
									VX[j] -= dvx * vis; VY[j] -= dvy * vis;
								}
							}
						}
						j = next[j];
					}
				}
			}
		}

		// pressure flow: a supported particle slides toward the lower side
		for (i = 0; i < cnt; i++) {
			var cx = Math.floor(PX[i]), cy = Math.floor(PY[i]);
			if (cx < 0 || cx >= gW || cy < 0 || cy >= gH) continue;
			if (isFree(cx, cy + 1)) continue;         // free to fall straight down
			var l = sideScore(cx - 1, cy), r = sideScore(cx + 1, cy);
			if (l !== r) {
				// a lower surface exists on one side: pressure pushes that way
				var push = (r > l ? 1 : -1) * CFG.flow * PP[i].flow;
				VX[i] += push * dt;
				PX[i] += push * 0.5 * dt;   // direct drift, so viscosity cannot stall a spreading pool
			} else {
				// level: keep a little momentum for sloshing, but let the pool come to rest
				if (Math.abs(VX[i]) < 0.28) VX[i] *= 0.7;
			}
		}

		// bounds + stop at solid cells
		for (i = 0; i < cnt; i++) {
			if (PX[i] < 0.5) { PX[i] = 0.5; if (VX[i] < 0) VX[i] *= -0.2; }
			else if (PX[i] > gW - 0.5) { PX[i] = gW - 0.5; if (VX[i] > 0) VX[i] *= -0.2; }
			if (PY[i] < 0.5) { PY[i] = 0.5; if (VY[i] < 0) VY[i] *= -0.2; }
			else if (PY[i] > gH - 0.5) { PY[i] = gH - 0.5; if (VY[i] > 0) VY[i] = -VY[i] * 0.15; }
			var tx = Math.floor(PX[i]), ty = Math.floor(PY[i]);
			if (isBlocked(tx, ty)) {
				var from = REF[i];
				PX[i] = from.x + 0.5;
				PY[i] = from.y + 0.5;
				VX[i] *= 0.25;
				VY[i] *= 0.15;
			}
		}
	}

	// ---- write the solver result back as pixels ---------------------------
	function writeBack() {
		for (var i = 0; i < cnt; i++) {
			var p = REF[i];
			if (!p || p.del === true) continue;
			var fromX = p.x, fromY = p.y;
			var tx = Math.floor(PX[i]), ty = Math.floor(PY[i]);
			// never teleport across more than one cell in a tick
			tx = Math.max(fromX - 1, Math.min(fromX + 1, tx));
			ty = Math.max(fromY - 1, Math.min(fromY + 1, ty));
			if (tx === fromX && ty === fromY) {
				PX[i] = fromX + 0.5; PY[i] = fromY + 0.5;
				continue;
			}
			var dxs = tx > fromX ? 1 : (tx < fromX ? -1 : 0);
			var vdir = VX[i] >= 0 ? 1 : -1;
			var cands = [
				[tx, ty],
				[fromX + dxs, fromY + 1],
				[fromX, fromY + 1],
				[fromX + dxs, fromY],
				[fromX + vdir, fromY + 1],
				[fromX + vdir, fromY]
			];
			var moved = false;
			for (var c = 0; c < cands.length; c++) {
				var cx = cands[c][0], cy = cands[c][1];
				if (cx === fromX && cy === fromY) continue;
				if (cx < 0 || cy < 0 || cx >= gW || cy >= gH) continue;
				if (cy < fromY) continue;                     // liquids never take themselves upward
				if (cy > fromY && cx !== tx && cx !== fromX) {
					// only allow a diagonal fall that we asked for
					if (cy !== fromY + 1) continue;
				}
				if (tryMove(p, cx, cy)) { moved = true; break; }
			}
			if (!moved) {
				VX[i] *= 0.2;
				if (VY[i] > 0) VY[i] = 0;                     // resting on something
			}
			PX[i] = p.x + 0.5;
			PY[i] = p.y + 0.5;
		}
	}

	// ---- wiring ------------------------------------------------------------
	runAfterAutogen(function () {
		refreshElements();
		runEveryTick(simulate);
		console.log("realistic fluids.js loaded (" + API.elements.length + " liquids simulated). Toggle with realisticFluids.enabled = false/true");
	});
})();
