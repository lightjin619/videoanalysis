// Shared browser rPPG pipeline. Invalid samples split runs; gaps are never joined.
export const SAMPLE_RATE = 30;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const boxOf = points => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return {x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs)-Math.min(...xs), height: Math.max(...ys)-Math.min(...ys)};
};
const iou = (a, b) => {
  const w = Math.max(0, Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x));
  const h = Math.max(0, Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return w*h / Math.max(1e-9, a.width*a.height+b.width*b.height-w*h);
};
export class FaceSignalExtractor {
  constructor() {
    this.mesh = null;
    this.faces = [];
    this.target = null;
    this.canvas = document.createElement("canvas");
    this.previousRgb = null;
  }
  async init() {
    if (this.mesh) return;
    // Both the Next page and standalone page supply this pinned MediaPipe constructor.
    this.mesh = new window.FaceMesh({locateFile: file =>
      "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/" + file});
    this.mesh.setOptions({maxNumFaces: 4, refineLandmarks: false,
      minDetectionConfidence: 0.7, minTrackingConfidence: 0.7});
    this.mesh.onResults(result => { this.faces = result.multiFaceLandmarks || []; });
    try { await this.mesh.initialize(); }
    catch(error) { await this.mesh.close(); this.mesh=null; throw error; }
  }
  async detect(video) {
    await this.init();
    this.faces = [];
    await this.mesh.send({image: video});
    return this.faces.map(boxOf);
  }
  select(index) {
    this.target = this.faces[index] ? boxOf(this.faces[index]) : null;
    this.previousRgb = null;
  }
  async sample(video, t) {
    const boxes = await this.detect(video);
    if (!this.target || !boxes.length) { this.previousRgb = null; return null; }
    const scores = boxes.map(b => iou(this.target, b));
    const index = scores.indexOf(Math.max(...scores));
    if (scores[index] < 0.45) { this.previousRgb = null; return null; }
    const face = this.faces[index], box = boxes[index];
    // Reject clipped/small faces and strongly turned heads.
    if (box.x < 0 || box.y < 0 || box.x+box.width > 1 || box.y+box.height > 1 ||
        box.width*video.videoWidth < 80 || box.height*video.videoHeight < 80) {
      this.previousRgb = null; return null;
    }
    const eyeMid = (face[33].x + face[263].x) / 2;
    if (Math.abs(face[1].x-eyeMid) > box.width*0.18 ||
        Math.abs(face[33].y-face[263].y) > box.height*0.18) {
      this.previousRgb = null; return null;
    }
    // Match against the previous accepted geometry; a large jump starts a new run.
    const motion = Math.hypot(box.x-this.target.x,box.y-this.target.y) / this.target.width;
    this.target = box;
    if (motion > 0.12) { this.previousRgb = null; return null; }
    const w = Math.min(640, video.videoWidth), h = Math.round(w*video.videoHeight/video.videoWidth);
    this.canvas.width = w; this.canvas.height = h;
    const ctx = this.canvas.getContext("2d", {willReadFrequently:true});
    if (!ctx) return null;
    ctx.drawImage(video,0,0,w,h);
    // Landmark polygons stay inside cheeks/forehead, excluding eyes and mouth.
    const polygons = [[109,10,338,337,299,333,298,301,251,284,332,297,67,103,54,21,71,68,104,69,108],
      [50,101,205,206,203,129,209,49], [280,330,425,426,423,358,429,279]];
    let sums = [0,0,0], count = 0, total = 0;
    for (const indices of polygons) {
      ctx.save();
      ctx.beginPath();
      indices.forEach((id,i) => { const p=face[id]; if(i)ctx.lineTo(p.x*w,p.y*h); else ctx.moveTo(p.x*w,p.y*h); });
      ctx.closePath();
      const b = boxOf(indices.map(id => face[id]));
      const x = clamp(Math.floor(b.x*w),0,w-1), y = clamp(Math.floor(b.y*h),0,h-1);
      const rw = Math.min(w-x,Math.ceil(b.width*w)+1), rh = Math.min(h-y,Math.ceil(b.height*h)+1);
      if (rw<=0 || rh<=0) {ctx.restore();continue;}
      const pixels=ctx.getImageData(x,y,rw,rh).data;
      for(let py=0;py<rh;py+=2) for(let px=0;px<rw;px+=2) {
        if(!ctx.isPointInPath(x+px,y+py))continue;
        total++;
        const k=(py*rw+px)*4, r=pixels[k],g=pixels[k+1],b=pixels[k+2];
        // Reject deep shadows and saturated highlights without a skin-tone threshold.
        if(Math.min(r,g,b)<15 || Math.max(r,g,b)>245)continue;
        sums[0]+=r;sums[1]+=g;sums[2]+=b;count++;
      }
      ctx.restore();
    }
    if(count<100 || count/Math.max(1,total)<0.7) {this.previousRgb=null;return null;}
    const rgb=sums.map(v=>v/count);
    const previous=this.previousRgb;
    this.previousRgb=rgb;
    if(previous && rgb.some((v,i)=>Math.abs(v-previous[i])/previous[i]>0.12))return null;
    return {t,r:rgb[0],g:rgb[1],b:rgb[2]};
  }
  async close() { if(this.mesh) await this.mesh.close(); this.mesh=null; }
}
/** Seek exactly before detection; do not reuse a stale frame after timeout. */
export function seekFrame(video, time, signal) {
  return new Promise((resolve,reject) => {
    if(signal?.aborted){reject(new DOMException("Cancelled","AbortError"));return;}
    if(Math.abs(video.currentTime-time)<0.0001 && video.readyState>=2){resolve();return;}
    const clean=()=>{clearTimeout(timer);video.removeEventListener("seeked",done);video.removeEventListener("error",fail);signal?.removeEventListener("abort",abort);};
    const done=()=>{clean();resolve();};
    const fail=()=>{clean();reject(new Error("비디오 프레임을 읽을 수 없습니다."));};
    const abort=()=>{clean();reject(new DOMException("Cancelled","AbortError"));};
    const timer=setTimeout(fail,10000);
    video.addEventListener("seeked",done,{once:true});video.addEventListener("error",fail,{once:true});
    signal?.addEventListener("abort",abort,{once:true});
    video.currentTime=time;
  });
}
// Standard POS: temporal RGB normalization, orthogonal projection and overlap-add.
export function pos(samples, fs = SAMPLE_RATE) {
  const n=samples.length, length=Math.round(1.6*fs), output=Array(n).fill(0), weights=Array(n).fill(0);
  for(let start=0;start+length<=n;start++){
    const window=samples.slice(start,start+length);
    const means=["r","g","b"].map(k=>mean(window.map(p=>p[k])));
    if(means.some(v=>!Number.isFinite(v)||v<=0))continue;
    const s1=window.map(p=>p.g/means[1]-p.b/means[2]);
    const s2=window.map(p=>-2*p.r/means[0]+p.g/means[1]+p.b/means[2]);
    const denominator=sd(s2);if(denominator<1e-9)continue;
    const alpha=sd(s1)/denominator, h=s1.map((v,i)=>v+alpha*s2[i]), center=mean(h);
    for(let i=0;i<length;i++){output[start+i]+=h[i]-center;weights[start+i]++;}
  }
  return output.map((v,i)=>weights[i]?v/weights[i]:0);
}
/** Only continuous, spectrally qualified 8-second windows become results. */
export function analyzeSamples(samples) {
  const runs=[];let run=[];
  for(const sample of samples) {
    if(!sample || !["t","r","g","b"].every(k=>Number.isFinite(sample[k])) ||
        Math.min(sample.r,sample.g,sample.b)<=0) {if(run.length)runs.push(run);run=[];continue;}
    if(run.length && (sample.t-run[run.length-1].t>1.5/SAMPLE_RATE ||
        sample.t<=run[run.length-1].t)) {runs.push(run);run=[];}
    run.push(sample);
  }
  if(run.length)runs.push(run);
  const windows=[];
  for(const segment of runs) {
    // Resample by actual video time within each run only.
    const uniform=[];let j=0;
    for(let t=segment[0].t;t<=segment[segment.length-1].t+1e-8;t+=1/SAMPLE_RATE){
      while(j+1<segment.length && segment[j+1].t<t)j++;
      const a=segment[j],b=segment[Math.min(j+1,segment.length-1)];
      const f=b.t>a.t?(t-a.t)/(b.t-a.t):0;
      uniform.push({t,r:a.r+(b.r-a.r)*f,g:a.g+(b.g-a.g)*f,b:a.b+(b.b-a.b)*f});
    }
    const pulse=pos(uniform), size=8*SAMPLE_RATE;
    for(let start=0;start+size<=pulse.length;start+=size){
      const raw=pulse.slice(start,start+size), center=mean(raw);
      if(sd(raw)<1e-7)continue;
      const x=raw.map((v,i)=>(v-center)*(0.5-0.5*Math.cos(2*Math.PI*i/(size-1))));
      const bins=[];let allPower=0;
      for(let k=1;k<=size/2;k++){
        let re=0,im=0;
        for(let i=0;i<size;i++){const angle=2*Math.PI*k*i/size;re+=x[i]*Math.cos(angle);im-=x[i]*Math.sin(angle);}
        const power=re*re+im*im,f=k*SAMPLE_RATE/size;
        allPower+=power;bins.push({k,f,power,re,im});
      }
      const cardiac=bins.filter(b=>b.f>=0.7 && b.f<=3);
      const peak=cardiac.reduce((a,b)=>b.power>a.power?b:a);
      const peakPower=cardiac.filter(b=>Math.abs(b.k-peak.k)<=1).reduce((s,b)=>s+b.power,0);
      const quality=peakPower/Math.max(1e-12,allPower);
      if(quality<0.5)continue;
      // Reconstruct only cardiac frequencies for the displayed pulse.
      const filtered=raw.map((_,i)=>cardiac.reduce((v,b)=>v+2/size*(b.re*Math.cos(2*Math.PI*b.k*i/size)-b.im*Math.sin(2*Math.PI*b.k*i/size)),0));
      const scale=sd(filtered);if(scale<1e-9)continue;
      windows.push({start:uniform[start].t,end:uniform[start+size-1].t+1/SAMPLE_RATE,
        bpm:peak.f*60,quality,pulse:filtered.map(v=>v/scale)});
    }
  }
  return windows;
}

let faceMeshLoading = null;
export function loadFaceMesh() {
  if(window.FaceMesh)return Promise.resolve();
  if(faceMeshLoading)return faceMeshLoading;
  faceMeshLoading=new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    const timer=setTimeout(()=>fail(),30000);
    const fail=()=>{clearTimeout(timer);script.remove();faceMeshLoading=null;reject(new Error("MediaPipe 모델을 불러오지 못했습니다."));};
    script.src="https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/face_mesh.js";
    script.crossOrigin="anonymous";
    script.onload=()=>{clearTimeout(timer);if(window.FaceMesh)resolve();else fail();};
    script.onerror=fail;
    document.head.appendChild(script);
  });
  return faceMeshLoading;
}
