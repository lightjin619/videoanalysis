import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSamples, FaceSignalExtractor } from "../public/rppg.mjs";
const fixture = (n=600) => Array.from({length:n},(_,i) => {
  const v=Math.sin(2*Math.PI*1.25*i/30);
  return {t:i/30,r:100+0.3*v,g:90+v,b:80+0.1*v};
});
test("POS recovers a known 75 BPM chromatic pulse",()=>{
  const windows=analyzeSamples(fixture());
  assert.equal(windows.length,2);
  for(const w of windows){assert.equal(w.bpm,75);assert.ok(w.quality>0.9);assert.ok(w.pulse.every(Number.isFinite));}
});
test("no-face samples split runs instead of joining both sides of a gap",()=>{
  const samples=fixture();samples[210]=null;
  const windows=analyzeSamples(samples);
  assert.equal(windows.length,1);
  assert.ok(windows.every(w=>w.start>7));
});
test("timestamps also split missing frames without an explicit null",()=>{
  const samples=fixture().filter((_,i)=>i!==210);
  assert.ok(analyzeSamples(samples).every(w=>w.start>7));
});
test("flat RGB, invalid RGB, and short valid runs produce no result",()=>{
  assert.equal(analyzeSamples(fixture().map(p=>({...p,r:100,g:90,b:80}))).length,0);
  assert.equal(analyzeSamples(fixture().map(p=>({...p,g:NaN}))).length,0);
  assert.equal(analyzeSamples(fixture(239)).length,0);
  assert.equal(analyzeSamples(fixture().map(p=>({...p,r:0}))).length,0);
});
test("large timestamp gaps and reversed time never create an artificial window",()=>{
  assert.equal(analyzeSamples(fixture(239).concat(fixture(239).map(p=>({...p,t:p.t+20})))).length,0);
  assert.equal(analyzeSamples(fixture(239).concat(fixture(239))).length,0);
});
test("no face / unmatched face never reads full-frame RGB",async()=>{
  const previousDocument=globalThis.document;
  globalThis.document={createElement:()=>({getContext:()=>{throw new Error("must not sample");}})};
  try {
    const extractor=new FaceSignalExtractor();
    extractor.target={x:0.1,y:0.1,width:0.2,height:0.2};
    extractor.previousRgb=[100,90,80];
    extractor.detect=async()=>[];
    assert.equal(await extractor.sample({},0),null);
    assert.equal(extractor.previousRgb,null);
    extractor.detect=async()=>[{x:0.7,y:0.7,width:0.2,height:0.2}];
    assert.equal(await extractor.sample({},1),null);
  } finally {globalThis.document=previousDocument;}
});
