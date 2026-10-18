import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const videoName=path.basename(process.env.QUALITY_VIDEO || "sub1.mp4");
const directory=path.resolve(root,process.env.QUALITY_OUTPUT || `artifacts/${path.parse(videoName).name}-mesh-quality`);
if (!directory.startsWith(path.join(root,"artifacts")+path.sep)) throw new Error("Report must be inside artifacts");
const report=JSON.parse(fs.readFileSync(path.join(directory,"report.json"),"utf8"));
const raw=JSON.parse(fs.readFileSync(path.join(directory,"raw-pos.json"),"utf8"));
const rows=fs.readFileSync(path.join(directory,"frames.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
const modes=["box","meshRaw","mesh"];
const labels={box:"박스 + 보정",meshRaw:"메쉬 (보정 없음)",mesh:"메쉬 + 보정"};
const pct=value=>value===null?"측정 불가":(value*100).toFixed(1)+"%";
const number=(value,digits=2)=>value===null||value===undefined?"측정 불가":value.toFixed(digits);
const c=report.comparison;
const longEnough=c.pairedWindows>=10;
const conclusion=report.summaries.mesh.samples===0
  ? "현재 설정에서는 메쉬 방식으로 분석 신호를 생성하지 못했습니다. 모든 프레임이 제외되어 품질 향상을 평가할 수 없습니다."
  : report.largeImprovementObserved
  ? "정의한 신호 품질 지표에서 큰 개선이 관찰되었습니다. 센서 기준 정확도 검증은 별도로 필요합니다."
  : c.coverageDeltaPercentagePoints < -5
    ? "현재 설정에서 큰 신호 품질 향상을 확인하지 못했습니다. 메쉬 방식에서 유효 샘플 손실이 더 큽니다."
    : "현재 설정에서 큰 신호 품질 향상을 확인하지 못했습니다.";
const coverageBins=Array.from({length:Math.ceil(report.metadata.duration/15)},(_,i)=>{
  const local=rows.filter(row=>row.t>=i*15&&row.t<Math.min((i+1)*15,report.metadata.duration));
  return {start:i*15,end:Math.min((i+1)*15,report.metadata.duration),...Object.fromEntries(modes.map(name=>[name,local.filter(row=>row.modes[name].rgb).length/local.length*100]))};
});
const data={report,raw,coverageBins};
const plotlyPath=path.join(directory,"plotly.min.js");
if (!fs.existsSync(plotlyPath)) fs.copyFileSync(path.join(root,"artifacts/sub1-mesh-quality/plotly.min.js"),plotlyPath);
const plotly=fs.readFileSync(plotlyPath,"utf8");
const htmlVideo=report.metadata.video.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const previews=(report.metadata.duration>=1200?[15,600,1200]:[15,300,600]).filter(t=>fs.existsSync(path.join(directory,`frame-${t}s.png`))).map(t=>({t,image:fs.readFileSync(path.join(directory,`frame-${t}s.png`)).toString("base64")}));
const regionAuditPath=path.join(directory,"region-audit.json");
const regionAudit=fs.existsSync(regionAuditPath)?JSON.parse(fs.readFileSync(regionAuditPath,"utf8")):null;
const areaRejected=regionAudit?.rows.filter(row=>row.faces.some(face=>face.rejectedBy.area.some(Boolean))).length;
const areaAuditText=regionAudit?`추가 영역 검사 ${regionAudit.rows.length}개 시점 중 ${areaRejected}개에서 볼 또는 이마 면적 조건 미달을 확인했습니다. 각 피부 영역이 얼굴 면적의 최소 ${(regionAudit.minimumAreaFraction*100).toFixed(1)}% 이상이어야 하는 현재 조건을 사용했습니다.`:"";
const reproduceVideo=report.metadata.video.replaceAll("'","''");
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlVideo} 메쉬 추적 신호 품질 비교</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#182638;background:#f3f6fa}main{max-width:1150px;margin:32px auto;padding:0 22px}
h1{font-size:27px}h2{font-size:20px;margin-top:32px}p{line-height:1.7}.lead{padding:20px;background:white;border-left:5px solid #176a75;border-radius:8px;font-size:18px}
.meta{color:#536278}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:12px;border-bottom:1px solid #dde4ee}th{background:#eaf0f6}
.chart{background:white;border-radius:10px;margin:20px 0;padding:4px}select{padding:8px;font-size:15px}details{background:white;padding:16px;margin:20px 0}
.note{padding:15px;background:#e7eef6;border-radius:8px}a{color:#176a75}img{max-width:100%}.gallery{display:flex;gap:12px;flex-wrap:wrap}.gallery figure{margin:0;width:260px}.gallery img{width:100%}figcaption{font-size:13px;color:#536278}
@media(max-width:650px){main{padding:0 12px}table{font-size:12px}th,td{padding:8px}}
</style><main>
<h1>${htmlVideo}: 박스 방식과 메쉬 방식의 신호 품질 비교</h1>
<p class="lead">${conclusion}</p>
<p class="meta">영상 전체 ${report.metadata.duration.toFixed(2)}초 · ${report.metadata.width} × ${report.metadata.height} · 동일한 ${report.metadata.fps} FPS 검사 프레임 ${rows.length.toLocaleString()}개 · ${report.metadata.delegate} · 로컬 브라우저 분석</p>
<table><thead><tr><th>방식</th><th>유효 RGB 샘플</th><th>유효 샘플 비율</th><th>메쉬/얼굴 미검출</th><th>ROI·움직임 제외</th></tr></thead><tbody>
${modes.map(name=>{const s=report.summaries[name];return `<tr><td>${labels[name]}</td><td>${s.samples.toLocaleString()}</td><td>${pct(s.coverage)}</td><td>${s.statuses["no-face"].toLocaleString()}</td><td>${s.statuses.motion.toLocaleString()}</td></tr>`;}).join("")}
</tbody></table>
<p>15초 기준 공통 유효 구간: <strong>${c.pairedWindows}개</strong>. 각 방식 모두 90% 이상의 샘플이 있고 긴 누락이 없는 동일한 구간만 주 비교에 사용했습니다.</p>
${regionAudit?`<p class="note">${areaAuditText}</p>`:""}
<div class="chart" id="coverage"></div>
<h2>신호 품질 지표</h2>
<p class="note">기준 센서 신호가 없으므로 아래 값은 정확도나 실제 SNR이 아닌 자체 품질 지표입니다. 주파수 집중도는 주기적인 움직임에도 높아질 수 있습니다. 최종 파형의 좁은 심박 필터를 적용하기 전 POS 신호를 사용했습니다.</p>
<table><thead><tr><th>공통 15초 구간 중앙값</th><th>박스 + 보정</th><th>메쉬 + 보정</th></tr></thead><tbody>
${[
  ["주파수 피크 주변 에너지 비율",s=>pct(s?.peakConcentration?.median)],
  ["피크 주변/나머지 대역 전력비 (dB)",s=>number(s?.peakToRestDb?.median)],
  ["정규화 스펙트럼 엔트로피 (낮을수록 집중)",s=>number(s?.entropy?.median,3)],
  ["추정 주기에서의 상관 (높을수록 주기적)",s=>number(s?.periodCorrelation?.median,3)],
].map(([label,value])=>`<tr><td>${label}</td><td>${value(c.pairedSummary.box)}</td><td>${value(c.pairedSummary.mesh)}</td></tr>`).join("")}
</tbody></table>
<p>메쉬 − 박스의 구간별 피크 전력비 차이 중앙값: <strong>${number(c.medianPeakToRestDeltaDb)} dB</strong>.
${longEnough?"":"공통 구간이 부족하여 영상 전체의 신호 품질 향상을 판정할 근거가 부족합니다."}</p>
<div class="chart" id="quality"></div><div class="chart" id="hr"></div>
<h2>필터 적용 전 POS 신호 확인</h2>
<p>구간을 바꾸면 동일한 영상 시간의 POS 신호를 비교할 수 있습니다. 각 파형은 표시할 구간 안에서 표준화했고, 데이터가 없는 구간은 연결하지 않았습니다.</p>
<label>영상 구간 <select id="interval">${coverageBins.map(bin=>`<option value="${bin.start}">${bin.start}–${bin.end.toFixed(1)}초</option>`).join("")}</select></label>
<div class="chart" id="wave"></div>
<details><summary>대표 프레임의 분석 영역</summary><div class="gallery">${previews.map(p=>`<figure><img src="data:image/png;base64,${p.image}" alt="${p.t}초 박스 및 메쉬 분석 상태"><figcaption>${p.t}초 · 왼쪽 박스, 오른쪽 메쉬. 제외된 메쉬의 오래된 영역은 표시하지 않았습니다.</figcaption></figure>`).join("")}</div></details>
<details><summary>검사 조건과 해석 범위</summary>
<p>박스 기준은 메쉬 도입 직전의 적응형 보정과 기존 48 × 48 직사각형 분석 영역입니다. 메쉬 방식은 현재 앱의 96 × 96 얼굴 crop에 이마·양쪽 볼 마스크를 적용합니다. 메쉬 보정 없는 조건도 함께 수집했습니다.</p>
<p>동일한 디코딩 프레임을 시각 순서대로 탐색해 입력했고, 감지 주기는 영상 시간으로 모사했습니다. 실제 재생 시의 처리 속도나 놓치는 프레임 수를 측정한 결과는 아닙니다. 영상 전체 검사와 생리 신호의 정확도 검증은 서로 다른 범위입니다.</p>
<p>15초 구간의 원본 POS 투영 신호에서 0.8–4 Hz 대역을 검사했습니다. 자체 추정 피크 ±0.1 Hz의 에너지와 나머지 에너지의 비, 스펙트럼 엔트로피, 추정 주기에서의 상관을 비교했습니다. +3 dB 이상, 엔트로피 감소, 주기 상관 증가, 유효 비율 손실 5%p 이하를 동시에 만족할 때만 큰 개선으로 분류하도록 사전에 정했습니다. 의학적 기준은 아닙니다.</p>
<p>5초의 공통 연속 구간을 사용한 보조 비교: ${c.exploratory5SecondWindows?.count추가0}개, 피크 전력비 차이 중앙값 ${number(c.exploratory5SecondWindows?.medianPeakToRestDeltaDb)} dB. 짧은 구간의 낮은 주파수 해상도와 선택 편향 때문에 주 비교를 대체할 수 없습니다.</p>
<p>POS 참고: <a href="https://research.tue.nl/en/publications/algorithmic-principles-of-remote-ppg/">Wang et al., Algorithmic principles of remote-PPG</a>. 분석 코드, 원본 RGB 수집 기록, 소스 해시와 전체 수치는 같은 결과 폴더의 JSON/NDJSON 파일에 보관했습니다.</p>
</details>
</main>
<script>${plotly.replaceAll("</script>","<\\/script>")}</script>
<script>
const data=${JSON.stringify(data).replaceAll("<","\\u003c")};
const colors={box:'#c87317',meshRaw:'#808a99',mesh:'#087d8d'};
const labels=${JSON.stringify(labels)};
const names=['box','meshRaw','mesh'];
const config={responsive:true,displaylogo:false,toImageButtonOptions:{format:'png',scale:2}};
const base={font:{family:'system-ui,sans-serif',size:13,color:'#253548'},paper_bgcolor:'white',plot_bgcolor:'white',margin:{l:70,r:20,t:55,b:55},legend:{orientation:'h',y:1.14},hovermode:'x unified',height:360};
const trace=(name,x,y)=>({x,y,name:labels[name],type:'scatter',mode:'lines+markers',line:{color:colors[name],width:2},marker:{size:4},connectgaps:false});
async function draw() {
await Plotly.newPlot('coverage',names.map(name=>trace(name,data.coverageBins.map(b=>(b.start+b.end)/120),data.coverageBins.map(b=>b[name]))),{
  ...base,title:{text:'15초 구간별 유효 RGB 샘플 비율'},xaxis:{title:{text:'영상 시간 (분)'}},yaxis:{title:{text:'유효 비율 (%)'},range:[-3,103]}},config);
await Plotly.newPlot('quality',names.map(name=>trace(name,data.report.windowsByMode[name].map(w=>(w.start+7.5)/60),data.report.windowsByMode[name].map(w=>w.quality?.peakToRestDb??null))),{
  ...base,title:{text:'POS 피크 주변/나머지 대역 전력비 (기준 센서 없는 지표)'},xaxis:{title:{text:'영상 시간 (분)'}},yaxis:{title:{text:'전력비 (dB)'}}},config);
await Plotly.newPlot('hr',names.map(name=>trace(name,data.report.windowsByMode[name].map(w=>(w.start+7.5)/60),data.report.windowsByMode[name].map(w=>w.quality?.peakBpm??null))),{
  ...base,title:{text:'15초 구간별 주파수 피크 기반 심박 추정 (정확도 검증 전)'},xaxis:{title:{text:'영상 시간 (분)'}},yaxis:{title:{text:'추정 심박 (BPM)'},range:[40,245]}},config);
await waveform(0);
window.meshQualityReportReady=true;
}
async function waveform(start) {
  const traces=names.map(name=>{
    const points=data.raw[name].filter(p=>p.t>=start&&p.t<start+15);
    const mean=points.length?points.reduce((s,p)=>s+p.value,0)/points.length:0;
    const sd=Math.sqrt(points.reduce((s,p)=>s+(p.value-mean)**2,0)/Math.max(1,points.length))||1;
    const x=[],y=[];
    points.forEach((p,i)=>{if(i && p.t-points[i-1].t>0.5){x.push(p.t);y.push(null);}x.push(p.t);y.push((p.value-mean)/sd);});
    return {...trace(name,x,y),mode:'lines'};
  });
  await Plotly.react('wave',traces,{...base,title:{text:'원본 POS 투영: '+start+'–'+(start+15)+'초'},
    xaxis:{title:{text:'영상 시간 (초)'},range:[start,start+15]},yaxis:{title:{text:'구간 표준화 값'}}},config);
}
document.querySelector('#interval').addEventListener('change',event=>waveform(Number(event.target.value)));
draw().catch(error=>{console.error(error);window.meshQualityReportError=error.message;});
</script></html>`;
fs.writeFileSync(path.join(directory,"report.html"),html);
const markdown=`# sub1.mp4 메쉬 추적 신호 품질 비교\n\n${conclusion}\n\n${areaAuditText}\n\n영상 전체 ${report.metadata.duration.toFixed(2)}초를 ${report.metadata.fps} FPS, ${rows.length.toLocaleString()}개 동일 프레임으로 비교했습니다. 현재 앱 코드는 검사 중 변경하지 않았습니다.\n\n| 지표 | 박스 + 보정 | 메쉬 + 보정 |\n| --- | ---: | ---: |\n| 유효 RGB 샘플 | ${report.summaries.box.samples} | ${report.summaries.mesh.samples} |\n| 유효 비율 | ${pct(report.summaries.box.coverage)} | ${pct(report.summaries.mesh.coverage)} |\n| 미검출로 제외 | ${report.summaries.box.statuses['no-face']} | ${report.summaries.mesh.statuses['no-face']} |\n| ROI·움직임 조건으로 제외 | ${report.summaries.box.statuses.motion} | ${report.summaries.mesh.statuses.motion} |\n\n공통으로 유효한 15초 구간은 ${c.pairedWindows}개입니다. 원본 POS 신호에서 비교한 피크 전력비 차이 중앙값은 ${number(c.medianPeakToRestDeltaDb)} dB입니다. 공통 데이터의 RGB 프레임 변화량 p95는 박스 ${number(c.pairedRgbJumpPercent?.box.p95,3)}%, 메쉬 ${number(c.pairedRgbJumpPercent?.mesh.p95,3)}%입니다. ${longEnough?'':'주 비교 구간이 부족하여 품질 향상을 확정할 수 없습니다.'}\n\n보조 5초 공통 연속 구간 ${c.exploratory5SecondWindows?.count??0}개에서의 피크 전력비 차이 중앙값: ${number(c.exploratory5SecondWindows?.medianPeakToRestDeltaDb)} dB. 짧은 구간과 선택 편향의 한계가 있습니다.\n\n동기화된 센서 기준 신호가 없어 실제 심박/HRV 정확도나 참 SNR 개선은 검증하지 않았습니다. 주파수 집중도는 움직임에도 높아질 수 있으므로, 최종 좁은 필터를 적용하기 전 신호만 비교했습니다. POS 배경은 [원 논문](https://research.tue.nl/en/publications/algorithmic-principles-of-remote-ppg/)을 참고했습니다.\n\n- [대화형 보고서](report.html): 시간별 유효 비율, 주파수 품질 지표, 심박 추정, 원본 POS 파형\n- [요약 그래프](coverage.png)\n- [상세 수치](report.json)\n- [검사 조건과 소스 해시](metadata.json)\n- [프레임별 RGB와 제외 사유](frames.ndjson)\n\n재현: 프로젝트에서 \`node scripts/compare-face-quality.mjs\`를 실행합니다. 원본 수집 데이터를 다시 분석하려면 \`node scripts/compare-face-quality.mjs --analyze\`를 사용합니다. 품질 지표 자체 검사: \`node scripts/compare-face-quality.mjs --self-test\`. 실제 재생 처리 속도 검사가 아닌 공통 프레임 오프라인 비교입니다.\n`;
fs.writeFileSync(path.join(directory,"REPORT.md"),markdown+`\n영상 지정: 먼저 PowerShell에서 \`$env:QUALITY_VIDEO = '${reproduceVideo}'\`를 설정하면 위 명령이 이 영상을 사용합니다.\n`);
let browser;
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
  const page=await browser.newPage();
  await page.goto('file:///'+path.join(directory,"report.html").replaceAll('\\','/'),{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.meshQualityReportReady||window.meshQualityReportError,{polling:100,timeout:30000});
  const error=await page.evaluate(()=>window.meshQualityReportError);
  if(error) throw new Error(error);
  for(const name of ['coverage','quality','hr']) {
    const png=await page.evaluate(name=>Plotly.toImage(document.getElementById(name),{format:'png',width:1200,height:450,scale:2}),name);
    fs.writeFileSync(path.join(directory,name+'.png'),Buffer.from(png.split(',')[1],"base64"));
  }
  console.log("Standalone report and plots saved:",path.join(directory,"report.html"));
} finally {if(browser) await browser.close();}
