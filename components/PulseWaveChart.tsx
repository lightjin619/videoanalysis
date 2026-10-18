"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HrvMetrics, PulsePoint, RrRecord } from "@/lib/posSignal";
import type { MotionInterval } from "@/lib/analysisCoverage";

interface PulseWaveChartProps {
  data: PulsePoint[];
  sampleRate: number | null;
  heartRate: number | null;
  peakFrequency: number | null;
  refinementBand: { low: number; high: number } | null;
  peaks: number[];
  rrRecords?: RrRecord[];
  motionIntervals?: MotionInterval[];
  hrv: HrvMetrics | null;
}

interface TachogramPoint {
  t: number;
  rr: number;
  start?: number;
  segmentId?: number;
}

const SEGMENT_SECONDS = 15;
const MAX_INTERPOLATE_GAP_SECONDS = 0.5;
const MAX_TACHOGRAM_CONNECT_GAP_SECONDS = 4;

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function prepareDisplayData(data: PulsePoint[]) {
  return data
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((a, b) => a.t - b.t);
}

function tachogramFromPeaks(peaks: number[], data: PulsePoint[]): TachogramPoint[] {
  return peaks
    .slice(1)
    .map((time, index) => ({
      t: time,
      rr: (time - peaks[index]) * 1000,
    }))
    .filter((point) => point.rr >= 300 && point.rr <= 2000)
    .filter((point) => !data.some((sample, index) => index > 0
      && sample.t - data[index - 1].t > MAX_INTERPOLATE_GAP_SECONDS
      && data[index - 1].t < point.t
      && sample.t > point.t - point.rr / 1000));
}

function nearestPoint(
  data: PulsePoint[],
  time: number,
  typicalInterval: number
) {
  let left = 0;
  let right = data.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (data[mid].t < time) left = mid + 1;
    else right = mid;
  }
  const before = data[Math.max(0, left - 1)];
  const after = data[left];
  const point =
    before && after
      ? Math.abs(after.t - time) < Math.abs(before.t - time)
        ? after
        : before
      : after ?? before;
  return point && Math.abs(point.t - time) <= typicalInterval * 3 ? point : null;
}

function drawMotionIntervals(
  context: CanvasRenderingContext2D,
  intervals: MotionInterval[],
  start: number,
  end: number,
  padding: number,
  width: number,
  height: number
) {
  if (end <= start) return;
  context.fillStyle = "rgba(245, 158, 11, 0.22)";
  for (const interval of intervals) {
    const left = Math.max(start, interval.start);
    const right = Math.min(end, interval.end);
    if (right <= left) continue;
    const x = padding + (left - start) / (end - start) * width;
    context.fillRect(x, padding, (right - left) / (end - start) * width, height);
  }
}

