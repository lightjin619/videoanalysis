const assert = require("node:assert/strict");
const load = require("./load-analysis.cjs");
const { calculatePulseSignalFromSamples, calculatePosSignal, analyzeFilteredPosSignal, POS_SIGNAL_PIPELINE, POS_RR_PIPELINE } = load("lib/posSignal.ts");
const { prepareWithinSubjectResult, calculateMetric, buildTrendSeries } = load("lib/withinSubject.ts");
const rate = 30;
const samples = Array.from({ length: 90 * rate }, (_, i) => {
  const t = i / rate;
  return { t, value: Math.sin(2 * Math.PI * 1.2 * t) + .6 * Math.sin(2 * Math.PI * 1.8 * t)
    + Math.sin(2 * Math.PI * .2 * t) + Math.sin(2 * Math.PI * 6 * t) };
});
const pulse = calculatePulseSignalFromSamples(samples, rate);
const component = (points, frequency) => {
  const inner = points.filter(p => p.t >= 10 && p.t < 80);
  return {
    sine: 2 / inner.length * inner.reduce((s, p) => s + p.value * Math.sin(2 * Math.PI * frequency * p.t), 0),
    cosine: 2 / inner.length * inner.reduce((s, p) => s + p.value * Math.cos(2 * Math.PI * frequency * p.t), 0),
  };
};
// Check actual gain and phase against the analytic transfer function; no normalization.
const low = Math.tan(Math.PI * .8 / rate), high = Math.tan(Math.PI * 3 / rate);
const center = Math.sqrt(low * high), omega = 2 * Math.atan(center);
const alpha = Math.sin(omega) * (high - low) / (2 * center), a0 = 1 + alpha;
for (const [f, inputAmplitude] of [[.2, 1], [1.2, 1], [1.8, .6], [6, 1]]) {
  const w = 2 * Math.PI * f / rate;
  const numerator = (alpha / a0 * (1 - Math.cos(2 * w))) ** 2 + (alpha / a0 * Math.sin(2 * w)) ** 2;
  const a1 = -2 * Math.cos(omega) / a0, a2 = (1 - alpha) / a0;
  const denominator = (1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w)) ** 2
    + (a1 * Math.sin(w) + a2 * Math.sin(2 * w)) ** 2;
  const actual = component(pulse.signal, f);
  assert.ok(Math.abs(actual.sine - inputAmplitude * numerator / denominator) < 1e-5, `filtfilt gain at ${f} Hz`);
  assert.ok(Math.abs(actual.cosine) < 1e-5, `zero phase at ${f} Hz`);
}
assert.deepEqual(JSON.parse(JSON.stringify(analyzeFilteredPosSignal(pulse.signal, rate).signal)),
  JSON.parse(JSON.stringify(pulse.signal)), "RR refinement must preserve the saved/displayed waveform values");

const rgb = samples.map(({ t }) => {
  const value = Math.sin(2 * Math.PI * 1.2 * t);
  return { t: t + 40, r: 100 + .1 * value, g: 100 + value, b: 100 - .2 * value };
}).filter(p => p.t < 72 || p.t >= 75);
const pos = calculatePosSignal(rgb);
const origin = pos.signal[0].t;
const saved = JSON.parse(JSON.stringify({
  id: "saved", projectId: "project", analysisId: "analysis", fileName: "synthetic.mp4",
  createdAt: new Date().toISOString(), signalPipeline: POS_SIGNAL_PIPELINE, signalTimeOrigin: origin,
  duration: pos.signal.at(-1).t - origin, sampleRate: pos.sampleRate,
  heartRate: pos.heartRate, peakFrequency: pos.peakFrequency, refinementBand: pos.refinementBand, hrv: null,
  ppgSignal: pos.signal.map(p => [p.t - origin, p.value]),
  rgbSignal: rgb.map(p => [p.t - origin, p.r, p.g, p.b]),
  motionIntervals: [{ start: 14.8, end: 15.5 }],
  rrRecords: [], // Within must compute the full RR list from the saved waveform.
}));
const prepared = prepareWithinSubjectResult(saved);
assert.ok(prepared?.rrRecords.length);
assert.equal(prepared.rrPipeline, POS_RR_PIPELINE);
assert.equal(prepared.ppgSignal, saved.ppgSignal);
assert.equal(prepared.rgbSignal, saved.rgbSignal);
assert.equal(prepared.motionIntervals, saved.motionIntervals);
assert.ok(prepared.rrRecords.some(r => r.accepted && r.start < 15 && r.end > 15), "15s display boundary must not split the full RR list");
assert.ok(prepared.rrRecords.some(r => r.accepted && r.start < 60 && r.end > 60), "full-recording peak detection across later display boundaries");
assert.ok(prepared.rrRecords.every(r => r.end < 32 || r.start >= 35), "never create RR across tracking loss");
assert.ok(prepared.rrRecords.some(r => r.accepted && r.start < 15.5 && r.end > 14.8), "motion annotation must not discard RR");
assert.equal(prepared.rrRecords.length, pos.rrRecords.length);
for (const metric of ["meanRr", "sdnn", "rmssd", "pnn50"]) {
  assert.ok(Math.abs(calculateMetric(prepared, metric, 0, prepared.duration) - pos.hrv[metric]) < 1e-7, `full-list ${metric}`);
}
const series = buildTrendSeries(prepared, "saved", "heartRate", 0, prepared.duration, [30, 60], false, ["red", "blue", "green"]);
assert.ok(series.some(s => s.label.endsWith("30s")) && series.some(s => s.label.endsWith("60s")), "retain existing within-subject window methods");
assert.equal(prepareWithinSubjectResult({ ...saved, signalPipeline: undefined }), null, "legacy narrow-band data must not be treated as current POS data");
console.log("Saved POS validation passed: unchanged waveform gain/phase, HR +/-0.2 Hz RR refinement, full-recording RR across 15s boundaries, motion retention, tracking gaps, persisted HRV, existing 30/60s analysis.");
