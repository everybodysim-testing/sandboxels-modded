// nocubes.js — smooth "no cubes" surface rendering for Sandboxels
//
// Instead of every pixel rendering as a hard square, the boundary between
// pixels and air is smoothed into round curves: a solidity field is built
// from the current pixels each frame, and only the boundary cells are
// re-rendered as soft, rounded shapes (bilinear field + smoothstep alpha).
//
// - Piles of powder/solid merge into smooth rounded blobs with NO gaps:
//   cells that only touch diagonally are joined by a filled, rounded neck.
// - Flat surfaces stay flush with the cell edge, so nothing shrinks away.
// - Pixels touching the world edge stay flush with the world edge.
// - Glow "plus" renders (fire, gases...) and semi-transparent pixels keep
//   their original rendering untouched.
// - Thermal and other special views are left unsmoothed.
//
// Toggle it off in Extras > Mods (remove "nocubes.js"), then reset the canvas.

(function () {
	"use strict";

	// Half-width of the anti-aliased edge band, in cell units.
	var EDGE_SOFT = 0.14;

	var sGrid = null;    // padded solidity (0..1, world border ring = 1)
	var clsGrid = null;  // padded class: 0 air, 1 solid, 2 translucent
	var colR = null, colG = null, colB = null, hasCol = null; // boundary colors
	var plusGrid = null; // padded mask of "plus" glow pixels (normal view)
	var pw = 0, ph = 0, gw = 0, gh = 0;
	var edgeCells = [];

	function ensureGrids(W, H) {
		if (sGrid && gw === W && gh === H) return;
		gw = W; gh = H;
		pw = W + 2; ph = H + 2;
		sGrid = new Float32Array(pw * ph);
		clsGrid = new Uint8Array(pw * ph);
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

			// "plus" glow renders spill into neighbor cells; keep them as drawn
			if (view === 1 && pixel.glow !== false &&
				((info.isGas && info.glow !== false) || info.glow || pixel.glow)) {
				plusGrid[(pixel.y + 1) * pw + (pixel.x + 1)] = 1;
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
		}

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
		if (!edgeCells.length) return;

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
		for (i = 0; i < edgeCells.length; i++) {
			gi = edgeCells[i];
			var cellX = (gi % pw) - 1, cellY = ((gi / pw) | 0) - 1;
			var isAir = clsGrid[gi] === 0;
			var ox = (cellX - minX) * PS, oy = (cellY - minY) * PS;
			var gy = (cellY + 1) * pw + cellX + 1;
			for (var py = 0; py < PS; py++) {
				var v = (py + 0.5) / PS - 0.5;
				var j = Math.floor(v), fv = v - j;
				var r0 = gy + j * pw, r1 = r0 + pw;
				var wT = 1 - fv, wB = fv;
				for (var px = 0; px < PS; px++) {
					var u = (px + 0.5) / PS - 0.5;
					var ii = Math.floor(u), fu = u - ii;
					var c0 = r0 + ii, c1 = c0 + 1;
					var w00 = (1 - fu) * wT, w10 = fu * wT, w01 = (1 - fu) * wB, w11 = fu * wB;
					var s00 = sGrid[c0], s10 = sGrid[c1], s01 = sGrid[c0 + pw], s11 = sGrid[c1 + pw];
					var cov = w00 * s00 + w10 * s10 + w01 * s01 + w11 * s11;
					var colW = (w00 * s00 * hasCol[c0]) + (w10 * s10 * hasCol[c1]) +
						(w01 * s01 * hasCol[c0 + pw]) + (w11 * s11 * hasCol[c1 + pw]);
					var t = (cov - lo) / range;
					var a = t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t));
					if (isAir && cov > 0) {
						// Air cells only show coverage that comes from real,
						// colored pixels (never from the virtual world border).
						a *= colW / cov;
						if (a > 1) a = 1;
					}
					var di = ((oy + py) * bw + ox + px) * 4;
					if (a <= 0 || colW < 1e-6) {
						data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; data[di + 3] = 0;
						continue;
					}
					data[di] = (w00 * s00 * hasCol[c0] * colR[c0] + w10 * s10 * hasCol[c1] * colR[c1] +
						w01 * s01 * hasCol[c0 + pw] * colR[c0 + pw] + w11 * s11 * hasCol[c1 + pw] * colR[c1 + pw]) / colW;
					data[di + 1] = (w00 * s00 * hasCol[c0] * colG[c0] + w10 * s10 * hasCol[c1] * colG[c1] +
						w01 * s01 * hasCol[c0 + pw] * colG[c0 + pw] + w11 * s11 * hasCol[c1 + pw] * colG[c1 + pw]) / colW;
					data[di + 2] = (w00 * s00 * hasCol[c0] * colB[c0] + w10 * s10 * hasCol[c1] * colB[c1] +
						w01 * s01 * hasCol[c0 + pw] * colB[c0 + pw] + w11 * s11 * hasCol[c1 + pw] * colB[c1 + pw]) / colW;
					data[di + 3] = a * 255;
				}
			}
		}
		ctx.putImageData(img, bx, by);
	}

	renderPostPixel(smoothPost);
})();
