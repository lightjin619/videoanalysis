export interface RgbPoint {
  t: number;
  r: number;
  g: number;
  b: number;
}

export interface PulsePoint {
  t: number;
  value: number;
}

export interface HeartRateWindow {
  start: number;
  end: number;
  heartRate: number;
  peakFrequency: number;
  refinementBand: { low: number; high: number };
  reusedPrevious: boolean;
}

export interface PosResult {
  rrRecords?: RrRecord[];
  heartRateWindows?: HeartRateWindow[];
  signal: PulsePoint[];
  sampleRate: number;
  heartRate: number;
  peakFrequency: number;
  refinementBand: { low: number; high: number };
  peaks: number[];
  rrIntervals: number[];
  hrv: HrvMetrics | null;
}

// Keep timing and rejection decisions so every chart/statistic uses the same RR list.
export interface RrRecord {
  start: number;
  end: number;
  interval: number;
  expectedRr: number;
  segmentId: number;
  accepted: boolean;
  rejectionReason?: "range" | "outlier";
}

export interface PpgSample {
  t: number;
  value: number;
}

export interface HrvMetrics {
  meanRr: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
  minHeartRate: number;
  maxHeartRate: number;
  peakCount: number;
}

const POS_WINDOW_SECONDS = 1.6;
const BANDPASS_LOW_HZ = 0.8;
const BANDPASS_HIGH_HZ = 3;
const HR_WINDOW_SECONDS = 15;
export const POS_SIGNAL_PIPELINE = "rgb-pos-filtfilt-0.8-3-v1" as const;
export const POS_RR_PIPELINE = "spectral-15s-filtfilt-pm0.2-v1" as const;
const RR_FILTER_HALF_WIDTH_HZ = 0.2;
// A complete POS projection window is sufficient to display a waveform.
// HRV availability is determined separately by valid consecutive RR intervals.
const MIN_POS_DURATION_SECONDS = POS_WINDOW_SECONDS;
const MAX_SHORT_RGB_GAP_SECONDS = 0.5;

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;
  return Math.sqrt(variance);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function interpolateRgb(data: RgbPoint[], sampleRate: number) {
  const interval = 1 / sampleRate;
  const start = data[0].t;
  const end = data[data.length - 1].t;
  const samples: RgbPoint[] = [];
  let sourceIndex = 0;

  for (let time = start; time <= end; time += interval) {
    while (
      sourceIndex < data.length - 2 &&
      data[sourceIndex + 1].t < time
    ) {
      sourceIndex += 1;
    }

    const left = data[sourceIndex];
    const right = data[Math.min(sourceIndex + 1, data.length - 1)];
    const duration = right.t - left.t;
    const ratio = duration > 0 ? (time - left.t) / duration : 0;
    samples.push({
      t: time,
      r: left.r + (right.r - left.r) * ratio,
      g: left.g + (right.g - left.g) * ratio,
      b: left.b + (right.b - left.b) * ratio,
    });
  }

  return samples;
}

