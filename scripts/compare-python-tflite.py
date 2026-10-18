from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import tensorflow as tf


TARGET_FRAMES = 451
TARGET_FS = 100.0
SAMPLES_PER_SEGMENT = 1500
PEAK_THRESHOLD = 0.3
BOUNDARY_THRESHOLD_SECONDS = 0.15
RR_RANGE_MIN_MS = 300.0
RR_RANGE_MAX_MS = 2000.0
HR_GATE_FACTOR = 0.3
MALIK_THRESHOLD = 0.2


def read_frames(path: Path):
    raw = path.read_bytes()
    width, height, n = struct.unpack_from(">QQQ", raw, 0)
    frame_offset = 24
    frame_bytes = width * height * 3 * n
    time_offset = frame_offset + frame_bytes
    if (
        0 < width <= 4096
        and 0 < height <= 4096
        and 0 < n
        and time_offset + n * 8 == len(raw)
    ):
        frames = np.frombuffer(
            raw, dtype=np.uint8, count=frame_bytes, offset=frame_offset
        ).reshape(n, width, height, 3)
        times_us = np.frombuffer(raw, dtype=">u8", count=n, offset=time_offset)
        return frames.copy(), (times_us.astype(np.float64) / 1e6).copy()

    n, w, h = struct.unpack_from("<III", raw, 0)
    times_offset = 12
    frame_offset = times_offset + n * 8
    times = np.frombuffer(raw, dtype="<f8", count=n, offset=times_offset).astype(np.float64)
    frames = np.frombuffer(raw, dtype=np.uint8, offset=frame_offset).reshape(n, h, w, 3)
    return frames.copy(), times.copy()


def zscore(values):
    arr = np.asarray(values, dtype=np.float64)
    std = float(np.std(arr))
    if std < 1e-8 or not math.isfinite(std):
        return arr - float(np.mean(arr))
    return (arr - float(np.mean(arr))) / std


def sigmoid(values):
    arr = np.asarray(values, dtype=np.float64)
    return 1.0 / (1.0 + np.exp(-arr))


def summarize(values):
    arr = np.asarray(values).reshape(-1)
    finite = arr[np.isfinite(arr)]
    nonzero = arr[np.abs(arr) > 1e-6]
    return {
        "length": int(arr.size),
        "min": float(finite.min()) if finite.size else None,
        "max": float(finite.max()) if finite.size else None,
        "first20": arr[:20].astype(float).tolist(),
        "nonZeroFirst20": nonzero[:20].astype(float).tolist(),
    }


def detect_peaks(peak_prob, ppg_hat):
    min_distance = int(round(0.3 * TARGET_FS))
    candidates = []
    for i in range(1, len(peak_prob) - 1):
        if (
            peak_prob[i] >= PEAK_THRESHOLD
            and peak_prob[i] >= peak_prob[i - 1]
            and peak_prob[i] >= peak_prob[i + 1]
        ):
            candidates.append(i)

    selected = []
    snap = int(round(0.05 * TARGET_FS))
    for cand in candidates:
        lo = max(0, cand - snap)
        hi = min(len(ppg_hat) - 1, cand + snap)
        snapped = lo + int(np.argmin(ppg_hat[lo : hi + 1]))
        if not selected or snapped - selected[-1] >= min_distance:
            selected.append(snapped)
        elif peak_prob[snapped] > peak_prob[selected[-1]]:
            selected[-1] = snapped
    return np.asarray(selected, dtype=np.int64)


def remove_boundary_peaks(peaks, boundaries, signal_len):
    thres = int(round(BOUNDARY_THRESHOLD_SECONDS * TARGET_FS))
    drops = set()
    for b in [0, *boundaries, signal_len]:
        before = peaks[peaks < b]
        if before.size and b - int(before[-1]) < thres:
            drops.add(int(before[-1]))
        after = peaks[peaks >= b]
        if after.size and int(after[0]) - b < thres:
            drops.add(int(after[0]))
    return np.asarray([int(p) for p in peaks if int(p) not in drops], dtype=np.int64)


