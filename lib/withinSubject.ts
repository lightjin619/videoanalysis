import type { SavedAnalysisResult } from "@/types/analysis";
import { analysisRrRecords, successiveRrDifferences, analyzeFilteredPosSignal, POS_SIGNAL_PIPELINE, POS_RR_PIPELINE } from "@/lib/posSignal";

/** Rebuild RR using each 15s spectral HR +/-0.2 Hz, preserving the saved POS waveform. */
export function prepareWithinSubjectResult(result: SavedAnalysisResult): SavedAnalysisResult | null {
  if (result.signalPipeline !== POS_SIGNAL_PIPELINE || !result.ppgSignal?.length) return null;
  const pulse = analyzeFilteredPosSignal(result.ppgSignal.map(([t, value]) => ({ t, value })), result.sampleRate);
  return pulse ? {
    ...result,
    rrPipeline: POS_RR_PIPELINE,
    heartRate: pulse.heartRate,
    peakFrequency: pulse.peakFrequency,
    refinementBand: pulse.refinementBand,
    heartRateWindows: pulse.heartRateWindows,
    peakTimes: pulse.peaks,
    rrRecords: pulse.rrRecords,
    rrIntervals: pulse.rrIntervals,
    hrv: pulse.hrv,
  } : null;
}

export type WithinMetric =
  | "heartRate"
  | "meanRr"
  | "sdnn"
  | "rmssd"
  | "pnn50"
  | "ppgAmplitude";

export interface TrendPoint {
  x: number;
  y: number;
}

export interface TrendSeries {
  label: string;
  color: string;
  points: TrendPoint[];
}

export interface SegmentStatistics {
  value: number | null;
  samples: number[];
  mean: number | null;
  standardDeviation: number | null;
}

export const METRIC_LABELS: Record<WithinMetric, string> = {
  heartRate: "Heart rate (BPM)",
  meanRr: "Mean RR (ms)",
  sdnn: "SDNN (ms)",
  rmssd: "RMSSD (ms)",
  pnn50: "pNN50 (%)",
  ppgAmplitude: "PPG amplitude (SD)",
};

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length
  );
}

function rrIntervals(result: SavedAnalysisResult, start: number, end: number) {
  return analysisRrRecords(result, start, end).map(record => record.interval);
}

export function calculateMetric(
  result: SavedAnalysisResult,
  metric: WithinMetric,
  start: number,
  end: number
) {
  if (metric === "ppgAmplitude") {
    const values =
      result.ppgSignal
        ?.filter(([time]) => time >= start && time <= end)
        .map(([, value]) => value) ?? [];
    return values.length >= 2 ? standardDeviation(values) : null;
  }

  const intervals = rrIntervals(result, start, end);
  if (!intervals.length) return null;

  if (metric === "heartRate") return 60000 / mean(intervals);
  if (metric === "meanRr") return mean(intervals);
  if (metric === "sdnn") return standardDeviation(intervals);

  const differences = successiveRrDifferences(analysisRrRecords(result, start, end));
  if (!differences.length) return null;
  if (metric === "rmssd") {
    return Math.sqrt(mean(differences.map((difference) => difference ** 2)));
  }
  return (
    (differences.filter((difference) => Math.abs(difference) > 50).length /
      differences.length) *
    100
  );
}

export function buildTrendSeries(
  result: SavedAnalysisResult,
  analysisName: string,
  metric: WithinMetric,
  start: number,
  end: number,
  windows: number[],
  includeTotal: boolean,
  colors: string[]
) {
  const series: TrendSeries[] = [];

  if (metric === "ppgAmplitude" && result.ppgSignal) {
    series.push({
      label: `${analysisName} PPG`,
      color: colors[0],
      points: result.ppgSignal
        .filter(([time]) => time >= start && time <= end)
        .map(([time, value]) => ({ x: time, y: value })),
    });
  }

  windows.forEach((windowSeconds, windowIndex) => {
    const points: TrendPoint[] = [];
    for (
      let windowStart = start;
      windowStart + windowSeconds <= end + 0.001;
      windowStart += windowSeconds
    ) {
      const value = calculateMetric(
        result,
        metric,
        windowStart,
        windowStart + windowSeconds
      );
      if (value !== null) {
        points.push({
          x: windowStart + windowSeconds / 2,
          y: value,
        });
      }
    }
    if (points.length) {
      series.push({
        label: `${analysisName} ${windowSeconds}s`,
        color: colors[(windowIndex + 1) % colors.length],
        points,
      });
    }
  });

  if (includeTotal) {
    const value = calculateMetric(result, metric, start, end);
    if (value !== null) {
      series.push({
        label: `${analysisName} total`,
        color: colors[(windows.length + 1) % colors.length],
        points: [
          { x: start, y: value },
          { x: end, y: value },
        ],
      });
    }
  }

  return series;
}

export function segmentStatistics(
  result: SavedAnalysisResult,
  metric: WithinMetric,
  start: number,
  end: number
): SegmentStatistics {
  const value = calculateMetric(result, metric, start, end);
  const samples =
    metric === "ppgAmplitude"
      ? result.ppgSignal
          ?.filter(([time]) => time >= start && time <= end)
          .map(([, sample]) => sample) ?? []
      : rrIntervals(result, start, end);

  return {
    value,
    samples,
    mean: samples.length ? mean(samples) : null,
    standardDeviation:
      samples.length > 1 ? standardDeviation(samples) : null,
  };
}

export function cohensD(a: number[], b: number[]) {
  if (a.length < 2 || b.length < 2) return null;
  const varianceA = standardDeviation(a) ** 2;
  const varianceB = standardDeviation(b) ** 2;
  const pooled = Math.sqrt(
    ((a.length - 1) * varianceA + (b.length - 1) * varianceB) /
      (a.length + b.length - 2)
  );
  return pooled > 0 ? (mean(b) - mean(a)) / pooled : null;
}
