// nocubes.js — smooth "no cubes" surface rendering for Sandboxels
//
// Instead of every pixel rendering as a hard square, surfaces are smoothed
// into round curves. Each frame the mod builds two fields from the live
// pixels and re-renders only the boundary cells:
//
// - "fine": exact per-cell solidity, so flat surfaces stay flush with the
//   cell edge, nothing erodes, and diagonal-only contacts of the SAME
//   material are joined by a filled, rounded neck (no gaps in sand piles).
// - "coarse": a gaussian-blurred solidity field (radius 2), which
//   interprets a larger section of pixels — staircases become smooth
//   slopes at any angle instead of 0/45/90 degree steps.
//
// The rendered silhouette is the union (max) of both fields, so smoothing
// can only fill in, never eat into existing pixels.
//
// - Air corners between DIFFERENT materials are only filled from the
//   dominant material, so placing sand over dirt doesn't paint mixed
//   pixels between the two; their colors blend smoothly instead.
// - Pixels touching the world edge stay flush with the world edge.
// - Gases and glow pixels render as soft round cloud particles with a
//   smooth fade; nearby gases stack into one bigger cloud that wraps the
//   whole shape.
// - Semi-transparent pixels keep their original rendering untouched.
// - Thermal and other special views are left unsmoothed.
//
// Toggle it off in Extras > Mods (remove "nocubes.js"), then reset the canvas.