function drawPulseSegment(
  canvas: HTMLCanvasElement,
  segmentData: PulsePoint[],
  segmentPeaks: number[],
  sampleRate: number | null,
  motionIntervals: MotionInterval[],
  startTime = segmentData[0]?.t ?? 0,
  endTime = segmentData.at(-1)?.t ?? startTime + SEGMENT_SECONDS
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const width = canvas.width;
  const height = canvas.height;
  const padding = 28;
  const graphWidth = width - padding * 2;
  const graphHeight = height - padding * 2;

  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#e2e8f0";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding, height / 2);
  context.lineTo(width - padding, height / 2);
  context.stroke();

  drawMotionIntervals(context, motionIntervals, startTime, endTime, padding, graphWidth, graphHeight);
  drawTimeAxis(context, startTime, endTime, padding, graphWidth, height);
  if (segmentData.length < 1) return;

  const intervals = segmentData
    .slice(1)
    .map((point, index) => point.t - segmentData[index].t)
    .filter((interval) => interval > 0 && interval < 2);
  const typicalInterval =
    sampleRate && sampleRate > 0 ? 1 / sampleRate : median(intervals) || 0.01;
  const duration = endTime - startTime || 1;
  const maxMagnitude =
    Math.max(Number.EPSILON, ...segmentData.map((point) => Math.abs(point.value))) * 1.1;

  context.strokeStyle = "#7c3aed";
  context.lineWidth = 2;
  context.beginPath();
  segmentData.forEach((point, index) => {
    const x = padding + ((point.t - startTime) / duration) * graphWidth;
    const y =
      padding +
      graphHeight / 2 -
      (point.value / maxMagnitude) * (graphHeight / 2);
    const previous = segmentData[index - 1];
    if (
      index === 0 ||
      (previous && point.t - previous.t > MAX_INTERPOLATE_GAP_SECONDS)
    ) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  context.fillStyle = "#dc2626";
  for (const peakTime of segmentPeaks) {
    const point = nearestPoint(segmentData, peakTime, typicalInterval);
    if (!point) continue;
    const x = padding + ((point.t - startTime) / duration) * graphWidth;
    const y =
      padding +
      graphHeight / 2 -
      (point.value / maxMagnitude) * (graphHeight / 2);
    context.beginPath();
    context.arc(x, y, 3, 0, Math.PI * 2);
    context.fill();
  }
}

function drawTimeAxis(context: CanvasRenderingContext2D, start: number, end: number,
  padding: number, width: number, height: number) {
  context.fillStyle = "#64748b";
  context.font = "12px sans-serif";
  context.textAlign = "center";
  for (let tick = 0; tick <= 3; tick++) {
    context.fillText(`${(start + (end - start) * tick / 3).toFixed(1)}s`,
      padding + width * tick / 3, height - 8);
  }
  context.textAlign = "left";
}

function drawTachogram(canvas: HTMLCanvasElement, points: TachogramPoint[], motionIntervals: MotionInterval[],
  startTime = points[0]?.t ?? 0, endTime = points.at(-1)?.t ?? startTime + SEGMENT_SECONDS) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const width = canvas.width;
  const height = canvas.height;
  const padding = 32;
  const graphWidth = width - padding * 2;
  const graphHeight = height - padding * 2;
  context.clearRect(0, 0, width, height);

  context.strokeStyle = "#e2e8f0";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding, height - padding);
  context.lineTo(width - padding, height - padding);
  context.moveTo(padding, padding);
  context.lineTo(padding, height - padding);
  context.stroke();

  drawMotionIntervals(context, motionIntervals, startTime, endTime, padding, graphWidth, graphHeight);
  drawTimeAxis(context, startTime, endTime, padding, graphWidth, height);
  if (!points.length) return;
  const duration = endTime - startTime || 1;
  const values = points.map((point) => point.rr);
  const minValue = Math.max(250, Math.min(...values) - 50);
  const maxValue = Math.min(2200, Math.max(...values) + 50);
  const valueRange = maxValue - minValue || 1;

  context.strokeStyle = "#0f766e";
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => {
    const x = padding + ((point.t - startTime) / duration) * graphWidth;
    const y =
      height -
      padding -
      ((point.rr - minValue) / valueRange) * graphHeight;
    const previous = points[index - 1];
    if (
      index === 0 ||
      (previous && (point.t - previous.t > MAX_TACHOGRAM_CONNECT_GAP_SECONDS ||
        (point.start !== undefined && Math.abs(point.start - previous.t) > 1e-6) ||
        point.segmentId !== previous.segmentId))
    ) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  context.fillStyle = "#0f766e";
  for (const point of points) {
    const x = padding + ((point.t - startTime) / duration) * graphWidth;
    const y =
      height -
      padding -
      ((point.rr - minValue) / valueRange) * graphHeight;
    context.beginPath();
    context.arc(x, y, 2.5, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "#64748b";
  context.font = "12px sans-serif";
  context.fillText(`${Math.round(maxValue)} ms`, 8, padding + 4);
  context.fillText(`${Math.round(minValue)} ms`, 8, height - padding);
}

export default function PulseWaveChart({
  data,
  sampleRate,
  heartRate,
  peakFrequency,
  refinementBand,
  peaks,
  rrRecords,
  motionIntervals,
  hrv,
}: PulseWaveChartProps) {
  const pulseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tachogramCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const displayData = useMemo(
    () => prepareDisplayData(data),
    [data]
  );
  const segmentCount = Math.max(
    1,
    Math.ceil(
      ((displayData.at(-1)?.t ?? 0) - (displayData[0]?.t ?? 0)) /
        SEGMENT_SECONDS
    )
  );
  const [segmentIndex, setSegmentIndex] = useState(0);
  const safeSegmentIndex = Math.min(segmentIndex, segmentCount - 1);
  const startTime = displayData[0]?.t ?? 0;
  const segmentStart = startTime + safeSegmentIndex * SEGMENT_SECONDS;
  const segmentEnd = segmentStart + SEGMENT_SECONDS;
  const segmentData = displayData.filter(
    (point) => point.t >= segmentStart && point.t <= segmentEnd
  );
  const segmentPeaks = peaks.filter(
    (peak) => peak >= segmentStart && peak <= segmentEnd
  );
  const segmentHr =
    segmentPeaks.length >= 2
      ? 60 /
        median(segmentPeaks.slice(1).map((time, index) => time - segmentPeaks[index]))
      : null;
  const tachogramPoints = useMemo(() => rrRecords
    ? rrRecords.filter(record => record.accepted).map(record => ({
      t: record.end, start: record.start, segmentId: record.segmentId, rr: record.interval,
    }))
    : tachogramFromPeaks(peaks, data), [rrRecords, peaks, data]);
  const segmentTachogram = tachogramPoints.filter(point => point.t >= segmentStart && point.t <= segmentEnd);

  useEffect(() => {
    if (segmentIndex > segmentCount - 1) {
      setSegmentIndex(Math.max(0, segmentCount - 1));
    }
  }, [segmentCount, segmentIndex]);

  useEffect(() => {
    const canvas = pulseCanvasRef.current;
    if (!canvas) return;
    drawPulseSegment(canvas, segmentData, segmentPeaks, sampleRate, motionIntervals ?? [], segmentStart, segmentEnd);
  }, [segmentData, segmentPeaks, sampleRate, motionIntervals, segmentStart, segmentEnd]);

  useEffect(() => {
    const canvas = tachogramCanvasRef.current;
    if (!canvas) return;
    drawTachogram(canvas, segmentTachogram, motionIntervals ?? [], segmentStart, segmentEnd);
  }, [segmentTachogram, motionIntervals, segmentStart, segmentEnd]);

  if (!data.length) return null;

  return (
    <div className="chart-container pulse-chart">
      <div className="chart-heading">
        <div>
          <span className="section-kicker">POS PPG</span>
          <h4>POS Signal · 0.8–3 Hz filtfilt</h4>
        </div>
        <div className="chart-metrics">
          {heartRate && (
            <span className="heart-rate-value">
              <strong>{Math.round(heartRate)}</strong> BPM
            </span>
          )}
          {segmentHr && (
            <span className="chart-meta">
              Segment HR {Math.round(segmentHr)} BPM
            </span>
          )}
          {peakFrequency && (
            <span className="chart-meta">
              Peak {peakFrequency.toFixed(2)} Hz
            </span>
          )}
          {sampleRate && (
            <span className="chart-meta">Fs {sampleRate.toFixed(1)} Hz</span>
          )}
        </div>
      </div>

      <div className="pulse-segment-controls">
        <button
          type="button"
          className="secondary-button"
          disabled={safeSegmentIndex === 0}
          onClick={() => setSegmentIndex((index) => Math.max(0, index - 1))}
        >
          Previous 15s
        </button>
        <span>
          Segment {safeSegmentIndex + 1} / {segmentCount} ·{" "}
          {segmentStart.toFixed(1)}s -{" "}
          {Math.min(segmentEnd, displayData.at(-1)?.t ?? segmentEnd).toFixed(1)}s
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={safeSegmentIndex >= segmentCount - 1}
          onClick={() =>
            setSegmentIndex((index) => Math.min(segmentCount - 1, index + 1))
          }
        >
          Next 15s
        </button>
      </div>

      <canvas ref={pulseCanvasRef} width={1000} height={280} />
      <p className="chart-note">
        <span aria-hidden="true" style={{ display: "inline-block", width: 14, height: 14, background: "rgba(245, 158, 11, 0.22)", marginRight: 6, verticalAlign: "middle" }} />
        Orange shading marks detected ROI motion. RGB and pulse samples in these intervals are included in the analysis.
      </p>

      <div className="tachogram-section">
        <div className="chart-heading compact">
          <div>
            <span className="section-kicker">RR · SPECTRAL HR ±0.2 Hz</span>
            <h4>Tachogram</h4>
          </div>
          <div className="chart-metrics">
            <span className="chart-meta">{segmentTachogram.length} intervals in this 15s segment</span>
          </div>
        </div>
        <canvas ref={tachogramCanvasRef} width={1000} height={220} />
      </div>

      {hrv && (
        <div className="hrv-grid">
          <div className="metric-card">
            <span>Mean RR</span>
            <strong>{hrv.meanRr.toFixed(1)} ms</strong>
          </div>
          <div className="metric-card">
            <span>SDNN</span>
            <strong>{hrv.sdnn.toFixed(1)} ms</strong>
          </div>
          <div className="metric-card">
            <span>RMSSD</span>
            <strong>{hrv.rmssd.toFixed(1)} ms</strong>
          </div>
          <div className="metric-card">
            <span>pNN50</span>
            <strong>{hrv.pnn50.toFixed(1)}%</strong>
          </div>
          <div className="metric-card">
            <span>HR Range</span>
            <strong>
              {Math.round(hrv.minHeartRate)}-{Math.round(hrv.maxHeartRate)} BPM
            </strong>
          </div>
          <div className="metric-card">
            <span>Detected Peaks</span>
            <strong>{hrv.peakCount}</strong>
          </div>
        </div>
      )}
      {!hrv && (
        <p className="hrv-empty">
          Heart rate and the pulse wave were calculated, but there are not
          enough valid consecutive peak intervals for HRV. Collect more usable
          RGB data to calculate these estimates.
        </p>
      )}
      <p className="chart-note">
        The saved POS signal is shown in 15-second segments after 0.8–3 Hz
        forward-backward (filtfilt) filtering. Spectral HR is estimated every 15 seconds.
        A separate signal is filtered around each spectral HR frequency ±0.2 Hz
        to detect peaks and calculate the tachogram and HRV, including within-subject metrics.
        Tracking gaps and large RR outliers are excluded from HRV summaries.
        HRV values from short recordings are preliminary estimates.
        {refinementBand
          ? ` RR filter bands span ${refinementBand.low.toFixed(2)}-${refinementBand.high.toFixed(2)} Hz across the recording.`
          : ""}
      </p>
      <p className="chart-warning">
        These are video-based estimates and must not be used for medical diagnosis.
      </p>
    </div>
  );
}
