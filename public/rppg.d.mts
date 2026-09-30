export interface Box { x:number; y:number; width:number; height:number; }
export interface Sample { t:number; r:number; g:number; b:number; }
export interface SignalWindow {start:number; end:number; bpm:number; quality:number; pulse:number[];}
export const SAMPLE_RATE:number;
export function loadFaceMesh():Promise<void>;
export function seekFrame(video:HTMLVideoElement,time:number,signal?:AbortSignal):Promise<void>;
export function pos(samples:Sample[],fs?:number):number[];
export function analyzeSamples(samples:(Sample|null)[]):SignalWindow[];
export class FaceSignalExtractor {
  target:Box|null;
  previousRgb:number[]|null;
  constructor();
  init():Promise<void>;
  detect(video:HTMLVideoElement):Promise<Box[]>;
  select(index:number):void;
  sample(video:HTMLVideoElement,t:number):Promise<Sample|null>;
  close():Promise<void>;
}
