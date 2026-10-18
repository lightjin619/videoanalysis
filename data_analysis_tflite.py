"""deploy/model_core.tflite 검증 GUI — face.bin + ref.csv 1:1 비교.

현재 deploy 모델: **baseline_v48** (anti-spoofing training negatives + morphology
+3-7% 개선 + fp16 4 GB RAM Android variant). TFLite signature 는 v25 부터 동일
— 이 스크립트는 모델 버전 무관 (deploy/model_core.tflite 경로만 봄). 옛 v45
또는 v32 비교는 좌상단 모델 경로 입력란에 deploy/model_core_v45_fp16.tflite
또는 로컬 backup 인 deploy/model_core_v32.tflite 지정.

흐름 (v25+ 옵션 C, timestamp-aware):
  1. 폴더 선택 → face.bin (필수) + ref.csv (선택)
  2. face.bin → (N, 36, 36, 3) uint8 frames + (N,) us timestamps.
  3. **30 FPS 균일 격자 리샘플 안 함**. frame-based non-overlap clip stepping
     (starts = [0, T_IN, 2·T_IN, …, last_t0], 451 frames per clip) 로
     raw frames + clip-상대 초 단위 timestamps 두 텐서를 deploy/model_core.tflite
     의 serving_default signature 에 전달. 모델 내부 timestamp-aware interp 가
     100 Hz 출력 격자 (ppg_100 + peak_logits) 생성.
  4. Python 후처리 (`deploy.run_core_reference`):
     - Stitching: clip 출력을 round((frame_ts[s] - session_t0) * 100) offset 에 배치
     - Session-level normalize: z-score + sigmoid (stitch 이후 한 번에)
     - detect_peaks (v21): find_peaks(height=0.3, distance=0.3s) + ±50ms ppg_hat
       local-min snap
     - compute_hrv (v26 adaptive smoothing): smoothed RMSSD > 30 ms 이면 raw RR
       (no smoothing) 사용 → high-HRV (e.g. s028_ywc RMSSD 64+) 케이스에서
       smoothing 이 진짜 변동까지 깎는 under-estimate 방지. 그 외 (≤25) 는
       smoothing 으로 양자화 noise 평탄화.
  5. ref.csv 는 100 Hz uniform 그리드에 linear interp 후 다음 파이프라인으로
     단일 HRV 산출:
       - baseline 제거 (0.3 Hz lowpass 빼기) → drift 차단
       - 0.5-4 Hz bandpass → dicrotic / diastolic HF 감쇠
       - VPG (1차 미분) 양의 peak → 직후 첫 zero-crossing (positive→negative)
         = PPG slope=0 = systolic peak. morphology 비정상 (diastolic ≥ systolic)
         케이스에서도 robust.
       - rPPG 와 동일한 Malik artifact filter (range → HR gate → Malik 20%)
  6. 4 단 plot:
       - HRV 비교 표 (Ref / TFLite Model)
       - rPPG vs Ref 파형 overlay (Medicore convention 으로 systolic-DOWN)
       - peak_prob + threshold + 검출 피크
       - RR overlay (kept/dropped 분리 마커 + drop reason 카운트)

Reference: deploy/eval_test_with_core.py:session_infer_tflite — 동일 spec, 같은
stitch offset, 같은 adaptive smoothing.

실행:
    python -m examples.data_analysis_tflite

필요 패키지:
    PyQt5, pyqtgraph, numpy, scipy, tensorflow (>=2.15)
"""

from __future__ import annotations

import csv
import logging
import os
import sys
import time

import numpy as np
import pyqtgraph as pg

