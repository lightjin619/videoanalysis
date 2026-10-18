import type { SavedAnalysisResult } from "@/types/analysis";
import { analysisRrRecords } from "@/lib/posSignal";
import {
  calculateMetric,
  type TrendPoint,
  type WithinMetric,
} from "@/lib/withinSubject";

export type BetweenMetric = WithinMetric | "lfHf";

export interface GroupTrendSeries {
  label: string;
  color: string;
  points: TrendPoint[];
}

export const BETWEEN_METRIC_LABELS: Record<BetweenMetric, string> = {
  heartRate: "Heart rate (BPM)",
  meanRr: "Mean RR (ms)",
  sdnn: "SDNN (ms)",
  rmssd: "RMSSD (ms)",
  pnn50: "pNN50 (%)",
  ppgAmplitude: "PPG amplitude (SD)",
  lfHf: "LF/HF ratio",
};

export function mean(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

export function standardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const average = mean(values) ?? 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1)
  );
}

function rrSeries(result: SavedAnalysisResult, start: number, end: number) {
  return analysisRrRecords(result, start, end);
}

function linearInterpolate(
  points: Array<{ end: number; interval: number }>,
  time: number
) {
  let right = points.findIndex((point) => point.end >= time);
  if (right === -1) return points.at(-1)?.interval ?? 0;
  if (right <= 0) return points[Math.max(0, right)]?.interval ?? 0;
  const left = right - 1;
  const span = points[right].end - points[left].end;
  if (span <= 0) return points[left].interval;
  const ratio = (time - points[left].end) / span;
  return (
    points[left].interval +
    (points[right].interval - points[left].interval) * ratio
  );
}

function bandPower(values: number[], sampleRate: number, low: number, high: number) {
  let power = 0;
  for (let index = 1; index < values.length / 2; index += 1) {
    const frequency = (index * sampleRate) / values.length;
    if (frequency < low || frequency >= high) continue;
    let real = 0;
    let imaginary = 0;
    values.forEach((value, sampleIndex) => {
      const angle = (2 * Math.PI * index * sampleIndex) / values.length;
      real += value * Math.cos(angle);
      imaginary -= value * Math.sin(angle);
    });
    power += (real ** 2 + imaginary ** 2) / values.length;
  }
  return power;
}

function calculateLfHf(
  result: SavedAnalysisResult,
  start: number,
  end: number
) {
  const intervals = rrSeries(result, start, end);
  if (intervals.length < 12 || end - start < 30) return null;
  // Never interpolate a tachogram across discarded beats or tracking gaps.
  if (intervals.some((record, index) => index > 0 && (
    record.segmentId !== intervals[index - 1].segmentId ||
    Math.abs(record.start - intervals[index - 1].end) > 1e-6
  ))) return null;

  const sampleRate = 4;
  const firstTime = intervals[0].end;
  const lastTime = intervals[intervals.length - 1].end;
  if (lastTime - firstTime < 30) return null;
  const values: number[] = [];
  for (let time = firstTime; time <= lastTime; time += 1 / sampleRate) {
    values.push(linearInterpolate(intervals, time));
  }
  if (values.length < 32) return null;

  const average = mean(values) ?? 0;
  const detrended = values.map((value) => value - average);
  const lf = bandPower(detrended, sampleRate, 0.04, 0.15);
  const hf = bandPower(detrended, sampleRate, 0.15, 0.4);
  return hf > 0 ? lf / hf : null;
}

export function calculateBetweenMetric(
  result: SavedAnalysisResult,
  metric: BetweenMetric,
  start: number,
  end: number
) {
  return metric === "lfHf"
    ? calculateLfHf(result, start, end)
    : calculateMetric(result, metric, start, end);
}

export function cohensD(a: number[], b: number[]) {
  if (a.length < 2 || b.length < 2) return null;
  const sdA = standardDeviation(a);
  const sdB = standardDeviation(b);
  if (sdA === null || sdB === null) return null;
  const pooled = Math.sqrt(
    ((a.length - 1) * sdA ** 2 + (b.length - 1) * sdB ** 2) /
      (a.length + b.length - 2)
  );
  const meanA = mean(a);
  const meanB = mean(b);
  return pooled > 0 && meanA !== null && meanB !== null
    ? (meanB - meanA) / pooled
    : null;
}

export function welchT(a: number[], b: number[]) {
  if (a.length < 2 || b.length < 2) return null;
  const meanA = mean(a);
  const meanB = mean(b);
  const sdA = standardDeviation(a);
  const sdB = standardDeviation(b);
  if (meanA === null || meanB === null || sdA === null || sdB === null) {
    return null;
  }
  const variance = sdA ** 2 / a.length + sdB ** 2 / b.length;
  return variance > 0 ? (meanB - meanA) / Math.sqrt(variance) : null;
}
