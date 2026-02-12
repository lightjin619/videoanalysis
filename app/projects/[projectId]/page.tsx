"use client";

import {
  useEffect,
  useRef,
  useState,
  ChangeEvent,
} from "react";
import { useParams } from "next/navigation";
import { useProjects } from "@/hooks/useProjects";
import AnalysisRangeBar from "@/components/AnalysisRangeBar";
import RgbLiveChart, { RgbPoint } from "@/components/RgbLiveChart";

interface FaceBox {
  id: number;
  x: number; // 0~1
  y: number; // 0~1
  width: number; // 0~1
  height: number; // 0~1
}

export default function VideoAnalysisPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const { projects, isLoaded } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [range, setRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [rgbData, setRgbData] = useState<RgbPoint[]>([]);
  const animIdRef = useRef<number | null>(null);

  // MediaPipe Face Detection 관련 상태
  const faceDetectionRef = useRef<any | null>(null);
  const [faceBoxes, setFaceBoxes] = useState<FaceBox[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<number | null>(null);
  const [isDetectingFaces, setIsDetectingFaces] = useState(false);

  // 비디오 파일 로드
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoSrc) {
      URL.revokeObjectURL(videoSrc);
    }
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setRgbData([]);
    setIsAnalyzing(false);
    setFaceBoxes([]);
    setSelectedFaceId(null);
  };

  // 메타데이터 로드 후 duration 설정
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setRange({ start: 0, end: video.duration });
  };

  // MediaPipe FaceDetection 초기화
  const initFaceDetection = async () => {
    if (faceDetectionRef.current) return;

    const mp: any = await import("@mediapipe/face_detection");
    const faceDetection = new mp.FaceDetection({
      locateFile: (file: string) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
    });

    faceDetection.setOptions({
      modelSelection: 0, // 0: short-range, 1: full-range
      minDetectionConfidence: 0.5,
    });

    faceDetection.onResults((results: any) => {
      const detections = results.detections || [];
      const boxes: FaceBox[] = detections.map(
        (det: any, idx: number): FaceBox => {
          const bbox = det.locationData.relativeBoundingBox;
          return {
            id: idx,
            x: bbox.xMin,
            y: bbox.yMin,
            width: bbox.width,
            height: bbox.height,
          };
        }
      );

      setFaceBoxes(boxes);
      setSelectedFaceId(boxes.length ? boxes[0].id : null);
      setIsDetectingFaces(false);
    });

    faceDetectionRef.current = faceDetection;
  };

  // 현재 프레임에서 얼굴 검출
  const detectFacesAtCurrentFrame = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.videoWidth || !video.videoHeight) return;

    setIsDetectingFaces(true);
    await initFaceDetection();

    // 비디오 일시정지 상태에서 현재 프레임 기준으로 검출
    video.pause();

    try {
      await faceDetectionRef.current.send({ image: video });
    } catch (err) {
      console.error("Face detection failed:", err);
      setIsDetectingFaces(false);
    }
  };

  // 분석 구간 시작점에서 얼굴 검출 (버튼에서 호출)
  const handleDetectFaces = async () => {
    const video = videoRef.current;
    if (!video || !duration) return;

    setFaceBoxes([]);
    setSelectedFaceId(null);

    // 분석 시작 구간으로 시킹
    if (Math.abs(video.currentTime - range.start) > 0.05) {
      const onSeeked = async () => {
        video.removeEventListener("seeked", onSeeked);
        await detectFacesAtCurrentFrame();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = range.start;
    } else {
      await detectFacesAtCurrentFrame();
    }
  };

  // 선택된 얼굴 ROI 또는 전체 프레임에서 RGB 샘플링
  const sampleFrameRgb = () => {
    const video = videoRef.current;
    const canvas = hiddenCanvasRef.current;
    if (!video || !canvas) return null;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, w, h);

    const selectedFace = faceBoxes.find((b) => b.id === selectedFaceId);

    let imageData: ImageData;

    if (selectedFace) {
      const x = Math.max(0, Math.floor(selectedFace.x * w));
      const y = Math.max(0, Math.floor(selectedFace.y * h));
      const roiW = Math.min(w - x, Math.floor(selectedFace.width * w));
      const roiH = Math.min(h - y, Math.floor(selectedFace.height * h));

      imageData = ctx.getImageData(x, y, roiW, roiH);
    } else {
      // 얼굴 선택이 안 되어 있으면 전체 프레임 평균
      imageData = ctx.getImageData(0, 0, w, h);
    }

    const data = imageData.data;
    const pixelCount = imageData.width * imageData.height;

    let rSum = 0;
    let gSum = 0;
    let bSum = 0;

    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }

    return {
      r: rSum / pixelCount,
      g: gSum / pixelCount,
      b: bSum / pixelCount,
    };
  };

  // 분석 루프
  const analysisLoop = () => {
    const video = videoRef.current;
    if (!video) return;

    if (!isAnalyzing) return;

    if (video.currentTime >= range.end || video.paused || video.ended) {
      video.pause();
      setIsAnalyzing(false);
      return;
    }

    const rgb = sampleFrameRgb();
    if (rgb) {
      setRgbData((prev) => [
        ...prev,
        {
          t: video.currentTime,
          r: rgb.r,
          g: rgb.g,
          b: rgb.b,
        },
      ]);
    }

    animIdRef.current = window.requestAnimationFrame(analysisLoop);
  };

  // 분석 시작 버튼
  const startAnalysis = () => {
    const video = videoRef.current;
    if (!video || !duration) return;

    // 얼굴 미선택 시, 경고 (그래도 전체 프레임으로 분석할 수 있게 허용)
    if (!selectedFaceId && faceBoxes.length > 0) {
      const ok = window.confirm(
        "얼굴이 여러 개 검출되었지만 선택된 얼굴이 없습니다. 전체 프레임으로 분석할까요?"
      );
      if (!ok) return;
    }

    video.currentTime = range.start;
    setRgbData([]);
    setIsAnalyzing(true);
    video.play();
  };

  // requestAnimationFrame 관리
  useEffect(() => {
    if (isAnalyzing) {
      animIdRef.current = window.requestAnimationFrame(analysisLoop);
    } else if (animIdRef.current !== null) {
      window.cancelAnimationFrame(animIdRef.current);
    }

    return () => {
      if (animIdRef.current !== null) {
        window.cancelAnimationFrame(animIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnalyzing, range.start, range.end, selectedFaceId, faceBoxes.length]);

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
          />
        </label>

        <button
          className="secondary-button"
          disabled={!videoSrc || !duration || isDetectingFaces}
          onClick={handleDetectFaces}
        >
          {isDetectingFaces ? "얼굴 검출 중..." : "얼굴 검출 & 선택"}
        </button>

        <button
          className="primary-button"
          disabled={!videoSrc || !duration}
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
                controls
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
                  onClick={() => setSelectedFaceId(box.id)}
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
          onChange={setRange}
        />
      </div>

      <RgbLiveChart data={rgbData} />

      {/* 프레임 RGB 추출용 숨겨진 캔버스 */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