(function () {
	"use strict";

	// Half-width of the anti-aliased edge band, in cell units.
	var EDGE_SOFT = 0.14;
	// Cells whose blurred solidity reaches this level belong to a larger
	// structure: their silhouette follows the blurred (smooth) field alone,
	// so staircase corners recede into a smooth curve. Smaller features
	// (lone grains, thin lines, small clusters) keep the exact field as a
	// floor, so nothing erodes away.
	var BLUR_SOLID = 0.45;
	// Separable gaussian blur kernel (sigma ~1.8, radius 3), sums to 1.
	// A symmetric kernel keeps iso-0.5 exactly on flat surfaces, while
	// staircase steps get averaged into smooth slopes at any angle.
	var BLUR = [0.058, 0.126, 0.2, 0.233, 0.2, 0.126, 0.058];

	var sGrid = null;      // padded solidity (0..1, world border ring = 1)
	var bGrid = null;      // blurred solidity
	var blurIn = null, blurTmp = null;
	var clsGrid = null;    // padded class: 0 air, 1 solid, 2 translucent
	var elemGrid = null;   // padded element index (-1 = none)
	var colR = null, colG = null, colB = null, hasCol = null;
	var plusGrid = null;   // padded mask of "plus" glow pixels (normal view)
	var pw = 0, ph = 0, gw = 0, gh = 0;
	var edgeCells = [];
	var cloudPixels = []; // this frame's gas/glow pixels: [x, y, color, alpha]
	var elemIndex = {}, elemCount = 0;

	function elemId(name) {
		var id = elemIndex[name];
		if (id === undefined) { id = elemCount++; elemIndex[name] = id; }
		return id;
	}

	function ensureGrids(W, H) {
		if (sGrid && gw === W && gh === H) return;
		gw = W; gh = H;
		pw = W + 2; ph = H + 2;
		sGrid = new Float32Array(pw * ph);
		bGrid = new Float32Array(pw * ph);
		blurIn = new Float32Array(pw * ph);
		blurTmp = new Float32Array(pw * ph);
		clsGrid = new Uint8Array(pw * ph);
		elemGrid = new Int32Array(pw * ph);
		colR = new Float32Array(pw * ph);
		colG = new Float32Array(pw * ph);
		colB = new Float32Array(pw * ph);
		hasCol = new Uint8Array(pw * ph);
		plusGrid = new Uint8Array(pw * ph);
	}

	function drawWorldBorder() {
		// Treat out-of-bounds as solid, so pixels stay flush with the world
		// edge instead of rounding away from it.
		var lastRow = (ph - 1) * pw;
		for (var x = 0; x < pw; x++) {
			sGrid[x] = 1; clsGrid[x] = 1;
			sGrid[lastRow + x] = 1; clsGrid[lastRow + x] = 1;
		}
		for (var y = 0; y < ph; y++) {
			var row = y * pw;
			sGrid[row] = 1; clsGrid[row] = 1;
			sGrid[row + pw - 1] = 1; clsGrid[row + pw - 1] = 1;
		}
	}

	function computeBlur() {
		// Blur the solidity field (excluding the virtual world border).
		blurIn.set(sGrid);
		var lastRow = (ph - 1) * pw;
		for (var x = 0; x < pw; x++) { blurIn[x] = 0; blurIn[lastRow + x] = 0; }
		for (var y = 0; y < ph; y++) {
			var row = y * pw;
			blurIn[row] = 0; blurIn[row + pw - 1] = 0;
		}
		var k, i, R = 3;
		// horizontal pass
		for (y = 0; y < ph; y++) {
			var row = y * pw;
			for (x = 0; x < pw; x++) {
				var acc = 0;
				for (k = -R; k <= R; k++) {
					i = x + k; if (i < 0) i = 0; else if (i >= pw) i = pw - 1;
					acc += blurIn[row + i] * BLUR[k + R];
				}
				blurTmp[row + x] = acc;
			}
		}
		// vertical pass
		for (y = 0; y < ph; y++) {
			var row = y * pw;
			for (x = 0; x < pw; x++) {
				var acc = 0;
				for (k = -R; k <= R; k++) {
					i = y + k; if (i < 0) i = 0; else if (i >= ph) i = ph - 1;
					acc += blurTmp[i * pw + x] * BLUR[k + R];
				}
				bGrid[row + x] = acc;
			}
		}
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
		sGrid.fill(0);
		clsGrid.fill(0);
		elemGrid.fill(-1);
		plusGrid.fill(0);
		drawWorldBorder();

		var i, d, gi;

		// Pass 1: solidity + classes from the live pixels
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
			// blocky squares or plus shapes (drawn after the pixel pass).
			if (view === 1 && !info.renderer && pixel.glow !== false &&
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
			sGrid[gi] = s;
			clsGrid[gi] = (s >= 0.5) ? 1 : 2; // 1 = solid, 2 = translucent (leave as drawn)
			elemGrid[gi] = elemId(pixel.element);
		}

		computeBlur();

		// Pass 2: find boundary cells (a solid cell touching air, or an air cell
		// touching solid), skipping anything affected by "plus" glow renders.
		edgeCells.length = 0;
		var minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
		var sq = squareCoords;
		for (var y = 0; y < H; y++) {
			var rowBase = (y + 1) * pw + 1;
			for (var x = 0; x < W; x++) {
				gi = rowBase + x;
				var cls = clsGrid[gi];
				if (cls === 2) continue;
				var solid = cls === 1;
				var edge = false, prot = false;
				for (d = 0; d < 8; d++) {
					var nc = clsGrid[gi + sq[d][1] * pw + sq[d][0]];
					if (nc === 2) { prot = true; break; }
					if ((nc === 1) !== solid) edge = true;
				}
				if (!prot && plusGrid[gi]) prot = true;
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
		if (edgeCells.length) {
		// Pass 3: read the drawn boundary from the pixels layer, so render
		// presets (heat glow, textures, ...) are preserved, then re-render the
		// boundary cells as smooth curves.
		minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
		maxX = Math.min(W - 1, maxX + 1); maxY = Math.min(H - 1, maxY + 1);
		var bx = minX * PS, by = minY * PS;
		var bw = (maxX - minX + 1) * PS, bh = (maxY - minY + 1) * PS;
		var img = ctx.getImageData(bx, by, bw, bh);
		var data = img.data;

		// Colors for the field: sample each solid cell's drawn color at its
		// center (falls back to the first drawn subpixel in the cell).
		for (var cy = minY; cy <= maxY; cy++) {
			for (var cx = minX; cx <= maxX; cx++) {
				gi = (cy + 1) * pw + (cx + 1);
				hasCol[gi] = 0;
				if (clsGrid[gi] !== 1) continue;
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

		var soft = EDGE_SOFT;
		var lo = 0.5 - soft, range = soft * 2;
		var pw2 = pw * 2;
		for (i = 0; i < edgeCells.length; i++) {
			gi = edgeCells[i];
			var cellX = (gi % pw) - 1, cellY = ((gi / pw) | 0) - 1;
			var isAir = clsGrid[gi] === 0;
			var ox = (cellX - minX) * PS, oy = (cellY - minY) * PS;
			var gy = (cellY + 1) * pw + cellX + 1;

			// For air cells, only the dominant neighboring material may fill
			// this cell — no mixed-material pixels between two elements.
			// Where two different materials meet, also skip the blurred
			// field, whose window mixes both materials.
			var dom = -2, mixed = false;
			if (isAir) {
				var best = 0, counts = {};
				for (d = 0; d < 8; d++) {
					var n = gi + sq[d][1] * pw + sq[d][0];
					var es = sGrid[n];
					if (es <= 0 || elemGrid[n] < 0) continue;
					if (es > best) { best = es; dom = elemGrid[n]; }
					if (counts[elemGrid[n]]) mixed = true;
					else counts[elemGrid[n]] = 1;
				}
				if (dom < 0) continue; // nothing to fill from
			}

			for (var py = 0; py < PS; py++) {
				var v = (py + 0.5) / PS - 0.5;
				var j = Math.floor(v), fv = v - j;
				var r0 = gy + j * pw, r1 = r0 + pw;
				var wT = 1 - fv, wB = fv;
				for (var px = 0; px < PS; px++) {
					var u = (px + 0.5) / PS - 0.5;
					var ii = Math.floor(u), fu = u - ii;
					var c0 = r0 + ii, c1 = c0 + 1;
					var c2 = c0 + pw, c3 = c1 + pw;
					var w00 = (1 - fu) * wT, w10 = fu * wT, w01 = (1 - fu) * wB, w11 = fu * wB;
					var s00, s10, s01, s11, f, colW;
					if (isAir) {
						s00 = elemGrid[c0] === dom ? sGrid[c0] : 0;
						s10 = elemGrid[c1] === dom ? sGrid[c1] : 0;
						s01 = elemGrid[c2] === dom ? sGrid[c2] : 0;
						s11 = elemGrid[c3] === dom ? sGrid[c3] : 0;
						var b00 = elemGrid[c0] === dom ? bGrid[c0] : 0;
						var b10 = elemGrid[c1] === dom ? bGrid[c1] : 0;
						var b01 = elemGrid[c2] === dom ? bGrid[c2] : 0;
						var b11 = elemGrid[c3] === dom ? bGrid[c3] : 0;
						f = w00 * s00 + w10 * s10 + w01 * s01 + w11 * s11;
						if (!mixed) { // blur mixes materials, so only use it in pure neighborhoods
							var fb = w00 * b00 + w10 * b10 + w01 * b01 + w11 * b11;
							if (fb > f) f = fb;
						}
						colW = (w00 * s00 * hasCol[c0]) + (w10 * s10 * hasCol[c1]) +
							(w01 * s01 * hasCol[c2]) + (w11 * s11 * hasCol[c3]);
					} else {
						s00 = sGrid[c0]; s10 = sGrid[c1]; s01 = sGrid[c2]; s11 = sGrid[c3];
						f = w00 * s00 + w10 * s10 + w01 * s01 + w11 * s11;
						var fb2 = w00 * bGrid[c0] + w10 * bGrid[c1] + w01 * bGrid[c2] + w11 * bGrid[c3];
						// Large structures follow the smoothed field alone (staircase
						// corners recede into a curve); small features keep the
						// exact field as a floor so nothing erodes away.
						if (bGrid[gi] >= BLUR_SOLID) f = fb2;
						else if (fb2 > f) f = fb2;
						colW = (w00 * s00 * hasCol[c0]) + (w10 * s10 * hasCol[c1]) +
							(w01 * s01 * hasCol[c2]) + (w11 * s11 * hasCol[c3]);
					}
					var t = (f - lo) / range;
					var a = t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t));
					var di = ((oy + py) * bw + ox + px) * 4;
					if (a <= 0 || colW < 1e-6 || (isAir && f > 0 && colW / f < 0.02)) {
						data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; data[di + 3] = 0;
						continue;
					}
					if (isAir) { a *= colW / f; if (a > 1) a = 1; }
					data[di] = (w00 * s00 * hasCol[c0] * colR[c0] + w10 * s10 * hasCol[c1] * colR[c1] +
						w01 * s01 * hasCol[c2] * colR[c2] + w11 * s11 * hasCol[c3] * colR[c3]) / colW;
					data[di + 1] = (w00 * s00 * hasCol[c0] * colG[c0] + w10 * s10 * hasCol[c1] * colG[c1] +
						w01 * s01 * hasCol[c2] * colG[c2] + w11 * s11 * hasCol[c3] * colG[c3]) / colW;
					data[di + 2] = (w00 * s00 * hasCol[c0] * colB[c0] + w10 * s10 * hasCol[c1] * colB[c1] +
						w01 * s01 * hasCol[c2] * colB[c2] + w11 * s11 * hasCol[c3] * colB[c3]) / colW;
					data[di + 3] = a * 255;
				}
			}
		}
		ctx.putImageData(img, bx, by);
		}
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
		var sprite = cloudCache[color];
		if (sprite) return sprite;
		var rgb = parseColorRGB(color);
		if (!rgb) rgb = [255, 255, 255]; // unparsable color: draw a neutral puff, never a hole
		var r = Math.ceil(CLOUD_R * pixelSize);
		sprite = document.createElement("canvas");
		sprite.width = sprite.height = r * 2;
		var sctx = sprite.getContext("2d");
		var grad = sctx.createRadialGradient(r, r, 0, r, r, r);
		grad.addColorStop(0, rgbaStr(rgb, 0.8));
		grad.addColorStop(0.35, rgbaStr(rgb, 0.4));
		grad.addColorStop(0.7, rgbaStr(rgb, 0.12));
		grad.addColorStop(1, rgbaStr(rgb, 0));
		sctx.fillStyle = grad;
		sctx.fillRect(0, 0, r * 2, r * 2);
		if (Object.keys(cloudCache).length > 96) cloudCache = {};
		cloudCache[color] = sprite;
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
