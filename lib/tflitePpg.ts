import type { HrvMetrics, PosResult, PulsePoint } from "@/lib/posSignal";

export interface TflitePpgFrame {
  t: number;
  width: number;
  height: number;
  data: Float32Array | Uint8Array;
}

type TensorLike = {
  dataSync: () => Float32Array | Int32Array | Uint8Array;
  dispose: () => void;
};

type ModelLike = {
  inputs: Array<{ shape?: number[]; name?: string; dtype?: string }>;
  outputs: Array<{ shape?: number[]; name?: string; dtype?: string }>;
  predict: (input: unknown) => TensorLike | TensorLike[] | Record<string, TensorLike>;
  execute?: (
    input: unknown,
    outputNames: string | string[]
  ) => TensorLike | TensorLike[];
};

type TfliteModule = {
  setWasmPath: (path: string) => void;
  loadTFLiteModel: (
    model: string | ArrayBuffer,
    options?: { numThreads?: number }
  ) => Promise<ModelLike>;
};

const MODEL_URLS = [
  "/models/model_core_v62_fp16.tflite",
  "/models/model_core_web.tflite",
];
const WASM_PATH = "/tfjs-tflite-wasm/wasm/";
const TARGET_FRAMES = 451;
const TARGET_FS = 100;
const SAMPLES_PER_SEGMENT = 1500;
const NOMINAL_FRAME_INTERVAL_SECONDS = 1 / 30;
const PEAK_THRESHOLD = 0.3;
const BOUNDARY_THRESHOLD_SECONDS = 0.15;
const BOUNDARY_CROSSFADE_SECONDS = 0.15;
const RR_RANGE_MIN_MS = 300;
const RR_RANGE_MAX_MS = 2000;
const HR_GATE_FACTOR = 0.3;
const MALIK_THRESHOLD = 0.2;

let modelPromise: Promise<ModelLike> | null = null;