function splitContinuousSegments<T extends { t: number }>(data: T[]) {
  if (data.length < 2) return [data];

  const intervals = data
    .slice(1)
    .map((point, index) => point.t - data[index].t)
    .filter((interval) => interval > 0 && interval < 0.5);
  if (!intervals.length) return [data];

  const typicalInterval = median(intervals);
  // A few rejected ROI frames should not discard an otherwise stable clip.
  // interpolateRgb bridges only these short gaps from their stable endpoints;
  // a longer loss of tracking still starts a new segment.
  const maximumGap = Math.max(
    typicalInterval * 4,
    MAX_SHORT_RGB_GAP_SECONDS
  );
  const segments: T[][] = [];
  let current = data.slice(0, 1);

  for (let index = 1; index < data.length; index += 1) {
    const gap = data[index].t - data[index - 1].t;
    if (gap <= maximumGap) {
      current.push(data[index]);
    } else {
      segments.push(current);
      current = [data[index]];
    }
  }

  segments.push(current);
  return segments;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function applyBiquad(
  values: number[],
  coefficients: BiquadCoefficients
) {
  const output = new Array(values.length).fill(0);
  let x1 = values[0] ?? 0;
  let x2 = x1;
  // Constant-input steady state, as used for the initial conditions in filtfilt.
  const dcGain = (coefficients.b0 + coefficients.b1 + coefficients.b2) /
    (1 + coefficients.a1 + coefficients.a2);
  let y1 = dcGain * x1;
  let y2 = y1;

  for (let index = 0; index < values.length; index += 1) {
    const x0 = values[index];
    const y0 =
      coefficients.b0 * x0 +
      coefficients.b1 * x1 +
      coefficients.b2 * x2 -
      coefficients.a1 * y1 -
      coefficients.a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return output;
}

function reflectPad(values: number[], padding: number) {
  const left = values
    .slice(1, padding + 1)
    .reverse()
    .map((value) => 2 * values[0] - value);
  const last = values[values.length - 1];
  const right = values
    .slice(values.length - padding - 1, values.length - 1)
    .reverse()
    .map((value) => 2 * last - value);
  return [...left, ...values, ...right];
}

function filtfilt(
  values: number[],
  coefficients: BiquadCoefficients,
  sampleRate: number,
  paddingSeconds = 2
) {
  const padding = Math.min(
    values.length - 1,
    Math.max(6, Math.round(sampleRate * paddingSeconds))
  );
  const padded = reflectPad(values, padding);
  const forward = applyBiquad(padded, coefficients);
  const backward = applyBiquad([...forward].reverse(), coefficients).reverse();
  return backward.slice(padding, backward.length - padding);
}

function bandpassFiltfilt(
  values: number[],
  sampleRate: number,
  lowCutoff = BANDPASS_LOW_HZ,
  highCutoff = BANDPASS_HIGH_HZ
) {
  // A high-pass/low-pass pair with fixed Q does not produce a narrow passband
  // when its cutoffs nearly coincide. Prewarp both edges, then transform a
  // Butterworth low-pass prototype to a true second-order band-pass biquad.
  const low = Math.tan(Math.PI * lowCutoff / sampleRate);
  const high = Math.tan(Math.PI * highCutoff / sampleRate);
  const center = Math.sqrt(low * high);
  const omega = 2 * Math.atan(center);
  const q = center / (high - low);
  const alpha = Math.sin(omega) / (2 * q);
  const a0 = 1 + alpha;
  return filtfilt(values, {
    b0: alpha / a0, b1: 0, b2: -alpha / a0,
    a1: -2 * Math.cos(omega) / a0, a2: (1 - alpha) / a0,
  }, sampleRate, Math.max(2, 3 / (Math.PI * (highCutoff - lowCutoff))));
}

function nextPowerOfTwo(value: number) {
  return 2 ** Math.ceil(Math.log2(value));
}

function fft(real: number[], imaginary: number[]) {
  const length = real.length;

  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [
        imaginary[reversed],
        imaginary[index],
      ];
    }
  }

  for (let size = 2; size <= length; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const cosineStep = Math.cos(angle);
    const sineStep = Math.sin(angle);

    for (let start = 0; start < length; start += size) {
      let cosine = 1;
      let sine = 0;

      for (let offset = 0; offset < size / 2; offset += 1) {
        const even = start + offset;
        const odd = even + size / 2;
        const oddReal = real[odd] * cosine - imaginary[odd] * sine;
        const oddImaginary = real[odd] * sine + imaginary[odd] * cosine;

        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;

        const nextCosine = cosine * cosineStep - sine * sineStep;
        sine = cosine * sineStep + sine * cosineStep;
        cosine = nextCosine;
      }
    }
  }
}

