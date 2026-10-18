const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const load = require("./load-analysis.cjs");
const pos = load("lib/posSignal.ts");
const within = load("lib/withinSubject.ts");
const between = load("lib/betweenSubject.ts");
const { collectMotionIntervals } = load("lib/analysisCoverage.ts");
const root = path.resolve(__dirname, "..");
const output = path.resolve(root, process.argv[2] || "artifacts/test3-pos-validation");
assert.ok(output.startsWith(path.join(root, "artifacts") + path.sep));
const metadata = JSON.parse(fs.readFileSync(path.join(output, "metadata.json"), "utf8"));
const rows = fs.readFileSync(path.join(output, "frames.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
assert.equal(metadata.video, "test3.mov");
assert.equal(metadata.duration, metadata.nativeDuration, "validate the entire video");
assert.equal(rows.length, Math.ceil(metadata.duration * metadata.fps), "full RGB scan must finish first");
assert.ok(metadata.wallSeconds > 0, "scan must have completed");
const rgb = rows.flatMap(row => row.modes.box.rgb ? [row.modes.box.rgb] : []);
const motionAnnotationsAvailable = rows.some(row => "motion" in row.modes.box);
const motionIntervals = motionAnnotationsAvailable ? collectMotionIntervals(
  { start: 0, end: metadata.duration }, rows.map(row => ({ t: row.t, status: row.modes.box.status, motion: row.modes.box.motion }))
) : undefined;
const result = pos.calculatePosSignal(rgb);
assert.ok(result && result.hrv && result.rrRecords.length);
assert.ok(result.signal.every(p => Number.isFinite(p.t) && Number.isFinite(p.value)));
assert.equal(result.rrIntervals.length, result.rrRecords.filter(r => r.accepted).length);
assert.ok(result.rrRecords.every(r => Math.abs(r.interval - (r.end-r.start)*1000)<1e-6));
const gaps = rgb.slice(1).flatMap((p,i) => p.t-rgb[i].t>.5 ? [[rgb[i].t,p.t]] : []);
assert.ok(result.rrRecords.every(r => !gaps.some(([start,end]) => r.start<end && r.end>start)));
for (const w of result.heartRateWindows) {
  assert.ok(w.heartRate>=48 && w.heartRate<=180);
  assert.equal(w.refinementBand.low,.8);
  assert.equal(w.refinementBand.high,3);
}
const origin = result.signal[0].t;
const saved = {
  id:"test3-pos-validation",projectId:"offline-validation",fileName:metadata.video,
  createdAt:new Date().toISOString(),duration:result.signal.at(-1).t-origin,
  signalPipeline:pos.POS_SIGNAL_PIPELINE,signalTimeOrigin:origin,
  rgbSignal:rgb.map(p=>[p.t-origin,p.r,p.g,p.b]),
  sampleRate:result.sampleRate,heartRate:result.heartRate,peakFrequency:result.peakFrequency,
  refinementBand:result.refinementBand,
  motionIntervals:motionIntervals?.map(interval => ({start:interval.start-origin,end:interval.end-origin})),
  heartRateWindows:result.heartRateWindows.map(w=>({...w,start:w.start-origin,end:w.end-origin})),
  rrIntervals:result.rrIntervals,
  rrRecords:result.rrRecords.map(r=>({...r,start:r.start-origin,end:r.end-origin})),
  peakTimes:result.peaks.map(t=>t-origin),
  ppgSignal:result.signal.map(p=>[p.t-origin,p.value]),
  hrv:result.hrv,
};
// Check the serialized representation that the browser actually saves.
const persisted = JSON.parse(JSON.stringify(saved));
const prepared = within.prepareWithinSubjectResult(persisted);
assert.ok(prepared && prepared.rrRecords.length === result.rrRecords.length);
const metrics = ["meanRr","sdnn","rmssd","pnn50"];
for (const metric of metrics) {
  const value = within.calculateMetric(prepared,metric,0,saved.duration);
  assert.ok(Math.abs(value-result.hrv[metric])<1e-8,metric+" summary/within mismatch");
  assert.equal(between.calculateBetweenMetric(persisted,metric,0,saved.duration),value);
}
const windowStatistics = result.heartRateWindows.map(w=>({
  start:w.start,end:w.end,heartRate:w.heartRate,reusedPrevious:w.reusedPrevious,band:w.refinementBand,
  rawRr:result.rrRecords.filter(r=>r.end>=w.start && r.end<w.end).length,
  acceptedRr:result.rrRecords.filter(r=>r.accepted && r.end>=w.start && r.end<w.end).length,
  statistics:Object.fromEntries(metrics.map(metric=>[metric,within.calculateMetric(persisted,metric,w.start-origin,w.end-origin)])),
}));
const hashFiles = ["lib/posSignal.ts","lib/withinSubject.ts","lib/betweenSubject.ts","scripts/validate-test3-pos.cjs"];
const analysisHashes = Object.fromEntries(hashFiles.map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(path.join(root,file))).digest("hex")]));
const accepted = result.rrIntervals.length;
const rejected = result.rrRecords.filter(r=>!r.accepted);
// Compare the broad-band result to known beat timing independently of video.
const phase = t => 1.2*t + .04*Math.sin(2*Math.PI*.25*t);
const synthetic = Array.from({length:120*30},(_,i)=>({t:i/30,value:Math.sin(2*Math.PI*phase(i/30))}));
const syntheticResult = pos.calculatePulseSignalFromSamples(synthetic,30);
const referencePeaks = [];
for (let beat=0;beat<143;beat++) {
  let left=0,right=120;
  for (let i=0;i<50;i++) { const middle=(left+right)/2; if(phase(middle)<beat+.25) left=middle; else right=middle; }
  const t=(left+right)/2;
  if(t>=10 && t<=110) referencePeaks.push(t);
}
const referenceRecords = referencePeaks.slice(1).map((end,i)=>({
  start:referencePeaks[i],end,interval:(end-referencePeaks[i])*1000,expectedRr:1000/1.2,segmentId:0,accepted:true,
}));
const syntheticVariability = {
  description:"120s noiseless phase modulation: sin(2π(1.2t + 0.04sin(2π0.25t))); evaluate inner 10–110s",
  reference:pos.hrvFromRrRecords(referenceRecords),
  filtered:pos.hrvFromRrRecords(syntheticResult.rrRecords.filter(r=>r.start>=10 && r.end<=110)),
};
const report = {
  syntheticVariability,
  metadata,analysisHashes,frames:rows.length,rgbSamples:rgb.length,coverage:rgb.length/rows.length,
  motionAnnotationsAvailable,
  motionFrames:motionAnnotationsAvailable ? rows.filter(row=>row.modes.box.motion).length : null,
  statuses:Object.fromEntries(["collected","no-face","unmatched","motion","read-failed"].map(s=>[s,rows.filter(row=>row.modes.box.status===s).length])),
  pulseSamples:result.signal.length,sampleRate:result.sampleRate,heartRate:result.heartRate,
  rawRr:result.rrRecords.length,acceptedRr:accepted,rejectedRr:rejected.length,
  rejections:Object.fromEntries(["range","outlier"].map(reason=>[reason,rejected.filter(r=>r.rejectionReason===reason).length])),
  trackingGaps:gaps,hrv:result.hrv,lfHf:between.calculateBetweenMetric(persisted,"lfHf",0,saved.duration),
  windows:windowStatistics,
  checks:["entire-video scan","finite POS waveform","0.8–3 Hz filtfilt, no narrow refilter","RR timings/counts","no RR across tracking loss","full saved signal analyzed by within-subject","summary/within/between HRV agreement"],
};
fs.writeFileSync(path.join(output,"saved-result.json"),JSON.stringify(saved,null,2));
fs.writeFileSync(path.join(output,"pos-report.json"),JSON.stringify(report,null,2));
const f = (x,d=2) => x === null ? "—" : x.toFixed(d);
const markdown = `# test3.mov POS·RR 검증 — 2026-10-18

## 방법과 범위

원본 ${f(metadata.nativeDuration,3)}초, ${metadata.width}×${metadata.height}, ${metadata.videoBytes} bytes를 로컬 Chrome/MediaPipe ${metadata.delegate}로 ${metadata.fps}fps 시각 간격 seek 검사했습니다. 첫 검출 얼굴 중 confidence가 가장 높은 얼굴을 선택하고 앱의 기존 안정화 ROI·추적 규칙을 사용했습니다. 전체 ${rows.length}개 샘플 시각을 검사했으며, 원본의 모든 디코딩 프레임 처리나 실제 앱 재생 처리율을 검증한 것은 아닙니다.

모든 유효 RGB를 연속 구간별 POS로 변환한 뒤 0.8–3Hz filtfilt → 전체 구간 피크 시각 보간 → RR 수집 → 범위·MAD 정제 → 기존 통계 순서로 처리했습니다. 추가 협대역 필터는 사용하지 않습니다. Video Analysis의 15초 표시는 RR 구간을 나누지 않습니다. HR 추정은 기존 15초 FFT를 유지하고 마지막 짧은 창은 직전 HR을 사용합니다. 저장한 전체 RGB를 현재 코드로 재분석한 결과이며, 추출 당시 소스와 현재 코드 해시는 별도로 보존합니다. 흔들림 프레임 수집·그래프 표시는 별도 production callback 회귀 검사인 validate-motion.cjs로 검증합니다.

## 결과

| 항목 | 값 |
| --- | ---: |
| 검사 시각 수 | ${rows.length} |
| 유효 RGB | ${rgb.length} (${f(report.coverage*100)}%) |
| 움직임 프레임 별도 기록 | ${report.motionFrames === null ? "기존 RGB 기록에는 별도 움직임 주석 없음" : report.motionFrames} |
| 추적/ROI 상태 | ${Object.entries(report.statuses).map(([k,v])=>k+": "+v).join(", ")} |
| POS 샘플 수 / 표본율 | ${result.signal.length} / ${f(result.sampleRate)}Hz |
| 15초 HR 창 수 | ${windowStatistics.length} |
| 창 길이 가중 평균 HR | ${f(result.heartRate)} BPM |
| 원시 / 채택 / 제외 RR | ${result.rrRecords.length} / ${accepted} / ${rejected.length} |
| 범위 / MAD 제외 | ${report.rejections.range} / ${report.rejections.outlier} |
| Mean RR | ${f(result.hrv.meanRr)}ms |
| SDNN | ${f(result.hrv.sdnn)}ms |
| RMSSD | ${f(result.hrv.rmssd)}ms |
| pNN50 | ${f(result.hrv.pnn50)}% |
| LF/HF | ${f(report.lfHf)} |

## 창별 HR·RR

| 구간(s) | HR(BPM) | 필터(Hz) | 원시/채택 RR | HR 재사용 |
| --- | ---: | --- | ---: | --- |
${windowStatistics.map(w=>`| ${f(w.start)}–${f(w.end)} | ${f(w.heartRate)} | ${f(w.band.low)}–${f(w.band.high)} | ${w.rawRr}/${w.acceptedRr} | ${w.reusedPrevious?"예":"아니오"} |`).join("\n")}

## 통과한 검사

${report.checks.map(check=>"- "+check).join("\n")}

요약·Within·Between의 Mean RR/SDNN/RMSSD/pNN50이 저장 후에도 같은 정제 RR로 계산되는지 확인했습니다. RMSSD/pNN50은 연속 RR 쌍만 사용합니다. LF/HF는 제외 RR 또는 추적 공백을 가로질러 보간하지 않으며 유효 연속 길이가 30초 미만이어도 반환하지 않습니다. 이 30초 기준은 기존 앱의 최소 계산 조건이며 LF/HF 정확도를 보장하지 않습니다.

## 제약과 해석

잡음이 없는 합성 신호 \`sin(2π(1.2t + 0.04sin(2π0.25t)))\`의 정확한 피크 시각과 비교했습니다(30Hz, 120초 중 내부 10–110초). 아래 값은 test3 실측값이 아닌 별도 합성 실험입니다.

| 합성 신호 지표 | 정확한 피크 기준 | 0.8–3Hz filtfilt 후 |
| --- | ---: | ---: |
| SDNN(ms) | ${f(syntheticVariability.reference.sdnn)} | ${f(syntheticVariability.filtered.sdnn)} |
| RMSSD(ms) | ${f(syntheticVariability.reference.rmssd)} | ${f(syntheticVariability.filtered.rmssd)} |

- 기준 ECG/접촉 PPG가 없어 위 HR·HRV 값은 정확도 검증 결과가 아닙니다. 영상만으로 추정한 값입니다.
- 필터와 피크 검출은 박동 시각에 영향을 줄 수 있으므로, 낮은 RMSSD/pNN50이나 안정적인 파형 자체가 정확도 개선을 뜻하지 않습니다.
- 영상 맥파의 간격은 엄밀히 PPI/PRV이며 ECG의 RR/HRV와 동일하다고 가정하지 않습니다. [Gudi et al., 2020](https://arxiv.org/abs/2012.15846)은 HRV에 정밀한 박동 시각 검증이 필요함을 설명합니다. POS 근거는 [Wang et al., 2017](https://doi.org/10.1109/TBME.2016.2609282)입니다.
- 원본 RGB 공백 ${gaps.length}개를 발견했습니다. 긴 공백은 별도 연속 구간으로 분리하고 교차 RR을 만들지 않습니다. 0.5초 이하의 짧은 공백 보간은 기존 규칙을 유지합니다.
- 원본 RGB 추출 시점의 소스 해시는 metadata.json, 현재 재분석 코드 해시는 pos-report.json에 기록합니다.

## 산출물과 재현

- [전체 결과·창별 통계·검사·해시](pos-report.json)
- [브라우저 저장 형식 결과와 판정 포함 RR](saved-result.json)
- [추출 메타데이터](metadata.json), [프레임별 원본 RGB/추적 기록](frames.ndjson)
- 저장한 RGB 재분석: \`node scripts/validate-test3-pos.cjs\`
- 전체 추출 재현 명령과 파이프라인 설명: [README](../../README.md#재현-검증)
`;
fs.writeFileSync(path.join(output,"REPORT.md"),markdown);
console.log(JSON.stringify({...report,metadata:undefined,analysisHashes:undefined,windows:undefined,trackingGaps:gaps.length},null,2));