function parseShape(shape?: number[]) {
  return shape?.map((dimension) => (dimension > 0 ? dimension : -1)) ?? [];
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function standardDeviation(values: number[], sample = false) {
  if (values.length <= (sample ? 1 : 0)) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
    (values.length - (sample ? 1 : 0));
  return Math.sqrt(Math.max(0, variance));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function zscore(values: number[]) {
  const avg = mean(values);
  const std = standardDeviation(values);
  if (std < 1e-8 || !Number.isFinite(std)) {
    return values.map((value) => value - avg);
  }
  return values.map((value) => (value - avg) / std);
}

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function resizeFrameArea(
  frame: TflitePpgFrame,
  targetWidth: number,
  targetHeight: number
) {
  if (frame.width === targetWidth && frame.height === targetHeight) {
    return frame.data;
  }

  const resized = new Float32Array(targetWidth * targetHeight * 3);
  const sourceData = frame.data;
  const scaleX = frame.width / targetWidth;
  const scaleY = frame.height / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(frame.height, Math.max(y0 + 1, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(frame.width, Math.max(x0 + 1, Math.ceil((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const source = (sy * frame.width + sx) * 3;
          r += sourceData[source];
          g += sourceData[source + 1];
          b += sourceData[source + 2];
          count += 1;
        }
      }
      const target = (y * targetWidth + x) * 3;
      resized[target] = r / count;
      resized[target + 1] = g / count;
      resized[target + 2] = b / count;
    }
  }
  return resized;
}

function resolveLayout(shape: number[], fallbackFrame: TflitePpgFrame) {
  const concrete = shape.map((dimension) => (dimension > 0 ? dimension : 0));
  return {
    shape,
    frames: concrete[1] || TARGET_FRAMES,
    height: concrete[2] || fallbackFrame.height,
    width: concrete[3] || fallbackFrame.width,
  };
}

function packClip(frames: TflitePpgFrame[], inputShape: number[], dtype = "float32") {
  const layout = resolveLayout(inputShape, frames[0]);
  const tensorShape = layout.shape.map((dimension, index) => {
    if (dimension > 0) return dimension;
    if (index === 0) return 1;
    if (index === 1) return frames.length;
    return dimension;
  });
  const packed = new Float32Array(frames.length * layout.height * layout.width * 3);
  frames.forEach((frame, frameIndex) => {
    const resized = resizeFrameArea(frame, layout.width, layout.height);
    for (let index = 0; index < resized.length; index += 1) {
      const value = resized[index];
      const byteValue = value <= 1 ? value * 255 : value;
      packed[frameIndex * resized.length + index] =
        dtype === "int32" ? Math.round(byteValue) : byteValue;
    }
  });
  return { packed, shape: tensorShape };
}

function tensorsFromOutput(
  output: TensorLike | TensorLike[] | Record<string, TensorLike>
) {
  if (Array.isArray(output)) {
    return output.map((tensor, index) => ({ name: String(index), tensor }));
  }
  if (
    typeof (output as TensorLike).dataSync === "function" &&
    typeof (output as TensorLike).dispose === "function"
  ) {
    return [{ name: "0", tensor: output as TensorLike }];
  }
  return Object.entries(output as Record<string, TensorLike>).map(
    ([name, tensor]) => ({ name, tensor })
  );
}

function disposeOutput(output: TensorLike | TensorLike[] | Record<string, TensorLike>) {
  if (Array.isArray(output)) {
    output.forEach((tensor) => tensor.dispose());
  } else if (typeof (output as TensorLike).dispose === "function") {
    (output as TensorLike).dispose();
  } else {
    Object.values(output as Record<string, TensorLike>).forEach((tensor) =>
      tensor.dispose()
    );
  }
}

async function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      await import("@tensorflow/tfjs-backend-cpu");
      const tf = await import("@tensorflow/tfjs-core");
      const tflite = (await import(
        "@tensorflow/tfjs-tflite/dist/tf-tflite.es2017.js"
      )) as TfliteModule;
      tflite.setWasmPath(WASM_PATH);
      await tf.setBackend("cpu");
      await tf.ready();
      let lastError: unknown = null;
      for (const modelUrl of MODEL_URLS) {
        try {
          return (await tflite.loadTFLiteModel(modelUrl, {
            numThreads: 1,
          })) as ModelLike;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })();
  }
  return modelPromise;
}

export async function getTflitePpgModelInfo() {
  const model = await loadModel();
  return {
    inputs: model.inputs,
    outputs: model.outputs,
  };
}

function summarize(values: number[]) {
  const finite = values.filter(Number.isFinite);
  return {
    length: values.length,
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
    first20: values.slice(0, 20),
    nonZeroFirst20: values.filter((value) => Math.abs(value) > 1e-6).slice(0, 20),
  };
}

function outputName(model: ModelLike, fallbackName: string, index: number) {
  return `${fallbackName} ${model.outputs[index]?.name ?? ""}`.toLowerCase();
}

async function runClip(
  model: ModelLike,
  clipFrames: TflitePpgFrame[],
  inputShape: number[],
  inputDtype: string
) {
  const tf = await import("@tensorflow/tfjs-core");
  const { packed, shape } = packClip(clipFrames, inputShape, inputDtype);
  const frameInput = tf.tensor(
    packed,
    shape,
    inputDtype === "int32" ? "int32" : "float32"
  );
  const timestampShape = parseShape(model.inputs[1]?.shape);
  const firstTime = clipFrames[0].t;
  const timestamps = Float32Array.from(clipFrames, (frame) => frame.t - firstTime);
  const timestampInput = model.inputs[1]
    ? tf.tensor(timestamps, timestampShape, "float32")
    : null;
  const input = timestampInput
    ? {
        [model.inputs[0].name ?? "serving_default_frames:0"]: frameInput,
        [model.inputs[1].name ?? "serving_default_timestamps:0"]:
          timestampInput,
      }
    : frameInput;
  const requestedOutputs = model.outputs
    .map((outputInfo) => outputInfo.name)
    .filter((name): name is string => Boolean(name));
  let output: TensorLike | TensorLike[] | Record<string, TensorLike>;
  try {
    output =
      model.execute && requestedOutputs.length
        ? model.execute(input, requestedOutputs)
        : model.predict(input);
  } catch (error) {
    if (
      error instanceof Error &&
      /execute\(\).*not supported/i.test(error.message)
    ) {
      output = model.predict(input);
    } else {
      throw error;
    }
  }
  const outputs = tensorsFromOutput(output).map(({ name, tensor }, index) => ({
    name,
    modelName: model.outputs[index]?.name,
    key: outputName(model, name, index),
    values: Array.from(tensor.dataSync(), Number),
  }));
  frameInput.dispose();
  timestampInput?.dispose();
  disposeOutput(output);
  return outputs;
}

function chooseSessionOutputs(
  outputs: Array<{ key: string; values: number[] }>
) {
  if (outputs.length === 1 && outputs[0].values.length >= 3450) {
    return {
      ppg: {
        key: "web_output ppg_100",
        values: outputs[0].values.slice(0, SAMPLES_PER_SEGMENT),
      },
      peak: {
        key: "web_output peak_logits",
        values: outputs[0].values.slice(
          SAMPLES_PER_SEGMENT,
          SAMPLES_PER_SEGMENT * 2
        ),
      },
    };
  }
  const ppgByName = outputs.find((output) => /ppg/.test(output.key));
  const peakByName = outputs.find((output) => /peak/.test(output.key));
  const longOutputs = outputs.filter((output) => output.values.length >= 1000);
  const ppg = ppgByName ?? longOutputs[0] ?? outputs[0];
  const peak =
    peakByName ??
    longOutputs.find((output) => output !== ppg) ??
    outputs.find((output) => output !== ppg) ??
    ppg;
  return { ppg, peak };
}

function hasInvalidModelValues(values: number[]) {
  return values.some(
    (value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000
  );
}

function padShortSession(frames: TflitePpgFrame[]) {
  if (frames.length >= TARGET_FRAMES) return [...frames];
  const padded = [...frames];
  const last = frames[frames.length - 1];
  const observedIntervals = frames
    .slice(1)
    .map((frame, index) => frame.t - frames[index].t)
    .filter((interval) => interval > 0 && interval < 0.5);
  const dt = observedIntervals.length
    ? median(observedIntervals)
    : NOMINAL_FRAME_INTERVAL_SECONDS;
  while (padded.length < TARGET_FRAMES) {
    const previous = padded[padded.length - 1];
    padded.push({ ...last, t: previous.t + dt });
  }
  return padded;
}

function clipStarts(frameCount: number) {
  const stride = TARGET_FRAMES - 1;
  const lastT0 = Math.max(0, frameCount - TARGET_FRAMES);
  const starts: number[] = [];
  for (let start = 0; start <= lastT0; start += stride) {
    starts.push(start);
  }
  if (!starts.length) starts.push(0);
  if (starts[starts.length - 1] !== lastT0) starts.push(lastT0);
  return starts;
}

function normalizeOutputs(ppg100: number[], peakLogits: number[]) {
  return {
    ppgHat: zscore(ppg100),
    peakProb: zscore(peakLogits).map(sigmoid),
  };
}

function smoothBoundaryTransitions(values: number[], boundaries: number[]) {
  const smoothed = [...values];
  const halfWindow = Math.max(2, Math.round(BOUNDARY_CROSSFADE_SECONDS * TARGET_FS));
  for (const boundary of boundaries) {
    const left = boundary - halfWindow;
    const right = boundary + halfWindow;
    if (left < 0 || right >= smoothed.length) continue;
    const leftValue = values[left];
    const rightValue = values[right];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
    for (let index = left + 1; index < right; index += 1) {
      const ratio = (index - left) / (right - left);
      const smoothRatio = ratio * ratio * (3 - 2 * ratio);
      smoothed[index] = leftValue + (rightValue - leftValue) * smoothRatio;
    }
  }
  return smoothed;
}

function detectPeaks(peakProb: number[], ppgHat: number[]) {
  const minDistance = Math.round(0.3 * TARGET_FS);
  const candidates: number[] = [];
  for (let index = 1; index < peakProb.length - 1; index += 1) {
    if (
      peakProb[index] >= PEAK_THRESHOLD &&
      peakProb[index] >= peakProb[index - 1] &&
      peakProb[index] >= peakProb[index + 1]
    ) {
      candidates.push(index);
    }
  }

  const selected: number[] = [];
  for (const candidate of candidates) {
    let snapped = candidate;
    const left = Math.max(0, candidate - Math.round(0.05 * TARGET_FS));
    const right = Math.min(ppgHat.length - 1, candidate + Math.round(0.05 * TARGET_FS));
    for (let index = left; index <= right; index += 1) {
      if (ppgHat[index] < ppgHat[snapped]) snapped = index;
    }
    const previous = selected[selected.length - 1];
    if (previous === undefined || snapped - previous >= minDistance) {
      selected.push(snapped);
    } else if (peakProb[snapped] > peakProb[previous]) {
      selected[selected.length - 1] = snapped;
    }
  }
  return selected;
}

function removeBoundaryPeaks(peaks: number[], boundaries: number[], signalLength: number) {
  const thresholdSamples = Math.round(BOUNDARY_THRESHOLD_SECONDS * TARGET_FS);
  const drops = new Set<number>();
  for (const boundary of [0, ...boundaries, signalLength]) {
    const before = peaks.filter((peak) => peak < boundary).at(-1);
    if (before !== undefined && boundary - before < thresholdSamples) {
      drops.add(before);
    }
    const after = peaks.find((peak) => peak >= boundary);
    if (after !== undefined && after - boundary < thresholdSamples) {
      drops.add(after);
    }
  }
  return peaks.filter((peak) => !drops.has(peak));
}

function filterRr(rrMs: number[], rrTimesSeconds: number[]) {
  let kept = rrMs
    .map((value, index) => ({ value, time: rrTimesSeconds[index] }))
    .filter(({ value }) => value > RR_RANGE_MIN_MS && value < RR_RANGE_MAX_MS);

  if (kept.length >= 3) {
    const buckets = new Map<number, number[]>();
    const t0 = kept[0].time;
    kept.forEach(({ value, time }) => {
      const bucket = Math.floor((time - t0) / 15);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), value]);
    });
    kept = kept.filter(({ value, time }) => {
      const bucketValues = buckets.get(Math.floor((time - t0) / 15)) ?? [];
      if (bucketValues.length < 3) return true;
      const med = median(bucketValues);
      return value >= med * (1 - HR_GATE_FACTOR) && value <= med * (1 + HR_GATE_FACTOR);
    });
  }

  if (kept.length >= 2) {
    const malikFiltered = [kept[0]];
    for (let index = 1; index < kept.length; index += 1) {
      const previous = malikFiltered[malikFiltered.length - 1].value;
      if (Math.abs(kept[index].value - previous) / (previous + 1e-6) <= MALIK_THRESHOLD) {
        malikFiltered.push(kept[index]);
      }
    }
    kept = malikFiltered;
  }

  return kept.map(({ value }) => value);
}