def filter_rr(rr_ms, rr_times_s):
    kept = [(float(rr), float(t)) for rr, t in zip(rr_ms, rr_times_s)
            if RR_RANGE_MIN_MS < rr < RR_RANGE_MAX_MS]
    if len(kept) >= 3:
        t0 = kept[0][1]
        buckets = {}
        for rr, t in kept:
            buckets.setdefault(int(math.floor((t - t0) / 15.0)), []).append(rr)
        next_kept = []
        for rr, t in kept:
            bucket = buckets[int(math.floor((t - t0) / 15.0))]
            if len(bucket) < 3:
                next_kept.append((rr, t))
                continue
            med = float(np.median(bucket))
            if med * (1.0 - HR_GATE_FACTOR) <= rr <= med * (1.0 + HR_GATE_FACTOR):
                next_kept.append((rr, t))
        kept = next_kept
    if len(kept) >= 2:
        malik = [kept[0]]
        for rr, t in kept[1:]:
            prev = malik[-1][0]
            if abs(rr - prev) / (prev + 1e-6) <= MALIK_THRESHOLD:
                malik.append((rr, t))
        kept = malik
    return np.asarray([rr for rr, _ in kept], dtype=np.float64)


def smooth_rr(rr):
    if rr.size < 3:
        return rr
    out = []
    for i in range(rr.size):
        out.append(float(np.median(rr[max(0, i - 1) : min(rr.size, i + 2)])))
    return np.asarray(out, dtype=np.float64)


def hrv_from_peaks(peaks, boundaries, signal_len):
    clip_bounds = [0, *boundaries, signal_len]
    rr_chunks = []
    rr_times = []
    for lo, hi in zip(clip_bounds[:-1], clip_bounds[1:]):
        clip_peaks = peaks[(peaks >= lo) & (peaks < hi)]
        if clip_peaks.size >= 2:
            rr_chunks.extend((np.diff(clip_peaks) / TARGET_FS * 1000.0).tolist())
            rr_times.extend((clip_peaks[:-1] / TARGET_FS).tolist())
    rr_raw = np.asarray(rr_chunks, dtype=np.float64)
    rr_times = np.asarray(rr_times, dtype=np.float64)
    rr_filt = filter_rr(rr_raw, rr_times)
    keep_rate = float(rr_filt.size / max(1, rr_raw.size)) if rr_raw.size else 0.0
    if rr_filt.size < 3:
        return rr_filt, None, keep_rate
    smoothed = smooth_rr(rr_filt)
    rmssd_smooth = (
        float(np.sqrt(np.mean(np.diff(smoothed) ** 2))) if smoothed.size >= 3 else 0.0
    )
    alpha = 1.0 / (1.0 + np.exp(-(rmssd_smooth - 22.0) / 10.0))
    rr = alpha * rr_filt + (1.0 - alpha) * smoothed if smoothed.size == rr_filt.size else rr_filt
    diffs = np.diff(rr)
    hrs = 60000.0 / rr
    rr_cv = float(np.std(rr) / (np.mean(rr) + 1e-6))
    return rr, {
        "meanRr": float(np.mean(rr)),
        "sdnn": float(np.std(rr, ddof=1)),
        "rmssd": float(np.sqrt(np.mean(diffs ** 2))) if diffs.size else 0.0,
        "pnn50": float((np.abs(diffs) > 50).sum() / max(1, diffs.size) * 100.0),
        "minHeartRate": float(np.min(hrs)),
        "maxHeartRate": float(np.max(hrs)),
        "peakCount": int(peaks.size),
        "rrCv": rr_cv,
    }, keep_rate


