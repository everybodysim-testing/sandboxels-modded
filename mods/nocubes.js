/* ========================================================================
 * nocubes.js - Sandboxels Visual Smoothing & Gap-Eliminating Mod
 * ======================================================================== */

(function () {
    console.log("[nocubes.js] Initializing real-time surface engine...");

    // Safe helper to fetch pixel objects without throwing out-of-bounds errors
    function getPixelAt(x, y) {
        if (x < 0 || y < 0 || x >= width || y >= height) return null;
        if (!pixelMap[x]) return null;
        return pixelMap[x][y] || null;
    }

    // Core smoothing pass executed on each frame
    function applyNoCubesSmoothing() {
        if (!window.ctx || !window.pixelMap) return;

        const pSize = window.pixelSize || 4;
        ctx.save();

        for (let x = 0; x < width; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < height; y++) {
                const current = pixelMap[x][y];
                if (!current) continue;

                // Query neighboring cells
                const top    = getPixelAt(x, y - 1);
                const bottom = getPixelAt(x, y + 1);
                const left   = getPixelAt(x - 1, y);
                const right  = getPixelAt(x + 1, y);

                const screenX = x * pSize;
                const screenY = y * pSize;
                const radius  = pSize * 0.5;

                // Match canvas background color so smoothing cuts blend perfectly
                ctx.fillStyle = window.backgroundColor || "#000000";

                // --- 1. ROUND EXPOSED OUTER CORNERS ---
                // Top-Left corner exposed to air
                if (!top && !left) {
                    ctx.beginPath();
                    ctx.moveTo(screenX, screenY);
                    ctx.lineTo(screenX + radius, screenY);
                    ctx.arcTo(screenX, screenY, screenX, screenY + radius, radius);
                    ctx.closePath();
                    ctx.fill();
                }
                // Top-Right corner exposed to air
                if (!top && !right) {
                    ctx.beginPath();
                    ctx.moveTo(screenX + pSize, screenY);
                    ctx.lineTo(screenX + pSize - radius, screenY);
                    ctx.arcTo(screenX + pSize, screenY, screenX + pSize, screenY + radius, radius);
                    ctx.closePath();
                    ctx.fill();
                }
                // Bottom-Left corner exposed to air
                if (!bottom && !left) {
                    ctx.beginPath();
                    ctx.moveTo(screenX, screenY + pSize);
                    ctx.lineTo(screenX + radius, screenY + pSize);
                    ctx.arcTo(screenX, screenY + pSize, screenX, screenY + pSize - radius, radius);
                    ctx.closePath();
                    ctx.fill();
                }
                // Bottom-Right corner exposed to air
                if (!bottom && !right) {
                    ctx.beginPath();
                    ctx.moveTo(screenX + pSize, screenY + pSize);
                    ctx.lineTo(screenX + pSize - radius, screenY + pSize);
                    ctx.arcTo(screenX + pSize, screenY + pSize, screenX + pSize, screenY + pSize - radius, radius);
                    ctx.closePath();
                    ctx.fill();
                }

                // --- 2. NO-GAPS DIAGONAL FUSER ---
                // Bridges diagonal corners (Dirt <-> Sand / Dirt <-> Dirt) so no air holes exist
                const bottomRight = getPixelAt(x + 1, y + 1);
                if (!right && !bottom && bottomRight) {
                    ctx.fillStyle = current.color;
                    ctx.beginPath();
                    ctx.arc(screenX + pSize, screenY + pSize, radius, 0, Math.PI * 2);
                    ctx.fill();
                }

                const bottomLeft = getPixelAt(x - 1, y + 1);
                if (!left && !bottom && bottomLeft) {
                    ctx.fillStyle = current.color;
                    ctx.beginPath();
                    ctx.arc(screenX, screenY + pSize, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        ctx.restore();
    }

    // --- RELIABLE HOOK INTO SANDBOXELS ENGINE ---
    if (window.runAfterRender) {
        window.runAfterRender.push(applyNoCubesSmoothing);
    } else {
        // Backup loop override if runAfterRender is unavailable
        const originalRender = window.render;
        window.render = function () {
            if (originalRender) originalRender();
            applyNoCubesSmoothing();
        };
    }

    // Register into Sandboxels Mod Manager
    if (window.modMetaData) {
        window.modMetaData["nocubes.js"] = {
            name: "NoCubes Smooth Engine",
            author: "AI",
            description: "Smooths surface edges and fills diagonal gaps in real-time.",
            version: "2.0"
        };
    }

    console.log("[nocubes.js] Successfully attached to Sandboxels rendering pipeline!");
})();
