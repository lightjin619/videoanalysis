import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const meshModule = ts.transpileModule(fs.readFileSync(path.join(root, "lib/faceMesh.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const videoPath = path.resolve(root, process.env.MESH_TEST_VIDEO || "sub1.mp4");
assert.ok(videoPath.startsWith(root + path.sep) && fs.existsSync(videoPath), "test video must exist inside the workspace");
const html = `<!doctype html><video id="video" src="/test-video" muted preload="auto"></video><canvas id="canvas"></canvas>
<script type="module">
import { FaceLandmarker, FaceDetector, FilesetResolver } from '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import * as mesh from '/mesh.js';
window.scan = async () => {
  const video = document.querySelector('video');
  const wait = event => new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Video timed out: '+event)), 15000);
    video.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  if (video.readyState < 2) await wait('loadeddata');
  const vision = await FilesetResolver.forVisionTasks('/public/mediapipe/wasm');
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: '/public/models/face_landmarker.task', delegate: ${JSON.stringify(process.env.MESH_DELEGATE || "CPU")} },
    runningMode: 'VIDEO', numFaces: 5, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
  });
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: '/public/models/blaze_face_short_range.tflite', delegate: 'CPU' }, runningMode: 'VIDEO',
  });
  let tracked = null, first = null;
  const rows = [];
  try {
    for (let frame=0; frame<30; frame++) {
      const time = frame/10;
      if (time >= video.duration) break;
      if (time > 0) { const done=wait('seeked'); video.currentTime=time; await done; }
      const candidates = landmarker.detectForVideo(video, frame*100+1).faceLandmarks.flatMap((points,id) => {
        const candidate = mesh.createFaceMesh(points,id); return candidate ? [candidate] : [];
      });
      if (!tracked) {
        const detection = detector.detectForVideo(video, frame*100+1).detections[0]?.boundingBox;
        if (detection) tracked = mesh.matchFaceMesh(candidates, {
          id: 42, x: detection.originX/video.videoWidth, y: detection.originY/video.videoHeight,
          width: detection.width/video.videoWidth, height: detection.height/video.videoHeight, confidence: 1,
        });
      } else {
        const match = mesh.matchFaceMesh(candidates, tracked.box);
        tracked = match ? mesh.smoothFaceMesh(tracked, match, 0.1) : null;
      }
      if (tracked) first ||= tracked;
      const mask = tracked ? mesh.createSkinMask(tracked,96,96) : [];
      const pixels = [0,1,2].map(region => Array.from(mask).filter(value => value === region).length);
      rows.push({ time, faces:candidates.length, matched: !!tracked, usable: tracked && mesh.hasUsableSkinRegions(tracked), pixels });
    }
    if (!first) throw new Error('No selected mesh detected');
    const translated = (dx,dy=0) => mesh.createFaceMesh(first.points.map(p => ({...p,x:p.x+dx,y:p.y+dy})), 9);
    const nearby = translated(0.003), distant = translated(0.5);
    if (mesh.matchFaceMesh([distant,first],first.box)?.box.id !== 42) throw new Error('Selection changed with result ordering');
    if (mesh.matchFaceMesh([first,nearby],first.box) !== null) throw new Error('Ambiguous faces accepted');
    if (mesh.matchFaceMesh([distant],first.box) !== null) throw new Error('Distant face accepted');
    if (mesh.createFaceMesh(first.points.slice(0,100),0) !== null) throw new Error('Incomplete mesh accepted');
    const offscreen = translated(1);
    if (offscreen && mesh.hasUsableSkinRegions(offscreen)) throw new Error('Offscreen skin accepted');
    let filtered = first, rawEnergy=0, filteredEnergy=0;
    for (let i=0;i<120;i++) {
      const jitter=(i%2 ? 1 : -1)*0.001;
      filtered=mesh.smoothFaceMesh(filtered,translated(jitter),1/30);
      rawEnergy+=jitter*jitter;
      filteredEnergy+=(filtered.points[10].x-first.points[10].x)**2;
    }
    if (filteredEnergy >= rawEnergy*0.2) throw new Error('Insufficient jitter suppression');
    const move = first.box.width*0.2;
    filtered=first;
    for(let i=0;i<15;i++) filtered=mesh.smoothFaceMesh(filtered,translated(move),1/30);
    if (Math.abs(filtered.points[10].x-first.points[10].x-move)>move*0.15) throw new Error('Real movement response too slow');
    const checks = ['selection order','ambiguous match','distant face','incomplete mesh','offscreen regions','jitter','movement'];
    return { rows, checks, jitterEnergyRatio: filteredEnergy/rawEnergy };
  } finally { landmarker.close(); detector.close(); }
};
</script>`;
const server = http.createServer((req,res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url === "/") { res.setHeader("Content-Type","text/html"); res.end(html); return; }
  if (url === "/mesh.js") { res.setHeader("Content-Type","text/javascript"); res.end(meshModule); return; }
  const file = url === "/test-video" ? videoPath : path.resolve(root, "."+url);
  if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(file).size;
  const mime = { ".js":"text/javascript", ".mjs":"text/javascript", ".wasm":"application/wasm", ".mp4":"video/mp4" }[path.extname(file)] || "application/octet-stream";
  res.setHeader("Content-Type",mime);
  res.setHeader("Accept-Ranges","bytes");
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]),size-1) : size-1;
  if (range) { res.statusCode=206; res.setHeader("Content-Range",`bytes ${start}-${end}/${size}`); }
  res.setHeader("Content-Length",end-start+1);
  fs.createReadStream(file,{start,end}).pipe(res);
});
let browser;
try {
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage();
  page.on("requestfailed", request => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") console.error("Request failed:", request.url(), request.failure()?.errorText);
  });
  page.on("pageerror", error => console.error(error.message));
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  console.log("Opening local mesh test page");
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
  console.log("Loading mesh test module");
  await page.waitForFunction(() => typeof window.scan === "function", { polling: 100 });
  console.log("Scanning test video");
  const result = await page.evaluate(() => window.scan());
  assert.ok(result.rows.filter(row => row.usable && row.pixels.every(count => count >= 32)).length >= result.rows.length*0.8, "at least 80% of test frames must have three usable skin regions");
  console.log(JSON.stringify({
    frames: result.rows.length,
    usableFrames: result.rows.filter(row => row.usable && row.pixels.every(count => count >= 32)).length,
    minimumRegionPixels: [0,1,2].map(i => Math.min(...result.rows.map(row => row.pixels[i]))),
    checks: result.checks,
    jitterEnergyRatio: result.jitterEnergyRatio,
  },null,2));
  if (process.env.MESH_APP_URL) {
    const appPage = await browser.newPage();
    const errors = [];
    appPage.on("pageerror", error => errors.push(error.message));
    await appPage.evaluateOnNewDocument(() => {
      const now = new Date().toISOString();
      localStorage.setItem("video-analysis-local-account",JSON.stringify({ username:"mesh-test",salt:"test",passwordHash:"test" }));
      sessionStorage.setItem("video-analysis-auth-session","mesh-test");
      localStorage.setItem("video-analysis-projects",JSON.stringify([{id:"mesh-test",name:"Mesh test",description:"",createdAt:now}]));
      localStorage.setItem("video-analysis-items",JSON.stringify([{id:"mesh-test",projectId:"mesh-test",name:"Mesh test",description:"",createdAt:now,updatedAt:now}]));
    });
    await appPage.goto(process.env.MESH_APP_URL + "/projects/mesh-test/analyses/mesh-test",{waitUntil:"domcontentloaded",timeout:60000});
    await appPage.waitForSelector('input[type="file"]');
    await (await appPage.$('input[type="file"]')).uploadFile(videoPath);
    await appPage.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    await appPage.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Detect Faces").click());
    await appPage.waitForSelector('.face-box');
    await appPage.click('.face-box');
    await appPage.evaluate(() => {
      window.meshUpdates = 0;
      const observer = new MutationObserver(records => {
        window.meshUpdates += records.filter(record => record.target.classList?.contains('face-mesh-contour')).length;
      });
      observer.observe(document.querySelector('.face-overlay-layer'), { subtree:true, attributes:true, attributeFilter:['points'] });
    });
    await appPage.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Analyze Selected Person").click());
    await appPage.waitForSelector('.face-mesh-overlay',{timeout:60000});
    assert.equal(await appPage.$$eval('.face-mesh-region',regions => regions.length),3);
    await appPage.waitForFunction(() => window.meshUpdates >= 30,{timeout:10000}).catch(async error => {
      console.error(await appPage.evaluate(() => ({ updates:window.meshUpdates, status:document.querySelector('.analysis-status')?.textContent,
        video:{time:document.querySelector('video')?.currentTime,paused:document.querySelector('video')?.paused,ended:document.querySelector('video')?.ended},
        mesh:!!document.querySelector('.face-mesh-overlay') })));
      throw error;
    });
    await appPage.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Stop Analysis").click());
    await appPage.waitForFunction(() => !document.querySelector('.face-mesh-overlay'));
    assert.deepEqual(errors,[],"analysis page must not have runtime errors");
    const counts = await appPage.$$eval('.collection-coverage tbody tr',rows => rows.map(row => [...row.querySelectorAll('td')].map(td => td.textContent)));
    assert.ok(counts.reduce((sum,row) => sum+Number(row[2]),0) >= 20,"page must collect actual RGB samples from the mesh");
    console.log("Analysis page mesh overlay, RGB sampling and stop checks passed:",counts.filter(row => Number(row[1]) > 0));
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
