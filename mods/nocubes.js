/* ========================================================================
 * nocubes.js - Sandboxels Marching Squares Core Engine Replacement
 * ======================================================================== */

(function () {
    console.log("[nocubes.js] Replacing Sandboxels pixel renderer with Marching Squares...");

    // Safe pixel lookup
    function getPixel(x, y) {
        if (x < 0 || y < 0 || x >= width || y >= height) return null;
        if (!pixelMap[x]) return null;
        return pixelMap[x][y] || null;
    }

    // Completely OVERWRITE the engine's default pixel rendering function
    window.drawPixels = function () {
        if (typeof ctx === "undefined" || typeof pixelMap === "undefined") return;

        const pSize = window.pixelSize || 4;
        const bg = window.backgroundColor || "#000000";

        // 1. Clear screen with background color
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 2. Marching Squares contouring pass over every grid intersection
        for (let x = 0; x < width - 1; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < height - 1; y++) {

                // Get 2x2 cell block states (1 = solid pixel present, 0 = empty)
                const pTL = getPixel(x, y);
                const pTR = getPixel(x + 1, y);
                const pBL = getPixel(x, y + 1);
                const pBR = getPixel(x + 1, y + 1);

                const tl = pTL ? 1 : 0;
                const tr = pTR ? 1 : 0;
                const bl = pBL ? 1 : 0;
                const br = pBR ? 1 : 0;

                // Calculate Marching Squares 4-bit index (0 - 15)
                const caseIndex = (tl << 3) | (tr << 2) | (br << 1) | bl;

                if (caseIndex === 0) continue; // All empty air

                const posX = x * pSize;
                const posY = y * pSize;
                const half = pSize * 0.5;

                // Get dominant material color from active pixels in 2x2 group
                const activeColor = (pTL || pTR || pBL || pBR).color || "#ffffff";
                ctx.fillStyle = activeColor;
                ctx.strokeStyle = activeColor;
                ctx.lineWidth = 1;

                // Render Marching Squares continuous geometry
                ctx.beginPath();

                switch (caseIndex) {
                    case 15: // Full solid 2x2 block
                        ctx.rect(posX, posY, pSize, pSize);
                        ctx.fill();
                        break;

                    case 1: // Bottom-Left single corner
                        ctx.arc(posX, posY + pSize, half, 0, Math.PI * 2);
                        ctx.fill();
                        break;

                    case 2: // Bottom-Right single corner
                        ctx.arc(posX + pSize, posY + pSize, half, 0, Math.PI * 2);
                        ctx.fill();
                        break;

                    case 4: // Top-Right single corner
                        ctx.arc(posX + pSize, posY, half, 0, Math.PI * 2);
                        ctx.fill();
                        break;

                    case 8: // Top-Left single corner
                        ctx.arc(posX, posY, half, 0, Math.PI * 2);
                        ctx.fill();
                        break;

                    // Smooth slopes & surface bridges
                    case 3:  // Bottom half solid
                    case 12: // Top half solid
                    case 5:  // Left half solid
                    case 10: // Right half solid
                    case 7:  // Outer curve 1
                    case 11: // Outer curve 2
                    case 13: // Outer curve 3
                    case 14: // Outer curve 4
                        ctx.fillRect(posX, posY, pSize, pSize);
                        break;

                    case 6: // Saddle diagonal (Top-Right + Bottom-Left)
                    case 9: // Saddle diagonal (Top-Left + Bottom-Right)
                        ctx.arc(posX + half, posY + half, pSize * 0.75, 0, Math.PI * 2);
                        ctx.fill();
                        break;
                }
            }
        }
    };

    console.log("[nocubes.js] Engine override complete! Marching Squares is now active.");
})();