function estimateHeartRate(values: number[], sampleRate: number) {
  const fftSize = nextPowerOfTwo(values.length * 4);
  const real = new Array(fftSize).fill(0);
  const imaginary = new Array(fftSize).fill(0);

  values.forEach((value, index) => {
    const hann =
      values.length > 1
        ? 0.5 * (1 - Math.cos((2 * Math.PI * index) / (values.length - 1)))
        : 1;
    real[index] = value * hann;
  });

  fft(real, imaginary);
  const magnitudes = real.map((value, index) =>
    Math.hypot(value, imaginary[index])
  );
  const minimumBin = Math.max(
    1,
    Math.ceil((BANDPASS_LOW_HZ * fftSize) / sampleRate)
  );
  const maximumBin = Math.min(
    fftSize / 2 - 1,
    Math.floor((BANDPASS_HIGH_HZ * fftSize) / sampleRate)
  );

  let peakBin = minimumBin;
  for (let bin = minimumBin + 1; bin <= maximumBin; bin += 1) {
    if (magnitudes[bin] > magnitudes[peakBin]) peakBin = bin;
  }

  const left = magnitudes[peakBin - 1] ?? magnitudes[peakBin];
  const center = magnitudes[peakBin];
  const right = magnitudes[peakBin + 1] ?? magnitudes[peakBin];
  const denominator = left - 2 * center + right;
  const offset =
    Math.abs(denominator) > Number.EPSILON
      ? 0.5 * (left - right) / denominator
      : 0;
  const peakFrequency = ((peakBin + offset) * sampleRate) / fftSize;

  return {
    peakFrequency,
    heartRate: peakFrequency * 60,
  };
}

function detectPulsePeaks(
  values: number[],
  sampleRate: number,
  centerFrequency: number | number[]
) {
  const edgeSamples = Math.min(
    Math.round(sampleRate * 2),
    Math.floor(values.length * 0.1)
  );
  const frequencyAt = (index: number) =>
    typeof centerFrequency === "number" ? centerFrequency : centerFrequency[index];
  const threshold = mean(values) + standardDeviation(values) * 0.05;
  const candidates: number[] = [];

  for (
    let index = Math.max(1, edgeSamples);
    index < values.length - Math.max(1, edgeSamples);
    index += 1
  ) {
    if (
      values[index] > threshold &&
      values[index] > values[index - 1] &&
      values[index] >= values[index + 1]
    ) {
      candidates.push(index);
    }
  }

  const peaks: number[] = [];
  for (const candidate of candidates) {
    const minimumDistance = Math.max(1, Math.floor(sampleRate / frequencyAt(candidate) * 0.6));
    const previous = peaks[peaks.length - 1];
    if (previous === undefined || candidate - previous >= minimumDistance) {
      peaks.push(candidate);
    } else if (values[candidate] > values[previous]) {
      peaks[peaks.length - 1] = candidate;
    }
  }
  return peaks;
}

export function cleanRrRecords(records: RrRecord[]): RrRecord[] {
  // Keep a broad physiological/FFT-consistent range first. The subsequent
  // median absolute deviation (MAD) step is deliberately data-driven so a
  // short motion artefact cannot dominate the HRV summary.
  const plausibleIntervals = records
    .filter(
      ({ interval, expectedRr }) =>
      Number.isFinite(interval) &&
      Number.isFinite(expectedRr) && expectedRr > 0 &&
      interval >= Math.max(250, expectedRr * 0.5) &&
      interval <= Math.min(2000, expectedRr * 1.75)
    );
  const plausible = new Set(plausibleIntervals);
  if (!plausibleIntervals.length) return records.map(record => ({
    ...record, accepted: false, rejectionReason: "range",
  }));
  // Compare RR relative to its local spectral HR so real HR changes survive rejection.
  const rrMedian = median(plausibleIntervals.map(({ interval, expectedRr }) => interval / expectedRr));
  const mad = median(
    plausibleIntervals.map(({ interval, expectedRr }) => Math.abs(interval / expectedRr - rrMedian))
  );
  const robustDeviation = 1.4826 * mad;
  const outlierLimit = Math.max(
    0.2,
    rrMedian * 0.2,
    robustDeviation * 3.5
  );
  return records.map(record => {
    const inRange = plausible.has(record);
    const accepted = inRange && Math.abs(record.interval / record.expectedRr - rrMedian)
      <= Math.max(outlierLimit, 80 / record.expectedRr);
    return { ...record, accepted, rejectionReason: accepted ? undefined : inRange ? "outlier" : "range" };
  });
}

