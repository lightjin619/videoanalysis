"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { FaceDetector as FaceDetectorType } from "@mediapipe/tasks-vision";
import { useProjects } from "@/hooks/useProjects";
import AnalysisRangeBar from "@/components/AnalysisRangeBar";
import PulseWaveChart from "@/components/PulseWaveChart";
import AnalysisHistory from "@/components/AnalysisHistory";
import AnalysisCoverage from "@/components/AnalysisCoverage";
import { summarizeAnalysisCoverage, type AnalysisCoverage as Coverage, type AnalysisFrameObservation, type FrameStatus } from "@/lib/analysisCoverage";
import {
  calculatePosSignal,
  POS_SIGNAL_PIPELINE,
  POS_RR_PIPELINE,
  type HrvMetrics,
  type PulsePoint,
  type RgbPoint,
  type RrRecord,
} from "@/lib/posSignal";
import { useAnalysisResults } from "@/hooks/useAnalysisResults";
import { useVideoAnalyses } from "@/hooks/useVideoAnalyses";

import { smoothFaceBox, isConsistentFaceMove, type FaceBox } from "@/lib/faceTracking";


interface VideoContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DETECTION_INTERVAL_MS = 80;
const MAX_CONSECUTIVE_TRACKING_MISSES = 3;
const POS_FACE_SAMPLE_SIZE = 48;
const FACE_DETECTION_CONFIDENCE = 0.5;
const MAX_ROI_CENTER_JUMP_FACE_WIDTHS = 0.55;
const MAX_ROI_AREA_RATIO = 1.6;
const MAX_CONSECUTIVE_ROI_OUTLIERS = 5;
const RECOVERY_MATCH_DISTANCE = 1;

function trimmedMean(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.1);
  const retained = sorted.slice(trimCount, sorted.length - trimCount);
  return retained.reduce((sum, value) => sum + value, 0) / retained.length;
}

function intersectionOverUnion(a: FaceBox, b: FaceBox) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function centerDistance(a: FaceBox, b: FaceBox) {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function isRoiMotionOutlier(previous: FaceBox, candidate: FaceBox) {
  const referenceFaceSize = Math.max(
    0.01,
    previous.width,
    previous.height
  );
  const centerShiftInFaceWidths =
    centerDistance(previous, candidate) / referenceFaceSize;
  const previousArea = previous.width * previous.height;
  const candidateArea = candidate.width * candidate.height;
  const areaRatio =
    previousArea > 0 && candidateArea > 0 ? candidateArea / previousArea : 1;

  return (
    centerShiftInFaceWidths > MAX_ROI_CENTER_JUMP_FACE_WIDTHS ||
    areaRatio > MAX_ROI_AREA_RATIO ||
    areaRatio < 1 / MAX_ROI_AREA_RATIO
  );
}

function findTrackedFace(
  candidates: FaceBox[],
  previous: FaceBox,
  isRecovering = false
) {
  let bestFace: FaceBox | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const iou = intersectionOverUnion(candidate, previous);
    const distance = centerDistance(candidate, previous) / Math.max(previous.width, previous.height, 0.01);
    const sizeRatio =
      Math.min(candidate.width * candidate.height, previous.width * previous.height) /
      Math.max(candidate.width * candidate.height, previous.width * previous.height);
    const score = iou * 0.6 + Math.max(0, 1 - distance * 2.5) * 0.25 + sizeRatio * 0.15;

    const maximumDistance = isRecovering ? RECOVERY_MATCH_DISTANCE : 0.65;
    if (sizeRatio >= 0.4 && (iou >= 0.15 || distance <= maximumDistance) && score > bestScore) {
      bestFace = candidate;
      bestScore = score;
    }
  }

  return bestFace;
}

