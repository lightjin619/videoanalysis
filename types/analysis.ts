import type { HeartRateWindow, HrvMetrics, RrRecord, POS_SIGNAL_PIPELINE, POS_RR_PIPELINE } from "@/lib/posSignal";
import type { AnalysisCoverage, MotionInterval } from "@/lib/analysisCoverage";

export interface SavedAnalysisResult {
  id: string;
  projectId: string;
  analysisId?: string;
  fileName: string;
  createdAt: string;
  duration: number;
  sampleRate: number;
  heartRate: number;
  peakFrequency: number;
  refinementBand: { low: number; high: number };
  heartRateWindows?: HeartRateWindow[];
  rrIntervals?: number[];
  rrRecords?: RrRecord[];
  hrv: HrvMetrics | null;
  ppgSignal?: Array<[number, number]>;
  signalPipeline?: typeof POS_SIGNAL_PIPELINE;
  rrPipeline?: typeof POS_RR_PIPELINE;
  /** Video time corresponding to t=0 in the saved RGB, pulse and motion data. */
  signalTimeOrigin?: number;
  rgbSignal?: Array<[number, number, number, number]>;
  peakTimes?: number[];
  motionIntervals?: MotionInterval[];
  coverage?: AnalysisCoverage;
}