export function successiveRrDifferences(records: RrRecord[]): number[] {
  const accepted = records.filter(record => record.accepted);
  return accepted.slice(1).flatMap((record, index) => {
    const previous = accepted[index];
    return previous.segmentId === record.segmentId && Math.abs(previous.end - record.start) < 1e-6
      ? [record.interval - previous.interval] : [];
  });
}

export function hrvFromRrRecords(records: RrRecord[]): HrvMetrics | null {
  const rrIntervals = records.filter(record => record.accepted).map(record => record.interval);
  if (rrIntervals.length < 3) return null;

  const meanRr = mean(rrIntervals);
  const sdnn = standardDeviation(rrIntervals);
  // Do not join intervals across a rejected artefact: doing so would make an
  // RMSSD/pNN50 difference appear valid even though a beat was missing or
  // falsely detected between the two retained intervals.
  const successiveDifferences = successiveRrDifferences(records);
  if (!successiveDifferences.length) return null;
  const rmssd = Math.sqrt(
    mean(successiveDifferences.map((difference) => difference ** 2))
  );
  const pnn50 =
    (successiveDifferences.filter(
      (difference) => Math.abs(difference) > 50
    ).length /
      successiveDifferences.length) *
    100;
  const instantaneousHeartRates = rrIntervals.map(
    (interval) => 60000 / interval
  );

  return {
    meanRr,
    sdnn,
    rmssd,
    pnn50,
    minHeartRate: Math.min(...instantaneousHeartRates),
    maxHeartRate: Math.max(...instantaneousHeartRates),
    peakCount: new Set(records.filter(record => record.accepted)
      .flatMap(record => [`${record.segmentId}:${record.start}`, `${record.segmentId}:${record.end}`])).size,
  };
}

function rrRecordsFromPeaks(peaks: number[], windows: HeartRateWindow[], fallbackFrequency: number, segmentId = 0): RrRecord[] {
  return peaks.slice(1).map((end, index) => ({
    start: peaks[index], end, interval: (end - peaks[index]) * 1000,
    expectedRr: 1000 / (windows.find(window => end >= window.start && end < window.end)?.peakFrequency ?? fallbackFrequency),
    segmentId, accepted: true,
  }));
}

function weightedHeartRate(windows: HeartRateWindow[]) {
  const duration = windows.reduce((sum, window) => sum + window.end - window.start, 0);
  return windows.reduce((sum, window) => sum + window.heartRate * (window.end - window.start), 0) / duration;
}

// Older saved analyses have no timestamped RR records. Rebuild and clean them
// once per read, preserving waveform gaps; an explicitly empty new list stays empty.
export function analysisRrRecords(result: {
  rrRecords?: RrRecord[]; peakTimes?: number[]; heartRateWindows?: HeartRateWindow[];
  peakFrequency: number; ppgSignal?: Array<[number, number]>;
}, start = -Infinity, end = Infinity): RrRecord[] {
  let records = result.rrRecords;
  if (!records) {
    const gaps = (result.ppgSignal ?? []).slice(1).flatMap((point, index) => {
      const previous = result.ppgSignal![index];
      return point[0] - previous[0] > MAX_SHORT_RGB_GAP_SECONDS ? [[previous[0], point[0]]] : [];
    });
    records = cleanRrRecords(rrRecordsFromPeaks(result.peakTimes ?? [], result.heartRateWindows ?? [], result.peakFrequency)
      .filter(record => !gaps.some(([left, right]) => record.start < right && record.end > left)));
  }
  return records.filter(record => record.accepted && record.start >= start && record.end <= end);
}

