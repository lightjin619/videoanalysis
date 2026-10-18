const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../lib/faceTracking.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const library = { exports: {} };
new Function("module", "exports", compiled)(library, library.exports);
const { smoothFaceBox, isConsistentFaceMove } = library.exports;
const face = { id: 7, x: 0.3, y: 0.2, width: 0.2, height: 0.25, confidence: 0.9 };
let tracked = face;
let rawEnergy = 0;
let filteredEnergy = 0;
for (let i = 0; i < 120; i++) {
  const jitter = (i % 2 ? 1 : -1) * 0.002;
  tracked = smoothFaceBox(tracked, { ...face, x: face.x + jitter, width: face.width + jitter }, 0.08);
  rawEnergy += jitter ** 2;
  filteredEnergy += (tracked.x - face.x) ** 2;
  assert.equal(tracked.id, face.id);
}
assert.ok(filteredEnergy < rawEnergy * 0.2, "stationary jitter should be strongly reduced");
const moved = { ...face, x: face.x + 0.08 };
tracked = face;
for (let i = 0; i < 6; i++) tracked = smoothFaceBox(tracked, moved, 0.08);
assert.ok(Math.abs(tracked.x - moved.x) < 0.01, "follow real movement within half a second");
const smallMove = { ...face, x: face.x + 0.001 };
let fast = face;
let slow = face;
for (let i = 0; i < 20; i++) fast = smoothFaceBox(fast, smallMove, 0.04);
for (let i = 0; i < 10; i++) slow = smoothFaceBox(slow, smallMove, 0.08);
assert.ok(Math.abs(fast.x - slow.x) < 1e-10, "response should use elapsed video time");
assert.ok(isConsistentFaceMove(moved, { ...moved, x: moved.x + 0.005 }));
assert.ok(!isConsistentFaceMove(moved, { ...moved, x: moved.x + 0.15 }));
const edge = smoothFaceBox(face, { ...face, x: 0.95, y: 0.98 }, 0.08);
assert.ok(edge.x >= 0 && edge.y >= 0 && edge.x + edge.width <= 1 && edge.y + edge.height <= 1);
console.log("Face tracking checks passed: jitter, movement, timing, outlier consistency, bounds.");