function smoothRr(rr: number[]) {
  if (rr.length < 3) return rr;
  return rr.map((value, index) => {
    const start = Math.max(0, index - 1);
    const end = Math.min(rr.length, index + 2);
    return median(rr.slice(start, end));
  });
}

function hrvFromPeaks(peaks: number[], boundaries: number[], signalLength: number) {
  const clipBounds = [0, ...boundaries, signalLength];
  const rrChunks: number[] = [];
  const rrTimes: number[] = [];
  for (let index = 0; index < clipBounds.length - 1; index += 1) {
    const lo = clipBounds[index];
    const hi = clipBounds[index + 1];
    const clipPeaks = peaks.filter((peak) => peak >= lo && peak < hi);
    for (let peakIndex = 1; peakIndex < clipPeaks.length; peakIndex += 1) {
      rrChunks.push(((clipPeaks[peakIndex] - clipPeaks[peakIndex - 1]) / TARGET_FS) * 1000);
      rrTimes.push(clipPeaks[peakIndex - 1] / TARGET_FS);
    }
  }

  const rrFiltered = filterRr(rrChunks, rrTimes);
  if (rrFiltered.length < 3) {
    return { rrIntervals: rrFiltered, metrics: null };
  }

  const smoothed = smoothRr(rrFiltered);
  const rmssdSmooth =
    smoothed.length >= 3
      ? Math.sqrt(mean(smoothed.slice(1).map((value, index) => (value - smoothed[index]) ** 2)))
      : 0;
  const alpha = 1 / (1 + Math.exp(-(rmssdSmooth - 22) / 10));
  const rr =
    smoothed.length === rrFiltered.length
      ? rrFiltered.map((value, index) => alpha * value + (1 - alpha) * smoothed[index])
      : alpha > 0.5
        ? rrFiltered
        : smoothed;
  const successiveDifferences = rr.slice(1).map((value, index) => value - rr[index]);
  const heartRates = rr.map((interval) => 60000 / interval);
  const metrics: HrvMetrics = {
    meanRr: mean(rr),
    sdnn: standardDeviation(rr, true),
    rmssd: Math.sqrt(mean(successiveDifferences.map((value) => value ** 2))),
    pnn50:
      successiveDifferences.length > 0
        ? (successiveDifferences.filter((value) => Math.abs(value) > 50).length /
            successiveDifferences.length) *
          100
        : 0,
    minHeartRate: Math.min(...heartRates),
    maxHeartRate: Math.max(...heartRates),
    peakCount: peaks.length,
  };
  return { rrIntervals: rr, metrics };
}

