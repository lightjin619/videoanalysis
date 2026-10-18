const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const load = require("./load-analysis.cjs");
const { summarizeAnalysisCoverage, collectMotionIntervals } = load("lib/analysisCoverage.ts");

// Run the production frame callback with deterministic detections and video times.
const pagePath = "app/projects/[projectId]/analyses/[analysisId]/page.tsx";
const source = fs.readFileSync(pagePath, "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runAnalysisFrame") {
    callback = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const helpers = ast.statements.filter(node => !ts.isImportDeclaration(node)
  && !(ts.isFunctionDeclaration(node) && node.name?.text === "VideoAnalysisPage"))
  .map(node => node.getText(ast)).join("\n");
const initial = { id: 7, x: 0.2, y: 0.2, width: 0.2, height: 0.2, confidence: 0.9 };
const moved = { ...initial, x: 0.32 };
const ref = current => ({ current });
const samples = [], observations = [];
let now = 0, candidates = [initial], sampledFace;
const context = {
  ...load("lib/faceTracking.ts"),
  videoRef: ref({ currentTime: 40, ended: false }), faceDetectorRef: ref({}),
  isAnalyzingRef: ref(true), startedRangeRef: ref({ start: 40, end: 44 }),
  observationsRef: ref(observations), rgbSamplesRef: ref(samples),
  trackedFaceRef: ref(initial), pendingFaceMoveRef: ref(null),
  trackingMissCountRef: ref(0), roiOutlierCountRef: ref(0),
  lastDetectionMediaTimeRef: ref(null), lastDetectionTimeRef: ref(0),
  lastSampleMediaTimeRef: ref(-1), isRoiStableRef: ref(false),
  exclusionReasonRef: ref("unmatched"), performance: { now: () => now },
  detectFaces: () => candidates,
  sampleSelectedFaceRgb: face => {
    sampledFace = face;
    const t = context.videoRef.current.currentTime;
    const pulse = Math.sin(2 * Math.PI * 1.2 * t);
    return { t, r: 100 + 0.1 * pulse, g: 100 + pulse, b: 100 - 0.2 * pulse };
  },
  setTrackedFace() {}, setAnalysisMessage() {}, setError() {}, setRgbSampleCount() {},
  scheduleNextAnalysisFrame() {}, stopAnalysis() { throw new Error("Unexpected stop"); },
  console,
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(`${helpers}\nconst runAnalysisFrame = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
function frame(t) {
  now += 100;
  context.videoRef.current.currentTime = t;
  vm.runInContext(`runAnalysisFrame(0, { mediaTime: ${t} });`, context);
}
frame(40);
assert.equal(samples.length, 1);
candidates = [moved];
frame(40 + 1 / 30);
assert.equal(samples.length, 2, "large ROI motion must still collect RGB");
assert.equal(sampledFace.x, moved.x, "sample the new detection, not the old anchor");
assert.equal(observations.at(-1).status, "collected");
assert.equal(observations.at(-1).motion, true);
for (let i = 2; i < 120; i++) frame(40 + i / 30);
assert.equal(samples.length, 120, "include every delivered motion/recovery frame");
assert.equal(observations.at(-1).motion, false, "clear motion once tracking settles");
const pos = load("lib/posSignal.ts").calculatePosSignal(samples);
assert.ok(pos && pos.signal.length > 0, "motion-inclusive RGB must reach POS");
assert.ok(pos.signal.some(point => point.t < 40.2), "retain pulse over the motion interval");
const coverage = summarizeAnalysisCoverage({ start: 40, end: 44 }, observations, samples, pos.signal);
assert.equal(coverage.rows[0].rgb, 120);
assert.ok(coverage.rows[0].motion > 0);
assert.ok(coverage.motionIntervals[0].start > 40);
assert.ok(coverage.motionIntervals[0].end < 41);
candidates = [];
frame(44 - 1 / 60);
assert.equal(samples.length, 120, "do not sample a stale box when no face is detected");
assert.equal(observations.at(-1).status, "no-face");
assert.equal(observations.at(-1).motion, false);

// The reproducible offline RGB scan must retain motion just like the live callback.
const scanSource = fs.readFileSync("scripts/compare-face-quality.mjs", "utf8");
const scanBox = scanSource.slice(scanSource.indexOf("function updateBox("), scanSource.indexOf("function updateMesh("))
  .replaceAll("${boxOnly ? 'state.pending??state.box' : 'state.box'}", "state.pending??state.box")
  .replaceAll("${boxOnly}", "true");
context.scanState = { box: initial, pending: null, lastDetection: -1, misses: 0, outliers: 0 };
context.scanMoved = moved;
vm.runInContext(scanBox, context);
vm.runInContext("updateBox(scanState, [scanMoved], 40)", context);
assert.equal(context.scanState.motion, true);
assert.equal(context.scanState.sampleBox.x, moved.x, "offline motion must sample the current detected ROI");
vm.runInContext("updateBox(scanState, [], 40.03)", context);
assert.equal(context.scanState.motion, true, "retain the cached motion flag between detections");
vm.runInContext("updateBox(scanState, [], 40.1)", context);
assert.equal(context.scanState.motion, false, "clear motion when a new detection finds no matched face");
assert.equal(context.scanState.sampleBox, null);

const markers = collectMotionIntervals({ start: 10, end: 12 }, [
  { t: 10, status: "collected", motion: true },
  { t: 10.1, status: "collected", motion: true },
  { t: 10.2, status: "collected" },
  { t: 11, status: "collected", motion: true },
  { t: 11.9, status: "collected", motion: true },
]);
assert.equal(markers.length, 3, "keep separated motion and unobserved gaps separate");
assert.ok(Math.abs(markers[0].end - 10.2) < 1e-6);
assert.ok(markers[1].end < 11.2, "do not shade an unobserved long gap");
assert.equal(markers[2].end, 12, "clip the last marker to the analysis range");
assert.equal(collectMotionIntervals({ start: 10, end: 12 }, []).length, 0);

// Verify both production canvas renderers shade only their visible time range.
const chartSource = fs.readFileSync("components/PulseWaveChart.tsx", "utf8");
const chartAst = ts.createSourceFile("chart.tsx", chartSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const chartHelpers = chartAst.statements.filter(node => !ts.isImportDeclaration(node)
  && !(ts.isFunctionDeclaration(node) && node.name?.text === "PulseWaveChart"))
  .map(node => node.getText(chartAst)).join("\n");
const fills = [];
const drawing = new Proxy({}, { get: (target, key) => key === "fillRect"
  ? (...args) => fills.push(args) : target[key] ?? (() => {}) });
const canvas = { width: 1000, height: 280, getContext: () => drawing };
const chartContext = { canvas, intervals: [{ start: 9, end: 10.5 }, { start: 20, end: 21 }] };
vm.createContext(chartContext);
vm.runInContext(ts.transpileModule(chartHelpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, chartContext);
vm.runInContext('drawPulseSegment(canvas, [{ t: 10, value: 0 }, { t: 11, value: 1 }], [], 30, intervals)', chartContext);
assert.deepEqual(fills.pop(), [28, 28, 472, 224]);
vm.runInContext('drawTachogram(canvas, [{ t: 10, rr: 800 }, { t: 11, rr: 810 }], intervals)', chartContext);
assert.deepEqual(fills.pop(), [32, 32, 468, 216]);
assert.equal(fills.length, 0, "ignore markers outside each graph's visible range");
console.log("Motion checks passed: RGB collection, moved ROI, recovery, POS, tracking loss, coverage, interval bounds, pulse/tachogram shading, offline scan parity.");
