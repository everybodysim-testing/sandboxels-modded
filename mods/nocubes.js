/* ========================================================================
 * nocubes.js - Sandboxels High-Performance Surface Smoother Mod
 * ======================================================================== */

(function () {
    console.log("[nocubes.js] Loading optimized surface smoothing engine...");

    // Safe helper to read active grid cells
    function getPixel(x, y) {
        if (x < 0 || y < 0 || x >= width || y >= height) return null;
        if (!pixelMap[x]) return null;
        return pixelMap[x][y] || null;
    }

    // Main optimized render pass
    function renderNoCubesOptimized() {
        if (typeof ctx === "undefined" || typeof pixelMap === "undefined") return;

        const pSize = window.pixelSize || 4;
        const radius = pSize * 0.5;
        const bg = window.backgroundColor || "#000000";

        ctx.save();

        // --- PASS 1: BATCH OUTSIDE CORNER CUTS ---
        // Batching all arc cuts into one path prevents canvas state flushes & lag
        ctx.fillStyle = bg;
        ctx.beginPath();

        for (let x = 0; x < width; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < height; y++) {
                const current = pixelMap[x][y];
                if (!current) continue;

                const top    = getPixel(x, y - 1);
                const bottom = getPixel(x, y + 1);
                const left   = getPixel(x - 1, y);
                const right  = getPixel(x + 1, y);

                const screenX = x * pSize;
                const screenY = y * pSize;

                // Round exposed corners
                if (!top && !left) {
                    ctx.moveTo(screenX, screenY);
                    ctx.lineTo(screenX + radius, screenY);
                    ctx.arcTo(screenX, screenY, screenX, screenY + radius, radius);
                    ctx.closePath();
                }
                if (!top && !right) {
                    ctx.moveTo(screenX + pSize, screenY);
                    ctx.lineTo(screenX + pSize - radius, screenY);
                    ctx.arcTo(screenX + pSize, screenY, screenX + pSize, screenY + radius, radius);
                    ctx.closePath();
                }
                if (!bottom && !left) {
                    ctx.moveTo(screenX, screenY + pSize);
                    ctx.lineTo(screenX + radius, screenY + pSize);
                    ctx.arcTo(screenX, screenY + pSize, screenX, screenY + pSize - radius, radius);
                    ctx.closePath();
                }
                if (!bottom && !right) {
                    ctx.moveTo(screenX + pSize, screenY + pSize);
                    ctx.lineTo(screenX + pSize - radius, screenY + pSize);
                    ctx.arcTo(screenX + pSize, screenY + pSize, screenX + pSize, screenY + pSize - radius, radius);
                    ctx.closePath();
                }
            }
        }
        ctx.fill();

        // --- PASS 2: BATCH DIAGONAL GAP BRIDGING ---
        for (let x = 0; x < width; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < height; y++) {
                const current = pixelMap[x][y];
                if (!current) continue;

                const right  = getPixel(x + 1, y);
                const bottom = getPixel(x, y + 1);
                const bottomRight = getPixel(x + 1, y + 1);

                // Fill diagonal air gaps between touching cells
                if (!right && !bottom && bottomRight) {
                    const screenX = x * pSize;
                    const screenY = y * pSize;
                    ctx.fillStyle = current.color || "#ffffff";
                    ctx.beginPath();
                    ctx.arc(screenX + pSize, screenY + pSize, radius * 0.75, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        ctx.restore();
    }

    // Direct registration into engine tick pipeline
    if (window.runAfterTicks && Array.isArray(window.runAfterTicks)) {
        window.runAfterTicks.push(renderNoCubesOptimized);
    } else {
        const origDraw = window.drawPixels;
        window.drawPixels = function () {
            if (origDraw) origDraw();
            renderNoCubesOptimized();
        };
    }

    console.log("[nocubes.js] Optimized mod successfully attached!");
})();