function resultFromSession(
  ppg100: number[],
  peakLogits: number[],
  boundaries: number[]
): PosResult | null {
  if (ppg100.length < TARGET_FS * 5) return null;
  const { ppgHat, peakProb } = normalizeOutputs(ppg100, peakLogits);
  const displayPpgHat = smoothBoundaryTransitions(ppgHat, boundaries);
  const peaks = removeBoundaryPeaks(
    detectPeaks(peakProb, ppgHat),
    boundaries,
    peakProb.length
  );
  if (peaks.length < 2) return null;

  const peakTimes = peaks.map((peak) => peak / TARGET_FS);
  const rawRr = peakTimes.slice(1).map((time, index) => (time - peakTimes[index]) * 1000);
  const meanRr = mean(rawRr);
  const heartRate = 60000 / meanRr;
  const { rrIntervals, metrics } = hrvFromPeaks(peaks, boundaries, peakProb.length);
  const signal: PulsePoint[] = displayPpgHat.map((value, index) => ({
    t: index / TARGET_FS,
    value: -value,
  }));

  return {
    signal,
    sampleRate: TARGET_FS,
    heartRate,
    peakFrequency: heartRate / 60,
    refinementBand: { low: 0.5, high: 4 },
    peaks: peakTimes,
    rrIntervals,
    hrv: metrics,
  };
}

