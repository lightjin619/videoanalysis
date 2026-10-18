import type { PulsePoint, RgbPoint } from "@/lib/posSignal";

export type FrameStatus = "collected" | "no-face" | "unmatched" | "motion" | "read-failed";
export interface AnalysisFrameObservation { t: number; status: FrameStatus; motion?: boolean }
export interface MotionInterval { start: number; end: number }
export interface AnalysisCoverage {
  start: number;
  end: number;
  observedEnd: number | null;
  rgbStart: number | null;
  rgbEnd: number | null;
  pulseStart: number | null;
  pulseEnd: number | null;
  motionIntervals?: MotionInterval[];
  rows: Array<{
    start: number;
    end: number;
    frames: number;
    rgb: number;
    pulse: number;
    noFace: number;
    unmatched: number;
    motion: number;
    readFailed: number;
  }>;
}

/** Use frame boundaries so motion markers never extend across an unobserved gap. */
export function collectMotionIntervals(
  range: { start: number; end: number },
  observations: AnalysisFrameObservation[]
): MotionInterval[] {
  const steps = observations.slice(1).map((frame, index) => frame.t - observations[index].t)
    .filter(step => step > 0 && step <= 0.5).sort((a, b) => a - b);
  const frameDuration = steps[Math.floor(steps.length / 2)] ?? 1 / 30;
  const intervals: MotionInterval[] = [];
  observations.forEach((frame, index) => {
    if (!frame.motion) return;
    const start = Math.max(range.start, frame.t);
    const next = observations[index + 1]?.t;
    const end = Math.min(range.end, next !== undefined && next - frame.t <= 0.5
      ? next : frame.t + frameDuration);
    if (end <= start) return;
    const previous = intervals.at(-1);
    if (previous && start <= previous.end + 1e-6) previous.end = Math.max(previous.end, end);
    else intervals.push({ start, end });
  });
  return intervals;
}

export function summarizeAnalysisCoverage(
  range: { start: number; end: number },
  observations: AnalysisFrameObservation[],
  rgb: RgbPoint[],
  pulse: PulsePoint[]
): AnalysisCoverage {
  const rows: AnalysisCoverage["rows"] = Array.from(
    { length: Math.max(0, Math.ceil((range.end - range.start) / 15)) },
    (_, index) => ({ start: range.start + index * 15,
      end: Math.min(range.end, range.start + (index + 1) * 15),
      frames: 0, rgb: 0, pulse: 0, noFace: 0, unmatched: 0, motion: 0, readFailed: 0 })
  );
  const rowFor = (t: number) => t >= range.start && t < range.end
    ? rows[Math.floor((t - range.start) / 15)] : undefined;
  for (const frame of observations) {
    const row = rowFor(frame.t);
    if (!row) continue;
    row.frames++;
    if (frame.status === "no-face") row.noFace++;
    if (frame.status === "unmatched") row.unmatched++;
    if (frame.motion || frame.status === "motion") row.motion++;
    if (frame.status === "read-failed") row.readFailed++;
  }
  for (const point of rgb) { const row = rowFor(point.t); if (row) row.rgb++; }
  for (const point of pulse) { const row = rowFor(point.t); if (row) row.pulse++; }
  return { ...range, observedEnd: observations.at(-1)?.t ?? null,
    rgbStart: rgb[0]?.t ?? null, rgbEnd: rgb.at(-1)?.t ?? null,
    pulseStart: pulse[0]?.t ?? null, pulseEnd: pulse.at(-1)?.t ?? null,
    motionIntervals: collectMotionIntervals(range, observations), rows };
}
