const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(require("node:path").join(__dirname, "../lib/posSignal.ts"), "utf8");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject });
const { calculatePulseSignalFromSamples, calculatePosSignal } = exportsObject;
const rate = 30;
const samples = Array.from({ length: 35 * rate }, (_, i) => {
  const t = i / rate;
  const phase = t < 15 ? t * 1.2 : 18 + (t - 15) * 1.8;
  return { t, value: Math.sin(2 * Math.PI * phase) + 0.2 * Math.sin(2 * Math.PI * 0.2 * t) };
});
const result = calculatePulseSignalFromSamples(samples, rate);
assert.ok(result);
assert.equal(result.signal.length, samples.length);
assert.equal(result.heartRateWindows.length, 3);
assert.ok(Math.abs(result.heartRateWindows[0].heartRate - 72) < 1);
assert.ok(Math.abs(result.heartRateWindows[1].heartRate - 108) < 1);
assert.equal(result.heartRateWindows[2].reusedPrevious, true);
assert.equal(result.heartRateWindows[2].heartRate, result.heartRateWindows[1].heartRate);
assert.ok(result.signal.every(({ value }) => Number.isFinite(value)));
assert.ok(result.rrIntervals.some(rr => Math.abs(rr - 833) < 40));
assert.ok(result.rrIntervals.some(rr => Math.abs(rr - 556) < 40));
assert.ok(result.peaks.some(t => t > 14.5 && t < 15.5));
const rgb = samples.map(({ t }) => {
  const pulse = Math.sin(2 * Math.PI * 1.2 * t);
  return { t, r: 100 + 0.1 * pulse, g: 100 + pulse, b: 100 - 0.2 * pulse };
}).filter(({ t }) => t < 16 || t >= 19);
const pos = calculatePosSignal(rgb);
assert.ok(pos);
assert.ok(Math.abs(pos.heartRate - 72) < 2);
assert.ok(pos.signal.every(({ t }) => t < 16 || t >= 19));
assert.ok(pos.rrIntervals.every(rr => rr < 1200));
const short = calculatePulseSignalFromSamples(samples.slice(0, 8 * rate), rate);
assert.ok(short);
assert.equal(short.heartRateWindows.length, 1);
assert.equal(short.heartRateWindows[0].reusedPrevious, false);
assert.equal(calculatePulseSignalFromSamples(samples.map(p => ({ ...p, value: 0 })), rate), null);
console.log("POS validation passed: changing HR, RR, window boundaries, short tails, tracking gaps, short clips, flat signal.");
