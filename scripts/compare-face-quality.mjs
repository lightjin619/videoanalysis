import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const videoPath = path.resolve(root, process.env.QUALITY_VIDEO || "sub1.mp4");
assert.ok(videoPath.startsWith(root + path.sep), "test video must be inside the workspace");
const videoName = path.basename(videoPath);
const artifactsRoot = path.join(root, "artifacts");
const output = path.resolve(root, process.env.QUALITY_OUTPUT || `artifacts/${path.parse(videoName).name}-mesh-quality`);
assert.ok(output.startsWith(artifactsRoot + path.sep), "results must be inside artifacts");
fs.mkdirSync(output, { recursive: true });
const fps = Number(process.env.QUALITY_FPS || 15);
const boxOnly = process.env.QUALITY_BOX_ONLY === '1';
const maxSeconds = Number(process.env.QUALITY_MAX_SECONDS || 0);
assert.ok(fps >= 10 && fps <= 30);
const source = name => fs.readFileSync(path.join(root,name),"utf8");
const compile = code => ts.transpileModule(code, { compilerOptions: { module:ts.ModuleKind.ES2022, target:ts.ScriptTarget.ES2022 } }).outputText;
const pageSource = source("app/projects/[projectId]/analyses/[analysisId]/page.tsx");
const helperSource = pageSource.slice(pageSource.indexOf("const DETECTION_INTERVAL_MS"),pageSource.indexOf("export default function"));
// Recreate the immediately preceding adaptive-box implementation, including its
// original absolute-distance association gate and 48px upper-face rectangle.
const baselineHelpers = helperSource
  .replace("const RECOVERY_MATCH_DISTANCE = 1;","const RECOVERY_MATCH_DISTANCE = 0.4;")
  .replace("centerDistance(candidate, previous) / Math.max(previous.width, previous.height, 0.01)","centerDistance(candidate, previous)")
  .replace("RECOVERY_MATCH_DISTANCE : 0.65","RECOVERY_MATCH_DISTANCE : 0.24")
  .replace("sizeRatio >= 0.4 && (iou >= 0.15 || distance <= maximumDistance)","(iou >= 0.08 || distance <= maximumDistance)");
const recoveryHelper = helperSource.slice(helperSource.indexOf("function findTrackedFace("))
  .replace("function findTrackedFace(","function findRecoveryFace(")
  .replaceAll("RECOVERY_MATCH_DISTANCE","1");
const posSource = source("lib/posSignal.ts");
const rawStart = posSource.indexOf("function calculateContinuousPosSignal(");
const rawEnd = posSource.indexOf("export function calculatePulseSignalFromSamples",rawStart);
const rawFunction = posSource.slice(rawStart,rawEnd)
  .replace("function calculateContinuousPosSignal(data: RgbPoint[]): PosResult | null", "export function calculateRawPosSignal(data: RgbPoint[])")
  .replace(/return calculatePulseSignalFromSamples\([\s\S]*?\);\s*}\s*$/, "return { signal: samples.map((sample, index) => ({ t: sample.t, value: combined[index] })), sampleRate };\n}\n");