def main():
    bin_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("face_5m.bin")
    model_path = sys.argv[2] if len(sys.argv) > 2 else "public/models/model_core_v62_fp16.tflite"
    peak_mode = sys.argv[3] if len(sys.argv) > 3 else "zscore"
    frames, times = read_frames(bin_path)
    interpreter = tf.lite.Interpreter(
        model_path=model_path,
        num_threads=8,
        experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES,
    )
    runner = interpreter.get_signature_runner("serving_default")

    n = frames.shape[0]
    stride = TARGET_FRAMES - 1
    last_t0 = max(0, n - TARGET_FRAMES)
    starts = list(range(0, last_t0 + 1, stride)) or [0]
    if starts[-1] != last_t0:
        starts.append(last_t0)

    session_t0 = float(times[0])
    valid_len = int(round((float(times[-1]) - session_t0) * TARGET_FS))
    work_len = valid_len + SAMPLES_PER_SEGMENT
    ppg_session = np.zeros(work_len, dtype=np.float32)
    peak_session = np.zeros(work_len, dtype=np.float32)
    boundaries = []
    prev_end = 0
    prev_tail_ppg = 0.0
    prev_tail_peak = 0.0
    first_summary = None

    for idx, start in enumerate(starts):
        clip_frames = frames[start : start + TARGET_FRAMES]
        clip_ts = (times[start : start + TARGET_FRAMES] - times[start]).astype(np.float32)
        out = runner(frames=clip_frames[None, ...], timestamps=clip_ts[None, ...])
        if first_summary is None:
            first_summary = {name: summarize(value) for name, value in out.items()}
        ppg_clip = np.asarray(out["ppg_100"]).reshape(-1).astype(np.float32)
        peak_clip = np.asarray(out["peak_logits"]).reshape(-1).astype(np.float32)
        off = int(round((float(times[start]) - session_t0) * TARGET_FS))
        end = min(off + SAMPLES_PER_SEGMENT, work_len)
        n_write = end - off
        if idx > 0 and off > prev_end:
            gap = off - prev_end
            interp = np.linspace(0.0, 1.0, gap + 2, dtype=np.float32)[1:-1]
            ppg_session[prev_end:off] = prev_tail_ppg + (float(ppg_clip[0]) - prev_tail_ppg) * interp
            peak_session[prev_end:off] = prev_tail_peak + (float(peak_clip[0]) - prev_tail_peak) * interp
        if idx > 0:
            boundaries.append(off)
        if n_write > 0:
            ppg_session[off:end] = ppg_clip[:n_write]
            peak_session[off:end] = peak_clip[:n_write]
            prev_tail_ppg = float(ppg_clip[n_write - 1])
            prev_tail_peak = float(peak_clip[n_write - 1])
        prev_end = end

    ppg_session = ppg_session[:valid_len]
    peak_session = peak_session[:valid_len]
    ppg_hat = zscore(ppg_session)
    peak_prob = sigmoid(peak_session) if peak_mode == "raw" else sigmoid(zscore(peak_session))
    peaks = remove_boundary_peaks(detect_peaks(peak_prob, ppg_hat), boundaries, len(peak_prob))
    peak_times = peaks.astype(np.float64) / TARGET_FS
    rr_raw = np.diff(peak_times) * 1000.0
    heart_rate = 60000.0 / float(np.mean(rr_raw)) if rr_raw.size else float("nan")
    rr, hrv, keep_rate = hrv_from_peaks(peaks, boundaries, len(peak_prob))
    peak_conf = float(np.mean(peak_prob[peaks])) if peaks.size >= 2 else 0.0
    rr_cv = hrv["rrCv"] if hrv else float("nan")

    print(json.dumps({
        "binPath": str(bin_path),
        "modelPath": model_path,
        "peakMode": peak_mode,
        "frames": int(n),
        "n_windows": len(starts),
        "sampleRate": TARGET_FS,
        "bpm": heart_rate,
        "peakCount": int(peaks.size),
        "quality": peak_conf,
        "keepRate": keep_rate,
        "rrCv": rr_cv,
        "ok": bool(peak_conf >= 0.5 and keep_rate >= 0.5 and (not math.isfinite(rr_cv) or rr_cv <= 0.2)),
        "firstPeaks": peak_times[:10].round(4).tolist(),
        "hrv": hrv,
        "rrIntervalsFirst10": rr[:10].round(4).tolist(),
        "firstOutputSummary": first_summary,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