export async function inspectTflitePpgOutputs(frames: TflitePpgFrame[]) {
  const prepared = padShortSession(
    [...frames]
      .sort((a, b) => a.t - b.t)
      .filter((frame, index, all) => index === 0 || frame.t > all[index - 1].t)
  );
  const model = await loadModel();
  const outputs = await runClip(
    model,
    prepared.slice(0, TARGET_FRAMES),
    parseShape(model.inputs[0]?.shape),
    model.inputs[0]?.dtype ?? "float32"
  );
  return outputs.map((output) => ({
    name: output.name,
    modelName: output.modelName,
    summary: summarize(output.values),
  }));
}

export async function extractTflitePpg(
  frames: TflitePpgFrame[]
): Promise<PosResult | null> {
  const ordered = [...frames]
    .sort((a, b) => a.t - b.t)
    .filter((frame, index, all) => index === 0 || frame.t > all[index - 1].t);
  if (ordered.length < 20) return null;

  const prepared = padShortSession(ordered);
  const model = await loadModel();
  const inputShape = parseShape(model.inputs[0]?.shape);
  const inputDtype = model.inputs[0]?.dtype ?? "float32";
  const starts = clipStarts(prepared.length);
  const sessionT0 = prepared[0].t;
  const sessionLast = ordered[ordered.length - 1].t;
  const validLength = Math.max(1, Math.round((sessionLast - sessionT0) * TARGET_FS));
  const workLength = validLength + SAMPLES_PER_SEGMENT;
  const ppg100 = Array(workLength).fill(0);
  const peakLogits = Array(workLength).fill(0);
  const boundaries: number[] = [];
  let previousEnd = 0;
  let previousTailPpg = 0;
  let previousTailPeak = 0;

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const clip = prepared.slice(start, start + TARGET_FRAMES);
    const outputs = await runClip(model, clip, inputShape, inputDtype);
    const { ppg, peak } = chooseSessionOutputs(outputs);
    const off = Math.round((prepared[start].t - sessionT0) * TARGET_FS);
    const end = Math.min(off + SAMPLES_PER_SEGMENT, workLength);
    const nWrite = Math.max(0, end - off);

    if (index > 0 && off > previousEnd) {
      const gap = off - previousEnd;
      const headPpg = ppg.values[0] ?? previousTailPpg;
      const headPeak = peak.values[0] ?? previousTailPeak;
      for (let gapIndex = 0; gapIndex < gap; gapIndex += 1) {
        const ratio = (gapIndex + 1) / (gap + 1);
        ppg100[previousEnd + gapIndex] =
          previousTailPpg + (headPpg - previousTailPpg) * ratio;
        peakLogits[previousEnd + gapIndex] =
          previousTailPeak + (headPeak - previousTailPeak) * ratio;
      }
    }
    if (index > 0) boundaries.push(off);

    if (hasInvalidModelValues(ppg.values) || hasInvalidModelValues(peak.values)) {
      throw new Error(
        "TFLite output is invalid in the browser runtime. The current model needs a web-compatible export."
      );
    }

    for (let sample = 0; sample < nWrite; sample += 1) {
      ppg100[off + sample] = ppg.values[sample] ?? ppg.values.at(-1) ?? 0;
      peakLogits[off + sample] = peak.values[sample] ?? peak.values.at(-1) ?? 0;
    }
    if (nWrite > 0) {
      previousTailPpg = ppg100[end - 1];
      previousTailPeak = peakLogits[end - 1];
    }
    previousEnd = end;
  }

  return resultFromSession(
    ppg100.slice(0, validLength),
    peakLogits.slice(0, validLength),
    boundaries.filter((boundary) => boundary > 0 && boundary < validLength)
  );
}