export default function VideoAnalysisPage() {
  const params = useParams<{ projectId: string; analysisId: string }>();
  const { projects, isLoaded } = useProjects();
  const project = projects.find((item) => item.id === params.projectId);
  const { analyses, isLoaded: analysesLoaded } = useVideoAnalyses(
    params.projectId
  );
  const analysisItem = analyses.find((item) => item.id === params.analysisId);
  const { results: savedResults, saveResult, deleteResult } = useAnalysisResults(
    params.projectId,
    params.analysisId
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceDetectorRef = useRef<FaceDetectorType | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const selectedFaceRef = useRef<FaceBox | null>(null);
  const trackedFaceRef = useRef<FaceBox | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const lastDetectionTimeRef = useRef(0);
  const lastSampleMediaTimeRef = useRef(-1);
  const trackingMissCountRef = useRef(0);
  const roiOutlierCountRef = useRef(0);
  const pendingFaceMoveRef = useRef<FaceBox | null>(null);
  const lastDetectionMediaTimeRef = useRef<number | null>(null);
  const isRoiStableRef = useRef(false);
  const isAnalyzingRef = useRef(false);
  const rgbSamplesRef = useRef<RgbPoint[]>([]);
  const observationsRef = useRef<AnalysisFrameObservation[]>([]);
  const startedRangeRef = useRef({ start: 0, end: 0 });
  const exclusionReasonRef = useRef<FrameStatus>("unmatched");
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [pulseData, setPulseData] = useState<PulsePoint[]>([]);
  const [posSampleRate, setPosSampleRate] = useState<number | null>(null);
  const [heartRate, setHeartRate] = useState<number | null>(null);
  const [peakFrequency, setPeakFrequency] = useState<number | null>(null);
  const [refinementBand, setRefinementBand] = useState<{
    low: number;
    high: number;
  } | null>(null);
  const [pulsePeaks, setPulsePeaks] = useState<number[]>([]);
  const [rrRecords, setRrRecords] = useState<RrRecord[]>([]);
  const [hrvMetrics, setHrvMetrics] = useState<HrvMetrics | null>(null);
  const [rgbSampleCount, setRgbSampleCount] = useState(0);
  const [faceBoxes, setFaceBoxes] = useState<FaceBox[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<number | null>(null);
  const [trackedFace, setTrackedFace] = useState<FaceBox | null>(null);
  const [videoContentRect, setVideoContentRect] =
    useState<VideoContentRect | null>(null);
  const [isDetectorLoading, setIsDetectorLoading] = useState(false);
  const [isDetectingFaces, setIsDetectingFaces] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState(
    "Load a video, then detect faces."
  );
  const [error, setError] = useState("");

  useEffect(() => {
    return () => {
      isAnalyzingRef.current = false;
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (
        videoFrameCallbackRef.current !== null &&
        videoRef.current?.cancelVideoFrameCallback
      ) {
        videoRef.current.cancelVideoFrameCallback(
          videoFrameCallbackRef.current
        );
      }
      faceDetectorRef.current?.close();
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;

    const updateVideoContentRect = () => {
      const elementWidth = video.clientWidth;
      const elementHeight = video.clientHeight;
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (!elementWidth || !elementHeight || !sourceWidth || !sourceHeight) {
        return;
      }

      const elementRatio = elementWidth / elementHeight;
      const sourceRatio = sourceWidth / sourceHeight;
      let renderedWidth = elementWidth;
      let renderedHeight = elementHeight;
      let left = 0;
      let top = 0;

      if (sourceRatio > elementRatio) {
        renderedHeight = elementWidth / sourceRatio;
        top = (elementHeight - renderedHeight) / 2;
      } else {
        renderedWidth = elementHeight * sourceRatio;
        left = (elementWidth - renderedWidth) / 2;
      }

      setVideoContentRect({
        left,
        top,
        width: renderedWidth,
        height: renderedHeight,
      });
    };

    updateVideoContentRect();
    const resizeObserver = new ResizeObserver(updateVideoContentRect);
    resizeObserver.observe(video);
    window.addEventListener("resize", updateVideoContentRect);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateVideoContentRect);
    };
  }, [videoSrc, duration]);

  const stopAnalysis = async (message: string, completed = false) => {
    isAnalyzingRef.current = false;
    setIsAnalyzing(false);
    videoRef.current?.pause();
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (
      videoFrameCallbackRef.current !== null &&
      videoRef.current?.cancelVideoFrameCallback
    ) {
      videoRef.current.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }

    if (!completed && observationsRef.current.length) {
      setCoverage(summarizeAnalysisCoverage(startedRangeRef.current, observationsRef.current, rgbSamplesRef.current, []));
    }
    if (completed) {
      const posResult = calculatePosSignal(rgbSamplesRef.current);
      const collectionCoverage = summarizeAnalysisCoverage(
        startedRangeRef.current, observationsRef.current, rgbSamplesRef.current, posResult?.signal ?? []
      );
      setCoverage(collectionCoverage);

      if (posResult) {
        const completedResult = posResult;
        setPulseData(completedResult.signal);
        setPosSampleRate(completedResult.sampleRate);
        setHeartRate(completedResult.heartRate);
        setPeakFrequency(completedResult.peakFrequency);
        setRefinementBand(completedResult.refinementBand);
        setPulsePeaks(completedResult.peaks);
        setRrRecords(completedResult.rrRecords ?? []);
        setHrvMetrics(completedResult.hrv);
        let saved = true;
        try {
          saveResult({
            id:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : String(Date.now()),
            projectId: params.projectId,
            analysisId: params.analysisId,
            fileName,
            createdAt: new Date().toISOString(),
            signalPipeline: POS_SIGNAL_PIPELINE,
            rrPipeline: POS_RR_PIPELINE,
            signalTimeOrigin: completedResult.signal[0].t,
            rgbSignal: rgbSamplesRef.current.map(point => [
              point.t - completedResult.signal[0].t, point.r, point.g, point.b,
            ]),
            coverage: collectionCoverage,
            motionIntervals: collectionCoverage.motionIntervals?.map(interval => ({
              start: interval.start - completedResult.signal[0].t,
              end: interval.end - completedResult.signal[0].t,
            })),
            duration:
              completedResult.signal.length > 1
                ? completedResult.signal[completedResult.signal.length - 1].t -
                  completedResult.signal[0].t
                : 0,
            sampleRate: completedResult.sampleRate,
            heartRate: completedResult.heartRate,
            peakFrequency: completedResult.peakFrequency,
            refinementBand: completedResult.refinementBand,
            heartRateWindows: completedResult.heartRateWindows?.map((window) => ({
              ...window,
              start: window.start - completedResult.signal[0].t,
              end: window.end - completedResult.signal[0].t,
            })),
            rrIntervals: completedResult.rrIntervals,
            rrRecords: completedResult.rrRecords?.map(record => ({
              ...record,
              start: record.start - completedResult.signal[0].t,
              end: record.end - completedResult.signal[0].t,
            })),
            hrv: completedResult.hrv,
            ppgSignal: completedResult.signal.map(
              (point) =>
                [
                  point.t - completedResult.signal[0].t,
                  point.value,
                ] as [number, number]
            ),
            peakTimes: completedResult.peaks.map((time) =>
              time - completedResult.signal[0].t
            ),
          });
        } catch (saveError) {
          saved = false;
          console.error("Could not save POS data:", saveError);
          setError("The POS waveform was calculated but could not be saved. Free browser storage and run the video analysis again before opening within-subject analysis.");
        }
        setAnalysisMessage(
          `${message} POS estimated heart rate is ${Math.round(completedResult.heartRate)} BPM. ${saved ? "RGB, the 0.8–3 Hz filtfilt signal and motion intervals were saved for within-subject analysis." : "The result is only available on this page until it is saved."}`
        );
      } else {
        const firstSample = rgbSamplesRef.current[0];
        const lastSample = rgbSamplesRef.current.at(-1);
        const collectedSeconds =
          firstSample && lastSample ? lastSample.t - firstSample.t : 0;
        setPulseData([]);
        setPosSampleRate(null);
        setHeartRate(null);
        setPeakFrequency(null);
        setRefinementBand(null);
        setPulsePeaks([]);
        setRrRecords([]);
        setHrvMetrics(null);
        setAnalysisMessage(
          `${message} No usable POS waveform could be calculated; each segment needs at least 20 valid RGB samples spanning 1.6 seconds with measurable variation. Collected ${rgbSamplesRef.current.length} samples across ${collectedSeconds.toFixed(1)} seconds.`
        );
      }
      return;
    }

    setAnalysisMessage(message);
  };

  const initFaceDetector = async () => {
    if (faceDetectorRef.current) return faceDetectorRef.current;

    setIsDetectorLoading(true);
    setError("");
    try {
      const { FaceDetector, FilesetResolver } = await import(
        "@mediapipe/tasks-vision"
      );
      const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      let detector: FaceDetectorType | null = null;
      for (const delegate of ["GPU", "CPU"] as const) {
        try {
          detector = await FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "/models/blaze_face_short_range.tflite",
              delegate,
            },
            runningMode: "VIDEO",
            minDetectionConfidence: FACE_DETECTION_CONFIDENCE,
            minSuppressionThreshold: 0.3,
          });
          break;
        } catch (delegateError) {
          if (delegate === "CPU") throw delegateError;
          console.warn("GPU face detector failed, retrying on CPU.", delegateError);
        }
      }
      if (!detector) throw new Error("Face detector could not be created.");
      faceDetectorRef.current = detector;
      return detector;
    } catch (detectorError) {
      console.error("Face detector initialization failed:", detectorError);
      setError("Could not load the face detection model.");
      throw detectorError;
    } finally {
      setIsDetectorLoading(false);
    }
  };

  const resetBoxTracking = () => {
    pendingFaceMoveRef.current = null;
    roiOutlierCountRef.current = 0;
    trackingMissCountRef.current = 0;
    lastDetectionMediaTimeRef.current = null;
    isRoiStableRef.current = false;
  };

  const detectFaces = (detector: FaceDetectorType, timestamp: number) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return [];

    const result = detector.detectForVideo(video, timestamp);
    return result.detections.flatMap((detection, index): FaceBox[] => {
      const box = detection.boundingBox;
      if (!box) return [];
      const left = Math.max(0, box.originX);
      const top = Math.max(0, box.originY);
      const right = Math.min(video.videoWidth, box.originX + box.width);
      const bottom = Math.min(video.videoHeight, box.originY + box.height);
      if (right <= left || bottom <= top) return [];

      return [
        {
          id: index,
          x: left / video.videoWidth,
          y: top / video.videoHeight,
          width: (right - left) / video.videoWidth,
          height: (bottom - top) / video.videoHeight,
          confidence: detection.categories[0]?.score ?? 0,
        },
      ];
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    stopAnalysis("The video is ready. Run face detection.");
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
    }

    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setVideoSrc(url);
    setFileName(file.name);
    setDuration(0);
    rgbSamplesRef.current = [];
    observationsRef.current = [];
    setCoverage(null);
    setRgbSampleCount(0);
    setPulseData([]);
    setPosSampleRate(null);
    setHeartRate(null);
    setPeakFrequency(null);
    setRefinementBand(null);
    setPulsePeaks([]);
    setRrRecords([]);
    setHrvMetrics(null);
    setFaceBoxes([]);
    setSelectedFaceId(null);
    setTrackedFace(null);
    resetBoxTracking();
    setVideoContentRect(null);
    setError("");
    selectedFaceRef.current = null;
    trackedFaceRef.current = null;
    isRoiStableRef.current = false;
    roiOutlierCountRef.current = 0;
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setRange({ start: 0, end: video.duration });
    window.requestAnimationFrame(() => {
      video.dispatchEvent(new Event("resize"));
    });
  };

  const waitForVideoSeek = (video: HTMLVideoElement, targetTime: number) =>
    new Promise<void>((resolve) => {
      const clampedTarget = Math.min(
        Math.max(0, targetTime),
        Math.max(0, (video.duration || targetTime) - 0.001)
      );

      if (Math.abs(video.currentTime - clampedTarget) <= 0.01) {
        window.requestAnimationFrame(() => resolve());
        return;
      }

      const timer = window.setTimeout(resolve, 2000);
      const handleSeeked = () => {
        window.clearTimeout(timer);
        video.removeEventListener("seeked", handleSeeked);
        resolve();
      };
      video.addEventListener("seeked", handleSeeked);
      video.currentTime = clampedTarget;
    });

  const detectFacesAtCurrentFrame = async () => {
    const video = videoRef.current;
    if (!video || !duration) return;

    setIsDetectingFaces(true);
    setError("");
    video.pause();
    try {
      const detector = await initFaceDetector();
      const boxes = detectFaces(detector, performance.now());
      setFaceBoxes(boxes);
      setSelectedFaceId(null);
      setTrackedFace(null);
      resetBoxTracking();
      selectedFaceRef.current = null;
      trackedFaceRef.current = null;
      setAnalysisMessage(
        boxes.length
          ? `Found ${boxes.length} faces. Select the person to analyze.`
          : "No faces were found in the current frame. Try again at a different point in the video."
      );
    } catch {
      // Initialization already exposes a user-facing error.
    } finally {
      setIsDetectingFaces(false);
    }
  };

  const handleDetectFaces = async () => {
    const video = videoRef.current;
    if (!video || !duration) return;

    if (Math.abs(video.currentTime - range.start) <= 0.05) {
      await detectFacesAtCurrentFrame();
      return;
    }

    await waitForVideoSeek(video, range.start);
    await detectFacesAtCurrentFrame();
  };

  const selectFace = (face: FaceBox) => {
    resetBoxTracking();
    setSelectedFaceId(face.id);
    setTrackedFace(face);
    selectedFaceRef.current = face;
    trackedFaceRef.current = face;
    isRoiStableRef.current = false;
    roiOutlierCountRef.current = 0;
    setAnalysisMessage("Person selected. You can now start the analysis.");
  };

  const sampleSelectedFaceRgb = (face: FaceBox): RgbPoint | null => {
    const video = videoRef.current;
    const canvas = hiddenCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    const x = Math.max(0, Math.floor(face.x * video.videoWidth));
    const y = Math.max(0, Math.floor(face.y * video.videoHeight));
    const width = Math.min(Math.max(1, Math.floor(face.width * video.videoWidth)), video.videoWidth - x);
    const height = Math.min(Math.max(1, Math.floor(face.height * video.videoHeight)), video.videoHeight - y);
    if (width <= 0 || height <= 0) return null;
    canvas.width = canvas.height = POS_FACE_SAMPLE_SIZE;
    // Keep the previous upper-face rectangular ROI and robust channel averages.
    context.drawImage(video, x + Math.floor(width * 0.15), y + Math.floor(height * 0.12),
      Math.max(1, Math.floor(width * 0.7)), Math.max(1, Math.floor(height * 0.58)),
      0, 0, POS_FACE_SAMPLE_SIZE, POS_FACE_SAMPLE_SIZE);
    const pixels = context.getImageData(0, 0, POS_FACE_SAMPLE_SIZE, POS_FACE_SAMPLE_SIZE).data;
    const red: number[] = [], green: number[] = [], blue: number[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      red.push(pixels[i]); green.push(pixels[i + 1]); blue.push(pixels[i + 2]);
    }
    return { t: video.currentTime, r: trimmedMean(red), g: trimmedMean(green), b: trimmedMean(blue) };
  };

  const scheduleNextAnalysisFrame = () => {
    const video = videoRef.current;
    if (!video || !isAnalyzingRef.current) return;

    if (video.requestVideoFrameCallback) {
      videoFrameCallbackRef.current = video.requestVideoFrameCallback(
        runAnalysisFrame
      );
    } else {
      animationFrameRef.current = window.requestAnimationFrame(() =>
        runAnalysisFrame(performance.now(), {
          mediaTime: video.currentTime,
        } as VideoFrameCallbackMetadata)
      );
    }
  };

  const runAnalysisFrame: VideoFrameRequestCallback = (
    _presentationTime,
    metadata
  ) => {
    const video = videoRef.current;
    const detector = faceDetectorRef.current;
    if (!video || !detector || !isAnalyzingRef.current) return;

    const mediaTime = metadata.mediaTime ?? video.currentTime;
    if (mediaTime >= startedRangeRef.current.end || video.ended) {
      stopAnalysis("Analysis of the selected range is complete.", true);
      return;
    }
    if (mediaTime < startedRangeRef.current.start || mediaTime <= (observationsRef.current.at(-1)?.t ?? -1)) {
      scheduleNextAnalysisFrame();
      return;
    }

    const now = performance.now();
    // Detection has its own cadence; RGB collection below runs on every delivered video frame.
    if (lastDetectionMediaTimeRef.current === null || now - lastDetectionTimeRef.current >= DETECTION_INTERVAL_MS) {
      let candidates: FaceBox[];
      try {
        candidates = detectFaces(detector, now);
      } catch (error) {
        console.error("Face tracking failed:", error);
        setError("Face tracking failed. Please restart the analysis.");
        stopAnalysis("Analysis stopped because face tracking failed.");
        return;
      }
      const previous = trackedFaceRef.current;
      const reference = pendingFaceMoveRef.current ?? previous;
      const matched = reference ? findTrackedFace(candidates, reference,
        trackingMissCountRef.current >= MAX_CONSECUTIVE_TRACKING_MISSES) : null;
      const elapsed = lastDetectionMediaTimeRef.current === null
        ? DETECTION_INTERVAL_MS / 1000 : mediaTime - lastDetectionMediaTimeRef.current;
      lastDetectionMediaTimeRef.current = mediaTime;
      lastDetectionTimeRef.current = now;
      isRoiStableRef.current = false;
      if (matched && previous) {
        trackingMissCountRef.current = 0;
        if (isRoiMotionOutlier(previous, matched)) {
          const pending = pendingFaceMoveRef.current;
          roiOutlierCountRef.current = pending && isConsistentFaceMove(pending, matched)
            ? roiOutlierCountRef.current + 1 : 1;
          pendingFaceMoveRef.current = matched;
          exclusionReasonRef.current = "motion";
          setAnalysisMessage("ROI movement detected. RGB is included in POS analysis and motion is marked on the graphs.");
          if (roiOutlierCountRef.current > MAX_CONSECUTIVE_ROI_OUTLIERS) {
            const reanchored = { ...matched, id: previous.id };
            trackedFaceRef.current = reanchored;
            setTrackedFace(reanchored);
            pendingFaceMoveRef.current = null;
            roiOutlierCountRef.current = 0;
          }
        } else {
          const smoothed = smoothFaceBox(previous, matched, elapsed);
          trackedFaceRef.current = smoothed;
          setTrackedFace(smoothed);
          pendingFaceMoveRef.current = null;
          roiOutlierCountRef.current = 0;
          isRoiStableRef.current = true;
          exclusionReasonRef.current = "collected";
          setAnalysisMessage("Tracking and analyzing the selected person with stabilized face boxes.");
        }
      } else {
        trackingMissCountRef.current += 1;
        pendingFaceMoveRef.current = null;
        roiOutlierCountRef.current = 0;
        exclusionReasonRef.current = candidates.length ? "unmatched" : "no-face";
        if (trackingMissCountRef.current > MAX_CONSECUTIVE_TRACKING_MISSES) {
          setTrackedFace(null);
          setAnalysisMessage("Searching for the selected person. RGB collection resumes when their face is detected.");
        }
      }
    }
    const motion = exclusionReasonRef.current === "motion";
    // During a large move, sample the detected face rather than the old anchor.
    const currentFace = motion
      ? pendingFaceMoveRef.current ?? trackedFaceRef.current
      : trackedFaceRef.current;
    let frameStatus: FrameStatus = exclusionReasonRef.current;
    if (
      currentFace &&
      (isRoiStableRef.current || motion) &&
      mediaTime > lastSampleMediaTimeRef.current + Number.EPSILON
    ) {
      const sample = sampleSelectedFaceRgb(currentFace);
      frameStatus = sample ? "collected" : "read-failed";
      if (sample) {
        rgbSamplesRef.current.push({ ...sample, t: mediaTime });
        setRgbSampleCount(rgbSamplesRef.current.length);
        lastSampleMediaTimeRef.current = mediaTime;
      }
    }
    observationsRef.current.push({ t: mediaTime, status: frameStatus, motion });

    scheduleNextAnalysisFrame();
  };

  const startAnalysis = async () => {
    const video = videoRef.current;
    const selectedFace = selectedFaceRef.current;
    if (!video || !duration || !selectedFace) {
      setError("Select a face to analyze first.");
      return;
    }

    setError("");
    try {
      await initFaceDetector();
      resetBoxTracking();
      await waitForVideoSeek(video, range.start);
      trackedFaceRef.current = selectedFace;
      setTrackedFace(selectedFace);
      rgbSamplesRef.current = [];
      observationsRef.current = [];
      startedRangeRef.current = { start: range.start, end: Math.min(range.end, video.duration) };
      setCoverage(null);
      setRgbSampleCount(0);
      setPulseData([]);
      setPosSampleRate(null);
      setHeartRate(null);
      setPeakFrequency(null);
      setRefinementBand(null);
      setPulsePeaks([]);
      setRrRecords([]);
      setHrvMetrics(null);
      lastDetectionTimeRef.current = 0;
      lastDetectionMediaTimeRef.current = null;
      lastSampleMediaTimeRef.current = -1;
      trackingMissCountRef.current = 0;
      roiOutlierCountRef.current = 0;
      isRoiStableRef.current = false;
      isAnalyzingRef.current = true;
      setIsAnalyzing(true);
      setAnalysisMessage("Starting stabilized face box tracking for the selected person.");
      await video.play();
      scheduleNextAnalysisFrame();
    } catch (analysisError) {
      console.error("Analysis failed:", analysisError);
      stopAnalysis("Could not start the analysis.");
    }
  };

  if (!isLoaded || !analysesLoaded) {
    return <p className="page-status">Loading analysis information.</p>;
  }
  if (!project) return <p className="page-status">Project not found.</p>;
  if (!analysisItem) {
    return <p className="page-status">Video analysis card not found.</p>;
  }

  const displayedBoxes = isAnalyzing
    ? trackedFace
      ? [trackedFace]
      : []
    : faceBoxes;

  return (
    <div className="video-page">
      <div className="page-heading">
        <div>
          <Link
            className="back-link"
            href={`/projects/${params.projectId}`}
          >
            ← {project.name}
          </Link>
          <span className="section-kicker">VIDEO WORKSPACE</span>
          <h1>{analysisItem.name}</h1>
          <p>
            {analysisItem.description ||
              "Estimate a pulse signal with POS from the selected person."}
          </p>
        </div>
        <span className={`analysis-badge ${isAnalyzing ? "is-running" : ""}`}>
          {isAnalyzing ? "Analyzing" : "Ready"}
        </span>
      </div>

      <div className="analysis-toolbar">
        <label className="file-button">
          Select Video File
          <input type="file" accept="video/*" hidden onChange={handleFileChange} />
        </label>
        <button
          className="secondary-button"
          disabled={!videoSrc || !duration || isDetectingFaces || isAnalyzing}
          onClick={handleDetectFaces}
        >
          {isDetectorLoading || isDetectingFaces
            ? "Preparing high-performance model..."
            : "Detect Faces"}
        </button>
        <button
          className="primary-button"
          disabled={!videoSrc || selectedFaceId === null || isAnalyzing || isDetectorLoading}
          onClick={startAnalysis}
        >
          Analyze Selected Person
        </button>
        {isAnalyzing && (
          <button
            className="danger-button"
            onClick={() => stopAnalysis("Analysis stopped.")}
          >
            Stop Analysis
          </button>
        )}
        {fileName && <span className="file-name">{fileName}</span>}
      </div>

      {error && <p className="analysis-error">{error}</p>}
      <p className="analysis-status">{analysisMessage}</p>
      {coverage && <AnalysisCoverage coverage={coverage} />}

      {heartRate !== null && (
        <section className="result-summary">
          <div>
            <span>Estimated Heart Rate</span>
            <strong>{Math.round(heartRate)} BPM</strong>
          </div>
          <div>
            <span>Dominant Frequency</span>
            <strong>{peakFrequency?.toFixed(2)} Hz</strong>
          </div>
          <div>
            <span>Sampling Rate</span>
            <strong>{posSampleRate?.toFixed(1)} Hz</strong>
          </div>
          <div>
            <span>HRV</span>
            <strong>{hrvMetrics ? "Calculated" : "Insufficient peak data"}</strong>
          </div>
        </section>
      )}

      {!isAnalyzing && rgbSampleCount >= 20 && pulseData.length === 0 && (
        <button
          className="result-calculate-button"
          type="button"
          onClick={() =>
            stopAnalysis("POS calculation from the collected RGB samples is complete.", true)
          }
        >
          Calculate POS Results
        </button>
      )}

      <div className="video-layout">
        <div className="video-preview">
          {videoSrc ? (
            <>
              <video
                ref={videoRef}
                src={videoSrc}
                controls
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={() => {
                  if (isAnalyzingRef.current) {
                    stopAnalysis("Analysis of the selected range is complete.", true);
                  }
                }}
                onPause={() => {
                  if (isAnalyzingRef.current) {
                    const video = videoRef.current;
                    const effectiveEnd = Math.min(
                      startedRangeRef.current.end,
                      video?.duration || startedRangeRef.current.end
                    );
                    const reachedEnd =
                      Boolean(video?.ended) ||
                      (video?.currentTime ?? 0) >= effectiveEnd - 0.15;

                    stopAnalysis(
                      reachedEnd
                        ? "Analysis of the selected range is complete."
                        : "Analysis stopped because the video was paused.",
                      reachedEnd
                    );
                  }
                }}
              />
              {videoContentRect && (
                <div
                  className="face-overlay-layer"
                  style={{
                    left: videoContentRect.left,
                    top: videoContentRect.top,
                    width: videoContentRect.width,
                    height: videoContentRect.height,
                  }}
                >
                  {displayedBoxes.map((box) => (
                    <button
                      key={`${box.id}-${box.x}-${box.y}`}
                      type="button"
                      className={`face-box ${
                        box.id === selectedFaceId || isAnalyzing
                          ? "face-box-selected"
                          : ""
                      }`}
                      style={{
                        left: `${box.x * 100}%`,
                        top: `${box.y * 100}%`,
                        width: `${box.width * 100}%`,
                        height: `${box.height * 100}%`,
                      }}
                      onClick={() => !isAnalyzing && selectFace(box)}
                      aria-label={`Select face ${box.id + 1}`}
                    >
                      <span>
                        {box.id === selectedFaceId || isAnalyzing
                          ? "Selected Person"
                          : `Person ${box.id + 1}`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="video-placeholder">
              <strong>Load a video to analyze</strong>
              <span>Choose an MP4, WebM, or another browser-compatible file</span>
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

      <PulseWaveChart
        motionIntervals={coverage?.motionIntervals}
        rrRecords={rrRecords}
        data={pulseData}
        sampleRate={posSampleRate}
        heartRate={heartRate}
        peakFrequency={peakFrequency}
        refinementBand={refinementBand}
        peaks={pulsePeaks}
        hrv={hrvMetrics}
      />
      {pulseData.length > 0 && (
        <Link className="back-link" href={`/projects/${params.projectId}/within-subject`}>
          Open within-subject analysis with saved POS signals →
        </Link>
      )}
      <AnalysisHistory results={savedResults} onDelete={deleteResult} />
      <canvas ref={hiddenCanvasRef} hidden />
    </div>
  );
}
