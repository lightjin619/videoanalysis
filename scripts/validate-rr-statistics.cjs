const assert = require("node:assert/strict");
const load = require("./load-analysis.cjs");
const { cleanRrRecords, hrvFromRrRecords, analysisRrRecords, successiveRrDifferences,
  calculatePulseSignalFromSamples, calculatePosSignal } = load("lib/posSignal.ts");
const { calculateMetric, segmentStatistics } = load("lib/withinSubject.ts");
const { calculateBetweenMetric } = load("lib/betweenSubject.ts");

const values = [800, 810, 790, 1200, 805, 795, 800, 100];
let time = 0;
const records = cleanRrRecords(values.map(interval => {
  const start = time; time += interval / 1000;
  return { start, end: time, interval, expectedRr: 800, segmentId: 0, accepted: true };
}));
assert.equal(records[3].rejectionReason, "outlier");
assert.equal(records[7].rejectionReason, "range");
assert.equal(records.filter(r => r.accepted).length, 6);
assert.equal(successiveRrDifferences(records).length, 4, "do not bridge a rejected RR");
const metrics = hrvFromRrRecords(records);
const saved = { rrRecords: records, peakTimes: [0, 0.1, 2.1], peakFrequency: 1.25 };
for (const name of ["meanRr", "sdnn", "rmssd", "pnn50"]) {
  assert.equal(calculateMetric(saved, name, 0, time), metrics[name]);
  assert.equal(calculateBetweenMetric(saved, name, 0, time), metrics[name]);
}
assert.equal(segmentStatistics(saved, "rmssd", 0, time).samples.length, 6);
assert.equal(analysisRrRecords({ ...saved, rrRecords: [] }).length, 0, "empty cleaned list must stay empty");
assert.equal(analysisRrRecords(saved, 0.2, 1.61).length, 1, "both RR endpoints must lie in range");

const legacy = { peakTimes: [0, .8, 1.6, 2.4, 3.2, 4, 4.8, 5.6], peakFrequency: 1.25,
  ppgSignal: [[0,0], [.4,1], [.8,0], [1.2,1], [1.6,0], [4,0], [4.4,1], [4.8,0], [5.2,1], [5.6,0]] };
const legacyRr = analysisRrRecords(legacy);
assert.ok(legacyRr.every(r => r.end <= 1.6 || r.start >= 4), "legacy RR must not span tracking loss");
assert.equal(successiveRrDifferences(legacyRr).length, 2);

const rate = 30;
const sine = (duration, f) => Array.from({ length: duration * rate }, (_, i) => ({t:i/rate,value:Math.sin(2*Math.PI*f*i/rate)}));
const steady = calculatePulseSignalFromSamples(sine(45, 1.37), rate);
assert.ok(Math.abs(steady.heartRate - 82.2) < .5);
assert.ok(steady.hrv.rmssd < 5, "subframe timing should avoid video-frame RR quantization");
for (const w of steady.heartRateWindows) {
  assert.ok(Math.abs(w.refinementBand.low - (w.peakFrequency - .2)) < 1e-12);
  assert.ok(Math.abs(w.refinementBand.high - (w.peakFrequency + .2)) < 1e-12);
  assert.ok(w.heartRate >= 48 && w.heartRate <= 180);
}
const mixed = sine(60,1.2).map(p => ({...p,value:p.value + .6*Math.sin(2*Math.PI*1.8*p.t)}));
const broad = calculatePulseSignalFromSamples(mixed, rate);
const amplitude = f => {
  const points = broad.signal.filter(p=>p.t>=10 && p.t<50);
  const real = points.reduce((s,p)=>s+p.value*Math.cos(2*Math.PI*f*p.t),0);
  const imag = points.reduce((s,p)=>s+p.value*Math.sin(2*Math.PI*f*p.t),0);
  return Math.hypot(real,imag);
};
assert.ok(amplitude(1.8)/amplitude(1.2)>.4,"retain neighboring pulse components inside 0.8–3 Hz without narrow refiltering");
const innerRr = broad.rrRecords.filter(r => r.accepted && r.start >= 10 && r.end < 50);
assert.ok(innerRr.length > 40);
// A second-order band-pass has finite roll-off: this interferer leaves about
// 25ms timing modulation, versus over 100ms without the narrow filter.
assert.ok(Math.max(...innerRr.map(r => Math.abs(r.interval - 1000/1.2))) < 30,
  "RR detection must suppress the 1.8 Hz interferer retained in the displayed POS waveform");
const high = calculatePulseSignalFromSamples(sine(30,2.9),rate);
assert.ok(high.heartRate > 172 && high.heartRate <= 180);
const sparse = calculatePulseSignalFromSamples(sine(15,1.2),rate,[3,3.8,4.6]);
assert.equal(sparse.rrIntervals.length,2,"retain RR even if too short for HRV summary");
assert.equal(sparse.hrv,null);
const changing = Array.from({length:35*rate},(_,i)=>{
  const t=i/rate, phase=t<15?1.2*t:18+(t-15)*1.8;
  return {t,value:Math.sin(2*Math.PI*phase)};
});
const weighted = calculatePulseSignalFromSamples(changing,rate);
assert.ok(Math.abs(weighted.heartRate-(72*15+108*20)/35)<1,"short tail HR must be duration weighted");
const rgb = sine(45,1.2).map(({t,value})=>({t,r:100+.1*value,g:100+value,b:100-.2*value}));
const gap = calculatePosSignal(rgb.filter(p=>p.t<15||p.t>=18));
assert.ok(gap.rrRecords.every(r=>r.end<15||r.start>=18));
assert.ok(new Set(gap.rrRecords.map(r=>r.segmentId)).size===2);
const long = calculatePulseSignalFromSamples(sine(90,1.2), rate);
const full = { ...saved, rrRecords: long.rrRecords };
assert.ok(Number.isFinite(calculateBetweenMetric(full,"lfHf",0,90)));
const hole = long.rrRecords.map((r,i)=>({...r,accepted:i!==30}));
assert.equal(calculateBetweenMetric({...full,rrRecords:hole},"lfHf",0,90),null,"LF/HF must not interpolate across an excluded beat");
assert.equal(calculatePulseSignalFromSamples(sine(30,1.2),1),null);
console.log("RR/statistics validation passed: outliers, adjacency, shared statistics, legacy gaps, subframe timing, saved broad passband, HR +/-0.2 Hz RR refinement, band edges, tracking loss, LF/HF gaps.");