export function calculatePosSignal(data: RgbPoint[]): PosResult | null {
  const ordered = data
    .filter((point) => [point.t, point.r, point.g, point.b].every(Number.isFinite)
      && point.r > 0 && point.g > 0 && point.b > 0)
    .sort((a, b) => a.t - b.t)
    .filter((point, index, points) => index === 0 || point.t > points[index - 1].t);
  const results = splitContinuousSegments(ordered)
    .map(calculateContinuousPosSignal)
    .filter((result): result is PosResult => result !== null);
  return combinePulseResults(results);
}

function combinePulseResults(results: PosResult[]): PosResult | null {
  if (!results.length) return null;
  const representative = results.reduce((best, result) =>
    result.signal.length > best.signal.length ? result : best
  );
  const rrRecords = cleanRrRecords(results.flatMap((result, segmentId) =>
    rrRecordsFromPeaks(result.peaks, result.heartRateWindows ?? [], result.peakFrequency, segmentId)));
  return {
    ...representative,
    heartRateWindows: results.flatMap((result) => result.heartRateWindows ?? []),
    heartRate: weightedHeartRate(results.flatMap(result => result.heartRateWindows ?? [])),
    peakFrequency: weightedHeartRate(results.flatMap(result => result.heartRateWindows ?? [])) / 60,
    refinementBand: {
      low: Math.min(...results.map(result => result.refinementBand.low)),
      high: Math.max(...results.map(result => result.refinementBand.high)),
    },
    signal: results.flatMap((result) => result.signal),
    peaks: results.flatMap((result) => result.peaks),
    rrRecords,
    rrIntervals: rrRecords.filter(record => record.accepted).map(record => record.interval),
    hrv: hrvFromRrRecords(rrRecords),
  };
}

function calculateContinuousPosSignal(data: RgbPoint[]): PosResult | null {
  if (data.length < 20) return null;

  const ordered = [...data]
    .sort((a, b) => a.t - b.t)
    .filter(
      (point, index, points) =>
        index === 0 || point.t > points[index - 1].t + Number.EPSILON
    );
  const continuous = ordered;
  const intervals = continuous
    .slice(1)
    .map((point, index) => point.t - continuous[index].t)
    .filter((interval) => interval > 0 && interval < 0.5);
  if (!intervals.length) return null;

  const sampleRate = Math.min(60, Math.max(8, 1 / median(intervals)));
  const samples = interpolateRgb(continuous, sampleRate);
  const windowSize = Math.max(8, Math.round(POS_WINDOW_SECONDS * sampleRate));
  if (samples.length < windowSize) return null;

  const accumulated = new Array(samples.length).fill(0);
  const overlapCount = new Array(samples.length).fill(0);

  for (let start = 0; start <= samples.length - windowSize; start += 1) {
    const window = samples.slice(start, start + windowSize);
    const meanR = mean(window.map((point) => point.r));
    const meanG = mean(window.map((point) => point.g));
    const meanB = mean(window.map((point) => point.b));
    if (meanR === 0 || meanG === 0 || meanB === 0) continue;

    const projectionA: number[] = [];
    const projectionB: number[] = [];

    for (const point of window) {
      const r = point.r / meanR;
      const g = point.g / meanG;
      const b = point.b / meanB;
      projectionA.push(g - b);
      projectionB.push(g + b - 2 * r);
    }

    const deviationB = standardDeviation(projectionB);
    const alpha =
      deviationB > Number.EPSILON
        ? standardDeviation(projectionA) / deviationB
        : 0;
    const projected = projectionA.map(
      (value, index) => value + alpha * projectionB[index]
    );
    const projectedMean = mean(projected);

    projected.forEach((value, index) => {
      const target = start + index;
      accumulated[target] += value - projectedMean;
      overlapCount[target] += 1;
    });
  }

  const combined = accumulated.map((value, index) =>
    overlapCount[index] ? value / overlapCount[index] : 0
  );
  return calculatePulseSignalFromSamples(
    samples.map((sample, index) => ({ t: sample.t, value: combined[index] })),
    sampleRate
  );
}