# Windows venv에서 Qt 플랫폼 플러그인 경로가 깨지는 문제 방지
# (사용자명에 한글이 있으면 ANSI codepage 경로 탐색이 실패)
if sys.platform == "win32":
    import PyQt5
    _qt_plugin_path = os.path.join(os.path.dirname(PyQt5.__file__), "Qt5", "plugins")
    os.environ.setdefault("QT_PLUGIN_PATH", _qt_plugin_path)
    os.environ.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH",
                          os.path.join(_qt_plugin_path, "platforms"))

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QLineEdit, QFileDialog, QMessageBox,
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from libs.hrv import (  # noqa: E402
    compute_hrv as _hrv_compute_from_ibi,
    filter_rr_artifacts,
    hrv_from_signal_wideband,
)
from libs.preprocess_mtx import extract_mtx_signal  # noqa: E402
# model_core 후처리 primitives — deploy/run_core_reference.py 가 Kotlin 포팅 spec.
# 정확히 동일한 함수를 호출해 e2e 결과와 parity 보장.
from deploy.run_core_reference import (  # noqa: E402
    normalize_outputs,
    detect_peaks,
    compute_hrv,
    filter_rr,
    smooth_rr,
    PEAK_THRESHOLD,
    QUALITY_MIN_CONF,
    QUALITY_MIN_KEEP,
    QUALITY_MAX_CV,
    FIXED_SESSION_FRAMES,
    TARGET_FS as CORE_TARGET_FS,
    RR_RANGE_MIN_MS,
    RR_RANGE_MAX_MS,
    HR_GATE_FACTOR,
    MALIK_TH,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ─── 상수 ────────────────────────────────────────────────────────────────
TARGET_FRAMES = 451            # 15 s @ 30 FPS + 1 motion 버퍼
TARGET_FS = 100.0              # ppg_hat 출력 sample rate
CLIP_SECONDS = TARGET_FRAMES / 30.0  # 15.0333... s

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL = os.path.join(PROJECT_ROOT, "deploy", "model_core.tflite")
RECORD_DIR = os.path.join(os.path.dirname(__file__), "records")

# model_core 는 SELECT_TF_OPS 미사용 (Play Store 배포 호환). HRV 후처리는 Python
# (deploy/run_core_reference.py) 에서 — 안드로이드는 동일 spec 의 Kotlin 포팅으로 수행.


# ─── 헬퍼 ────────────────────────────────────────────────────────────────
def _zscore_np(x: np.ndarray) -> np.ndarray:
    std = float(np.std(x))
    if std < 1e-8 or not np.isfinite(std):
        return x - float(np.mean(x))
    return (x - float(np.mean(x))) / std


def _filter_rr_with_reasons(rr_ms,
                             range_min=RR_RANGE_MIN_MS,
                             range_max=RR_RANGE_MAX_MS,
                             hr_gate_factor=HR_GATE_FACTOR,
                             malik_th=MALIK_TH,
                             rr_times_s=None,
                             clip_seconds=15.0):
    """deploy.run_core_reference.filter_rr 와 libs.hrv.filter_rr_artifacts
    의 3-stage 필터 미러 — 각 단계에서 떨어진 인덱스를 같이 반환.

    HRV 분석에서 제외된 RR 을 시각화하는 용도. HR gate 는 stat 계산 (libs.hrv.
    filter_rr_artifacts) 과 동일하게 per-clip 15s local median 사용 — 측정 중
    HR drift 가 있으면 global median 게이트는 정상 RR 까지 outlier 로 잡음.
    rr_times_s 가 None 이면 옛 global median 동작 (호환).

    Args:
        rr_times_s: (N,) — 각 RR 의 *시작 peak 시각*. None → global gate.
        clip_seconds: per-clip window 크기 (sec). 기본 15.0.

    Returns: dict {
        "kept":    (N,) bool — True 면 HRV 분석에 포함됨
        "range":   (N,) bool — range filter 단계에서 drop
        "hr_gate": (N,) bool — HR gate 밖 (per-clip 또는 global)
        "malik":   (N,) bool — 인접 RR 과 |Δ|/prev > 0.2
    }
    한 RR 은 가장 먼저 fail 한 stage 에만 mark 됨 (mutual exclusive).
    """
    rr = np.asarray(rr_ms, dtype=np.float64)
    N = rr.size
    kept = np.ones(N, dtype=bool)
    range_drop = np.zeros(N, dtype=bool)
    gate_drop = np.zeros(N, dtype=bool)
    malik_drop = np.zeros(N, dtype=bool)
    if N == 0:
        return {"kept": kept, "range": range_drop,
                "hr_gate": gate_drop, "malik": malik_drop}

    # Stage 1 — range
    range_drop = ~((rr > range_min) & (rr < range_max))
    kept[range_drop] = False

    # Stage 2 — HR gate. rr_times_s 제공 시 per-clip 15s local median, 아니면
    # 옛 global median.
    surv = np.where(kept)[0]
    if surv.size >= 3 and hr_gate_factor > 0:
        rr_s = rr[surv]
        if rr_times_s is not None and len(rr_times_s) == N and clip_seconds > 0:
            t_s = np.asarray(rr_times_s, dtype=np.float64)[surv]
            t0 = float(t_s[0])
            buckets = np.floor((t_s - t0) / clip_seconds).astype(np.int64)
            gate_fail_local = np.zeros(surv.size, dtype=bool)
            for b in np.unique(buckets):
                m = (buckets == b)
                if m.sum() < 3:
                    continue   # bucket 표본 부족 — skip
                bvals = rr_s[m]
                med = float(np.median(bvals))
                lo = med * (1.0 - hr_gate_factor)
                hi = med * (1.0 + hr_gate_factor)
                gate_fail_local |= m & ~((rr_s >= lo) & (rr_s <= hi))
        else:
            med = float(np.median(rr_s))
            lo = med * (1.0 - hr_gate_factor)
            hi = med * (1.0 + hr_gate_factor)
            gate_fail_local = ~((rr_s >= lo) & (rr_s <= hi))
        bad = surv[gate_fail_local]
        gate_drop[bad] = True
        kept[bad] = False

    # Stage 3 — Malik (sequential, first kept)
    surv = np.where(kept)[0]
    if surv.size >= 2:
        rr_s = rr[surv]
        prev = np.concatenate([rr_s[:1], rr_s[:-1]])
        ratio = np.abs(rr_s - prev) / (prev + 1e-6)
        ratio[0] = 0.0
        malik_fail_local = ratio > malik_th
        bad = surv[malik_fail_local]
        malik_drop[bad] = True
        kept[bad] = False

    return {"kept": kept, "range": range_drop,
            "hr_gate": gate_drop, "malik": malik_drop}


def _add_compact_legend(plot_item, offset=(-10, 10)):
    """addLegend 의 compact 버전 — 작고 반투명한 배경, 좁은 padding.

    pyqtgraph 의 기본 legend 는 좌상단(=offset=(10,10)) 에 불투명 검정 배경으로
    그려져 시계열 데이터 위를 크게 가린다. 우상단 anchor + 반투명 배경 + 8pt
    텍스트로 데이터 가림을 최소화. offset 의 음수는 anchor 가 plot 우/하단
    경계 기준임을 의미 (pyqtgraph 규칙).
    """
    legend = plot_item.addLegend(
        offset=offset,
        labelTextSize="8pt",
        horSpacing=8,
        verSpacing=-3,
        brush=pg.mkBrush(30, 30, 30, 160),
        pen=pg.mkPen(120, 120, 120, 120),
    )
    return legend


def _load_ref_csv(path: str):
    """ref.csv → 100 Hz uniform 그리드 (build_cache.py 패턴 동일).

    스텝:
      1) CSV (time_s, ppg) 로드
      2) t_first..t_last 구간을 0.01 s spacing 으로 채움 (M = round(Δt*100) + 1)
      3) np.interp 로 PPG 보간, int16 clip
    반환: (ppg_ts_s float64, ppg_raw float64) — t[0] = CSV 첫 ts 그대로 유지.
    """
    if not os.path.exists(path):
        return None, None
    times, vals = [], []
    with open(path, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        _ = next(reader, None)
        for row in reader:
            if len(row) < 2:
                continue
            try:
                times.append(float(row[0]))
                vals.append(float(row[1]))
            except ValueError:
                continue
    if not times or len(times) < 2:
        return None, None
    ppg_ts_raw = np.asarray(times, dtype=np.float64)
    ppg_raw_orig = np.asarray(vals, dtype=np.float64)
    t_first = float(ppg_ts_raw[0])
    t_last = float(ppg_ts_raw[-1])
    M = int(round((t_last - t_first) * 100.0)) + 1
    ppg_ts_s = np.arange(M, dtype=np.float64) / 100.0 + t_first
    ppg_raw_f = np.interp(ppg_ts_s, ppg_ts_raw, ppg_raw_orig)
    ppg_raw = np.clip(ppg_raw_f, -32768.0, 32767.0)   # int16 range, dtype 유지(f64)
    return ppg_ts_s, ppg_raw

def _safe(v):
    try:
        fv = float(np.asarray(v).ravel()[0])
        return fv if np.isfinite(fv) else None
    except Exception:
        return None


SEGMENT_SECONDS = 15.0    # model_core 입력 길이 = 1 segment
SEGMENT_US = int(SEGMENT_SECONDS * 1e6)
SAMPLES_PER_SEGMENT = int(SEGMENT_SECONDS * CORE_TARGET_FS)   # 1500
PERIOD_US = 33333          # 30 FPS = 1/30 s


def _bandpass_for_display(signal: np.ndarray, fs: float = 100.0,
                            lo: float = 0.5, hi: float = 8.0,
                            order: int = 3) -> np.ndarray:
    """libs.hrv.bandpass_filter 와 동일한 0.5–8 Hz Butterworth filtfilt.

    Display / find_peaks / 학습 입력 (ppg_100) 모두 0.5–8 Hz 동일 band 사용 —
    peak 마커가 화면 곡선의 정확한 systolic 위치에 박힘.
    """
    from scipy.signal import butter, filtfilt
    nyq = fs / 2
    b, a = butter(order, [lo / nyq, hi / nyq], btype="band")
    return filtfilt(b, a, signal)


# v25 (옵션 C): 30 FPS 균일 격자 resample 함수 (_resample_at_anchor) 폐기.
# 모델이 raw non-uniform timestamps 를 직접 받아 내부 timestamp-aware interp
# 로 100 Hz 출력을 만들기 때문에 frame-side resample 불필요.


def _run_tflite(model_path: str, frames_raw: np.ndarray,
                 time_us_raw: np.ndarray):
    """model_core sliding-window 추론 + 전 세션 HRV → (out_dict, infer_ms).

    옵션 C (v25 이후) — 모델 입력이 **frames + timestamps** 두 텐서. 30 FPS
    균일 격자 리샘플은 안 함. 카메라의 raw non-uniform 시퀀스와 frame 별 raw
    timestamp 를 그대로 모델에 넣어 모델 내부 timestamp-aware interp 가 100 Hz
    출력 격자를 만든다. (deploy/eval_test_with_core.py:session_infer_tflite,
    deploy/run_core_reference.py:prepare_clip 와 동일 spec.)

    Stitching: clip i 의 model 출력은 시각 [frame_ts[s_i], frame_ts[s_i]+15s]
    의 100 Hz uniform 격자라, session 시계열에서의 시작 sample = (frame_ts[s_i]
    - session_t0) * 100. 옛 버전처럼 `s * fs/30` 으로 두면 카메라 jitter /
    startup delay 누적분만큼 매 clip 이 잘못된 sample 위치에 박혀 Pearson r
    하락.

    Normalize: 옵션 C 는 session-level z-score (모든 clip stitch 후 한 번).
    옛 per-window normalize 는 clip 경계에서 discontinuity 를 만들어 peak
    detection 을 흔들었음.

    반환 dict 의 추가 키:
      n_windows  : 처리된 clip 수 (frame-based, T_IN 만큼 stride)
      face_t0_s  : face.bin 첫 프레임의 절대 시각(s) — recording origin
                   (_record_t_mono_base = 첫 PPG sample) 기준. ref.csv 의
                   time_s 와 같은 anchor 이므로, ref 를 rPPG 시간축에 정렬할 때
                   `t_ref - face_t0_s` 로 shift 하면 두 신호가 정확히 같은
                   절대 시각을 가리키게 된다.
    """
    import tensorflow as tf  # lazy
    time_us_raw = time_us_raw.astype(np.int64)
    frames_raw = frames_raw.astype(np.uint8)

    N = frames_raw.shape[0]
    T_IN = TARGET_FRAMES - 1   # 450; clip 은 T_IN+1=451 프레임
    if N < 2:
        raise ValueError(f"face.bin 프레임 수 너무 적음: {N}")

    # 짧은 세션 (N < 451) 은 run_core_reference.prepare_clip 패턴으로 마지막
    # 프레임 replicate 패딩 + nominal Δt=1/30s 의 가짜 ts 추가. 모델은 ts-aware
    # interp 라 패딩 구간은 출력 끝에 평탄 prefix 로 나타남 — 짧은 세션 사용자
    # 가 적어도 1개의 clip 결과를 받아볼 수 있게 함.
    if N < TARGET_FRAMES:
        pad_n = TARGET_FRAMES - N
        last_dt_us = int(round(1e6 / 30.0))
        pad_ts = time_us_raw[-1] + np.arange(1, pad_n + 1, dtype=np.int64) * last_dt_us
        time_us_raw = np.concatenate([time_us_raw, pad_ts])
        frames_raw = np.concatenate(
            [frames_raw, np.repeat(frames_raw[-1:], pad_n, axis=0)], axis=0)
        N = frames_raw.shape[0]
        logger.warning(
            "face.bin 프레임 부족 (%d < %d) — 마지막 프레임 %d 회 replicate 패딩 적용",
            N - pad_n, TARGET_FRAMES, pad_n)

    frame_ts_s = (time_us_raw.astype(np.float64) / 1e6)
    session_t0 = float(frame_ts_s[0])
    session_t_last = float(frame_ts_s[-1])
    total_duration_s = session_t_last - session_t0

    # 인터프리터 한 번만 로드해 모든 윈도우에서 재사용
    # num_threads=8: 단일 invoke 1.7s → 0.55s (~3× speedup). 16 이상은 hyperthread
    # contention 으로 오히려 회귀. CPU 코어 수에 무관하게 8 고정.
    interp = tf.lite.Interpreter(
        model_path=model_path,
        num_threads=8,
        experimental_op_resolver_type=(
            tf.lite.experimental.OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES),
    )
    runner = interp.get_signature_runner("serving_default")

    # Frame-index 기반 비-overlap clip stepping. 마지막 clip 은 N-(T_IN+1) 에
    # pin 해서 session 꼬리까지 커버 (eval_tf.py / eval_test_with_core 와 동일).
    last_t0 = max(0, N - (T_IN + 1))
    starts = list(range(0, last_t0 + 1, T_IN))
    if not starts:
        starts = [0]
    if starts[-1] != last_t0:
        starts.append(last_t0)
    n_windows = len(starts)

    # Session-level 출력 버퍼 — 각 clip 의 1500-sample 출력을
    # `(frame_ts[s] - session_t0) * TARGET_FS` 위치에 채워 stitch.
    valid_len = int(round(total_duration_s * TARGET_FS))
    work_len = valid_len + int(SAMPLES_PER_SEGMENT)   # +T_OUT safety pad
    ppg_100_session = np.zeros(work_len, dtype=np.float32)
    peak_logits_session = np.zeros(work_len, dtype=np.float32)
    infer_ms_total = 0.0

    # Inter-clip stitch boundaries — 후처리에서 ±150 ms 안의 peak 를 stitching
    # artifact 로 간주해 drop. eval_test_with_core.py:session_infer_tflite 와
    # 동일 spec.
    boundaries: list[int] = []
    prev_end = 0
    prev_tail_ppg = 0.0
    prev_tail_peak = 0.0

    for i, s in enumerate(starts):
        clip_frames = frames_raw[s:s + T_IN + 1]
        clip_ts_s = (frame_ts_s[s:s + T_IN + 1] - frame_ts_s[s]).astype(np.float32)

        t0 = time.time()
        fwd = runner(frames=clip_frames[None, ...],
                     timestamps=clip_ts_s[None, ...])
        infer_ms_total += (time.time() - t0) * 1000.0
        ppg_clip = np.asarray(fwd["ppg_100"]).reshape(-1).astype(np.float32)
        lg_clip = np.asarray(fwd["peak_logits"]).reshape(-1).astype(np.float32)

        off = int(round((float(frame_ts_s[s]) - session_t0) * TARGET_FS))
        end = min(off + int(SAMPLES_PER_SEGMENT), work_len)
        n_write = end - off

        # Gap fill (camera FPS drop 으로 clip 사이 빈 sample 이 생기면 zeros 가
        # 남아 sigmoid(0)=0.5 → spurious peak 됨). 직전 clip 끝값과 현 clip
        # 첫값 사이 linear interp 으로 메움.
        if i > 0 and off > prev_end:
            head_ppg = float(ppg_clip[0])
            head_peak = float(lg_clip[0])
            n_gap = off - prev_end
            ts_interp = np.linspace(0.0, 1.0, n_gap + 2)[1:-1]
            ppg_100_session[prev_end:off] = (
                prev_tail_ppg + (head_ppg - prev_tail_ppg) * ts_interp
            ).astype(np.float32)
            peak_logits_session[prev_end:off] = (
                prev_tail_peak + (head_peak - prev_tail_peak) * ts_interp
            ).astype(np.float32)
        if i > 0:
            boundaries.append(off)

        if n_write > 0:
            ppg_100_session[off:end] = ppg_clip[:n_write]
            peak_logits_session[off:end] = lg_clip[:n_write]
            prev_tail_ppg = float(ppg_clip[n_write - 1])
            prev_tail_peak = float(lg_clip[n_write - 1])
        prev_end = end

    ppg_100_session = ppg_100_session[:valid_len]
    peak_logits_session = peak_logits_session[:valid_len]

    # Session-level normalize: z-score + sigmoid (옵션 C 표준 — eval_tf.py /
    # eval_test_with_core.py 와 동일). Stitch 이후에만 적용해 clip 경계의
    # statistics drift 가 detect_peaks 에 영향 안 주도록.
    norm = normalize_outputs(ppg_100_session, peak_logits_session)
    ppg_hat = np.asarray(norm["ppg_hat"], dtype=np.float32)
    peak_prob_all = np.asarray(norm["peak_prob"], dtype=np.float32)
    peak_logits_all = peak_logits_session

    # v21 detect_peaks: find_peaks(height, distance=0.3s) → ±50ms ppg_hat
    # local min snap. Session 전체 신호에 한 번만 적용.
    peak_indices_all = detect_peaks(peak_prob_all, ppg_hat, threshold=PEAK_THRESHOLD)

    # Inter-clip boundary 인접 peak 선별 제거 (stitching artifact). sample 0
    # (clip 0 start) 과 valid_len (last clip end) 도 boundary 로 취급 → 세션
    # 첫/마지막 peak 도 thres 안에 들어오면 drop (eval_test_with_core.py /
    # scripts/eval_tf.py 와 동일).
    BOUNDARY_THRES_S = 0.15
    if peak_indices_all.size > 0 and len(peak_prob_all) > 0:
        thres_n = int(BOUNDARY_THRES_S * TARGET_FS)
        peaks_int = np.asarray(peak_indices_all, dtype=np.int64)
        bs_all = [0] + list(boundaries) + [len(peak_prob_all)]
        to_drop: set[int] = set()
        for b in bs_all:
            before = peaks_int[peaks_int < b]
            if before.size:
                last_before = int(before[-1])
                if b - last_before < thres_n:
                    to_drop.add(last_before)
            after = peaks_int[peaks_int >= b]
            if after.size:
                first_after = int(after[0])
                if first_after - b < thres_n:
                    to_drop.add(first_after)
        if to_drop:
            keep_mask = ~np.isin(peaks_int, list(to_drop))
            peak_indices_all = peak_indices_all[keep_mask]

    # ── 세션 HRV — per-clip RR (eval_test_with_core / scripts/eval_tf v29 spec)
    # compute_hrv 를 직접 부르면 diff(peak_times) 가 cross-clip RR 까지 계산해서,
    # boundary peak filter 가 real peak 를 drop 했을 때 가짜 doubled-RR outlier
    # 가 생긴다. boundaries 기준으로 clip 별 인접 peak 끼리만 RR 산출 → filter_rr
    # → adaptive sigmoid blend on SMOOTHED RMSSD (CENTER=22, SCALE=10) → SDNN/
    # RMSSD/HR. v29 변경: raw_rmssd 단독 게이트 시 모델 peak jitter 가 raw 를
    # inflate 해서 노이즈 데이터가 잘못 raw 모드로 빠지는 문제를 smoothed_rmssd
    # 기반 gradual sigmoid (gentle transition) 로 해소.
    peak_times_all = (peak_indices_all.astype(np.float64) / TARGET_FS).astype(np.float64)
    peak_conf_val = (float(peak_prob_all[peak_indices_all].mean())
                     if peak_indices_all.size >= 2 else 0.0)

    clip_bounds = [0] + list(boundaries) + [len(peak_prob_all)]
    rr_chunks, rrt_chunks = [], []
    for ci in range(len(clip_bounds) - 1):
        lo_s, hi_s = clip_bounds[ci], clip_bounds[ci + 1]
        m = (peak_indices_all >= lo_s) & (peak_indices_all < hi_s)
        pt_clip = peak_times_all[m]
        if pt_clip.size >= 2:
            rr_chunks.append(np.diff(pt_clip) * 1000.0)
            rrt_chunks.append(pt_clip[:-1])
    rr_raw = np.concatenate(rr_chunks) if rr_chunks else np.array([], dtype=np.float64)
    rrt_raw = (np.concatenate(rrt_chunks) if rrt_chunks
               else np.array([], dtype=np.float64))

    rr_filt = filter_rr(rr_raw, rr_times_s=rrt_raw)
    keep_rate_val = (float(rr_filt.size) / max(rr_raw.size, 1)) if rr_raw.size else 0.0

    if rr_filt.size >= 3:
        rr_smoothed_cand = smooth_rr(rr_filt)
        # Sigmoid blend on SMOOTHED RMSSD (run_core_reference v29).
        # CENTER=22, SCALE=10 (gradual transition):
        #   smoothed 10: α≈0.23 → 거의 smoothed (저 HRV)
        #   smoothed 22: α=0.5  → 50:50
        #   smoothed 30: α≈0.69 → mostly raw (mid HRV)
        #   smoothed 42: α≈0.86 → mostly raw (high HRV)
        rmssd_smooth_ = (float(np.sqrt(np.mean(np.diff(rr_smoothed_cand) ** 2)))
                          if rr_smoothed_cand.size >= 3 else 0.0)
        alpha = float(1.0 / (1.0 + np.exp(-(rmssd_smooth_ - 22.0) / 10.0)))
        if rr_smoothed_cand.size == rr_filt.size:
            rr_sm = alpha * rr_filt + (1.0 - alpha) * rr_smoothed_cand
        else:
            rr_sm = rr_filt if alpha > 0.5 else rr_smoothed_cand
        sdnn_v   = float(np.std(rr_sm, ddof=1))
        rmssd_v  = float(np.sqrt((np.diff(rr_sm) ** 2).mean()))
        mean_rr_ = float(rr_sm.mean())
        hr_v     = 60000.0 / (mean_rr_ + 1e-8)
        rr_cv_v  = float(np.std(rr_sm) / (mean_rr_ + 1e-6))
        hrv_ok = bool(peak_conf_val >= QUALITY_MIN_CONF
                       and keep_rate_val >= QUALITY_MIN_KEEP
                       and rr_cv_v <= QUALITY_MAX_CV)
        hrv = {
            "n_peaks":      int(peak_indices_all.size),
            "peak_times_s": peak_times_all.tolist(),
            "n_rr_smooth":  int(rr_sm.size),
            "rr_smooth_ms": rr_sm.astype(np.float32).tolist(),
            "sdnn_ms":      sdnn_v,
            "rmssd_ms":     rmssd_v,
            "mean_hr_bpm":  hr_v,
            "quality_conf": peak_conf_val,
            "keep_rate":    keep_rate_val,
            "rr_cv":        rr_cv_v,
            "ok":           hrv_ok,
        }
    else:
        hrv = {
            "n_peaks":      int(peak_indices_all.size),
            "peak_times_s": peak_times_all.tolist(),
            "n_rr_smooth":  0,
            "rr_smooth_ms": [],
            "sdnn_ms":      float("nan"),
            "rmssd_ms":     float("nan"),
            "mean_hr_bpm":  float("nan"),
            "quality_conf": peak_conf_val,
            "keep_rate":    keep_rate_val,
            "rr_cv":        float("nan"),
            "ok":           False,
        }

    peak_times = np.asarray(hrv["peak_times_s"], dtype=np.float32)
    rr_smooth = np.asarray(hrv.get("rr_smooth_ms", []), dtype=np.float32)

    out = {
        "ppg_hat": ppg_hat,
        "peak_logits": peak_logits_all,
        "peak_prob": peak_prob_all,
        "peak_times_pad": peak_times,
        "n_peaks": np.int32(hrv["n_peaks"]),
        "rr_smooth_pad": rr_smooth,
        "n_rr_smooth": np.int32(hrv.get("n_rr_smooth", 0)),
        "sdnn_ms": np.float32(hrv.get("sdnn_ms", float("nan"))),
        "rmssd_ms": np.float32(hrv.get("rmssd_ms", float("nan"))),
        "mean_hr_bpm": np.float32(hrv.get("mean_hr_bpm", float("nan"))),
        "quality_conf": np.float32(hrv.get("quality_conf", 0.0)),
        "keep_rate": np.float32(hrv.get("keep_rate", 0.0)),
        "rr_cv": np.float32(hrv.get("rr_cv", float("nan"))),
        "ok": np.bool_(hrv.get("ok", False)),
        "n_windows": np.int32(n_windows),
        "face_t0_s": np.float64(time_us_raw[0]) / 1e6,
        # Worker 에서 ref 측 boundary peak filter 에 사용. sample idx (100 Hz)
        # 단위 — 호출 측에서 face_t0_s + b/100 으로 절대 시각 변환.
        "boundaries": np.asarray(boundaries, dtype=np.int64),
        "session_end_s": np.float64(time_us_raw[-1]) / 1e6,
    }
    return out, infer_ms_total


# ─── 백그라운드 워커 ────────────────────────────────────────────────────
class _InferWorker(QThread):
    """face.bin 로드 + TFLite 추론 + ref HRV 를 백그라운드에서 수행.

    메인 스레드(=Qt 이벤트 루프)에서 직접 돌리면 SELECT_TF_OPS 델리게이트
    초기화 + invoke 동안 수 초~수십 초간 GUI 가 블록되어 Windows 가
    "응답 없음" 으로 표시한다. 결과는 finished_ok / failed signal 로
    메인 스레드에 비동기 통보.
    """
    # (out_dict, infer_ms, n_raw, t_ref, v_ref, ref_hrv)
    finished_ok = pyqtSignal(object, float, int, object, object, object)
    failed = pyqtSignal(str)

    def __init__(self, model_path: str, bin_path: str, ref_path: str):
        super().__init__()
        self.model_path = model_path
        self.bin_path = bin_path
        self.ref_path = ref_path

    def run(self):
        try:
            time_us, _, _, _, frames = extract_mtx_signal(self.bin_path)
            frames_u8 = np.asarray(frames, dtype=np.uint8)
            time_us_arr = np.asarray(time_us, dtype=np.int64)
            n_raw = int(frames_u8.shape[0])
            out, infer_ms = _run_tflite(self.model_path, frames_u8, time_us_arr)

            t_ref, v_ref = _load_ref_csv(self.ref_path)
            ref_hrv = {"ok": False}
            if t_ref is not None:
                # Ref HRV — *단일* path: baseline 제거 (0.3 Hz lowpass 빼기)
                # + 0.5-4 Hz bandpass 로 깨끗한 신호 만들고, 1차 미분 (VPG) 의
                # 양의 peak 직후 첫 zero-crossing (positive→negative) 으로
                # systolic peak 정확히 검출 (수학적으로 PPG slope=0 지점).
                # diastolic ≥ systolic 인 morphology 비정상 케이스에서도 항상
                # systolic 만 잡힘. 그 결과 RR 에 rPPG 와 동일한 Malik artifact
                # filter (range → HR gate → Malik 20%) 적용.
                try:
                    from scipy.signal import (butter as _butter,
                                                sosfiltfilt as _sosfiltfilt,
                                                find_peaks as _find_peaks)
                    v_ref64 = v_ref.astype(np.float64)
                    t_ref64 = t_ref.astype(np.float64)
                    dur_ref = (float(t_ref64[-1] - t_ref64[0])
                                if len(t_ref64) >= 2 else 0.0)
                    fs_ref = ((len(v_ref64) - 1) / dur_ref) if dur_ref > 0 else 100.0
                    # 1) baseline 제거 (0.3 Hz lowpass)
                    sos_lp = _butter(3, 0.3 / (fs_ref / 2.0),
                                      btype='low', output='sos')
                    baseline = _sosfiltfilt(sos_lp, v_ref64)
                    detrended = v_ref64 - baseline
                    # 2) 0.5-4 Hz bandpass + Medicore 부호 convention
                    #    (-v_ref = systolic UP)
                    sos_bp = _butter(3,
                                      [0.5 / (fs_ref / 2.0), 4.0 / (fs_ref / 2.0)],
                                      btype='band', output='sos')
                    sig_vpg = _sosfiltfilt(sos_bp, -detrended)
                    # 3) 1차 미분 (np.gradient: 양 끝 forward/backward,
                    #    중간 central). fs 곱해 단위/sec.
                    vpg = np.gradient(sig_vpg) * fs_ref
                    # 4) VPG 양의 peak 검출 — distance 0.4 s (HR ≤ 150 BPM),
                    #    prominence = std·0.3, height = std·0.5.
                    #    Height gate 가 핵심 — VPG 의 절댓값이 systolic upstroke
                    #    진폭에 비해 작은 (또는 음수인) 부분에서 발생하는
                    #    "꿀렁이는 구간 local max" 를 후보 단계에서 차단. 옛
                    #    (prominence-only) 코드는 diastolic decay 중간의 작은
                    #    bump 를 spurious systolic peak 로 잡아 RR 절반 짜리를
                    #    만들었다 (20260529 YWC 105203 t≈2.5s, 10s 케이스).
                    #    systolic upstroke 의 VPG 는 보통 신호 std 의 3-5 배 →
                    #    std·0.5 는 진짜 systolic 다 살리면서 잡음 wiggle 만 제외.
                    std_vpg = float(np.std(vpg))
                    peaks_vpg_idx, _ = _find_peaks(
                        vpg, distance=int(fs_ref * 0.4),
                        prominence=max(std_vpg * 0.3, 1e-6),
                        height=max(std_vpg * 0.5, 1e-6))
                    # 5) Snap forward to VPG zero-crossing (positive→negative)
                    #    = PPG slope=0 = systolic peak. max_snap 250 ms (pulse
                    #    최대 폭) — dicrotic notch (300+ ms 후) 까지 안 닿음.
                    #    Fallback: zero-crossing 못 찾으면 argmax (드물게 평탄).
                    max_snap = int(0.25 * fs_ref)
                    sys_idx_list = []
                    L = len(sig_vpg)
                    for vp in peaks_vpg_idx:
                        lo_w = int(vp)
                        hi_w = min(L, lo_w + max_snap + 1)
                        if hi_w - lo_w < 2:
                            continue
                        found = -1
                        for j in range(lo_w + 1, hi_w):
                            if vpg[j] <= 0.0 < vpg[j - 1]:
                                found = j
                                break
                        if found >= 0:
                            sys_idx_list.append(found)
                        else:
                            sys_idx_list.append(
                                lo_w + int(np.argmax(sig_vpg[lo_w:hi_w])))
                    sys_idx = np.asarray(sys_idx_list, dtype=np.int64)
                    # 6) Boundary peak filter + per-clip RR (scripts/eval_tf
                    #    ._ref_hrv_segmented v29 strict 매칭).
                    #    (a) clip 시작/끝 + 세션 양 끝 ±150 ms 안의 직전/직후
                    #        ref peak 를 drop — est 측 _compute_est_hrv 와
                    #        anchor 대칭.
                    #    (b) clip 경계를 *가로지르는* RR 도 drop — boundary 직전
                    #        peak 와 직후 peak 간 RR 은 cross-clip 이라 est 의
                    #        per-clip RR 분할과 비대칭이 됨.
                    internal_boundary_times: list[float] = []
                    if sys_idx.size >= 2:
                        peak_t_all = t_ref64[sys_idx]
                        try:
                            boundaries_arr = np.asarray(
                                out.get("boundaries", np.array([], dtype=np.int64)),
                                dtype=np.int64)
                            session_start_t = float(np.asarray(
                                out.get("face_t0_s", t_ref64[0])).ravel()[0])
                            session_end_t = float(np.asarray(
                                out.get("session_end_s", t_ref64[-1])).ravel()[0])
                            internal_boundary_times = [
                                session_start_t + float(b) / 100.0
                                for b in boundaries_arr.tolist()]
                            bs_abs = [session_start_t,
                                       *internal_boundary_times,
                                       session_end_t]
                            BOUNDARY_THRES_S = 0.15
                            drop_idx: set[int] = set()
                            for bt in bs_abs:
                                before = np.where(peak_t_all < bt)[0]
                                if before.size and (bt - peak_t_all[before[-1]]) < BOUNDARY_THRES_S:
                                    drop_idx.add(int(before[-1]))
                                after = np.where(peak_t_all >= bt)[0]
                                if after.size and (peak_t_all[after[0]] - bt) < BOUNDARY_THRES_S:
                                    drop_idx.add(int(after[0]))
                            if drop_idx:
                                keep_mask = np.ones(len(peak_t_all), dtype=bool)
                                for i in drop_idx:
                                    keep_mask[i] = False
                                peak_t_all = peak_t_all[keep_mask]
                                sys_idx = sys_idx[keep_mask]
                        except Exception:
                            logger.exception("Ref boundary peak filter 실패 — pre-filter peak 사용")
                            internal_boundary_times = []
                    # 6b) Per-clip RR + IBI + Malik artifact filter + HRV stats.
                    #     length matching: beat_times[i] 는 RR[i] 의 *end-peak*
                    #     시각 (= peak_t_all[1:], length N-1). per-clip RR drop
                    #     으로 RR/beat 모두 같은 mask 적용 → downstream plot 의
                    #     _slice_segment 가 length 일치 가정으로 동작.
                    if sys_idx.size >= 2:
                        rr_raw_full = (np.diff(peak_t_all) * 1000.0).astype(np.float64)
                        beats_full  = peak_t_all[1:].astype(np.float64)
                        # Per-clip RR keep mask: 두 인접 peak 가 같은 clip 안일
                        # 때만 RR keep. clip = boundary 사이 구간. boundary 가
                        # 없으면 (single-clip 세션) 모두 keep.
                        # Start-peak 시각 — filter_rr_artifacts 의 per-clip
                        # HR gate 에 넘기는 rr_times_s 와 동일 convention
                        # (각 RR 의 시작 peak 시각).
                        rr_start_full = peak_t_all[:-1].astype(np.float64)
                        if internal_boundary_times:
                            clip_edges = ([-np.inf]
                                            + list(internal_boundary_times)
                                            + [np.inf])
                            keep_clip = np.zeros(len(rr_raw_full), dtype=bool)
                            for ci in range(len(clip_edges) - 1):
                                lo_t, hi_t = clip_edges[ci], clip_edges[ci + 1]
                                in_clip = (peak_t_all >= lo_t) & (peak_t_all < hi_t)
                                keep_clip |= (in_clip[:-1] & in_clip[1:])
                            ibi_raw = rr_raw_full[keep_clip]
                            beat_times_aligned = beats_full[keep_clip]
                            rr_start_kept = rr_start_full[keep_clip]
                        else:
                            ibi_raw = rr_raw_full
                            beat_times_aligned = beats_full
                            rr_start_kept = rr_start_full
                        # Malik + per-clip 15s HR gate (HR drift 케이스 보호 —
                        # 옛 global median 은 측정 중 HR 증감 시 정상 RR 까지
                        # outlier 로 잡아 ref peak 절반 가까이 drop 시키는 문제
                        # 있었음. rPPG 쪽 computeHrv 는 이미 per-clip 사용).
                        ibi_filt = filter_rr_artifacts(
                            ibi_raw,
                            rr_times_s=rr_start_kept,
                            clip_seconds=15.0)
                        if len(ibi_filt) >= 2:
                            rmssd_v, sdnn_v, hr_v = _hrv_compute_from_ibi(ibi_filt)
                            ref_hrv = {
                                "ok":            True,
                                # 표시용 stats (Malik 후)
                                "rmssd":         rmssd_v,
                                "sdnn":          sdnn_v,
                                "mean_hr":       hr_v,
                                "n_beats":       int(len(ibi_filt) + 1),
                                # plot/슬라이싱용 (length-matched, end-peak 시각,
                                # per-clip RR drop 후 / Malik 전 — _filter_rr_
                                # with_reasons 가 다시 분류해 kept/dropped 표시).
                                "beat_times_s":  beat_times_aligned,
                                "ibi_ms":        ibi_raw,
                                # PPG trace 위의 marker 전용 — 모든 검출된 peak
                                # (boundary filter 후). beat_times_s 는 cross-
                                # clip RR 의 end-peak 가 빠져 각 clip 의 첫 peak
                                # 가 marker 에서 사라지는 버그가 있었어서 분리.
                                "peaks_s":       peak_t_all.copy(),
                            }
                except Exception:
                    logger.exception("Ref HRV (base-sub + 4Hz + VPG) 계산 실패")
            self.finished_ok.emit(out, float(infer_ms), n_raw, t_ref, v_ref, ref_hrv)
        except Exception as e:
            logger.exception("InferWorker 실패")
            self.failed.emit(f"{type(e).__name__}: {e}")


# ─── GUI ─────────────────────────────────────────────────────────────────
class DataAnalysisTFLiteWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Data Analysis - deploy/model_core.tflite vs Ref")
        self.setMinimumSize(680, 220)

        self.selected_dir: str = ""
        self._plot_windows = []
        self._worker: _InferWorker | None = None

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        # 모델 경로
        m_row = QHBoxLayout()
        m_row.addWidget(QLabel("TFLite:"))
        self.edit_model = QLineEdit(DEFAULT_MODEL)
        self.edit_model.setPlaceholderText("deploy/model_core.tflite")
        m_row.addWidget(self.edit_model, stretch=1)
        self.btn_pick_m = QPushButton("...")
        self.btn_pick_m.setFixedWidth(30)
        self.btn_pick_m.clicked.connect(self._on_pick_model)
        m_row.addWidget(self.btn_pick_m)
        layout.addLayout(m_row)

        # 폴더 선택
        d_row = QHBoxLayout()
        self.btn_pick = QPushButton("세션 폴더 선택")
        self.btn_pick.clicked.connect(self._on_pick_dir)
        d_row.addWidget(self.btn_pick)
        self.label_dir = QLabel("(선택된 폴더 없음)")
        self.label_dir.setStyleSheet("color: gray;")
        d_row.addWidget(self.label_dir, stretch=1)
        layout.addLayout(d_row)

        # 실행
        self.btn_run = QPushButton(
            f"face.bin → TFLite 추론 (15 s 단위 sliding-window, 전 세션)")
        self.btn_run.setMinimumHeight(40)
        self.btn_run.setEnabled(False)
        self.btn_run.clicked.connect(self._on_run)
        layout.addWidget(self.btn_run)

        # 상태
        self.label_status = QLabel("대기 중")
        self.label_status.setAlignment(Qt.AlignCenter)
        self.label_status.setStyleSheet("color: #555; padding: 4px;")
        layout.addWidget(self.label_status)

    # ─── 이벤트 ──────────────────────────────────────────────
    def _on_pick_model(self):
        cur = self.edit_model.text().strip()
        start = os.path.dirname(cur) if cur and os.path.isdir(os.path.dirname(cur)) \
            else os.path.dirname(DEFAULT_MODEL)
        path, _ = QFileDialog.getOpenFileName(
            self, "TFLite 모델 선택", start, "TFLite (*.tflite)")
        if path:
            self.edit_model.setText(path)

    def _on_pick_dir(self):
        start_dir = RECORD_DIR if os.path.isdir(RECORD_DIR) else ""
        path = QFileDialog.getExistingDirectory(
            self, "세션 폴더 선택 (face.bin 필수, ref.csv 선택)", start_dir)
        if not path:
            return
        bin_path = os.path.join(path, "face.bin")
        if not os.path.exists(bin_path):
            QMessageBox.warning(self, "face.bin 없음",
                                f"선택한 폴더에 face.bin 이 없습니다:\n{path}")
            return
        self.selected_dir = path
        try:
            rel = os.path.relpath(path, PROJECT_ROOT)
        except ValueError:
            rel = path
        ref_msg = " + ref.csv" if os.path.exists(
            os.path.join(path, "ref.csv")) else " (ref.csv 없음)"
        self.label_dir.setText(rel + ref_msg)
        self.label_dir.setStyleSheet("color: black;")
        self.btn_run.setEnabled(True)
        size_kb = os.path.getsize(bin_path) / 1024
        self.label_status.setText(f"선택됨: face.bin ({size_kb:.1f} KB)")

    def _on_run(self):
        if not self.selected_dir:
            return
        bin_path = os.path.join(self.selected_dir, "face.bin")
        ref_path = os.path.join(self.selected_dir, "ref.csv")
        model_path = self.edit_model.text().strip()
        if not os.path.isfile(model_path):
            QMessageBox.warning(self, "모델 없음",
                                f"TFLite 모델 파일이 존재하지 않습니다:\n{model_path}")
            return

        self.btn_run.setEnabled(False)
        self.label_status.setText("백그라운드 추론 중... (느린 머신은 수십 초 소요 가능)")
        self.label_status.setStyleSheet("color: #555; padding: 4px;")

        # 메인 스레드 블록 방지를 위해 QThread 워커로 위임
        self._worker = _InferWorker(model_path, bin_path, ref_path)
        self._worker.finished_ok.connect(self._on_infer_done)
        self._worker.failed.connect(self._on_infer_failed)
        self._worker.start()

    def _on_infer_done(self, out, infer_ms: float, n_raw: int,
                       t_ref, v_ref, ref_hrv):
        logger.info("TFLite 추론 완료 — n_raw=%d → 그래프 내부 리샘플 to %d, %.1f ms",
                    n_raw, TARGET_FRAMES, infer_ms)
        try:
            self._plot_all(out=out, infer_ms=infer_ms,
                           t_ref=t_ref, v_ref=v_ref, ref_hrv=ref_hrv,
                           n_raw=n_raw)
            self.label_status.setText(
                f"완료 ({infer_ms:.0f} ms TFLite, ref={'Y' if t_ref is not None else 'N'})")
            self.label_status.setStyleSheet("color: #27ae60; padding: 4px;")
        except Exception:
            logger.exception("플롯 실패")
            QMessageBox.critical(self, "플롯 실패", "콘솔 로그 확인")
        finally:
            self.btn_run.setEnabled(True)

    def _on_infer_failed(self, msg: str):
        self.label_status.setText("추론 실패")
        self.label_status.setStyleSheet("color: #c0392b; padding: 4px;")
        QMessageBox.critical(self, "추론 실패", f"{msg}\n\n콘솔 로그 확인")
        self.btn_run.setEnabled(True)

    # ─── HRV 표 ─────────────────────────────────────────────
    @staticmethod
    def _format_hrv_table(model_out: dict, ref_hrv: dict) -> str:
        def fmt(v, unit="", width=12):
            if v is None:
                return "—".rjust(width)
            try:
                f = float(v)
            except (TypeError, ValueError):
                return str(v).rjust(width)
            if not np.isfinite(f):
                return "—".rjust(width)
            return f"{f:>{width - len(unit) - 1}.1f}{' ' + unit if unit else ''}"

        # Ref HRV — 단일 path (base-sub + 0.5-4Hz + VPG zero-cross + Malik).
        # 표준 키 (rmssd/sdnn/mean_hr/n_beats) 만 사용.
        rf = ref_hrv if ref_hrv else None
        hr_m = _safe(model_out.get("mean_hr_bpm"))
        sdnn_m = _safe(model_out.get("sdnn_ms"))
        rmssd_m = _safe(model_out.get("rmssd_ms"))
        n_rr_m = int(np.asarray(model_out.get("n_rr_smooth", 0)).ravel()[0])
        n_peaks_m = int(np.asarray(model_out.get("n_peaks", 0)).ravel()[0])

        def _rf_get(key):
            return rf.get(key) if rf else None

        rows = [
            ("Mean HR",
             fmt(_rf_get("mean_hr"), "bpm"),
             fmt(hr_m, "bpm")),
            ("RMSSD",
             fmt(_rf_get("rmssd"), "ms"),
             fmt(rmssd_m, "ms")),
            ("SDNN",
             fmt(_rf_get("sdnn"), "ms"),
             fmt(sdnn_m, "ms")),
            ("N beats",
             fmt(_rf_get("n_beats")),
             fmt(n_peaks_m)),
            ("N RR (sm)",
             fmt(((_rf_get("n_beats") or 0) - 1) if rf else None),
             fmt(n_rr_m)),
        ]

        # 모델 quality 한 줄
        q_conf = _safe(model_out.get("quality_conf"))
        q_keep = _safe(model_out.get("keep_rate"))
        q_cv = _safe(model_out.get("rr_cv"))
        q_ok = bool(np.asarray(model_out.get("ok", False)).ravel()[0])
        quality_line = (
            f"<span style='color:#95a5a6;'>Model quality: "
            f"conf={q_conf:.3f}  keep={q_keep:.2f}  rr_cv={q_cv:.3f}"
            f"  → {'OK' if q_ok else 'REJECT'}</span>"
        ) if q_conf is not None else ""

        header = (f"{'Metric':<10}| {'Ref':>14}"
                  f" | {'TFLite Model':>13}")
        sep = "-" * len(header)
        body = "\n".join(
            f"{name:<10}| {a:>14} | {b:>13}"
            for name, a, b in rows
        )
        return (
            "<pre style='font-family: Consolas, monospace; font-size: 11px; "
            "color: #ecf0f1; margin: 2px;'>"
            f"{header}\n{sep}\n{body}\n"
            f"{quality_line}"
            "</pre>"
        )

    # ─── 플롯 ──────────────────────────────────────────────
    def _plot_all(self, *, out: dict, infer_ms: float,
                  t_ref, v_ref, ref_hrv: dict, n_raw: int):
        """세션 전체 추론 결과를 15 s 세그먼트 뷰어로 표시."""
        win = SessionPlotWindow(
            session_dir=self.selected_dir,
            out=out, infer_ms=infer_ms,
            t_ref=t_ref, v_ref=v_ref, ref_hrv=ref_hrv, n_raw=n_raw,
        )
        win.show()
        self._plot_windows.append(win)


# ═══════════════════════════════════════════════════════════════════════
# Session segment viewer (15s 단위 + Prev/Next)
# ═══════════════════════════════════════════════════════════════════════

class SessionPlotWindow(QWidget):
    """전 세션 추론 결과 + Prev/Next 로 15 s 세그먼트 단위 뷰어.

    상단:
      - HRV 표 (전 세션 기준 — 세그먼트 이동해도 안 바뀜)
      - Prev / Next 버튼 + 세그먼트 위치 라벨
    하단 (pg.GraphicsLayoutWidget):
      - row 0: rPPG / Ref 파형 오버레이 (현재 15s 만) + peak 마커
      - row 1: peak_prob + threshold + 검출 peak
      - row 2: RR intervals (rPPG vs Ref, 현재 15s 만)

    ←/→ 키보드 단축키도 동작.
    """

    def __init__(self, *, session_dir: str, out: dict, infer_ms: float,
                 t_ref, v_ref, ref_hrv: dict, n_raw: int):
        super().__init__()
        self.setWindowTitle(
            f"Session viewer — {os.path.basename(session_dir)}")
        self.resize(1600, 900)

        # ─── 세션 데이터 unpack ────────────────────────────────────
        self.ppg_hat = np.asarray(out.get("ppg_hat"), dtype=np.float64)
        self.peak_prob_full = np.asarray(out.get("peak_prob"), dtype=np.float64)
        peak_times_pad = np.asarray(out.get("peak_times_pad", []),
                                     dtype=np.float64)
        rr_smooth_pad = np.asarray(out.get("rr_smooth_pad", []),
                                    dtype=np.float64)
        self.n_peaks = int(np.asarray(out.get("n_peaks", 0)).ravel()[0])
        self.n_rr = int(np.asarray(out.get("n_rr_smooth", 0)).ravel()[0])
        self.peak_times = (peak_times_pad[:self.n_peaks]
                            if self.n_peaks > 0 else np.array([]))
        self.rr_smooth = (rr_smooth_pad[:self.n_rr]
                           if self.n_rr > 0 else np.array([]))

        L = self.ppg_hat.shape[0]
        # Threshold-based ceil: 마지막 segment 가 최소 ~5s (=1/3 segment) 의
        # 데이터를 가질 때만 carry. 옛 floor 는 59.98s 세션의 마지막 ~15s tail
        # 을 영영 못 보여줬고, 단순 ceil 은 60.01s 세션 끝의 0.01s = 1 sample
        # 짜리 빈 segment 를 추가하는 문제가 있었음. (L - MIN_TAIL) // SEG + 1
        # 공식으로 양쪽 다 해결.
        MIN_TAIL_SAMPLES = SAMPLES_PER_SEGMENT // 3       # 500 samples = 5s
        self.n_segs = max(
            1, (L - MIN_TAIL_SAMPLES) // SAMPLES_PER_SEGMENT + 1)
        self.t_grid_full = np.arange(L, dtype=np.float64) / CORE_TARGET_FS
        self.rppg_curve_full = _zscore_np(-self.ppg_hat)

        # ─── Ref↔rPPG 정렬 (eval_test_with_core.py 와 동일 규칙) ──────────
        # face.bin time_us 와 ref.csv time_s 는 둘 다 *recording origin*
        # (=_record_t_mono_base, 첫 PPG sample 의 back-dated arrival) 기준의
        # 절대 시각. 따라서 rPPG t=0 (= face.bin 첫 프레임) 에 ref 를 맞추려면
        # ref 를 face_t0_s 만큼만 빼면 된다. 과거엔 `t_ref - t_ref[0]` 로 ref
        # 도 자체 0 으로 shift 해서, 카메라 first frame 과 PPG first sample
        # 사이의 latency 만큼 ref-rPPG 가 항상 어긋났다.
        face_t0_s = float(np.asarray(out.get("face_t0_s", 0.0)).ravel()[0])
        self._t_ref_base = face_t0_s
        if t_ref is not None:
            self.t_ref_zero = t_ref - face_t0_s
            # Display 신호도 worker 와 동일 전처리 (baseline 제거 + 0.5-4 Hz
            # bandpass + Medicore 부호 convention systolic UP). 같은 신호 위에서
            # VPG peak 마커가 정확히 systolic 정점에 박힘.
            try:
                from scipy.signal import butter, sosfiltfilt
                v64 = v_ref.astype(np.float64)
                sos_lp = butter(3, 0.3 / (CORE_TARGET_FS / 2.0),
                                 btype='low', output='sos')
                baseline = sosfiltfilt(sos_lp, v64)
                v_detrended = v64 - baseline
                ref_filt = _bandpass_for_display(
                    v_detrended, fs=CORE_TARGET_FS, lo=0.5, hi=4.0, order=3)
            except Exception:
                ref_filt = v_ref.astype(np.float64)
            self.ref_curve_full = _zscore_np(-ref_filt)
        else:
            self.t_ref_zero = None
            self.ref_curve_full = None
        self.ref_hrv = ref_hrv
        if ref_hrv.get("ok") and t_ref is not None:
            self.ref_beat_t_zero = (
                np.asarray(ref_hrv["beat_times_s"]) - self._t_ref_base)
            self.ref_ibi_ms = np.asarray(ref_hrv.get("ibi_ms", []))
            # Display marker 전용 — 모든 검출된 peak (각 clip 첫 peak 포함).
            # beat_times_s 는 RR end-peak 라 cross-clip RR drop 시 첫 peak 가
            # 빠지는데, PPG 곡선 위 marker 는 검출된 peak 전부 보여줘야 함.
            peaks_full = ref_hrv.get("peaks_s")
            if peaks_full is not None and len(peaks_full) > 0:
                self.ref_peak_t_zero = (
                    np.asarray(peaks_full) - self._t_ref_base)
            else:
                self.ref_peak_t_zero = self.ref_beat_t_zero
        else:
            self.ref_beat_t_zero = np.array([])
            self.ref_ibi_ms = np.array([])
            self.ref_peak_t_zero = np.array([])

        # ─── HRV 분석에서 제외된 RR 시각화용 mask (session-level) ────────
        # Stat 계산 (filter_rr_artifacts) 과 동일하게 per-clip 15s HR gate 적용
        # — rr_times_s = 각 RR 의 *시작 peak 시각*. global gate 로 가면 HR drift
        # 케이스에서 정상 RR 까지 dropped 로 표기되는 inconsistency 생김.
        if len(self.peak_times) >= 2:
            self.rppg_rr_full_t = self.peak_times[1:]
            self.rppg_rr_full_v = np.diff(self.peak_times) * 1000.0
            rppg_rr_start = self.peak_times[:-1]
            self.rppg_rr_drop = _filter_rr_with_reasons(
                self.rppg_rr_full_v,
                rr_times_s=rppg_rr_start,
                clip_seconds=15.0)
        else:
            self.rppg_rr_full_t = np.array([])
            self.rppg_rr_full_v = np.array([])
            self.rppg_rr_drop = _filter_rr_with_reasons(np.array([]))
        if len(self.ref_beat_t_zero) > 0 and len(self.ref_ibi_ms):
            # ref start peak time = end peak - RR (ms→s). ref_beat_t_zero 는
            # _t_ref_base 만큼 shift 됐지만 bucketing 은 상대시각이라 결과 동일.
            ref_rr_start = (np.asarray(self.ref_beat_t_zero, dtype=np.float64)
                            - np.asarray(self.ref_ibi_ms, dtype=np.float64) / 1000.0)
            self.ref_rr_drop = _filter_rr_with_reasons(
                self.ref_ibi_ms,
                rr_times_s=ref_rr_start,
                clip_seconds=15.0)
        else:
            self.ref_rr_drop = _filter_rr_with_reasons(np.array([]))

        # 메타 정보
        self._title_meta = (
            f"Session HR={_safe(out.get('mean_hr_bpm')) or 0:.1f} "
            f"SDNN={_safe(out.get('sdnn_ms')) or 0:.1f} "
            f"RMSSD={_safe(out.get('rmssd_ms')) or 0:.1f}   |   "
            f"n_windows={int(np.asarray(out.get('n_windows', 1)).ravel()[0])}, "
            f"n_raw={n_raw}  ({infer_ms:.0f} ms total)")
        self.current_seg = 0

        # ─── UI 구성 ────────────────────────────────────────────────
        root = QVBoxLayout(self)
        root.setContentsMargins(8, 8, 8, 8)

        # (1) 전 세션 HRV 표
        self.hrv_label = QLabel()
        self.hrv_label.setTextFormat(Qt.RichText)
        self.hrv_label.setStyleSheet("background-color: #2c3e50; padding: 6px;")
        self.hrv_label.setText(
            DataAnalysisTFLiteWindow._format_hrv_table(out, ref_hrv))
        root.addWidget(self.hrv_label)

        # (2) 컨트롤 바
        ctrl = QHBoxLayout()
        self.btn_prev = QPushButton("← Prev (15 s)")
        self.btn_prev.setMinimumHeight(32)
        self.btn_prev.clicked.connect(self._on_prev)
        ctrl.addWidget(self.btn_prev)
        self.seg_label = QLabel()
        self.seg_label.setAlignment(Qt.AlignCenter)
        self.seg_label.setStyleSheet("font-weight: bold; padding: 4px;")
        ctrl.addWidget(self.seg_label, stretch=1)
        self.btn_next = QPushButton("Next (15 s) →")
        self.btn_next.setMinimumHeight(32)
        self.btn_next.clicked.connect(self._on_next)
        ctrl.addWidget(self.btn_next)
        root.addLayout(ctrl)

        # (3) pyqtgraph 영역
        pg.setConfigOptions(antialias=True)
        self.gl = pg.GraphicsLayoutWidget()
        root.addWidget(self.gl, stretch=1)

        self._draw_segment()

    # ─── 네비게이션 ────────────────────────────────────────────────
    def _on_prev(self):
        if self.current_seg > 0:
            self.current_seg -= 1
            self._draw_segment()

    def _on_next(self):
        if self.current_seg < self.n_segs - 1:
            self.current_seg += 1
            self._draw_segment()

    def keyPressEvent(self, evt):
        if evt.key() == Qt.Key_Right:
            self._on_next()
        elif evt.key() == Qt.Key_Left:
            self._on_prev()
        else:
            super().keyPressEvent(evt)

    # ─── 세그먼트 렌더 ──────────────────────────────────────────────
    def _draw_segment(self):
        self.gl.clear()
        seg = self.current_seg
        t0 = seg * SEGMENT_SECONDS
        t1 = t0 + SEGMENT_SECONDS
        i0 = seg * SAMPLES_PER_SEGMENT
        i1 = i0 + SAMPLES_PER_SEGMENT

        t_seg = self.t_grid_full[i0:i1]
        rppg_seg = self.rppg_curve_full[i0:i1]
        prob_seg = self.peak_prob_full[i0:i1]

        seg_pk_mask = (self.peak_times >= t0) & (self.peak_times < t1)
        peaks_seg = self.peak_times[seg_pk_mask]

        ref_peaks_seg = np.array([])
        # PPG marker 는 모든 검출된 peak 사용 (각 clip 첫 peak 포함).
        # RR 시계열용 beat_times 는 cross-clip RR drop 으로 빠진 peak 있음.
        ref_marker_src = (self.ref_peak_t_zero
                          if getattr(self, "ref_peak_t_zero", None) is not None
                          and len(self.ref_peak_t_zero)
                          else self.ref_beat_t_zero)
        if len(ref_marker_src):
            mask = ((ref_marker_src >= t0) & (ref_marker_src < t1))
            ref_peaks_seg = ref_marker_src[mask]

        # 컨트롤 라벨 + 버튼 상태
        self.seg_label.setText(
            f"Segment {seg + 1} / {self.n_segs}   |   "
            f"t = {t0:.0f} – {t1:.0f} s   |   "
            f"rPPG peaks: {len(peaks_seg)}   |   "
            f"Ref peaks: {len(ref_peaks_seg)}")
        self.btn_prev.setEnabled(seg > 0)
        self.btn_next.setEnabled(seg < self.n_segs - 1)

        # ─── row 0: 파형 오버레이 ─────────────────────────────────
        p1 = self.gl.addPlot(
            row=0, col=0,
            title=(f"rPPG vs Ref (rPPG=-ppg_hat zscored UP, "
                   f"Ref=-bandpass(ppg_raw) zscored DOWN)   |   "
                   f"{self._title_meta}"))
        p1.setLabel("bottom", "Time", units="s")
        p1.setLabel("left", "z-score")
        p1.setXRange(t0, t1, padding=0.0)
        p1.showGrid(x=True, y=True, alpha=0.3)
        _add_compact_legend(p1, offset=(-10, 10))   # top-right, semi-transparent
        p1.plot(t_seg, rppg_seg,
                pen=pg.mkPen("#e74c3c", width=2),
                name="rPPG (model)")
        if len(peaks_seg):
            p1.plot(peaks_seg,
                    np.interp(peaks_seg, self.t_grid_full,
                               self.rppg_curve_full),
                    pen=None, symbol="o", symbolSize=8,
                    symbolBrush="#c0392b",
                    symbolPen=pg.mkPen("w", width=1.5),
                    name=f"rPPG peaks ({len(peaks_seg)})")
        if self.t_ref_zero is not None:
            ref_mask = ((self.t_ref_zero >= t0) & (self.t_ref_zero < t1))
            t_ref_seg = self.t_ref_zero[ref_mask]
            ref_curve_seg = self.ref_curve_full[ref_mask]
            p1.plot(t_ref_seg, ref_curve_seg,
                    pen=pg.mkPen("#2980b9", width=2),
                    name="Ref (base-sub + 4Hz)")
            if len(ref_peaks_seg):
                p1.plot(ref_peaks_seg,
                        np.interp(ref_peaks_seg,
                                   self.t_ref_zero, self.ref_curve_full),
                        pen=None, symbol="s", symbolSize=8,
                        symbolBrush="#1f4e79",
                        symbolPen=pg.mkPen("w", width=1.5),
                        name=f"Ref peaks (VPG) ({len(ref_peaks_seg)})")

        # ─── row 1: peak_prob ──────────────────────────────────────
        p_pk = self.gl.addPlot(
            row=1, col=0, title="peak_prob (σ logits) + threshold")
        p_pk.setLabel("bottom", "Time", units="s")
        p_pk.setLabel("left", "peak_prob")
        p_pk.setXRange(t0, t1, padding=0.0)
        p_pk.setYRange(-0.05, 1.05)
        p_pk.showGrid(x=True, y=True, alpha=0.3)
        # peak_prob 은 보통 0 / 1 부근에 데이터가 몰리고 중앙 0.4~0.6 는 비어
        # 있는 경우가 많아 legend 를 중앙 우측에 둠.
        _add_compact_legend(p_pk, offset=(-10, 60))
        p_pk.plot(t_seg, prob_seg,
                  pen=pg.mkPen("#16a085", width=1.5),
                  name="peak_prob")
        p_pk.addItem(pg.InfiniteLine(
            pos=PEAK_THRESHOLD, angle=0,
            pen=pg.mkPen("#bdc3c7", width=1, style=Qt.DashLine)))
        if len(peaks_seg):
            p_pk.plot(peaks_seg,
                      np.interp(peaks_seg, self.t_grid_full,
                                 self.peak_prob_full),
                      pen=None, symbol="o", symbolSize=7,
                      symbolBrush="#8e44ad",
                      name=f"detected ({len(peaks_seg)})")

        # ─── row 2: RR overlay (현재 세그먼트의 beat 만) ───────────
        # peak_times diff 로 만든 raw RR 사용 — row 0 의 peak 마커와 1:1 정렬.
        # __init__ 에서 session-level filter mask 를 미리 계산해뒀고, 여기서는
        # 시간 마스크로 현재 segment 만 잘라낸 뒤 kept/dropped 를 분리 렌더.
        # dropped RR 은 X 마커 + 선 없음 으로 표시해서 HRV 분석에서 제외된
        # 사실을 한눈에 보이게 함.
        def _slice_segment(t_full, v_full, drop_info):
            if len(t_full) == 0:
                empty = np.array([])
                return empty, empty, {"kept": empty.astype(bool),
                                       "range": empty.astype(bool),
                                       "hr_gate": empty.astype(bool),
                                       "malik": empty.astype(bool)}
            m = (t_full >= t0) & (t_full < t1)
            return t_full[m], v_full[m], {k: v[m] for k, v in drop_info.items()}

        rppg_t, rppg_v, rppg_d = _slice_segment(
            self.rppg_rr_full_t, self.rppg_rr_full_v, self.rppg_rr_drop)
        ref_t, ref_v, ref_d = _slice_segment(
            self.ref_beat_t_zero, self.ref_ibi_ms, self.ref_rr_drop)

        def _drop_label(d):
            parts = []
            if d["range"].any():   parts.append(f"rng:{int(d['range'].sum())}")
            if d["hr_gate"].any(): parts.append(f"gate:{int(d['hr_gate'].sum())}")
            if d["malik"].any():   parts.append(f"malik:{int(d['malik'].sum())}")
            return "/".join(parts) if parts else "0"

        if len(rppg_t) > 0 or len(ref_t) > 0:
            p_rr = self.gl.addPlot(
                row=2, col=0,
                title=("RR intervals (ms) — segment   |   "
                       "filled = kept by HRV filter, X = dropped"))
            p_rr.setLabel("bottom", "beat time", units="s")
            p_rr.setLabel("left", "RR", units="ms")
            p_rr.setXRange(t0, t1, padding=0.0)
            p_rr.showGrid(x=True, y=True, alpha=0.3)
            _add_compact_legend(p_rr, offset=(-10, 10))

            # rPPG: kept = solid line + filled triangle, dropped = X
            if len(rppg_t):
                keep = rppg_d["kept"]
                drop = ~keep
                if keep.any():
                    p_rr.plot(rppg_t[keep], rppg_v[keep],
                              pen=pg.mkPen("#e74c3c", width=2),
                              symbol="t", symbolSize=6,
                              symbolBrush="#e74c3c",
                              name=f"rPPG kept ({int(keep.sum())})")
                if drop.any():
                    p_rr.plot(rppg_t[drop], rppg_v[drop],
                              pen=None,
                              symbol="x", symbolSize=12,
                              symbolBrush=None,
                              symbolPen=pg.mkPen("#e74c3c", width=2),
                              name=f"rPPG dropped ({_drop_label(rppg_d)})")

            # Ref: kept = dotted line + filled square, dropped = X
            if len(ref_t):
                keep = ref_d["kept"]
                drop = ~keep
                if keep.any():
                    p_rr.plot(ref_t[keep], ref_v[keep],
                              pen=pg.mkPen("#2980b9", width=2,
                                            style=Qt.DotLine),
                              symbol="s", symbolSize=6,
                              symbolBrush="#2980b9",
                              name=f"Ref kept ({int(keep.sum())})")
                if drop.any():
                    p_rr.plot(ref_t[drop], ref_v[drop],
                              pen=None,
                              symbol="x", symbolSize=12,
                              symbolBrush=None,
                              symbolPen=pg.mkPen("#2980b9", width=2),
                              name=f"Ref dropped ({_drop_label(ref_d)})")


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    w = DataAnalysisTFLiteWindow()
    w.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
