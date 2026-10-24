<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Sandboxels with NoCubes Rendering Engine</title>
    <style>
        body {
            margin: 0;
            background: #121212;
            color: #fff;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }
        canvas {
            border: 2px solid #333;
            background: #000;
            image-rendering: pixelated;
        }
        .controls {
            margin-top: 10px;
            display: flex;
            gap: 10px;
        }
        button {
            padding: 8px 16px;
            background: #222;
            color: #fff;
            border: 1px solid #555;
            cursor: pointer;
            border-radius: 4px;
        }
        button.active {
            background: #4a90e2;
        }
    </style>
</head>
<body>

    <h2>Sandboxels + NoCubes Engine</h2>
    <canvas id="sandbox" width="400" height="400"></canvas>

    <div class="controls">
        <button id="btnDirt" class="active" onclick="setElem('dirt')">Dirt</button>
        <button id="btnSand" onclick="setElem('sand')">Sand</button>
        <button id="btnClear" onclick="clearGrid()">Clear</button>
    </div>

    <script>
        const canvas = document.getElementById('sandbox');
        const ctx = canvas.getContext('2d');

        const GRID_SIZE = 80;
        const CELL_SIZE = canvas.width / GRID_SIZE;
        let grid = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(null));
        let selectedElem = 'dirt';

        const ElemTypes = {
            dirt: { color: '#8B5A2B', solid: true },
            sand: { color: '#E2C07D', solid: true }
        };

        function setElem(type) {
            selectedElem = type;
            document.getElementById('btnDirt').classList.toggle('active', type === 'dirt');
            document.getElementById('btnSand').classList.toggle('active', type === 'sand');
        }

        function clearGrid() {
            grid = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(null));
        }

        function getCell(x, y) {
            if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return null;
            return grid[x][y];
        }

        // --- Core NoCubes Smooth Rendering Pipeline ---
        function render() {
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Pass 1: Render Base Material Blocks
            for (let x = 0; x < GRID_SIZE; x++) {
                for (let y = 0; y < GRID_SIZE; y++) {
                    const cell = grid[x][y];
                    if (cell) {
                        ctx.fillStyle = cell.color;
                        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                    }
                }
            }

            // Pass 2: NoCubes Smoothing & Gap Elimination
            const radius = CELL_SIZE * 0.5;

            for (let x = 0; x < GRID_SIZE; x++) {
                for (let y = 0; y < GRID_SIZE; y++) {
                    const current = grid[x][y];
                    if (!current) continue;

                    const top = getCell(x, y - 1);
                    const bottom = getCell(x, y + 1);
                    const left = getCell(x - 1, y);
                    const right = getCell(x + 1, y);

                    const screenX = x * CELL_SIZE;
                    const screenY = y * CELL_SIZE;

                    // Shave exposed outer corners to smooth block edges into curves
                    ctx.fillStyle = '#000000';

                    if (!top && !left) {
                        ctx.beginPath();
                        ctx.moveTo(screenX, screenY);
                        ctx.lineTo(screenX + radius, screenY);
                        ctx.arcTo(screenX, screenY, screenX, screenY + radius, radius);
                        ctx.closePath();
                        ctx.fill();
                    }
                    if (!top && !right) {
                        ctx.beginPath();
                        ctx.moveTo(screenX + CELL_SIZE, screenY);
                        ctx.lineTo(screenX + CELL_SIZE - radius, screenY);
                        ctx.arcTo(screenX + CELL_SIZE, screenY, screenX + CELL_SIZE, screenY + radius, radius);
                        ctx.closePath();
                        ctx.fill();
                    }

                    // Bridge diagonal gaps (Dirt <-> Sand or Dirt <-> Dirt)
                    const bottomRight = getCell(x + 1, y + 1);
                    if (!right && !bottom && bottomRight) {
                        ctx.fillStyle = current.color;
                        ctx.beginPath();
                        ctx.arc(screenX + CELL_SIZE, screenY + CELL_SIZE, radius, 0, Math.PI * 2);
                        ctx.fill();
                    }

                    const bottomLeft = getCell(x - 1, y + 1);
                    if (!left && !bottom && bottomLeft) {
                        ctx.fillStyle = current.color;
                        ctx.beginPath();
                        ctx.arc(screenX, screenY + CELL_SIZE, radius, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }

            requestAnimationFrame(render);
        }

        // Mouse Drawing Interactions
        let isDrawing = false;

        function draw(e) {
            if (!isDrawing) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / CELL_SIZE);
            const y = Math.floor((e.clientY - rect.top) / CELL_SIZE);

            if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
                grid[x][y] = { type: selectedElem, color: ElemTypes[selectedElem].color };
            }
        }

        canvas.addEventListener('mousedown', (e) => { isDrawing = true; draw(e); });
        canvas.addEventListener('mousemove', draw);
        window.addEventListener('mouseup', () => isDrawing = false);

        // Start render loop
        render();
    </script>
</body>
</html>