assert.ok(rawFunction.includes("return { signal:"),"raw POS diagnostic must bypass all final waveform filters");
const posModule = compile(posSource + "\n" + rawFunction + "\nexport { splitContinuousSegments, fft, nextPowerOfTwo };\n");
const modules = {
  "/mesh.js": compile(source("lib/faceMesh.ts")),
  "/box.js": compile(source("lib/faceTracking.ts")),
  "/pos.js": posModule,
};
const html = `<!doctype html><meta charset="utf-8"><video id="video" src="/quality-video" muted preload="auto"></video>
<script type="module">
import { FaceDetector, FaceLandmarker, FilesetResolver } from '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import { smoothFaceBox, isConsistentFaceMove } from '/box.js';
import { FACE_OVAL, skinPolygons, createFaceMesh, matchFaceMesh, smoothFaceMesh, meshDisplacement, hasUsableSkinRegions, createSkinMask } from '/mesh.js';
${compile(boxOnly ? helperSource : baselineHelpers)}
${compile(recoveryHelper)}
const fps = ${fps};
const video = document.querySelector('video');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d',{willReadFrequently:true});
function event(name) {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => reject(new Error('Video '+name+' timed out')),20000);
    video.addEventListener(name,() => {clearTimeout(timer);resolve();},{once:true});
  });
}
async function seek(t) {
  if (Math.abs(video.currentTime-t)<0.00001 && video.readyState>=2) return;
  const done=event('seeked'); video.currentTime=t; await done;
}
function detectBoxes(result) {
  return result.detections.flatMap((d,id) => {
    const b=d.boundingBox; if (!b) return [];
    const left=Math.max(0,b.originX), top=Math.max(0,b.originY);
    const right=Math.min(video.videoWidth,b.originX+b.width), bottom=Math.min(video.videoHeight,b.originY+b.height);
    return right>left && bottom>top ? [{id,x:left/video.videoWidth,y:top/video.videoHeight,
      width:(right-left)/video.videoWidth,height:(bottom-top)/video.videoHeight,confidence:d.categories[0]?.score??0}] : [];
  });
}
function sampleBox(face,t) {
  const x=Math.floor(face.x*video.videoWidth),y=Math.floor(face.y*video.videoHeight);
  const w=Math.min(Math.max(1,Math.floor(face.width*video.videoWidth)),video.videoWidth-x);
  const h=Math.min(Math.max(1,Math.floor(face.height*video.videoHeight)),video.videoHeight-y);
  canvas.width=canvas.height=48;
  ctx.drawImage(video,x+Math.floor(w*.15),y+Math.floor(h*.12),Math.max(1,Math.floor(w*.7)),Math.max(1,Math.floor(h*.58)),0,0,48,48);
  const pixels=ctx.getImageData(0,0,48,48).data,channels=[[],[],[]];
  for(let i=0;i<pixels.length;i+=4) for(let c=0;c<3;c++) channels[c].push(pixels[i+c]);
  return {t,r:trimmedMean(channels[0]),g:trimmedMean(channels[1]),b:trimmedMean(channels[2])};
}
function sampleMesh(mesh,t) {
  const b=mesh.box;
  canvas.width=canvas.height=96;
  ctx.drawImage(video,b.x*video.videoWidth,b.y*video.videoHeight,b.width*video.videoWidth,b.height*video.videoHeight,0,0,96,96);
  const pixels=ctx.getImageData(0,0,96,96).data,mask=createSkinMask(mesh,96,96);
  const regions=Array.from({length:3},() => [[],[],[]]);
  for(let i=0;i<mask.length;i++) if(mask[i]>=0) for(let c=0;c<3;c++) regions[mask[i]][c].push(pixels[i*4+c]);
  if(regions.some(region => region[0].length<32)) return null;
  const rgb=regions.map(region => region.map(trimmedMean));
  return {t,r:rgb.reduce((s,p)=>s+p[0],0)/3,g:rgb.reduce((s,p)=>s+p[1],0)/3,b:rgb.reduce((s,p)=>s+p[2],0)/3,
    regions:rgb.map(p=>({t,r:p[0],g:p[1],b:p[2]})),pixelCounts:regions.map(r=>r[0].length)};
}
function updateBox(state,boxes,t) {
  if(t-state.lastDetection<0.08-1e-8) return;
  const elapsed=state.lastDetection<0 ? 0.08 : t-state.lastDetection;
  state.lastDetection=t;
  const match=findTrackedFace(boxes,${boxOnly ? 'state.pending??state.box' : 'state.box'},state.misses>=3);
  state.stable=false;state.motion=false;state.sampleBox=null;
  if(!match) {state.misses++;state.outliers=0;state.pending=null;state.reason=boxes.length?'unmatched':'no-face';return;}
  state.misses=0;
  if(isRoiMotionOutlier(state.box,match)) {
    state.outliers=state.pending && isConsistentFaceMove(state.pending,match) ? state.outliers+1 : 1;
    state.pending=match;state.reason='motion';
    if(${boxOnly}) {state.motion=true;state.sampleBox={...match,id:state.box.id};}
    if(state.outliers>5) {state.box={...match,id:state.box.id};state.outliers=0;state.pending=null;}
  } else {state.box=smoothFaceBox(state.box,match,elapsed);state.outliers=0;state.pending=null;state.stable=true;}
}
function updateMesh(state,candidates,boxes,t,smoothing) {
  const previous=state.box,recovering=state.misses>=3;
  const reference=state.pending?.box??previous;
  let match=matchFaceMesh(candidates,reference,recovering && candidates.length===1);
  // Match the analysis page recovery detector gate (face-relative distance).
  if(!match && recovering && candidates.length===1 && t-state.lastRecovery>=0.08-1e-8) {
    state.lastRecovery=t;
    const recovered=findRecoveryFace(boxes,previous,true);
    if(recovered) match=matchFaceMesh(candidates,{...recovered,id:previous.id});
  }
  const dt=state.lastTime===null ? 1/30 : t-state.lastTime;state.lastTime=t;
  state.stable=false;
  if(!match) {state.misses++;state.outliers=0;state.pending=null;state.reason=candidates.length?'unmatched':'no-face';return;}
  const outlier=state.mesh && (isRoiMotionOutlier(previous,match.box)||meshDisplacement(state.mesh,match)>0.35);
  if(outlier) {
    state.outliers=state.pending && isConsistentFaceMove(state.pending.box,match.box) && meshDisplacement(state.pending,match)<0.15 ? state.outliers+1 : 1;
    state.pending=match;state.reason='motion';
    if(state.outliers>5) {state.mesh=match;state.box=match.box;state.pending=null;state.outliers=0;}
  } else {
    const filtered=state.mesh && !recovering && smoothing ? smoothFaceMesh(state.mesh,match,dt) : match;
    state.mesh=filtered;state.box=filtered.box;state.pending=null;state.outliers=0;
    state.stable=hasUsableSkinRegions(match)&&hasUsableSkinRegions(filtered)&&!recovering;state.reason='motion';
  }
  state.misses=0;
}
window.scan = async () => {
  if(video.readyState<2) await event('loadeddata');
  const vision=await FilesetResolver.forVisionTasks('/public/mediapipe/wasm');
  let delegate=${JSON.stringify(process.env.QUALITY_DELEGATE||"GPU")};
  let detector,landmarker;
  const modelStarted=performance.now();
  try {
    detector=await FaceDetector.createFromOptions(vision,{baseOptions:{modelAssetPath:'/public/models/blaze_face_short_range.tflite',delegate},runningMode:'VIDEO',minDetectionConfidence:0.5,minSuppressionThreshold:0.3});
    if(!${boxOnly}) landmarker=await FaceLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:'/public/models/face_landmarker.task',delegate},runningMode:'VIDEO',numFaces:5,minFaceDetectionConfidence:0.5,minFacePresenceConfidence:0.6,minTrackingConfidence:0.6});
    const duration=Math.min(video.duration,${maxSeconds}||video.duration),count=Math.ceil(duration*fps);
    const metadata={video:${JSON.stringify(videoName)},nativeDuration:video.duration,duration,width:video.videoWidth,height:video.videoHeight,fps,delegate,
      sampling:'seek decoded video at shared timestamps; media-time detector cadence; not a live playback throughput test',
      baseline:${JSON.stringify(boxOnly ? 'current restored adaptive box; 48px rectangular ROI; 80ms media-time detector cadence; mesh not executed' : 'adaptive box immediately before mesh implementation; 48px rectangular ROI; 80ms detector cadence')},
      modes:['box','meshRaw','mesh'],modelInitMs:performance.now()-modelStarted};
    await window.saveMetadata(metadata);
    let states=null,chunk=[],boxes=[],lastBoxTime=-1;
    const timings={seek:[],detector:[],mesh:[],sampling:[]};
    const scanStart=performance.now();
    for(let index=0;index<count;index++) {
      const t=index/fps;
      let started=performance.now();await seek(t);timings.seek.push(performance.now()-started);
      started=performance.now();
      if(t-lastBoxTime>=0.08-1e-8) {boxes=detectBoxes(detector.detectForVideo(video,index*1000/fps+1));lastBoxTime=t;timings.detector.push(performance.now()-started);}
      started=performance.now();const candidates=landmarker ? landmarker.detectForVideo(video,index*1000/fps+1).faceLandmarks.flatMap((points,id)=>{const m=createFaceMesh(points,id);return m?[m]:[];}) : [];if(landmarker) timings.mesh.push(performance.now()-started);
      if(!states && boxes.length) {
        const selected=[...boxes].sort((a,b)=>b.confidence-a.confidence)[0];
        const initial=()=>({box:selected,mesh:null,pending:null,misses:0,outliers:0,stable:false,reason:'unmatched',lastDetection:-1,lastRecovery:-1,lastTime:null});
        states={box:initial(),meshRaw:initial(),mesh:initial()};
        metadata.selectionTime=t;metadata.selectionBox=selected;
      }
      const row={index,t,faces:boxes.length,meshes:candidates.length,modes:{}};
      started=performance.now();
      if(states) {
        updateBox(states.box,boxes,t);
        if(landmarker) {
          updateMesh(states.meshRaw,candidates,boxes,t,false);
          updateMesh(states.mesh,candidates,boxes,t,true);
        }
        for(const [name,state] of Object.entries(states)) {
          const motion=name==='box' && ${boxOnly} && !!state.motion;
          const collect=state.stable || motion;
          const sample=collect ? name==='box' ? sampleBox(motion ? state.sampleBox : state.box,t) : sampleMesh(state.mesh,t) : null;
          row.modes[name]={status:sample?'collected':collect?'read-failed':state.reason,motion,rgb:sample,box:state.box};
        }
      } else for(const name of metadata.modes) row.modes[name]={status:'no-face',rgb:null};
      timings.sampling.push(performance.now()-started);chunk.push(row);
      if([0,10,15,30,60,300,600,900,1200].some(seconds=>index===Math.round(seconds*fps))) {
        const preview=document.createElement('canvas');preview.width=600;preview.height=Math.round(300*video.videoHeight/video.videoWidth);
        const pc=preview.getContext('2d');
        for(let col=0;col<2;col++) {
          const name=col===0?'box':'mesh',state=states?.[name];
          pc.drawImage(video,col*300,0,300,preview.height);
          pc.save();pc.translate(col*300,0);pc.scale(300,preview.height);pc.lineWidth=2/300;
          if(state && row.modes[name].status==='collected') {
            pc.strokeStyle=col===0?'#f59e0b':'#10b981';
            const b=state.box;
            if(col===0) pc.strokeRect(b.x+b.width*.15,b.y+b.height*.12,b.width*.7,b.height*.58);
            else for(const polygon of [FACE_OVAL.map(i=>state.mesh.points[i]),...skinPolygons(state.mesh.points)]) {
              pc.beginPath();polygon.forEach((p,i)=>i?pc.lineTo(p.x,p.y):pc.moveTo(p.x,p.y));pc.closePath();pc.stroke();
            }
          }
          pc.restore();pc.fillStyle='#000b';pc.fillRect(col*300,0,300,28);pc.fillStyle='white';pc.font='14px sans-serif';pc.fillText(name+' '+t.toFixed(1)+'s: '+row.modes[name].status,col*300+6,19);
        }
        await window.savePreview(t,preview.toDataURL('image/png'));
      }
      if(chunk.length>=fps*30 || index===count-1) {
        await window.saveChunk(chunk);chunk=[];
        console.log('PROGRESS '+JSON.stringify({frame:index+1,total:count,seconds:t,duration,wallSeconds:(performance.now()-scanStart)/1000}));
      }
    }
    metadata.wallSeconds=(performance.now()-scanStart)/1000;
    const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)]};};
    metadata.timingsMs=Object.fromEntries(Object.entries(timings).map(([name,values])=>[name,summary(values)]));
    await window.saveMetadata(metadata);
    return metadata;
  } finally {detector?.close();landmarker?.close();}
};
</script>`;