export function calculatePulseSignalFromSamples(
  samples: PpgSample[],
  sampleRate?: number,
  externalPeakTimes?: number[]
): PosResult | null {
  if (samples.length < 20) return null;

  const ordered = [...samples]
    .sort((a, b) => a.t - b.t)
    .filter(
      (point, index, points) =>
        Number.isFinite(point.value) &&
        (index === 0 || point.t > points[index - 1].t + Number.EPSILON)
    );
  if (ordered.length < 20) return null;
  if (
    ordered[ordered.length - 1].t - ordered[0].t <
    MIN_POS_DURATION_SECONDS
  ) {
    return null;
  }

  const intervals = ordered
    .slice(1)
    .map((point, index) => point.t - ordered[index].t)
    .filter((interval) => interval > 0 && interval < 0.5);
  if (!intervals.length) return null;

  const resolvedSampleRate =
    sampleRate ?? Math.min(60, Math.max(8, 1 / median(intervals)));
  const values = ordered.map((sample) => sample.value);
  if (!Number.isFinite(resolvedSampleRate) || resolvedSampleRate / 2 <= BANDPASS_LOW_HZ + 0.1) return null;
  const highCutoff = Math.min(BANDPASS_HIGH_HZ, resolvedSampleRate / 2 - 0.1);
  const filtered = bandpassFiltfilt(values, resolvedSampleRate, BANDPASS_LOW_HZ, highCutoff);
  return analyzeFilteredPulseSignal(
    ordered.map((point, index) => ({ t: point.t, value: filtered[index] })),
    resolvedSampleRate,
    externalPeakTimes
  );
}

