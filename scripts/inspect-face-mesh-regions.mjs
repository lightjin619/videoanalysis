import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const video=path.resolve(root,process.env.QUALITY_VIDEO||"sub1.mp4");
const directory=path.resolve(root,process.env.QUALITY_OUTPUT||`artifacts/${path.parse(video).name}-mesh-quality`);
if(!video.startsWith(root+path.sep)||!directory.startsWith(path.join(root,"artifacts")+path.sep)) throw new Error("Paths must stay in the workspace");
const moduleCode=ts.transpileModule(fs.readFileSync(path.join(root,"lib/faceMesh.ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const html=`<!doctype html><video src="/video" muted preload="auto"></video><script type="module">
import {FaceLandmarker,FilesetResolver} from '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import {createFaceMesh,skinPolygons,polygonArea,hasUsableSkinRegions} from '/mesh.js';
window.inspectRegions=async()=>{
  const video=document.querySelector('video');
  const wait=event=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(event+' timed out')),20000);video.addEventListener(event,()=>{clearTimeout(timer);resolve();},{once:true});});
  if(video.readyState<2) await wait('loadeddata');
  const vision=await FilesetResolver.forVisionTasks('/public/mediapipe/wasm');
  const model=await FaceLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:'/public/models/face_landmarker.task',delegate:'GPU'},runningMode:'VIDEO',numFaces:5,minFaceDetectionConfidence:.5,minFacePresenceConfidence:.6,minTrackingConfidence:.6});
  const rows=[];
  try{
    for(let t=0;t<video.duration;t+=60){
      if(t>0){const done=wait('seeked');video.currentTime=t;await done;}
      const faces=model.detectForVideo(video,t*1000+1).faceLandmarks.flatMap((points,id)=>{const mesh=createFaceMesh(points,id);return mesh?[mesh]:[];});
      rows.push({t,faces:faces.map(mesh=>{
        const polygons=skinPolygons(mesh.points),areaFractions=polygons.map(p=>polygonArea(p)/(mesh.box.width*mesh.box.height));
        const inside=polygons.map(p=>p.every(point=>point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1));
        const cheekRatio=areaFractions[1]/areaFractions[2];
        return {box:mesh.box,areaFractions,inside,cheekRatio,usable:hasUsableSkinRegions(mesh),
          rejectedBy:{area:areaFractions.map(a=>a<.008),bounds:inside.map(a=>!a),cheekRatio:cheekRatio<=.25||cheekRatio>=4}};
      })});
    }
    return {videoDuration:video.duration,skinRegions:['forehead','cheek1','cheek2'],minimumAreaFraction:.008,cheekRatioRange:[.25,4],rows};
  }finally{model.close();}
};</script>`;
const server=http.createServer((req,res)=>{
  const url=decodeURIComponent(req.url.split('?')[0]);
  if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(url==='/mesh.js'){res.setHeader('Content-Type','text/javascript');res.end(moduleCode);return;}
  if(url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file=url==='/video'?video:path.resolve(root,'.'+url);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const size=fs.statSync(file).size,range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),size-1):size-1;
  res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.mp4':'video/mp4','.mov':'video/quicktime'})[path.extname(file).toLowerCase()]||'application/octet-stream');
  res.setHeader('Accept-Ranges','bytes');
  if(range){res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);}
  res.setHeader('Content-Length',end-start+1);fs.createReadStream(file,{start,end}).pipe(res);
});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof window.inspectRegions==='function',{polling:100});
  const result=await page.evaluate(()=>window.inspectRegions());
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'region-audit.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
