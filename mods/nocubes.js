// nocubes.js — smooth "no cubes" surface rendering for Sandboxels
//
// Instead of every pixel rendering as a hard square, surfaces are re-rendered
// as smooth curves. Each frame the mod builds a signed distance field per
// material (chamfer distance to the nearest opposite phase, then a gaussian
// smooth) and redraws only the boundary cells on the game's own pixels
// layer. index.html is not touched.
//
// - Edges form smooth curves that span multiple pixels — staircases and
//   block corners flow into rounded slopes at any angle, not just
//   0/45/90 degree steps.
// - Each material keeps its own field, so where two materials touch the
//   seam stays fully solid and colors never mix into muddy pixels.
// - Small features (lone grains, thin lines) fall back to the exact pixel
//   grid, so nothing dissolves into dots or gaps.
// - Pixels touching the world edge stay flush with the world edge.
// - Gases and glow pixels render as soft round cloud particles with a
//   smooth fade; nearby gases stack into one bigger cloud that wraps the
//   whole shape.
// - Semi-transparent pixels and thermal/other special views keep their
//   original rendering.
//
// Toggle it off in Extras > Mods (remove "nocubes.js"), then reset the canvas.

(function () {
	"use strict";

	if (typeof renderPostPixel !== "function" || typeof viewInfo !== "object" || !viewInfo[1]) {
		console.warn("nocubes.js: game runtime not found — mod not loaded.");
		return;
	}

	// Tuning (cell units):
	var EDGE_SOFT = 0.14; // half-width of the exact-grid AA band
	var EDGE_A = 0.3;     // half-width of the curve-field AA band
	var T_SOLID = 0.55;   // blurred distance above which a cell follows the curve field only
	var D_CAP = 12;       // distance cap, in cells
	// Separable gaussian kernel (sigma 2, radius 4), sums to 1.
	var KERNEL = [0.0276, 0.0663, 0.1238, 0.1802, 0.2042, 0.1802, 0.1238, 0.0663, 0.0276];
	var KR = 4;

	var pw = 0, ph = 0, gw = 0, gh = 0;
	var clsGrid = null;    // padded: -2 border, -1 air, -3 translucent, >=0 material id
	var plusGrid = null;   // padded mask of gas/glow cells (normal view)
	var colR = null, colG = null, colB = null, hasCol = null;
	var bufA = null, bufB = null, bufC = null; // chamfer/blur scratch
	var smoothImg = null, smoothU32 = null; // cached smoothed cells, kept across frames
	var hashGrid = null, hashFrame = null, frameId = 0;
	var edgeCells = [];
	var cloudPixels = [];  // this frame's gas/glow pixels: [x, y, color, alpha]
	var elemIndex = {}, elemCount = 0;
	var classBufs = {};    // material id -> { solid, dist }
	var presentClasses = [];

	function elemId(name) {
		var id = elemIndex[name];
		if (id === undefined) { id = elemCount++; elemIndex[name] = id; }
		return id;
	}

	function ensureGrids(W, H) {
		if (clsGrid && gw === W && gh === H) return;
		gw = W; gh = H;
		pw = W + 2; ph = H + 2;
		var N = pw * ph;
		clsGrid = new Int16Array(N);
		plusGrid = new Uint8Array(N);
		colR = new Float32Array(N);
		colG = new Float32Array(N);
		colB = new Float32Array(N);
		hasCol = new Uint8Array(N);
		bufA = new Float32Array(N);
		bufB = new Float32Array(N);
		bufC = new Float32Array(N);
		classBufs = {};
		hashGrid = new Int32Array(N);
		hashFrame = new Int32Array(N);
		frameId = 0;
	}

	function getClassBufs(id) {
		var b = classBufs[id];
		if (!b) {
			b = { solid: new Uint8Array(pw * ph), dist: new Float32Array(pw * ph) };
			classBufs[id] = b;
		}
		return b;
	}

	// Two-pass chamfer distance transform (3/4 weights), in place.
	function chamfer(field) {
		var i, x, y, row, v;
		for (y = 0; y < ph; y++) {
			row = y * pw;
			for (x = 0; x < pw; x++) {
				i = row + x;
				v = field[i];
				if (x > 0 && field[i - 1] + 3 < v) v = field[i - 1] + 3;
				if (y > 0) {
					if (field[i - pw] + 3 < v) v = field[i - pw] + 3;
					if (x > 0 && field[i - pw - 1] + 4 < v) v = field[i - pw - 1] + 4;
					if (x < pw - 1 && field[i - pw + 1] + 4 < v) v = field[i - pw + 1] + 4;
				}
				field[i] = v;
			}
		}
		for (y = ph - 1; y >= 0; y--) {
			row = y * pw;
			for (x = pw - 1; x >= 0; x--) {
				i = row + x;
				v = field[i];
				if (x < pw - 1 && field[i + 1] + 3 < v) v = field[i + 1] + 3;
				if (y < ph - 1) {
					if (field[i + pw] + 3 < v) v = field[i + pw] + 3;
					if (x < pw - 1 && field[i + pw + 1] + 4 < v) v = field[i + pw + 1] + 4;
					if (x > 0 && field[i + pw - 1] + 4 < v) v = field[i + pw - 1] + 4;
				}
				field[i] = v;
			}
		}
	}

	// Separable gaussian blur of src into dst (src may equal dst).
	function blurField(src, dst) {
		var x, y, k, i, acc, row, ii;
		for (y = 0; y < ph; y++) {
			row = y * pw;
			for (x = 0; x < pw; x++) {
				acc = 0;
				for (k = -KR; k <= KR; k++) {
					i = x + k; if (i < 0) i = 0; else if (i >= pw) i = pw - 1;
					acc += src[row + i] * KERNEL[k + KR];
				}
				bufC[row + x] = acc;
			}
		}
		for (y = 0; y < ph; y++) {
			row = y * pw;
			for (x = 0; x < pw; x++) {
				acc = 0;
				for (k = -KR; k <= KR; k++) {
					i = y + k; if (i < 0) i = 0; else if (i >= ph) i = ph - 1;
					acc += bufC[i * pw + x] * KERNEL[k + KR];
				}
				dst[row + x] = acc;
			}
		}
	}

	// Signed distance field for one material: positive inside, negative
	// outside, in cells. The world border counts as solid, so pixels stay
	// flush with the world edge.
	function buildClassField(id, b) {
		var i, N = pw * ph, c, member;
		for (i = 0; i < N; i++) {
			c = clsGrid[i];
			member = (c === id || c === -2) ? 1 : 0;
			b.solid[i] = member;
			bufA[i] = member ? 1e9 : 0; // distance to nearest non-member
			bufB[i] = member ? 0 : 1e9; // distance to nearest member
		}
		chamfer(bufA);
		chamfer(bufB);
		for (i = 0; i < N; i++) {
			if (bufA[i] === 0) b.dist[i] = Math.min(bufB[i] === 1e9 ? D_CAP : bufB[i] / 3, D_CAP) * -1;
			else b.dist[i] = Math.min(bufA[i] / 3, D_CAP);
		}
		blurField(b.dist, b.dist);
	}

	function smoothPost(ctx) {
		if (view !== 1 && view !== 3) return;
		if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) return;
		var W = width + 1, H = height + 1; // sim coords are 0..width inclusive
		var PS = pixelSize;
		if (!PS || PS < 2) return;
		var canvas = ctx.canvas;
		if (canvas.width < W * PS || canvas.height < H * PS) return; // mid-resize safety

		ensureGrids(W, H);
		clsGrid.fill(-1);
		plusGrid.fill(0);
		cloudPixels.length = 0; // rebuild every frame so old clouds never linger

		var i, d, gi;

		// Pass 1: classify the live pixels; collect gas/glow cloud particles
		presentClasses.length = 0;
		for (i = 0; i < currentPixels.length; i++) {
			var pixel = currentPixels[i];
			if (!pixel || pixel.del === true) continue;
			if (!pixelMap[pixel.x] || pixelMap[pixel.x][pixel.y] === undefined) continue;
			if (pixel.con) {
				if (!elements[pixel.con.element]) delete pixel.con;
				else if (elements[pixel.element].canContain === true) pixel = pixel.con;
			}
			var info = elements[pixel.element];
			if (!info) continue;
			if (pixel.x < 0 || pixel.y < 0 || pixel.x >= W || pixel.y >= H) continue;

			// Gases and glow pixels become soft cloud particles instead of
			// blocky squares, plus shapes or custom renderers (drawn after
			// the pixel pass).
			if (view === 1 && pixel.glow !== false &&
				(info.isGas || info.glow || pixel.glow)) {
				gi = (pixel.y + 1) * pw + (pixel.x + 1);
				plusGrid[gi] = 1;
				cloudPixels.push([pixel.x, pixel.y, pixel.color,
					pixel.alpha === undefined ? 1 : pixel.alpha]);
				continue;
			}

			var s;
			if (view === 3) {
				if (pixel.alpha === 0) continue;
				s = 1;
			} else {
				s = (settings.textures !== 0) ? (pixel.alpha === undefined ? 1 : pixel.alpha) : 1;
				if (s === 0) continue;
			}

			gi = (pixel.y + 1) * pw + (pixel.x + 1);
			var id = elemId(pixel.element);
			clsGrid[gi] = (s >= 0.5) ? id : -3; // -3 = translucent, leave as drawn
			if (presentClasses.indexOf(id) === -1) presentClasses.push(id);
		}

		// World border ring
		var lastRow = (ph - 1) * pw;
		for (var x = 0; x < pw; x++) { clsGrid[x] = -2; clsGrid[lastRow + x] = -2; }
		for (var y = 0; y < ph; y++) { clsGrid[y * pw] = -2; clsGrid[y * pw + pw - 1] = -2; }

		// Build this frame's distance fields
		for (i = 0; i < presentClasses.length; i++) {
			buildClassField(presentClasses[i], getClassBufs(presentClasses[i]));
		}

		// Pass 2: boundary cells (any cell touching a cell of another phase
		// or material), skipping anything affected by gas/glow cells.
		edgeCells.length = 0;
		var minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
		var sq = squareCoords;
		for (y = 0; y < H; y++) {
			var rowBase = (y + 1) * pw + 1;
			for (x = 0; x < W; x++) {
				gi = rowBase + x;
				var cls = clsGrid[gi];
				if (cls < 0 && cls !== -1) continue; // border/translucent
				var prot = plusGrid[gi] === 1;
				var edge = false;
				for (d = 0; d < 8 && !prot; d++) {
					var nc = clsGrid[gi + sq[d][1] * pw + sq[d][0]];
					if (nc === -3) { prot = true; break; }
					if (nc !== -2 && nc !== cls) edge = true;
				}
				if (!prot) {
					for (d = 0; d < 8; d++) {
						if (plusGrid[gi + sq[d][1] * pw + sq[d][0]]) { prot = true; break; }
					}
				}
				if (prot || !edge) continue;
				edgeCells.push(gi);
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
		}
		if (!edgeCells.length) {
			if (view === 1) drawClouds(ctx);
			return;
		}

		// Pass 3: read the drawn boundary from the pixels layer, so render
		// presets (heat glow, textures, ...) are preserved, then re-render the
		// boundary cells as smooth curves.
		minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
		maxX = Math.min(W - 1, maxX + 1); maxY = Math.min(H - 1, maxY + 1);
		var bx = minX * PS, by = minY * PS;
		var bw = (maxX - minX + 1) * PS, bh = (maxY - minY + 1) * PS;
		var img = ctx.getImageData(bx, by, bw, bh);
		var data = img.data;
		frameId++;
		var cw = canvas.width, chh = canvas.height;
		if (!smoothImg || smoothImg.width !== cw || smoothImg.height !== chh) {
			smoothImg = ctx.createImageData(cw, chh);
			smoothU32 = new Uint32Array(smoothImg.data.buffer);
			hashFrame.fill(0); // cached cells no longer have pixels stored
		}
		var imgU32 = new Uint32Array(img.data.buffer);

		// Sample each material cell's drawn color at its center (fallback:
		// the first drawn subpixel in the cell).
		for (var cy = minY; cy <= maxY; cy++) {
			for (var cx = minX; cx <= maxX; cx++) {
				gi = (cy + 1) * pw + (cx + 1);
				hasCol[gi] = 0;
				if (clsGrid[gi] < 0) continue;
				var ox = (cx - minX) * PS, oy = (cy - minY) * PS;
				var ci = ((oy + (PS >> 1)) * bw + ox + (PS >> 1)) * 4;
				if (data[ci + 3] < 40) { // custom renderer left the center empty
					var found = false;
					for (var sy = 0; sy < PS && !found; sy++) {
						for (var sx = 0; sx < PS; sx++) {
							var ti = ((oy + sy) * bw + ox + sx) * 4;
							if (data[ti + 3] >= 40) { ci = ti; found = true; break; }
						}
					}
					if (!found) continue;
				}
				colR[gi] = data[ci]; colG[gi] = data[ci + 1]; colB[gi] = data[ci + 2];
				hasCol[gi] = 1;
			}
		}

		// Per-boundary-cell scratch (small plain arrays, reused).
		var kList = [], kMode = [], kHasRep = [], kRepR = [], kRepG = [], kRepB = [];
		for (i = 0; i < edgeCells.length; i++) {
			gi = edgeCells[i];
			var cellX = (gi % pw) - 1, cellY = ((gi / pw) | 0) - 1;
			var ox = (cellX - minX) * PS, oy = (cellY - minY) * PS;

			// Cells whose 3x3 neighborhood (materials + drawn colors) is
			// unchanged since they were last rendered are copied from the
			// cache instead of recomputed — big scenes stay cheap.
			var h = 0x9e3779b9;
			for (var hy = -1; hy <= 1; hy++) {
				for (var hx = -1; hx <= 1; hx++) {
					var gj2 = gi + hy * pw + hx;
					h = (Math.imul(h ^ clsGrid[gj2], 0x85ebca6b) + hasCol[gj2]) | 0;
					if (hasCol[gj2]) {
						h = (Math.imul(h ^ (colR[gj2] | 0), 0x27d4eb2f) + ((colG[gj2] | 0) << 2)) | 0;
						h = Math.imul(h ^ (colB[gj2] | 0), 0x165667b1) | 0;
					}
				}
			}
			if (hashFrame[gi] !== 0 && hashGrid[gi] === h) {
				var sx0 = cellX * PS, sy0 = cellY * PS;
				for (var cy2 = 0; cy2 < PS; cy2++) {
					var src = (sy0 + cy2) * cw + sx0;
					var dst = (oy + cy2) * bw + ox;
					for (var cx2 = 0; cx2 < PS; cx2++) imgU32[dst + cx2] = smoothU32[src + cx2];
				}
				continue;
			}

			// Materials present in the 3x3 neighborhood, with per-material
			// mode (curve-only vs exact floor) and fallback color.
			kList.length = 0;
			for (var dy = -1; dy <= 1; dy++) {
				for (var dx = -1; dx <= 1; dx++) {
					var nc = clsGrid[gi + dy * pw + dx];
					if (nc >= 0 && kList.indexOf(nc) === -1) kList.push(nc);
				}
			}
			kMode.length = kHasRep.length = kRepR.length = kRepG.length = kRepB.length = kList.length;
			for (var ki = 0; ki < kList.length; ki++) {
				var kBuf = getClassBufs(kList[ki]);
				kMode[ki] = kBuf.dist[gi] >= T_SOLID ? 1 : 0;
				kHasRep[ki] = 0;
				if (hasCol[gi]) { // the cell itself may already carry this material's color
					kRepR[ki] = colR[gi]; kRepG[ki] = colG[gi]; kRepB[ki] = colB[gi];
					kHasRep[ki] = 1;
				}
				for (var q = 0; q < 8 && !kHasRep[ki]; q++) {
					var gj = gi + sq[q][1] * pw + sq[q][0];
					if (clsGrid[gj] === kList[ki] && hasCol[gj]) {
						kRepR[ki] = colR[gj]; kRepG[ki] = colG[gj]; kRepB[ki] = colB[gj];
						kHasRep[ki] = 1;
					}
				}
			}

			for (var py = 0; py < PS; py++) {
				var v = (py + 0.5) / PS - 0.5;
				var j = Math.floor(v), fv = v - j;
				var r0 = gi + j * pw, wT = 1 - fv, wB = fv;
				for (var px = 0; px < PS; px++) {
					var u = (px + 0.5) / PS - 0.5;
					var ii = Math.floor(u), fu = u - ii;
					var c0 = r0 + ii, c1 = c0 + 1, c2 = c0 + pw, c3 = c1 + pw;
					var w00 = (1 - fu) * wT, w10 = fu * wT, w01 = (1 - fu) * wB, w11 = fu * wB;
					// Pick the material that covers this subpixel most; ties go
					// to the one whose smoothed surface is closest. Colors are
					// taken from the winner only, so materials never mix.
					var best = 0, bestKi = -1, bestD = -1e9;
					for (ki = 0; ki < kList.length; ki++) {
						var b = getClassBufs(kList[ki]);
						var e = w00 * b.solid[c0] + w10 * b.solid[c1] +
							w01 * b.solid[c2] + w11 * b.solid[c3];
						var dv = w00 * b.dist[c0] + w10 * b.dist[c1] +
							w01 * b.dist[c2] + w11 * b.dist[c3];
						var t2 = (dv + EDGE_A) / (EDGE_A * 2);
						var a = t2 <= 0 ? 0 : (t2 >= 1 ? 1 : t2 * t2 * (3 - 2 * t2));
						if (!kMode[ki]) { // small feature: keep the exact grid as a floor
							var t1 = (e - (0.5 - EDGE_SOFT)) / (EDGE_SOFT * 2);
							var a1 = t1 <= 0 ? 0 : (t1 >= 1 ? 1 : t1 * t1 * (3 - 2 * t1));
							if (a1 > a) a = a1;
						}
						if (a > best || (a === best && dv > bestD)) {
							best = a; bestKi = ki; bestD = dv;
						}
					}
					var di = ((oy + py) * bw + ox + px) * 4;
					if (best <= 0 || bestKi < 0) {
						data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; data[di + 3] = 0;
						continue;
					}
					var win = kList[bestKi];
					var cw = 0, rr = 0, gg = 0, bb = 0;
					if (clsGrid[c0] === win && hasCol[c0]) { cw += w00; rr += w00 * colR[c0]; gg += w00 * colG[c0]; bb += w00 * colB[c0]; }
					if (clsGrid[c1] === win && hasCol[c1]) { cw += w10; rr += w10 * colR[c1]; gg += w10 * colG[c1]; bb += w10 * colB[c1]; }
					if (clsGrid[c2] === win && hasCol[c2]) { cw += w01; rr += w01 * colR[c2]; gg += w01 * colG[c2]; bb += w01 * colB[c2]; }
					if (clsGrid[c3] === win && hasCol[c3]) { cw += w11; rr += w11 * colR[c3]; gg += w11 * colG[c3]; bb += w11 * colB[c3]; }
					if (cw > 1e-6) {
						data[di] = rr / cw; data[di + 1] = gg / cw; data[di + 2] = bb / cw;
					} else if (kHasRep[bestKi]) {
						data[di] = kRepR[bestKi]; data[di + 1] = kRepG[bestKi]; data[di + 2] = kRepB[bestKi];
					} else {
						continue; // winning material has no color here: leave as drawn
					}
					data[di + 3] = best * 255;
				}
			}
			// remember this cell's rendered pixels + what they depend on
			var sx0 = cellX * PS, sy0 = cellY * PS;
			for (var cy2 = 0; cy2 < PS; cy2++) {
				var src = (sy0 + cy2) * cw + sx0;
				var dst = (oy + cy2) * bw + ox;
				for (var cx2 = 0; cx2 < PS; cx2++) smoothU32[src + cx2] = imgU32[dst + cx2];
			}
			hashGrid[gi] = h;
			hashFrame[gi] = frameId;
		}
		ctx.putImageData(img, bx, by);
		if (view === 1) drawClouds(ctx);
	}

	// --- Gas / glow cloud particles ------------------------------------

	function rgbaStr(rgb, a) {
		return "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + "," + a + ")";
	}

	function parseColorRGB(c) {
		if (!c || !c.charCodeAt) return null;
		var ch = c.charCodeAt(0);
		if (ch === 35) { // '#...'
			var h = c.substring(1);
			if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
			if (h.length >= 6) return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
			return null;
		}
		var m = c.match(/[\d\.]+/g);
		if (ch === 114 && m) return [+m[0], +m[1], +m[2]]; // rgb(...)
		if (ch === 104 && m && typeof HSLtoRGB === "function") { // hsl(...)
			var rgb = HSLtoRGB([m[0] / 360, m[1] / 100, m[2] / 100]);
			return [rgb[0], rgb[1], rgb[2]];
		}
		return null;
	}

	var CLOUD_R = 2.3;  // cloud radius, in cells
	var CLOUD_A = 0.55; // base opacity of a single gas pixel's cloud
	var cloudCache = {}, cloudCachePS = 0;

	function cloudSprite(color) {
		if (Array.isArray(color)) color = color[0]; // some elements list several colors
		var rgb = parseColorRGB(color);
		if (!rgb) rgb = [255, 255, 255]; // unparsable color: draw a neutral puff, never a hole
		// Quantize colors to 16-level buckets: fire's continuously shifting
		// rgb(...) colors would otherwise overflow the cache every frame and
		// force dozens of sprite rebuilds — that made fire scenes lag badly.
		var qr = rgb[0] & ~15, qg = rgb[1] & ~15, qb = rgb[2] & ~15;
		var key = qr + "," + qg + "," + qb;
		var sprite = cloudCache[key];
		if (sprite) return sprite;
		var r = Math.ceil(CLOUD_R * pixelSize);
		sprite = document.createElement("canvas");
		sprite.width = sprite.height = r * 2;
		var sctx = sprite.getContext("2d");
		var grad = sctx.createRadialGradient(r, r, 0, r, r, r);
		grad.addColorStop(0, rgbaStr([qr, qg, qb], 0.8));
		grad.addColorStop(0.35, rgbaStr([qr, qg, qb], 0.4));
		grad.addColorStop(0.7, rgbaStr([qr, qg, qb], 0.12));
		grad.addColorStop(1, rgbaStr([qr, qg, qb], 0));
		sctx.fillStyle = grad;
		sctx.fillRect(0, 0, r * 2, r * 2);
		if (Object.keys(cloudCache).length > 512) cloudCache = {};
		cloudCache[key] = sprite;
		return sprite;
	}

	function drawClouds(ctx) {
		if (!cloudPixels.length) return;
		if (cloudCachePS !== pixelSize) { cloudCache = {}; cloudCachePS = pixelSize; }
		var r = CLOUD_R * pixelSize;
		for (var i = 0; i < cloudPixels.length; i++) {
			var g = cloudPixels[i];
			var sprite = cloudSprite(g[2]);
			if (!sprite) continue;
			ctx.globalAlpha = CLOUD_A * g[3];
			// Overlapping soft circles stack up: a group of nearby gas pixels
			// fades into one bigger cloud that wraps the whole shape.
			ctx.drawImage(sprite, (g[0] + 0.5) * pixelSize - r, (g[1] + 0.5) * pixelSize - r, r * 2, r * 2);
		}
		ctx.globalAlpha = 1;
	}

	// Some gases (like fire) draw through a custom renderer; bypass those
	// in the normal view too — the clouds replace their rendering entirely.
	for (var elName in elements) {
		var el = elements[elName];
		if (!el || !el.renderer) continue;
		(function (orig) {
			el.renderer = function (pixel, ctx) {
				if (view === 1 && pixel.glow !== false &&
					(el.isGas || el.glow || pixel.glow)) return;
				orig(pixel, ctx);
			};
		})(el.renderer);
	}

	// The game draws gas/glow pixels as a plus shape in the normal view;
	// skip that — the clouds above replace it.
	var origView1Pixel = viewInfo[1].pixel;
	viewInfo[1].pixel = function (pixel, ctx) {
		var info = elements[pixel.element];
		if (view === 1 && info && !info.renderer && pixel.glow !== false &&
			(info.isGas || info.glow || pixel.glow)) return;
		origView1Pixel(pixel, ctx);
	};

	renderPostPixel(smoothPost);
})();