async function scan() {
  assert.ok(fs.existsSync(videoPath));
  const server=http.createServer((req,res)=>{
    const url=decodeURIComponent(req.url.split("?")[0]);
    if(url==="/") {res.setHeader("Content-Type","text/html");res.end(html);return;}
    if(url==="/favicon.ico") {res.writeHead(204);res.end();return;}
    if(modules[url]) {res.setHeader("Content-Type","text/javascript");res.end(modules[url]);return;}
    const file=url==="/quality-video" ? videoPath : path.resolve(root,"."+url);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) {res.writeHead(404);res.end();return;}
    const size=fs.statSync(file).size;
    res.setHeader("Content-Type",({".mjs":"text/javascript",".js":"text/javascript",".wasm":"application/wasm",".mp4":"video/mp4",".mov":"video/quicktime"})[path.extname(file).toLowerCase()]||"application/octet-stream");
    res.setHeader("Accept-Ranges","bytes");
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),size-1):size-1;
    if(start>=size||start>end) {res.writeHead(416);res.end();return;}
    if(range) {res.statusCode=206;res.setHeader("Content-Range",`bytes ${start}-${end}/${size}`);}
    res.setHeader("Content-Length",end-start+1);fs.createReadStream(file,{start,end}).pipe(res);
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true,protocolTimeout:3600000});
    const page=await browser.newPage();
    page.on("pageerror",e=>console.error(e.message));
    page.on("console",m=>{if(m.text().startsWith("PROGRESS ")) console.log(m.text());});
    fs.writeFileSync(path.join(output,"frames.ndjson"),"");
    await page.exposeFunction("saveChunk",rows=>fs.appendFileSync(path.join(output,"frames.ndjson"),rows.map(row=>JSON.stringify(row)).join("\n")+"\n"));
    await page.exposeFunction("savePreview",(t,data)=>fs.writeFileSync(path.join(output,"frame-"+t+"s.png"),Buffer.from(data.split(',')[1],"base64")));
    const files=["scripts/compare-face-quality.mjs","lib/faceMesh.ts","lib/faceTracking.ts","lib/posSignal.ts","app/projects/[projectId]/analyses/[analysisId]/page.tsx"];
    const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash("sha256").update(source(file)).digest("hex")]));
    await page.exposeFunction("saveMetadata",metadata=>fs.writeFileSync(path.join(output,"metadata.json"),JSON.stringify({...metadata,sourceHashes:hashes,videoBytes:fs.statSync(videoPath).size},null,2)));
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>typeof window.scan==="function",{polling:100});
    console.log("Starting full paired scan");
    const metadata=await page.evaluate(()=>window.scan());
    console.log("Scan completed",JSON.stringify(metadata.timingsMs));
  } finally {if(browser) await browser.close();await new Promise(resolve=>server.close(resolve));}
}

