"use client";
import { useEffect, useRef, useState, ChangeEvent } from "react";
import { useParams } from "next/navigation";
import { useProjects } from "@/hooks/useProjects";
import AnalysisRangeBar from "@/components/AnalysisRangeBar";
import RgbLiveChart, { RgbPoint } from "@/components/RgbLiveChart";
import { FaceSignalExtractor, seekFrame, analyzeSamples, SAMPLE_RATE, loadFaceMesh } from "@/public/rppg.mjs";

interface FaceBox { id: number; x: number; y: number; width: number; height: number; }
type Result = ReturnType<typeof analyzeSamples>[number];

export default function VideoAnalysisPage() {
  const params = useParams<{ projectId: string }>();
  const { projects, isLoaded } = useProjects();
  const project = projects.find(p => p.id === params.projectId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const extractorRef = useRef<FaceSignalExtractor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const taskRef = useRef<Promise<void>>(Promise.resolve());
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const sourceRef = useRef<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState({start:0,end:0});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDetectingFaces, setIsDetectingFaces] = useState(false);
  const [faceBoxes, setFaceBoxes] = useState<FaceBox[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<number | null>(null);
  const [rgbData, setRgbData] = useState<RgbPoint[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [status, setStatus] = useState("비디오를 불러오고 분석할 얼굴을 선택하세요.");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      const extractor = extractorRef.current;
      extractorRef.current = null;
      void taskRef.current.then(() => extractor?.close()).catch(console.error);
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
    };
  }, []);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || busyRef.current) return;
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
    sourceRef.current = URL.createObjectURL(file);
    setVideoSrc(sourceRef.current);
    setDuration(0);setRange({start:0,end:0});setRgbData([]);setResults([]);
    setFaceBoxes([]);setSelectedFaceId(null);
    if (extractorRef.current) extractorRef.current.target = null;
    setStatus("얼굴 검출 버튼을 눌러 분석할 얼굴을 선택하세요.");
  };
  const handleLoadedMetadata = () => {
    const value=videoRef.current?.duration || 0;
    if(Number.isFinite(value)){setDuration(value);setRange({start:0,end:value});}
  };
  const getExtractor = async () => {
    await loadFaceMesh();
    if (!extractorRef.current) extractorRef.current = new FaceSignalExtractor();
    return extractorRef.current;
  };
  const perform = (analyzing: boolean, operation: (signal: AbortSignal) => Promise<void>) => {
    if(busyRef.current)return;
    busyRef.current=true;
    const controller=new AbortController();abortRef.current=controller;
    setIsAnalyzing(analyzing);setIsDetectingFaces(!analyzing);
    taskRef.current=(async()=>{
      try { await operation(controller.signal); }
      catch(error) {
        if(mountedRef.current) {
          setResults([]);setRgbData([]);
          setStatus(controller.signal.aborted ? "분석을 취소했습니다." :
            "분석 실패: " + (error instanceof Error ? error.message : String(error)));
        }
      } finally {
        busyRef.current=false;
        if(mountedRef.current){setIsAnalyzing(false);setIsDetectingFaces(false);}
      }
    })();
  };
  const handleDetectFaces = () => perform(false, async signal => {
    const video=videoRef.current;if(!video)return;
    video.pause();setFaceBoxes([]);setSelectedFaceId(null);setResults([]);setRgbData([]);
    await seekFrame(video,range.start,signal);
    const extractor=await getExtractor();
    if(signal.aborted)throw new DOMException("Cancelled","AbortError");
    const boxes=await extractor.detect(video);
    if(signal.aborted)return;
    setFaceBoxes(boxes.map((box,id)=>({...box,id})));
    // Multiple faces always require an explicit selection.
    if(boxes.length===1){extractor.select(0);setSelectedFaceId(0);}else extractor.target=null;
    setStatus(boxes.length ? "분석할 얼굴 박스를 선택하고 분석을 시작하세요." : "얼굴을 찾지 못했습니다. 구간 시작점을 조정하세요.");
  });
  const startAnalysis = () => {
    if(selectedFaceId===null || range.end-range.start<8) {
      setStatus("얼굴을 선택하고 최소 8초의 분석 구간을 지정하세요.");return;
    }
    perform(true,async signal=>{
      const video=videoRef.current;if(!video)return;
      video.pause();setResults([]);setRgbData([]);
      const extractor=await getExtractor();
      extractor.previousRgb=null;
      const samples: (RgbPoint | null)[]=[];
      let accepted=0;
      // Offline fixed-time sampling prevents playback/detection latency from dropping frames.
      for(let i=0;range.start+i/SAMPLE_RATE<range.end;i++){
        if(signal.aborted)throw new DOMException("Cancelled","AbortError");
        const t=range.start+i/SAMPLE_RATE;
        await seekFrame(video,t,signal);
        const sample=await extractor.sample(video,t);
        if(signal.aborted)throw new DOMException("Cancelled","AbortError");
        samples.push(sample);
        if(sample)accepted++;
        if(i%30===0 && mountedRef.current){
          setFaceBoxes(extractor.target?[{...extractor.target,id:selectedFaceId}]:[]);
          setStatus(`프레임 검사 ${(t-range.start).toFixed(1)}/${(range.end-range.start).toFixed(1)}초 · 유효 RGB ${accepted}/${samples.length}`);
        }
      }
      const valid=analyzeSamples(samples);
      if(!mountedRef.current || signal.aborted)return;
      setResults(valid);
      // Do not draw RGB lines across rejected spans; show the first qualified window only.
      const first=valid[0];
      setRgbData(first?samples.filter((s): s is RgbPoint=>!!s && s.t>=first.start && s.t<first.end):[]);
      setStatus(valid.length ? `완료 · 유효 분석 ${valid.length}개 구간 / ${valid.length*8}초 · RGB 추출 ${accepted}/${samples.length}프레임` :
        "분석 가능한 연속 신호가 없습니다. 얼굴 검출·조명·움직임을 확인하세요.");
    });
  };
  if (!isLoaded) {
    return <p>프로젝트 정보를 불러오는 중입니다…</p>;
  }

  if (!project) {
    return <p>프로젝트를 찾을 수 없습니다.</p>;
  }

  return (
    <div className="video-page">
      <h2>{project.name}</h2>
      <p className="project-desc">{project.description}</p>

      <div className="top-bar">
        <label className="file-button">
          비디오 파일 불러오기
          <input
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={handleFileChange}
            disabled={isAnalyzing || isDetectingFaces}
          />
        </label>

        <button
          className="secondary-button"
          disabled={!videoSrc || !duration || isDetectingFaces || isAnalyzing}
          onClick={handleDetectFaces}
        >
          {isDetectingFaces ? "얼굴 검출 중..." : "얼굴 검출 & 선택"}
        </button>

        <button
          className="primary-button"
          disabled={!videoSrc || !duration || isAnalyzing || isDetectingFaces || selectedFaceId === null}
          onClick={startAnalysis}
        >
          {isAnalyzing ? "분석 중..." : "분석 시작"}
        </button>
      </div>

      <div className="video-layout">
        <div className="video-preview">
          {videoSrc ? (
            <>
              <video
                ref={videoRef}
                src={videoSrc}
                controls={!isAnalyzing && !isDetectingFaces}
                onLoadedMetadata={handleLoadedMetadata}
              />
              {/* 얼굴 박스 오버레이 */}
              {faceBoxes.map((box) => (
                <div
                  key={box.id}
                  className={
                    "face-box" +
                    (box.id === selectedFaceId ? " face-box-selected" : "")
                  }
                  style={{
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.width * 100}%`,
                    height: `${box.height * 100}%`,
                  }}
                  onClick={() => { if (!isAnalyzing && !isDetectingFaces) { extractorRef.current?.select(box.id); setSelectedFaceId(box.id); } }}
                  title="이 얼굴 선택"
                />
              ))}
            </>
          ) : (
            <div className="video-placeholder">
              비디오를 업로드하면 프리뷰가 표시됩니다.
            </div>
          )}
        </div>

        <AnalysisRangeBar
          duration={duration}
          start={range.start}
          end={range.end}
          onChange={(next) => { if (!isAnalyzing && !isDetectingFaces) { setRange(next); setResults([]); setRgbData([]); } }}
        />
      </div>

      <p role="status">{status}</p>
      {isAnalyzing && <button onClick={() => abortRef.current?.abort()}>분석 취소</button>}
      <RgbLiveChart data={rgbData} />
      <p>얼굴·RGB 품질 검사를 통과한 연속 8초 구간만 표시합니다. 검출 실패 구간을 연결하지 않습니다.</p>
      {results.map((result, index) => (
        <div key={index}>
          <p>{result.start.toFixed(2)}–{result.end.toFixed(2)}초 · 추정 심박수 {result.bpm.toFixed(1)} BPM · 신호 집중도 {(result.quality * 100).toFixed(0)}%</p>
          <svg viewBox="0 0 600 100" width="100%" height="100" role="img" aria-label="유효 구간 POS 파형">
            <polyline fill="none" stroke="#34d399" strokeWidth="1.5"
              points={result.pulse.map((value, i) => `${i * 600 / (result.pulse.length - 1)},${50 - Math.max(-4, Math.min(4, value)) * 10}`).join(" ")} />
          </svg>
        </div>
      ))}

      {/* 프레임 RGB 추출용 숨겨진 캔버스 */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