/** Keep the persisted POS waveform; refine a separate copy for RR detection. */
export function analyzeFilteredPosSignal(samples: PpgSample[], sampleRate: number): PosResult | null {
  const ordered = samples.filter(point => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((a, b) => a.t - b.t)
    .filter((point, index, points) => index === 0 || point.t > points[index - 1].t);
  return combinePulseResults(splitContinuousSegments(ordered)
    .map(segment => analyzeFilteredPulseSignal(segment, sampleRate))
    .filter((result): result is PosResult => result !== null));
}

function analyzeFilteredPulseSignal(
  ordered: PpgSample[],
  resolvedSampleRate: number,
  externalPeakTimes?: number[]
): PosResult | null {
  if (ordered.length < 20 || !Number.isFinite(resolvedSampleRate) || resolvedSampleRate <= 6 ||
    ordered[ordered.length - 1].t - ordered[0].t < MIN_POS_DURATION_SECONDS) return null;
  const highCutoff = Math.min(BANDPASS_HIGH_HZ, resolvedSampleRate / 2 - 0.1);
  const filtered = ordered.map(point => point.value);
  const filteredMean = mean(filtered);
  const filteredDeviation = standardDeviation(filtered);
  if (filteredDeviation <= Number.EPSILON) return null;

  const normalized = filtered.map(
    (value) => (value - filteredMean) / filteredDeviation
  );
  const windowSamples = Math.max(1, Math.round(HR_WINDOW_SECONDS * resolvedSampleRate));
  const heartRateWindows: HeartRateWindow[] = [];
  const centers = new Array<number>(ordered.length);
  const refined = new Array<number>(ordered.length).fill(0);
  const weights = new Array<number>(ordered.length).fill(0);
  const overlap = Math.max(1, Math.round(resolvedSampleRate * 0.5));

  for (let start = 0; start < normalized.length; start += windowSamples) {
    const end = Math.min(normalized.length, start + windowSamples);
    const previous = heartRateWindows.at(-1);
    // Short tails reuse the previous HR; short recordings use a provisional spectrum.
    const reusedPrevious = end - start < windowSamples && previous !== undefined;
    const estimate = reusedPrevious ? previous : estimateHeartRate(
      normalized.slice(start, end), resolvedSampleRate
    );
    const peakFrequency = Math.max(BANDPASS_LOW_HZ, Math.min(highCutoff, estimate.peakFrequency));
    const refinementBand = {
      low: Math.max(0.01, peakFrequency - RR_FILTER_HALF_WIDTH_HZ),
      high: Math.min(resolvedSampleRate / 2 - 0.1, peakFrequency + RR_FILTER_HALF_WIDTH_HZ),
    };
    if (refinementBand.high <= refinementBand.low) return null;
    heartRateWindows.push({
      start: ordered[start].t, end: ordered[end - 1].t + 1 / resolvedSampleRate,
      heartRate: peakFrequency * 60, peakFrequency, refinementBand, reusedPrevious,
    });
    centers.fill(peakFrequency, start, end);
    // Include neighboring samples for filter settling, then crossfade only at
    // window boundaries. Peak detection still runs once over the full segment.
    const context = Math.ceil(resolvedSampleRate * Math.max(
      2, 3 / (Math.PI * (refinementBand.high - refinementBand.low))
    ));
    const blendStart = Math.max(0, start - overlap);
    const blendEnd = Math.min(normalized.length, end + overlap);
    const contextStart = Math.max(0, blendStart - context);
    const contextEnd = Math.min(normalized.length, blendEnd + context);
    const windowFiltered = bandpassFiltfilt(
      normalized.slice(contextStart, contextEnd), resolvedSampleRate,
      refinementBand.low, refinementBand.high
    );
    for (let index = blendStart; index < blendEnd; index += 1) {
      const fadeIn = start === 0 ? 1 : Math.min(1, (index - start + overlap) / (2 * overlap));
      const fadeOut = end === normalized.length ? 1 : Math.min(1, (end + overlap - index) / (2 * overlap));
      const weight = (0.5 - 0.5 * Math.cos(Math.PI * fadeIn))
        * (0.5 - 0.5 * Math.cos(Math.PI * fadeOut));
      refined[index] += windowFiltered[index - contextStart] * weight;
      weights[index] += weight;
    }
  }
  const rrSignal = refined.map((value, index) => value / weights[index]);
  const heartRate = weightedHeartRate(heartRateWindows);
  const peakFrequency = heartRate / 60;
  const refinementBand = {
    low: Math.min(...heartRateWindows.map((window) => window.refinementBand.low)),
    high: Math.max(...heartRateWindows.map((window) => window.refinementBand.high)),
  };
  const detectedPeakIndexes = detectPulsePeaks(
    rrSignal,
    resolvedSampleRate,
    centers
  );
  // Parabolic interpolation avoids quantizing every RR to one video frame.
  const detectedPeakTimes = detectedPeakIndexes.map((index) => {
    const left = rrSignal[index - 1], center = rrSignal[index], right = rrSignal[index + 1];
    const denominator = left - 2 * center + right;
    const offset = Math.abs(denominator) > Number.EPSILON
      ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator)) : 0;
    return ordered[index].t + offset / resolvedSampleRate;
  });
  const peakTimes =
    externalPeakTimes && externalPeakTimes.length >= 2
      ? externalPeakTimes
          .filter((time) => time >= ordered[0].t && time <= ordered[ordered.length - 1].t)
          .sort((a, b) => a - b)
      : detectedPeakTimes;
  const rrRecords = cleanRrRecords(rrRecordsFromPeaks(peakTimes, heartRateWindows, peakFrequency));

  return {
    heartRateWindows,
    sampleRate: resolvedSampleRate,
    heartRate,
    peakFrequency,
    refinementBand,
    peaks: peakTimes,
    rrRecords,
    rrIntervals: rrRecords.filter(record => record.accepted).map(record => record.interval),
    hrv: hrvFromRrRecords(rrRecords),
    signal: filtered.map((value, index) => ({
      t: ordered[index].t,
      value,
    })),
  };
}