// Analysis is implemented below; --analyze reuses the checkpointed frame data.
const posUrl="data:text/javascript;base64,"+Buffer.from(posModule).toString("base64");
const pos=await import(posUrl);
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const quantile=(values,q)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);const at=(sorted.length-1)*q,lo=Math.floor(at);return sorted[lo]+(sorted[Math.ceil(at)]-sorted[lo])*(at-lo);};
const std=values=>{const avg=mean(values);return Math.sqrt(mean(values.map(v=>(v-avg)**2)));};
function spectrum(values,rate) {
  const n=pos.nextPowerOfTwo(values.length*4),real=Array(n).fill(0),imag=Array(n).fill(0),avg=mean(values);
  values.forEach((v,i)=>real[i]=(v-avg)*0.5*(1-Math.cos(2*Math.PI*i/(values.length-1))));
  pos.fft(real,imag);
  return real.slice(1,n/2).map((r,i)=>({f:(i+1)*rate/n,p:r*r+imag[i+1]*imag[i+1]}));
}
function quality(values,rate) {
  const bins=spectrum(values,rate).filter(b=>b.f>=0.8&&b.f<=4);
  const total=bins.reduce((s,b)=>s+b.p,0);
  if(total<1e-24)return null;
  const peak=bins.reduce((a,b)=>b.p>a.p?b:a);
  const near=bins.filter(b=>Math.abs(b.f-peak.f)<=0.1).reduce((s,b)=>s+b.p,0);
  const entropy=-bins.reduce((s,b)=>{const p=b.p/total;return s+(p>0?p*Math.log(p):0);},0)/Math.log(bins.length);
  const lag=Math.round(rate/peak.f),avg=mean(values);
  let cross=0,left=0,right=0;
  for(let i=lag;i<values.length;i++) {const a=values[i]-avg,b=values[i-lag]-avg;cross+=a*b;left+=a*a;right+=b*b;}
  return {peakBpm:peak.f*60,peakConcentration:near/total,peakToRestDb:10*Math.log10(near/Math.max(total-near,1e-24)),
    entropy,periodCorrelation:cross/Math.sqrt(left*right),edgePeak:peak.f<0.9||peak.f>3.9};
}
function summarizeWindows(windows) {
  const valid=windows.filter(w=>w.quality);
  const summary={windows:windows.length,validWindows:valid.length};
  for(const key of ["peakConcentration","peakToRestDb","entropy","periodCorrelation","peakBpm"]) {
    const values=valid.map(w=>w.quality[key]);summary[key]={median:quantile(values,.5),p25:quantile(values,.25),p75:quantile(values,.75)};
  }
  summary.edgePeakFraction=mean(valid.map(w=>Number(w.quality.edgePeak)));
  // Preserve original indices for adjacent valid windows with gaps.
  const adjacent=[];
  for(let i=1;i<valid.length;i++) if(valid[i].start-valid[i-1].start<=15.001) adjacent.push(Math.abs(valid[i].quality.peakBpm-valid[i-1].quality.peakBpm));
  summary.hrAdjacentChangeBpm={median:quantile(adjacent,.5),p95:quantile(adjacent,.95),jumpsOver15:adjacent.filter(v=>v>15).length,pairs:adjacent.length};
  return summary;
}
function analyze() {
  const metadata=JSON.parse(fs.readFileSync(path.join(output,"metadata.json"),"utf8"));
  const rows=fs.readFileSync(path.join(output,"frames.ndjson"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(rows.length,Math.ceil(metadata.duration*metadata.fps),"full scan must finish before reporting full-video results");
  if (boxOnly) {
    const collected = rows.filter(row => row.modes.box.rgb);
    const rgb = collected.map(row => row.modes.box.rgb);
    const result = pos.calculatePosSignal(rgb);
    const report = {metadata, frames:rows.length, rgbSamples:rgb.length, coverage:rgb.length/rows.length,
      motionFrames:rows.some(row=>'motion' in row.modes.box) ? rows.filter(row=>row.modes.box.motion).length : null,
      statuses:Object.fromEntries(['collected','no-face','unmatched','motion','read-failed'].map(status => [status,rows.filter(row => row.modes.box.status === status).length])),
      sampleRate:result?.sampleRate ?? null,heartRate:result?.heartRate ?? null,pulseSamples:result?.signal.length ?? 0,
      limitation:'Offline timestamp sampling, not live throughput or pulse accuracy validation; mesh modes were not executed.'};
    fs.writeFileSync(path.join(output,'box-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    return;
  }
  const names=metadata.modes;
  const summaries={},windowsByMode={},rawByMode={};
  for(const name of names) {
    const rgb=rows.flatMap(row=>row.modes[name].rgb?[row.modes[name].rgb]:[]);
    const segments=pos.splitContinuousSegments(rgb);
    const raw=segments.flatMap(segment=>pos.calculateRawPosSignal(segment)?.signal??[]);
    rawByMode[name]=raw;
    const windows=[];
    for(let start=0;start+15<=metadata.duration+1e-6;start+=15) {
      const local=rgb.filter(p=>p.t>=start&&p.t<start+15);
      const coverage=local.length/(15*metadata.fps);
      const gaps=local.slice(1).map((p,i)=>p.t-local[i].t);
      const usable=coverage>=.9&&local.length>=20&&Math.max(0,...gaps)<=.5
        &&local[0]?.t-start<=.25&&start+15-local.at(-1)?.t<=.25;
      const projected=usable?pos.calculateRawPosSignal(local):null;
      const q=projected?quality(projected.signal.map(p=>p.value),projected.sampleRate):null;
      windows.push({start,end:start+15,coverage,quality:q});
    }
    windowsByMode[name]=windows;
    const result=pos.calculatePosSignal(rgb);
    const colorJumps=[];
    for(let i=1;i<rgb.length;i++) if(rgb[i].t-rgb[i-1].t<1.5/metadata.fps) {
      colorJumps.push(Math.sqrt(["r","g","b"].reduce((sum,c)=>sum+((rgb[i][c]-rgb[i-1][c])/rgb[i-1][c])**2,0)/3)*100);
    }
    const statuses=Object.fromEntries(["collected","no-face","unmatched","motion","read-failed"].map(status=>[status,rows.filter(row=>row.modes[name].status===status).length]));
    const hrs=result?.heartRateWindows?.filter(w=>!w.reusedPrevious).map(w=>w.heartRate)??[];
    summaries[name]={samples:rgb.length,coverage:rgb.length/rows.length,statuses,segments:segments.map(s=>({start:s[0]?.t,end:s.at(-1)?.t,samples:s.length})),
      rgbJumpPercent:{median:quantile(colorJumps,.5),p95:quantile(colorJumps,.95)},rawQuality:summarizeWindows(windows),
      pipeline:{heartRate:result?.heartRate??null,heartRateWindowStd:hrs.length?std(hrs):null,pulseSamples:result?.signal.length??0,
        hrv:result?.hrv??null,heartRateWindows:result?.heartRateWindows??[]}};
  }
  const paired=[];
  for(let i=0;i<windowsByMode.box.length;i++) {
    const entries=Object.fromEntries(names.map(name=>[name,windowsByMode[name][i]]));
    if(entries.box.quality && entries.mesh.quality) paired.push({start:entries.box.start,box:entries.box.quality,mesh:entries.mesh.quality});
  }
  const pairedSummary=Object.fromEntries(["box","mesh"].map(name=>[name,summarizeWindows(paired.map(row=>({start:row.start,quality:row[name]})))]));
  const deltas=paired.map(row=>({start:row.start,peakToRestDb:row.mesh.peakToRestDb-row.box.peakToRestDb,
    concentration:row.mesh.peakConcentration-row.box.peakConcentration,entropy:row.mesh.entropy-row.box.entropy,
    periodCorrelation:row.mesh.periodCorrelation-row.box.periodCorrelation,hrDifferenceBpm:row.mesh.peakBpm-row.box.peakBpm}));
  const commonFrames=rows.filter(row=>row.modes.box.rgb && row.modes.mesh.rgb);
  const pairedColorJumps={box:[],mesh:[]};
  for(let i=1;i<commonFrames.length;i++) if(commonFrames[i].t-commonFrames[i-1].t<1.5/metadata.fps) {
    for(const name of ["box","mesh"]) {
      const before=commonFrames[i-1].modes[name].rgb,after=commonFrames[i].modes[name].rgb;
      pairedColorJumps[name].push(Math.sqrt(["r","g","b"].reduce((s,c)=>s+((after[c]-before[c])/before[c])**2,0)/3)*100);
    }
  }
  const shortPaired=[];
  let run=[];
  const flush=()=>{
    const size=Math.round(5*metadata.fps);
    for(let i=0;i+size<=run.length;i+=size) {
      const local=run.slice(i,i+size),q={};
      for(const name of ["box","mesh"]) {
        const projected=pos.calculateRawPosSignal(local.map(row=>row.modes[name].rgb));
        q[name]=projected?quality(projected.signal.map(p=>p.value),projected.sampleRate):null;
      }
      if(q.box && q.mesh) shortPaired.push({start:local[0].t,box:q.box,mesh:q.mesh});
    }
    run=[];
  };
  for(const row of commonFrames) {
    if(run.length && row.t-run.at(-1).t>1.5/metadata.fps) flush();
    run.push(row);
  }
  flush();
  const comparison={pairedWindows:paired.length,commonFrames:commonFrames.length,
    medianPeakToRestDeltaDb:quantile(deltas.map(p=>p.peakToRestDb),.5),
    medianConcentrationDelta:quantile(deltas.map(p=>p.concentration),.5),
    medianEntropyDelta:quantile(deltas.map(p=>p.entropy),.5),
    medianPeriodCorrelationDelta:quantile(deltas.map(p=>p.periodCorrelation),.5),
    improvedPeakRatioWindowFraction:mean(deltas.map(p=>Number(p.peakToRestDb>0))),
    medianAbsoluteHrDifferenceBpm:quantile(deltas.map(p=>Math.abs(p.hrDifferenceBpm)),.5),
    coverageDeltaPercentagePoints:(summaries.mesh.coverage-summaries.box.coverage)*100,
    pairedRgbJumpPercent:Object.fromEntries(["box","mesh"].map(name=>[name,{median:quantile(pairedColorJumps[name],.5),p95:quantile(pairedColorJumps[name],.95),pairs:pairedColorJumps[name].length}])),
    pairedSummary,
    exploratory5SecondWindows:{count:shortPaired.length,medianPeakToRestDeltaDb:quantile(shortPaired.map(p=>p.mesh.peakToRestDb-p.box.peakToRestDb),.5),
      medianEntropyDelta:quantile(shortPaired.map(p=>p.mesh.entropy-p.box.entropy),.5),
      medianPeriodCorrelationDelta:quantile(shortPaired.map(p=>p.mesh.periodCorrelation-p.box.periodCorrelation),.5),
      caveat:'Only short common continuous runs; weaker spectral resolution and selection bias. Does not replace the primary 15-second comparison.',windows:shortPaired}};
  const report={metadata,analysisSourceHash:crypto.createHash("sha256").update(source("scripts/compare-face-quality.mjs")).digest("hex"),
    modelHashes:Object.fromEntries(["public/models/blaze_face_short_range.tflite","public/models/face_landmarker.task"].map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(path.join(root,file))).digest("hex")])),
    metrics:{windowSeconds:15,requiredCoverage:.9,pulseBandHz:[.8,4],peakHalfWidthHz:.1,
    stage:'raw POS projection before bandpass and narrow HR refinement',
    caveat:'peak-to-rest ratio is a self-selected spectral concentration proxy, NOT ground-truth SNR. Periodic motion can also score well. No synchronized sensor reference was found.',
    largeImprovementRule:'median paired peak-to-rest delta >=3 dB AND entropy decreases AND period correlation increases; coverage loss <=5 percentage points. Operational screening rule, not a clinical threshold.'},
    summaries,comparison,windowsByMode,pairedDeltas:deltas};
  report.largeImprovementObserved=paired.length>=10&&comparison.medianPeakToRestDeltaDb>=3&&comparison.medianEntropyDelta<0
    &&comparison.medianPeriodCorrelationDelta>0&&comparison.coverageDeltaPercentagePoints>=-5;
  fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(output,"raw-pos.json"),JSON.stringify(rawByMode));
  console.log(JSON.stringify({report:path.join(output,"report.json"),largeImprovementObserved:report.largeImprovementObserved,
    samples:Object.fromEntries(names.map(name=>[name,{coverage:summaries[name].coverage,rawQuality:summaries[name].rawQuality}])),comparison},null,2));
  return report;
}
function selfTest() {
  const rate=15;
  let seed=123456;
  const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32-.5;};
  const clean=Array.from({length:15*rate},(_,i)=>Math.sin(2*Math.PI*1.2*i/rate));
  const noisy=clean.map(value=>value+random()*8);
  const a=quality(clean,rate),b=quality(noisy,rate);
  assert.ok(Math.abs(a.peakBpm-72)<1);
  assert.ok(a.peakConcentration>b.peakConcentration);
  assert.ok(a.entropy<b.entropy);
  assert.ok(a.periodCorrelation>b.periodCorrelation);
  assert.ok(quality(Array(225).fill(1),rate)===null);
  const rgb=clean.map((p,i)=>({t:i/rate,r:100+p*.1,g:100+p,b:100-p*.2}));
  const projected=pos.calculateRawPosSignal(rgb);
  assert.ok(projected && Math.abs(quality(projected.signal.map(p=>p.value),rate).peakBpm-72)<1);
  assert.equal(pos.splitContinuousSegments([...rgb.slice(0,80),...rgb.slice(100)]).length,2);
  console.log('Quality metric validation passed: known pulse, added noise, flat signal, raw POS, tracking gaps.');
}
if(process.argv.includes("--self-test")) selfTest();
else {
  if(!process.argv.includes("--analyze")) await scan();
  analyze();
}
