"""
Medicore Smart Pulse PPG - 실시간 신호 + 카메라(얼굴 촬영) 예제

realtime_plot.py 기능에 웹캠 영상 표시 패널을 추가한 버전이다.
- 좌측: 실시간 PPG 파형 + 컨트롤
- 우측 상단: 웹캠 실시간 프리뷰 (얼굴 촬영용)
- 우측 하단: 심박수 / 손가락 상태 / 샘플 정보

실행:
    cd medicore-ppg
    python -m examples.realtime_withcam_plot

필요 패키지:
    pip install bleak PyQt5 pyqtgraph numpy opencv-python
"""

from __future__ import annotations

import sys
import os
import asyncio
import threading
import queue
import logging

import csv
import json
import re
import struct
import time as _time
from collections import deque
from datetime import datetime, timezone

import numpy as np
import cv2

# mediapipe 를 PyQt5 보다 (패키지 init 포함) 무조건 먼저 임포트.
# 순서가 반대이면 일부 Windows 머신에서 Qt ↔ mediapipe native deps
# (TF Lite / abseil / protobuf / gRPC) 의 COM apartment·CRT 충돌로
# 프로세스가 segfault 또는 GUI 미표시 상태에 빠지는 경우 있음.
# `import PyQt5` (패키지 __init__) 만으로도 일부 wheel 에서 native DLL
# search path 가 잡혀서 충돌을 트리거하므로 Qt plugin path 블록보다도 위.
try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    mp = None
    mp_python = None
    mp_vision = None
    MEDIAPIPE_AVAILABLE = False

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
    QPushButton, QLabel, QLineEdit, QGroupBox, QComboBox, QMessageBox, QFileDialog,
)

# FaceLandmarker 모델 (Tasks API용)
FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
FACE_LANDMARKER_PATH = os.path.join(MODEL_DIR, "face_landmarker.task")


def ensure_face_landmarker_model() -> str:
    """FaceLandmarker 모델 파일이 없으면 다운로드한다."""
    if os.path.exists(FACE_LANDMARKER_PATH):
        return FACE_LANDMARKER_PATH
    os.makedirs(MODEL_DIR, exist_ok=True)
    import urllib.request
    logger.info("FaceLandmarker 모델 다운로드: %s", FACE_LANDMARKER_URL)
    urllib.request.urlretrieve(FACE_LANDMARKER_URL, FACE_LANDMARKER_PATH)
    logger.info("모델 저장: %s", FACE_LANDMARKER_PATH)
    return FACE_LANDMARKER_PATH
from PyQt5.QtCore import QTimer, Qt
from PyQt5.QtGui import QFont, QImage, QPixmap
import pyqtgraph as pg

# 프로젝트 루트를 path에 추가
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from medicore_ppg.sdk import SmartPulseBLE
from medicore_ppg.protocol import (
    PPGPacket, SAMPLE_RATE_HZ, SAMPLES_PER_PACKET, SAMPLE_INTERVAL_MS,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ─── 설정 ─────────────────────────────────────────────────────────────
PLOT_WINDOW_SEC = 5
BUFFER_SIZE = SAMPLE_RATE_HZ * PLOT_WINDOW_SEC
UPDATE_FPS = 20
UPDATE_INTERVAL_MS = 1000 // UPDATE_FPS
PACKET_TIMEOUT_INITIAL = 2.0
PACKET_TIMEOUT_NORMAL = 0.3

# 카메라 설정
CAMERA_FPS = 30
CAMERA_INTERVAL_MS = 1000 // CAMERA_FPS
CAMERA_WIDTH = 1920
CAMERA_HEIGHT = 1080
CAMERA_MAX_PROBE = 5  # 0~N-1까지 탐색
SNAPSHOT_DIR = os.path.join(os.path.dirname(__file__), "snapshots")
RECORD_DIR = os.path.join(os.path.dirname(__file__), "records")

# 세션 기록 설정
# (실제 기록 시간, 표시 라벨) - 0.1초 여유 포함
RECORD_DURATION_OPTIONS = [
    (15.1, "15초"),
    (30.1, "30초"),
    (45.1, "45초"),
    (60.1, "1분"),
    (600.1, "10분"),
    (1800.1, "30분"),
]
RECORD_CHUNK_SECONDS = 60.0  # 장시간 녹화 시 디스크 flush 주기
RECORD_FACE_SIZE = 36  # 잘라낸 얼굴 저장 해상도 (NxN)
RECORD_FACE_PAD = 0.05  # bbox 대비 여백 비율 (양쪽 각각)


def _dshow_device_names() -> list[str]:
    """Windows DSHOW 카메라 이름 목록. pygrabber 있으면 사용, 없으면 [] 반환.

    반환 순서 = OpenCV VideoCapture 인덱스 순서 (DSHOW 백엔드 기준).
    """
    if not sys.platform.startswith("win"):
        return []
    try:
        from pygrabber.dshow_graph import FilterGraph  # type: ignore
    except ImportError:
        return []
    try:
        return list(FilterGraph().get_input_devices())
    except Exception:
        logger.exception("pygrabber 디바이스 이름 조회 실패")
        return []


def enumerate_cameras(max_probe: int = CAMERA_MAX_PROBE) -> list[tuple[int, str]]:
    """사용 가능한 (카메라 인덱스, 표시 이름) 목록을 반환한다.

    표시 이름은 Windows+pygrabber 설치 시 실제 디바이스 모델명, 아니면 "Camera N".
    각 인덱스는 VideoCapture로 프레임 1장을 읽어 실제 사용 가능 여부를 검증한다.
    """
    backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else 0
    dshow_names = _dshow_device_names()
    available: list[tuple[int, str]] = []
    for idx in range(max_probe):
        cap = cv2.VideoCapture(idx, backend)
        if cap.isOpened():
            ok, _ = cap.read()
            if ok:
                name = (dshow_names[idx] if idx < len(dshow_names)
                        else f"Camera {idx}")
                available.append((idx, name))
            cap.release()
    return available


# ═══════════════════════════════════════════════════════════════════════
# BLE Worker Thread
# ═══════════════════════════════════════════════════════════════════════

class BLEWorker(threading.Thread):
    """별도 스레드에서 asyncio 이벤트 루프를 실행하여 BLE 통신을 처리"""

    def __init__(self, data_queue: queue.Queue, hr_queue: queue.Queue,
                 status_queue: queue.Queue, finger_queue: queue.Queue):
        super().__init__(daemon=True)
        self.data_queue = data_queue
        self.hr_queue = hr_queue
        self.status_queue = status_queue
        self.finger_queue = finger_queue
        self.loop: asyncio.AbstractEventLoop = None
        self.sdk = SmartPulseBLE()
        # PPG 최신 도착 시각 ↔ SDK timestamp_ms 매핑 (카메라 시각 변환용)
        self._latest_ppg_lock = threading.Lock()
        self._latest_ppg_arrival_mono: float = -1.0
        self._latest_ppg_ts_ms: float = -1.0
        self._devices = []

    def run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)

        self.sdk.on_ppg_data(self._on_ppg_data)
        self.sdk.on_heart_rate(self._on_heart_rate)
        self.sdk.on_finger_state(self._on_finger_state)
        self.sdk.on_status(self._on_status)

        self.loop.run_forever()

    def _on_ppg_data(self, packet: PPGPacket):
        # BLE 콜백 스레드: 최신 (도착 monotonic, 마지막 샘플 ts_ms) 쌍 갱신
        if packet.samples:
            now = _time.monotonic()
            last_ts_ms = packet.samples[-1].timestamp_ms
            with self._latest_ppg_lock:
                self._latest_ppg_arrival_mono = now
                self._latest_ppg_ts_ms = last_ts_ms
            # single-anchor 정렬용: 패킷 도착 monotonic 부착
            packet.arrival_mono = now
        try:
            self.data_queue.put_nowait(packet)
        except queue.Full:
            pass

    def get_latest_ppg_anchor(self):
        """(arrival_mono, ts_ms) 또는 아직 없으면 (None, None) 반환."""
        with self._latest_ppg_lock:
            if self._latest_ppg_arrival_mono < 0:
                return None, None
            return self._latest_ppg_arrival_mono, self._latest_ppg_ts_ms

    def _on_heart_rate(self, hr: float):
        try:
            self.hr_queue.put_nowait(hr)
        except queue.Full:
            pass

    def _on_finger_state(self, finger_on: bool):
        try:
            self.finger_queue.put_nowait(finger_on)
        except queue.Full:
            pass

    def _on_status(self, message: str, color: str):
        try:
            self.status_queue.put_nowait((message, color))
        except queue.Full:
            pass

    def run_coroutine(self, coro):
        if self.loop and self.loop.is_running():
            return asyncio.run_coroutine_threadsafe(coro, self.loop)
        return None

    def request_scan(self):
        return self.run_coroutine(self._do_scan())

    def request_connect(self, address: str):
        return self.run_coroutine(self.sdk.connect(address))

    def request_disconnect(self):
        return self.run_coroutine(self.sdk.disconnect())

    def request_start(self):
        return self.run_coroutine(self.sdk.start_measurement())

    def request_stop(self):
        return self.run_coroutine(self.sdk.stop_measurement())

    def request_discover(self):
        return self.run_coroutine(self.sdk.discover_services())

    async def _do_scan(self):
        self._devices = await self.sdk.scan()
        return self._devices

    @property
    def devices(self):
        return self._devices

    def stop(self):
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)


# ═══════════════════════════════════════════════════════════════════════
# Ring Buffer
# ═══════════════════════════════════════════════════════════════════════

class RingBuffer:
    """numpy 기반 원형 버퍼"""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self.data = np.zeros(capacity, dtype=np.float64)
        self.index = 0
        self.count = 0

    def append(self, values):
        arr = np.asarray(values, dtype=np.float64)
        n = len(arr)
        if n >= self.capacity:
            self.data[:] = arr[-self.capacity:]
            self.index = 0
            self.count = self.capacity
        else:
            end = self.index + n
            if end <= self.capacity:
                self.data[self.index:end] = arr
            else:
                first = self.capacity - self.index
                self.data[self.index:] = arr[:first]
                self.data[:n - first] = arr[first:]
            self.index = (self.index + n) % self.capacity
            self.count = min(self.count + n, self.capacity)

    def get_ordered(self) -> np.ndarray:
        if self.count < self.capacity:
            return self.data[:self.count].copy()
        return np.roll(self.data, -self.index).copy()


# ═══════════════════════════════════════════════════════════════════════
# Camera Widget
# ═══════════════════════════════════════════════════════════════════════

class CameraPanel(QGroupBox):
    """웹캠 프리뷰 + 시작/중지/스냅샷 버튼 패널.

    OpenCV VideoCapture는 QTimer로 주기적으로 폴링한다. 성능이 충분해서
    별도 스레드 없이 GUI 스레드에서 처리해도 30fps가 무리 없이 나온다.
    """

    def __init__(self, parent=None):
        super().__init__("Camera (Face)", parent)
        self.capture: cv2.VideoCapture | None = None
        self.last_frame: np.ndarray | None = None
        self.frame_callback = None  # (frame_bgr: np.ndarray, t_mono: float) -> None
        self._cap_thread: threading.Thread | None = None
        self._cap_stop = threading.Event()
        self._frame_lock = threading.Lock()
        # 최근 캡처 프레임 도착 시각 (rolling window FPS 계산용)
        self._frame_times: "deque[float]" = deque(maxlen=60)

        # MediaPipe FaceLandmarker (별도 스레드에서 처리 - 캡처 레이트 무관)
        self._face_landmarker = None
        self._mesh_thread: threading.Thread | None = None
        self._mesh_stop = threading.Event()
        self._mesh_lock = threading.Lock()
        # 최신 mesh 결과: (landmarks, bbox_xyxy, frame_shape_hw)
        self._mesh_landmarks = None
        self._mesh_bbox: "tuple | None" = None
        self._mesh_frame_shape: "tuple | None" = None
        self._mesh_last_capture_id = -1  # capture id 기반으로 신규 프레임만 처리
        self._capture_id = 0

        layout = QVBoxLayout(self)

        # 카메라 선택 줄 (맨 위)
        select_layout = QHBoxLayout()
        select_layout.addWidget(QLabel("장치:"))
        self.combo_cameras = QComboBox()
        self.combo_cameras.setMinimumWidth(150)
        select_layout.addWidget(self.combo_cameras, stretch=1)
        self.btn_cam_refresh = QPushButton("새로고침")
        self.btn_cam_refresh.clicked.connect(self.refresh_cameras)
        select_layout.addWidget(self.btn_cam_refresh)
        self.label_fps = QLabel("FPS: --")
        self.label_fps.setStyleSheet("color: #27ae60; font-weight: bold; padding: 0 6px;")
        self.label_fps.setMinimumWidth(70)
        select_layout.addWidget(self.label_fps)
        layout.addLayout(select_layout)

        # 카메라 뷰 — preview 위젯 사이즈는 실제 캡처 해상도와 무관하게
        # 고정. 그렇지 않으면 CAMERA_WIDTH/HEIGHT 를 키우는 순간 view 위젯도
        # 거대해져서 PPG plot 을 밀어버리고 픽스맵이 확대 표시됨.
        self.view = QLabel("카메라 꺼짐")
        self.view.setAlignment(Qt.AlignCenter)
        self.view.setMinimumSize(320, 240)
        self.view.setMaximumHeight(320)
        self.view.setStyleSheet(
            "background-color: #222; color: #aaa; border: 1px solid #444;"
        )
        layout.addWidget(self.view, stretch=0)

        # 시작 / 중지 / 스냅샷 (뷰 바로 아래)
        btn_layout = QHBoxLayout()
        self.btn_cam_start = QPushButton("카메라 시작")
        self.btn_cam_start.clicked.connect(self.start_camera)
        btn_layout.addWidget(self.btn_cam_start)

        self.btn_cam_stop = QPushButton("카메라 중지")
        self.btn_cam_stop.clicked.connect(self.stop_camera)
        self.btn_cam_stop.setEnabled(False)
        btn_layout.addWidget(self.btn_cam_stop)

        self.btn_snapshot = QPushButton("스냅샷 저장")
        self.btn_snapshot.clicked.connect(self.save_snapshot)
        self.btn_snapshot.setEnabled(False)
        btn_layout.addWidget(self.btn_snapshot)

        layout.addLayout(btn_layout)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._update_frame)

        self.refresh_cameras()

    def refresh_cameras(self):
        """사용 가능한 카메라를 다시 탐색하여 콤보박스를 갱신한다."""
        if self.capture is not None:
            # 실행 중에는 재탐색하면 점유 충돌이 나므로 막는다
            QMessageBox.information(self, "카메라",
                                    "먼저 카메라를 중지한 뒤 새로고침하세요.")
            return
        self.combo_cameras.clear()
        cams = enumerate_cameras()
        if not cams:
            self.combo_cameras.addItem("(사용 가능한 카메라 없음)", -1)
            self.btn_cam_start.setEnabled(False) if hasattr(self, "btn_cam_start") else None
            return
        for idx, name in cams:
            # userData = (idx, name) 튜플 — 기록 시 이름 조회용
            self.combo_cameras.addItem(f"{name} [{idx}]", (idx, name))
        if hasattr(self, "btn_cam_start"):
            self.btn_cam_start.setEnabled(True)

    def get_selected_camera(self) -> tuple[int, str] | None:
        """콤보에서 선택된 (index, name). 유효한 선택이 없으면 None."""
        data = self.combo_cameras.currentData()
        if not isinstance(data, tuple) or len(data) != 2:
            return None
        idx, name = data
        if idx is None or idx < 0:
            return None
        return int(idx), str(name)

    def start_camera(self):
        if self.capture is not None:
            return
        selected = self.get_selected_camera()
        if selected is None:
            QMessageBox.warning(self, "카메라", "선택된 카메라가 없습니다.")
            return
        index, _name = selected
        # Windows에서는 CAP_DSHOW가 초기화가 빠르고 안정적이다
        backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else 0
        cap = cv2.VideoCapture(index, backend)
        if not cap.isOpened():
            QMessageBox.warning(self, "카메라 오류",
                                f"카메라(index={index})를 열 수 없습니다.")
            return
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
        # 버퍼 크기 1로 고정 → 백로그 burst 방지, 항상 최신 프레임만 반환
        # (드라이버에 따라 무시될 수 있으나 DSHOW에서는 유효)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        actual_fps = cap.get(cv2.CAP_PROP_FPS)
        aw = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        ah = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        # FOURCC 진단: MSMF는 signed int32 로 음수 반환할 수 있어 uint32 마스킹
        # 후 4-byte ASCII 로 디코드. 예: MJPG (0x47504A4D), YUY2 (0x32595559).
        fourcc_int = int(cap.get(cv2.CAP_PROP_FOURCC)) & 0xFFFFFFFF
        fourcc_bytes = fourcc_int.to_bytes(4, "little", signed=False)
        fourcc_ascii = "".join(
            chr(b) if 32 <= b < 127 else "?" for b in fourcc_bytes)
        logger.info(
            "카메라 오픈: idx=%d, %.0fx%.0f @ %.1f fps  fourcc=%s (0x%08X)",
            index, aw, ah, actual_fps, fourcc_ascii, fourcc_int)
        self.capture = cap
        # Face Landmarker 초기화 (기본 활성)
        self._init_face_landmarker()
        # 캡처 스레드 시작 (GUI와 분리)
        self._cap_stop.clear()
        self._cap_thread = threading.Thread(
            target=self._capture_loop, daemon=True
        )
        self._cap_thread.start()
        # Mesh 스레드 시작 (캡처/녹화와 분리)
        if self._face_landmarker is not None:
            self._mesh_stop.clear()
            self._mesh_last_capture_id = -1
            self._mesh_thread = threading.Thread(
                target=self._mesh_loop, daemon=True
            )
            self._mesh_thread.start()
        # 디스플레이 타이머 (페인팅만)
        self.timer.start(CAMERA_INTERVAL_MS)
        self.btn_cam_start.setEnabled(False)
        self.btn_cam_stop.setEnabled(True)
        self.btn_snapshot.setEnabled(True)
        self.combo_cameras.setEnabled(False)
        self.btn_cam_refresh.setEnabled(False)

    def stop_camera(self):
        # 1) mesh 스레드 정지 (face_landmarker 해제 전에)
        self._mesh_stop.set()
        if self._mesh_thread is not None:
            self._mesh_thread.join(timeout=1.5)
            self._mesh_thread = None
        # 2) landmarker 해제
        if self._face_landmarker is not None:
            try:
                self._face_landmarker.close()
            except Exception:
                pass
            self._face_landmarker = None
        with self._mesh_lock:
            self._mesh_landmarks = None
            self._mesh_bbox = None
            self._mesh_frame_shape = None
        # 3) 캡처 스레드 정지
        self.timer.stop()
        self._cap_stop.set()
        if self._cap_thread is not None:
            self._cap_thread.join(timeout=1.5)
            self._cap_thread = None
        if self.capture is not None:
            self.capture.release()
            self.capture = None
        with self._frame_lock:
            self.last_frame = None
            self._frame_times.clear()
        self.label_fps.setText("FPS: --")
        self.view.setText("카메라 꺼짐")
        self.view.setPixmap(QPixmap())
        self.btn_cam_start.setEnabled(True)
        self.btn_cam_stop.setEnabled(False)
        self.btn_snapshot.setEnabled(False)
        self.combo_cameras.setEnabled(True)
        self.btn_cam_refresh.setEnabled(True)

    def _capture_loop(self):
        """별도 스레드에서 카메라 프레임을 연속 캡처한다.

        시각은 PPG와 같은 축을 쓰기 위해 time.monotonic()으로 통일.
        """
        cap = self.capture
        while not self._cap_stop.is_set() and cap is not None:
            ok, frame = cap.read()
            if not ok or frame is None:
                if self._cap_stop.is_set():
                    break
                continue
            t = _time.monotonic()
            with self._frame_lock:
                self.last_frame = frame
                self._capture_id += 1
                self._frame_times.append(t)
            cb = self.frame_callback
            if cb is not None:
                try:
                    cb(frame, t)
                except Exception:
                    logger.exception("frame_callback error")

    def _mesh_loop(self):
        """Mesh 전용 스레드. 매 반복마다 '최신' 프레임만 처리.

        이미 처리한 capture_id면 스킵. 처리 중인 동안 캡처 스레드가
        last_frame을 여러 번 갱신하면, 다음 루프에서 자동으로 최신
        프레임으로 점프하여 '그 다음 이미지'로 재수행되는 효과.
        """
        while not self._mesh_stop.is_set():
            if self._face_landmarker is None:
                if self._mesh_stop.wait(0.05):
                    break
                continue
            # 최신 프레임 & id 획득
            with self._frame_lock:
                cap_id = self._capture_id
                frame = None if self.last_frame is None else self.last_frame.copy()
            if frame is None or cap_id == self._mesh_last_capture_id:
                if self._mesh_stop.wait(0.01):
                    break
                continue
            self._mesh_last_capture_id = cap_id

            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = self._face_landmarker.detect(mp_image)
            except Exception:
                logger.exception("face landmarker 처리 실패")
                continue

            h, w = frame.shape[:2]
            landmarks = None
            bbox = None
            if result.face_landmarks:
                landmarks = result.face_landmarks[0]
                bbox = self._compute_bbox(landmarks, w, h)
            with self._mesh_lock:
                self._mesh_landmarks = landmarks
                self._mesh_bbox = bbox
                self._mesh_frame_shape = (h, w)

    @staticmethod
    def _compute_bbox(face_landmarks, w: int, h: int) -> tuple:
        """랜드마크 min/max → (x_min, y_min, x_max, y_max) 픽셀 좌표."""
        xs = np.fromiter((p.x for p in face_landmarks), dtype=np.float32)
        ys = np.fromiter((p.y for p in face_landmarks), dtype=np.float32)
        x_min = float(xs.min()) * w
        y_min = float(ys.min()) * h
        x_max = float(xs.max()) * w
        y_max = float(ys.max()) * h
        bw = x_max - x_min
        bh = y_max - y_min
        x_min -= bw * RECORD_FACE_PAD
        x_max += bw * RECORD_FACE_PAD
        y_min -= bh * RECORD_FACE_PAD
        y_max += bh * RECORD_FACE_PAD
        x_min = int(max(0, x_min))
        y_min = int(max(0, y_min))
        x_max = int(min(w - 1, x_max))
        y_max = int(min(h - 1, y_max))
        if x_max <= x_min or y_max <= y_min:
            return None
        return (x_min, y_min, x_max, y_max)

    def get_face_bbox(self) -> "tuple | None":
        """Recording 스레드에서 호출. 최신 mesh bbox를 스냅샷으로 반환."""
        with self._mesh_lock:
            return self._mesh_bbox

    def get_mesh_snapshot(self):
        """Display 스레드에서 호출. (landmarks, bbox, (h,w)) 반환."""
        with self._mesh_lock:
            return self._mesh_landmarks, self._mesh_bbox, self._mesh_frame_shape

    def _init_face_landmarker(self):
        """카메라 시작 시 FaceLandmarker 초기화 (mesh 기본 활성)."""
        if not MEDIAPIPE_AVAILABLE or self._face_landmarker is not None:
            return
        try:
            model_path = ensure_face_landmarker_model()
            options = mp_vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(
                    model_asset_path=model_path),
                running_mode=mp_vision.RunningMode.IMAGE,
                num_faces=1,
            )
            self._face_landmarker = mp_vision.FaceLandmarker.create_from_options(options)
            logger.info("FaceLandmarker 초기화 완료")
        except Exception as e:
            logger.exception("FaceLandmarker 초기화 실패")
            self._mesh_enabled = False
            QMessageBox.warning(self, "FaceLandmarker",
                                f"초기화 실패 (mesh 비활성):\n{e}")

    def _draw_mesh_overlay(self, frame_bgr: np.ndarray) -> np.ndarray:
        """Mesh 스레드가 저장한 최신 결과를 프레임에 오버레이."""
        landmarks, bbox, shape = self.get_mesh_snapshot()
        if landmarks is None or shape is None:
            return frame_bgr
        ref_h, ref_w = shape
        h, w = frame_bgr.shape[:2]
        # 해상도 일치 가정 (캡처는 고정 해상도)
        if (ref_h, ref_w) != (h, w):
            return frame_bgr
        # 랜드마크 점 (초록)
        for lm in landmarks:
            px = int(lm.x * w)
            py = int(lm.y * h)
            if 0 <= px < w and 0 <= py < h:
                cv2.circle(frame_bgr, (px, py), 1, (0, 255, 0), -1)
        # BBox (cyan)
        if bbox is not None:
            x1, y1, x2, y2 = bbox
            cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), (255, 255, 0), 2)
        return frame_bgr

    def _update_frame(self):
        """디스플레이 전용: 최근 프레임을 GUI에 페인트.

        주의: 이 경로는 녹화/캡처와 완전히 분리되어 있다.
        FaceMesh 처리가 느려져도 녹화 FPS에는 영향이 없다.
        """
        now = _time.monotonic()
        with self._frame_lock:
            frame = None if self.last_frame is None else self.last_frame.copy()
            ft = list(self._frame_times)
        # FPS: 최근 프레임 시각들로 rolling 계산. 오래된 프레임(>2s)은 무시.
        recent = [t for t in ft if now - t <= 2.0]
        if len(recent) >= 2:
            span = recent[-1] - recent[0]
            fps = (len(recent) - 1) / span if span > 0 else 0.0
            self.label_fps.setText(f"FPS: {fps:.1f}")
        elif not ft:
            self.label_fps.setText("FPS: --")
        if frame is None:
            return
        # Mesh 오버레이 (캐시된 결과 그리기만 - 추론은 mesh 스레드에서)
        if self._face_landmarker is not None:
            frame = self._draw_mesh_overlay(frame)
        # cv2.resize 로 view 위젯 크기에 맞춰 미리 축소 — QPixmap.scaled 만
        # 의존하면 윈도우 확장 시 pixmap 이 커지면서 view label 도 함께
        # 늘어나 layout(특히 PPG plot 영역)을 밀어버리는 경우가 있다.
        # cv2.resize INTER_AREA 가 QPixmap.scaled(SmoothTransformation)
        # 보다 빠르기도 함.
        h0, w0 = frame.shape[:2]
        target_w = max(1, self.view.width())
        target_h = max(1, self.view.height())
        if w0 > target_w or h0 > target_h:
            s = min(target_w / w0, target_h / h0)
            new_w = max(1, int(w0 * s))
            new_h = max(1, int(h0 * s))
            frame_small = cv2.resize(frame, (new_w, new_h),
                                     interpolation=cv2.INTER_AREA)
        else:
            frame_small = frame
        rgb = cv2.cvtColor(frame_small, cv2.COLOR_BGR2RGB)
        h, w, ch = rgb.shape
        qimg = QImage(rgb.data, w, h, ch * w, QImage.Format_RGB888)
        self.view.setPixmap(QPixmap.fromImage(qimg))

    @property
    def is_running(self) -> bool:
        return self.capture is not None

    def save_snapshot(self):
        if self.last_frame is None:
            return
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_path = os.path.join(SNAPSHOT_DIR, f"face_{ts}.png")
        path, _ = QFileDialog.getSaveFileName(
            self, "스냅샷 저장", default_path, "Images (*.png *.jpg)"
        )
        if not path:
            return
        cv2.imwrite(path, self.last_frame)
        logger.info("스냅샷 저장: %s", path)


# ═══════════════════════════════════════════════════════════════════════
# Main Window
# ═══════════════════════════════════════════════════════════════════════

class PPGWithCamWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Medicore Smart Pulse - PPG + 카메라")
        self.resize(1500, 900)
        self.setMinimumSize(1200, 820)

        # 데이터
        self.ring_buffer = RingBuffer(BUFFER_SIZE)
        self.data_queue = queue.Queue(maxsize=5000)
        self.hr_queue = queue.Queue(maxsize=100)
        self.status_queue = queue.Queue(maxsize=100)
        self.finger_queue = queue.Queue(maxsize=100)
        self.current_hr = 0.0
        self.sample_count = 0
        self.finger_on = False
        self._is_measuring_ui = False
        self._last_packet_time = 0.0
        self._no_packet_handled = False
        self._got_first_packet = False

        # 세션 기록 상태
        self._recording = False
        self._csv_file = None
        self._csv_writer = None
        self._record_start_time = 0.0
        self._current_finger_on = False
        self._record_frames: list[np.ndarray] = []
        self._record_frame_times: list[float] = []
        self._record_csv_path: str = ""
        self._record_bin_path: str = ""
        self._record_duration: float = RECORD_DURATION_OPTIONS[0][0]
        # 첫 PPG 샘플의 monotonic 시각 — PPG CSV와 face.bin 모두 여기를 t=0으로 사용
        self._record_t_mono_base: float = -1.0
        # Gemini 방식 save-time 회귀용 PPG 버퍼: list of (raw_value, expected_idx, arrival_mono)
        self._record_ppg_buffer: "list[tuple[int, int, float]]" = []
        # 드롭 보정된 샘플 인덱스 카운터 (예상 samples received-if-no-drops)
        self._record_ppg_expected_idx: int = 0
        # 이전 패킷 arrival_mono (dt/4 계산용)
        self._record_ppg_prev_arr: float = -1.0
        # 장시간 녹화용 chunk writer (디스크 I/O를 별 스레드로 분리)
        self._record_buf_lock = threading.Lock()
        self._chunk_queue: "queue.Queue | None" = None
        self._writer_thread: "threading.Thread | None" = None
        self._chunk_paths: list[str] = []
        self._chunk_index: int = 0
        self._flush_timer: "QTimer | None" = None

        # BLE Worker
        self.ble_worker = BLEWorker(self.data_queue, self.hr_queue,
                                    self.status_queue, self.finger_queue)
        self.ble_worker.start()

        self._init_ui()
        self._init_timer()

    def _init_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)

        # ─── 좌측: 플롯 + 컨트롤 ──────────────────────────────────────
        plot_layout = QVBoxLayout()

        ctrl_layout = QHBoxLayout()

        self.btn_scan = QPushButton("스캔")
        self.btn_scan.clicked.connect(self._on_scan)
        ctrl_layout.addWidget(self.btn_scan)

        self.combo_devices = QComboBox()
        self.combo_devices.setMinimumWidth(250)
        ctrl_layout.addWidget(self.combo_devices)

        self.btn_connect = QPushButton("연결")
        self.btn_connect.clicked.connect(self._on_connect)
        self.btn_connect.setEnabled(False)
        ctrl_layout.addWidget(self.btn_connect)

        self.btn_start = QPushButton("측정 시작")
        self.btn_start.clicked.connect(self._on_start)
        self.btn_start.setEnabled(False)
        ctrl_layout.addWidget(self.btn_start)

        self.btn_stop = QPushButton("측정 중단")
        self.btn_stop.clicked.connect(self._on_stop)
        self.btn_stop.setEnabled(False)
        ctrl_layout.addWidget(self.btn_stop)

        self.btn_disconnect = QPushButton("연결 해제")
        self.btn_disconnect.clicked.connect(self._on_disconnect)
        self.btn_disconnect.setEnabled(False)
        ctrl_layout.addWidget(self.btn_disconnect)

        ctrl_layout.addStretch()
        plot_layout.addLayout(ctrl_layout)

        self.label_status = QLabel("대기 중")
        self.label_status.setStyleSheet("color: gray; font-size: 12px; padding: 2px;")
        plot_layout.addWidget(self.label_status)

        pg.setConfigOptions(antialias=True)
        self.plot_widget = pg.PlotWidget()
        self.plot_widget.setMinimumSize(500, 300)
        self.plot_widget.setBackground("w")
        self.plot_widget.setTitle("PPG Waveform", color="k", size="12pt")
        self.plot_widget.setLabel("left", "Raw Value")
        self.plot_widget.setLabel("bottom", "Time (s)")
        self.plot_widget.showGrid(x=True, y=True, alpha=0.3)
        self.plot_curve = self.plot_widget.plot(pen=pg.mkPen(color="r", width=2))
        plot_layout.addWidget(self.plot_widget)

        main_layout.addLayout(plot_layout, stretch=3)

        # ─── 우측: 카메라 + Info ──────────────────────────────────────
        right_layout = QVBoxLayout()

        self.camera_panel = CameraPanel()
        right_layout.addWidget(self.camera_panel, stretch=3)

        info_group = QGroupBox("Info")
        info_layout = QVBoxLayout(info_group)
        info_layout.setAlignment(Qt.AlignTop)
        info_layout.setSpacing(4)
        info_layout.setContentsMargins(8, 8, 8, 8)

        hr_label = QLabel("Heart Rate")
        hr_label.setAlignment(Qt.AlignCenter)
        hr_label.setFont(QFont("Arial", 14))
        info_layout.addWidget(hr_label)

        self.label_hr = QLabel("-- BPM")
        self.label_hr.setAlignment(Qt.AlignCenter)
        self.label_hr.setFont(QFont("Arial", 26, QFont.Bold))
        self.label_hr.setStyleSheet("color: #e74c3c;")
        info_layout.addWidget(self.label_hr)

        finger_label = QLabel("Finger")
        finger_label.setAlignment(Qt.AlignCenter)
        finger_label.setFont(QFont("Arial", 12))
        info_layout.addWidget(finger_label)

        self.label_finger = QLabel("--")
        self.label_finger.setAlignment(Qt.AlignCenter)
        self.label_finger.setFont(QFont("Arial", 14, QFont.Bold))
        self.label_finger.setStyleSheet("color: gray;")
        info_layout.addWidget(self.label_finger)

        self.label_samples = QLabel("Samples: 0")
        self.label_samples.setFont(QFont("Arial", 10))
        info_layout.addWidget(self.label_samples)

        self.label_rate = QLabel("Rate: -- Hz")
        self.label_rate.setFont(QFont("Arial", 10))
        info_layout.addWidget(self.label_rate)

        info_layout.addSpacing(6)

        # 세션 메타데이터 입력 (학습용 데이터셋 구축)
        meta_label = QLabel("세션 메타데이터 (필수)")
        meta_label.setFont(QFont("Arial", 9, QFont.Bold))
        info_layout.addWidget(meta_label)

        subj_row = QHBoxLayout()
        subj_row.addWidget(QLabel("Subject ID:"))
        self.edit_subject = QLineEdit()
        self.edit_subject.setPlaceholderText("예: s001")
        subj_row.addWidget(self.edit_subject, stretch=1)
        info_layout.addLayout(subj_row)

        cond_row = QHBoxLayout()
        cond_row.addWidget(QLabel("Condition:"))
        self.combo_condition = QComboBox()
        for c in ["rest", "exercise", "post_exercise", "talking", "other"]:
            self.combo_condition.addItem(c)
        cond_row.addWidget(self.combo_condition, stretch=1)
        info_layout.addLayout(cond_row)

        light_row = QHBoxLayout()
        light_row.addWidget(QLabel("Lighting:"))
        self.combo_lighting = QComboBox()
        for l in ["natural", "indoor_warm", "indoor_cool", "dim"]:
            self.combo_lighting.addItem(l)
        light_row.addWidget(self.combo_lighting, stretch=1)
        info_layout.addLayout(light_row)

        notes_row = QHBoxLayout()
        notes_row.addWidget(QLabel("Notes:"))
        self.edit_notes = QLineEdit()
        self.edit_notes.setPlaceholderText("선택")
        notes_row.addWidget(self.edit_notes, stretch=1)
        info_layout.addLayout(notes_row)

        info_layout.addSpacing(4)

        duration_row = QHBoxLayout()
        duration_row.addWidget(QLabel("녹화 길이:"))
        self.combo_duration = QComboBox()
        for dur, label in RECORD_DURATION_OPTIONS:
            self.combo_duration.addItem(label, dur)
        duration_row.addWidget(self.combo_duration, stretch=1)
        info_layout.addLayout(duration_row)

        self.btn_record = QPushButton("기록 시작")
        self.btn_record.setFont(QFont("Arial", 12, QFont.Bold))
        self.btn_record.setMinimumHeight(40)
        self.btn_record.clicked.connect(self._on_record_toggle)
        self.btn_record.setEnabled(False)
        info_layout.addWidget(self.btn_record)

        self.label_record = QLabel("카메라와 PPG 신호가 모두 필요합니다")
        self.label_record.setAlignment(Qt.AlignCenter)
        self.label_record.setStyleSheet("color: gray; font-size: 10px;")
        self.label_record.setWordWrap(True)
        info_layout.addWidget(self.label_record)

        right_layout.addWidget(info_group, stretch=2)

        main_layout.addLayout(right_layout, stretch=2)

    def _init_timer(self):
        self.update_timer = QTimer()
        self.update_timer.timeout.connect(self._update_plot)
        self.update_timer.start(UPDATE_INTERVAL_MS)

        self._rate_sample_count = 0
        self._rate_timer = QTimer()
        self._rate_timer.timeout.connect(self._update_rate)
        self._rate_timer.start(1000)

    # ─── 버튼 핸들러 ─────────────────────────────────────────────────

    def _on_scan(self):
        self.btn_scan.setEnabled(False)
        self.combo_devices.clear()
        self.label_status.setText("스캔 중...")

        future = self.ble_worker.request_scan()
        if future:
            future.add_done_callback(self._on_scan_done)

    def _on_scan_done(self, future):
        QTimer.singleShot(0, self._update_device_list)

    def _update_device_list(self):
        self.btn_scan.setEnabled(True)
        devices = self.ble_worker.devices
        self.combo_devices.clear()
        for d in devices:
            display = f"{d.name} ({d.address})"
            self.combo_devices.addItem(display, d.address)
        self.btn_connect.setEnabled(len(devices) > 0)

    def _on_connect(self):
        address = self.combo_devices.currentData()
        if not address:
            return
        self.btn_connect.setEnabled(False)
        future = self.ble_worker.request_connect(address)
        if future:
            future.add_done_callback(lambda f: QTimer.singleShot(0, self._on_connect_done))

    def _on_connect_done(self):
        if self.ble_worker.sdk.is_connected:
            self.btn_start.setEnabled(True)
            self.btn_disconnect.setEnabled(True)
            self.btn_connect.setEnabled(False)
        else:
            self.btn_connect.setEnabled(True)

    def _on_start(self):
        self.ble_worker.request_start()
        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.sample_count = 0
        self._rate_sample_count = 0
        self._is_measuring_ui = True
        self._last_packet_time = _time.monotonic()
        self._no_packet_handled = False
        self._got_first_packet = False
        self.ring_buffer = RingBuffer(BUFFER_SIZE)
        self.label_status.setText("측정 대기 중...")
        self.label_status.setStyleSheet("color: green; font-size: 12px; padding: 2px;")
        self.label_finger.setText("--")
        self.label_finger.setStyleSheet("color: gray;")

    def _on_stop(self):
        if self._recording:
            self._stop_recording()
        self.ble_worker.request_stop()
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self._is_measuring_ui = False
        self._update_record_availability()

    def _on_disconnect(self):
        if self._recording:
            self._stop_recording()
        self.ble_worker.request_disconnect()
        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(False)
        self.btn_disconnect.setEnabled(False)
        self.btn_connect.setEnabled(True)

    # ─── 기록 (세션) ─────────────────────────────────────────────────

    def _update_record_availability(self):
        """카메라 동작 + PPG 패킷 수신 중일 때만 기록 버튼 활성화.

        PPG 신호 유효성은 최근 0.5초 이내 패킷이 들어왔는지로 판단한다.
        (is_measuring_ui 플래그에만 의존하면 UI 상태와 실제 스트림이
        어긋날 때 버튼이 활성화되지 않을 수 있다)
        """
        if self._recording:
            return
        ppg_stream_alive = (
            self._got_first_packet
            and self._last_packet_time > 0
            and (_time.monotonic() - self._last_packet_time) < 0.5
        )
        cam_ok = self.camera_panel.is_running
        ready = ppg_stream_alive and cam_ok
        self.btn_record.setEnabled(ready)
        if ready:
            self.label_record.setText("준비됨 - 기록을 시작할 수 있습니다")
            self.label_record.setStyleSheet("color: #27ae60; font-size: 10px; font-weight: bold;")
        else:
            missing = []
            if not cam_ok:
                missing.append("카메라")
            if not ppg_stream_alive:
                missing.append("PPG 신호")
            self.label_record.setText(f"대기: {', '.join(missing)} 필요")
            self.label_record.setStyleSheet("color: gray; font-size: 10px;")

    def _on_record_toggle(self):
        if self._recording:
            self._stop_recording()
        else:
            self._start_recording()

    @staticmethod
    def _sanitize_id(s: str) -> str:
        """파일시스템 안전한 subject_id로 변환 (영문/숫자/_/- 만 유지)."""
        cleaned = re.sub(r"[^A-Za-z0-9_\-]", "_", s.strip())
        return cleaned or "unknown"

    @staticmethod
    def _format_duration(sec: float) -> str:
        """60초 이상은 mm:ss, 미만은 {SS.S}s."""
        sec = max(0.0, float(sec))
        if sec >= 60:
            m = int(sec // 60)
            s = sec - m * 60
            return f"{m}:{s:04.1f}"
        return f"{sec:4.1f}s"

    def _capture_device_info(self) -> dict:
        """녹화 시점 카메라/기기 메타데이터 스냅샷."""
        sel = self.camera_panel.get_selected_camera()
        return {
            "camera_backend": (
                "DSHOW" if sys.platform.startswith("win") else "default"),
            "camera_index": sel[0] if sel is not None else -1,
            "camera_name": sel[1] if sel is not None else "unknown",
            "ppg_device": "Medicore Smart Pulse",
        }

    def _start_recording(self):
        # 필수 메타데이터 검증
        subject_id_raw = self.edit_subject.text().strip()
        if not subject_id_raw:
            QMessageBox.warning(
                self, "메타데이터 누락",
                "Subject ID를 입력해야 녹화를 시작할 수 있습니다."
            )
            return
        subject_id = self._sanitize_id(subject_id_raw)
        condition = self.combo_condition.currentText()
        lighting = self.combo_lighting.currentText()
        notes = self.edit_notes.text().strip()

        # 선택된 녹화 길이 캡처
        self._record_duration = float(self.combo_duration.currentData())
        self.combo_duration.setEnabled(False)
        # 메타 입력 위젯 잠금
        self.edit_subject.setEnabled(False)
        self.combo_condition.setEnabled(False)
        self.combo_lighting.setEnabled(False)
        self.edit_notes.setEnabled(False)

        # records/<subject_id>/<YYYYMMDD_HHMMSS>/{face.bin, ref.csv, meta.json}
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        start_iso = datetime.now(timezone.utc).astimezone().isoformat()
        session_dir = os.path.join(RECORD_DIR, subject_id, session_id)
        os.makedirs(session_dir, exist_ok=True)
        csv_path = os.path.join(session_dir, "ref.csv")
        bin_path = os.path.join(session_dir, "face.bin")
        meta_path = os.path.join(session_dir, "meta.json")
        # CSV는 라이브 스트리밍하지 않고 종료 시 회귀 처리 후 한 번에 씀
        # (경로만 저장해뒀다가 _stop_recording에서 기록)
        self._csv_file = None
        self._csv_writer = None

        self._record_csv_path = csv_path
        self._record_bin_path = bin_path
        self._record_meta_path = meta_path
        self._record_frames = []
        self._record_frame_times = []
        # 녹화 전체 구간 프레임 도착 시각 (총평균 FPS 계산용)
        self._record_frame_arrivals_mono: list[float] = []
        # 메타 정보 스냅샷
        self._record_meta = {
            "session_id": session_id,
            "subject_id": subject_id,
            "subject_id_raw": subject_id_raw,
            "condition": condition,
            "lighting": lighting,
            "notes": notes,
            "start_time": start_iso,
            "target_duration_s": self._record_duration,
            "face_size": RECORD_FACE_SIZE,
            "face_pad_ratio": RECORD_FACE_PAD,
            "camera_target_fps": CAMERA_FPS,
            "ppg_sample_rate_hz": SAMPLE_RATE_HZ,
            "ppg_polarity": "inverted",
            "device": self._capture_device_info(),
        }

        self._recording = True
        self._record_start_time = _time.monotonic()
        self._record_t_mono_base = -1.0
        self._record_ppg_sample_count = 0
        # PPG 버퍼 + 드롭 추적 상태 리셋
        self._record_ppg_buffer = []
        self._record_ppg_expected_idx = 0
        self._record_ppg_prev_arr = -1.0
        # chunk writer 초기화 + 시작
        self._chunk_paths = []
        self._chunk_index = 0
        self._chunk_queue = queue.Queue()
        self._writer_thread = threading.Thread(
            target=self._writer_loop, name="RecordWriter", daemon=True)
        self._writer_thread.start()
        # 60초마다 flush — QTimer 생성은 최초 1회만, 이후 재시작
        if self._flush_timer is None:
            self._flush_timer = QTimer(self)
            self._flush_timer.setInterval(int(RECORD_CHUNK_SECONDS * 1000))
            self._flush_timer.timeout.connect(self._flush_chunk)
        self._flush_timer.start()
        # 카메라 프레임 콜백 연결
        self.camera_panel.frame_callback = self._on_record_frame

        self.btn_record.setText(
            f"기록 중 {self._format_duration(self._record_duration)}")
        self.btn_record.setStyleSheet(
            "QPushButton { background-color: #c0392b; color: white; }"
        )
        self.label_record.setText(
            f"기록 중: {os.path.relpath(session_dir, RECORD_DIR)}")
        self.label_record.setStyleSheet("color: #c0392b; font-size: 10px; font-weight: bold;")

    def _on_record_frame(self, frame_bgr: np.ndarray, t_mono: float):
        """CameraPanel 캡처 스레드에서 매 프레임 호출.

        카메라 프레임 시각은 순수 monotonic 기반으로 저장한다:
            elapsed = t_mono - self._record_t_mono_base
        PPG CSV의 t(0부터)와 같은 원점(첫 PPG 샘플의 실시간 순간)을 공유하지만
        각 스트림이 자기 시계로 흐르므로 프레임 간격은 카메라 드라이버의
        네이티브 지터만 반영한다.
        """
        if not self._recording:
            return
        if self._record_t_mono_base < 0:
            return  # 첫 PPG 샘플 아직 없음 → 원점 미확정
        elapsed = t_mono - self._record_t_mono_base
        if elapsed < 0 or elapsed > self._record_duration:
            return
        # 전체 녹화구간 FPS 통계용 (rolling deque와 별개로 총합 누적)
        self._record_frame_arrivals_mono.append(t_mono)
        bbox = self.camera_panel.get_face_bbox()
        if bbox is None:
            return
        x1, y1, x2, y2 = bbox
        h, w = frame_bgr.shape[:2]
        # 안전 클램프
        x1 = max(0, min(w - 1, x1))
        y1 = max(0, min(h - 1, y1))
        x2 = max(0, min(w, x2))
        y2 = max(0, min(h, y2))
        if x2 <= x1 or y2 <= y1:
            return
        crop = frame_bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return
        face = cv2.resize(
            crop,
            (RECORD_FACE_SIZE, RECORD_FACE_SIZE),
            interpolation=cv2.INTER_AREA,
        )
        with self._record_buf_lock:
            self._record_frames.append(face)
            self._record_frame_times.append(elapsed)

    @staticmethod
    def _write_bin(out_path: str, frames_bgr_list: list, times_sec: list):
        """libs/preprocess_mtx.py 호환 bin 포맷으로 저장.

        헤더 (big-endian uint64 × 3): width, height, timeLen
        이미지: N × W × H × 3 uint8 (RGB)
        시간: N × 8B uint64 (μs, 소수점 버림)
        """
        n = len(frames_bgr_list)
        if n == 0:
            return
        frames = np.stack(frames_bgr_list, axis=0)  # (N, H, W, 3) BGR uint8
        h, w = frames.shape[1], frames.shape[2]
        # BGR → RGB
        frames_rgb = frames[..., ::-1]
        # preprocess_mtx.py reshape는 (timeLen, width, height, 3)
        # 정사각 (W==H)이면 차이 없음, 일반화를 위해 전치
        if w != h:
            frames_rgb = np.transpose(frames_rgb, (0, 2, 1, 3))
        frames_rgb = np.ascontiguousarray(frames_rgb)

        # 초 → 마이크로초 (소수점 버림)
        times_us = (np.asarray(times_sec, dtype=np.float64) * 1_000_000.0)
        times_us = np.trunc(times_us).astype(np.uint64)

        with open(out_path, "wb") as f:
            f.write(struct.pack(">Q", w))
            f.write(struct.pack(">Q", h))
            f.write(struct.pack(">Q", n))
            f.write(frames_rgb.tobytes())
            f.write(struct.pack(f">{n}Q", *times_us.tolist()))

        logger.info("BIN 저장: %s (%d faces @ %dx%d, %.2f MB)",
                    out_path, n, w, h,
                    os.path.getsize(out_path) / 1024 / 1024)

    def _flush_chunk(self):
        """버퍼 스왑 → writer 큐에 push. 락 유지 시간 O(microseconds).

        GUI 스레드(60초 QTimer 혹은 녹화 종료 시점)에서만 호출.
        """
        with self._record_buf_lock:
            frames = self._record_frames
            times = self._record_frame_times
            self._record_frames = []
            self._record_frame_times = []
        if frames and self._chunk_queue is not None:
            self._chunk_queue.put((frames, times))

    def _writer_loop(self):
        """chunk 큐에서 꺼내 파일로 저장하는 writer 스레드 메인.

        None(sentinel)을 받으면 종료.
        """
        while True:
            item = self._chunk_queue.get()
            if item is None:  # shutdown sentinel
                return
            frames, times = item
            chunk_path = (
                f"{self._record_bin_path}.chunk{self._chunk_index:03d}")
            self._chunk_index += 1
            try:
                fixed, n_fixed = self._interpolate_bad_times(times)
                if n_fixed:
                    logger.debug("chunk %s 타임스탬프 보정: %d곳",
                                 os.path.basename(chunk_path), n_fixed)
                self._write_bin(chunk_path, frames, fixed)
                self._chunk_paths.append(chunk_path)
            except Exception:
                logger.exception("chunk 저장 실패: %s", chunk_path)
            finally:
                # numpy 배열들 즉시 해제 (GC hint)
                del frames, times

    @staticmethod
    def _merge_chunks(final_path: str, chunk_paths: list[str]):
        """chunk mini-bin들을 하나의 face.bin으로 병합.

        각 chunk는 동일 포맷(헤더 + 프레임 + 타임스탬프)을 가진다고 가정.
        스트리밍 방식으로 복사하므로 메모리에 전체를 올리지 않음.
        """
        if not chunk_paths:
            return
        if len(chunk_paths) == 1:
            # 단일 chunk면 그냥 rename — merge 비용 0
            os.replace(chunk_paths[0], final_path)
            return

        # 1st pass: 헤더만 읽어 total N + W/H 확인
        infos = []
        w = h = None
        total_n = 0
        for cp in chunk_paths:
            with open(cp, "rb") as f:
                cw, ch, cn = struct.unpack(">QQQ", f.read(24))
            if w is None:
                w, h = cw, ch
            elif (cw, ch) != (w, h):
                logger.warning("chunk W/H 불일치, 스킵: %s", cp)
                continue
            infos.append((cp, cn))
            total_n += cn

        if total_n == 0 or w is None:
            return

        frame_bytes_per = int(w) * int(h) * 3
        buf_size = 4 * 1024 * 1024

        # 2nd pass: 헤더 쓰고, 프레임 블록들 순차 연결, 타임스탬프 블록들 순차 연결
        with open(final_path, "wb") as fout:
            fout.write(struct.pack(">QQQ", int(w), int(h), int(total_n)))
            # frames section
            for cp, cn in infos:
                with open(cp, "rb") as fin:
                    fin.seek(24)
                    remaining = cn * frame_bytes_per
                    while remaining > 0:
                        block = fin.read(min(remaining, buf_size))
                        if not block:
                            break
                        fout.write(block)
                        remaining -= len(block)
            # timestamps section
            for cp, cn in infos:
                with open(cp, "rb") as fin:
                    fin.seek(24 + cn * frame_bytes_per)
                    remaining = cn * 8
                    while remaining > 0:
                        block = fin.read(min(remaining, buf_size))
                        if not block:
                            break
                        fout.write(block)
                        remaining -= len(block)

        # 병합 성공 시 chunk 파일 삭제
        for cp, _ in infos:
            try:
                os.remove(cp)
            except OSError:
                logger.warning("chunk 삭제 실패: %s", cp)

    def _write_ref_csv_regressed(self):
        """PPG 버퍼에 선형회귀를 적용해 ref.csv를 한 번에 기록한다 (Gemini Step 2).

        원리:
          y = slope * idx + intercept
          - idx: 받은 sample의 순서 인덱스 (0, 1, 2, ...)
          - y: 드레인 루프에서 저장한 per-sample arrival_mono (Gemini Step 1)
        회귀로 얻은 slope가 "sample당 실제 경과 시간". 디바이스 실제 rate에 자동
        맞춰지고 결과는 단조증가 보장. Drop은 명시 감지 대신 회귀가 흡수.
        """
        buf = self._record_ppg_buffer
        if not buf or not self._record_csv_path:
            # 빈 CSV라도 헤더는 써두면 다운스트림 호환 유지
            if self._record_csv_path:
                with open(self._record_csv_path, "w", newline="",
                          encoding="utf-8") as f:
                    writer = csv.writer(f)
                    writer.writerow(["time_s", "ppg"])
            self._record_ppg_sample_count = 0
            return

        raws = np.fromiter((r for r, _, _ in buf), dtype=np.int32, count=len(buf))
        idxs = np.fromiter((i for _, i, _ in buf), dtype=np.float64, count=len(buf))
        arrs = np.fromiter((t for _, _, t in buf), dtype=np.float64, count=len(buf))

        if len(buf) >= 2 and idxs.max() > idxs.min():
            slope, intercept = np.polyfit(idxs, arrs, 1)
            t_fitted = slope * idxs + intercept
        else:
            # 샘플이 1개뿐이면 회귀 불가 — raw 사용
            t_fitted = arrs.copy()

        # face.bin과 동일 origin (record_t_mono_base)으로 상대화
        if self._record_t_mono_base < 0:
            self._record_t_mono_base = float(t_fitted[0])
        t_rel = t_fitted - self._record_t_mono_base

        # 녹화 duration 초과분 컷
        cutoff = self._record_duration
        keep = t_rel <= cutoff
        t_rel = t_rel[keep]
        raws = raws[keep]

        with open(self._record_csv_path, "w", newline="",
                  encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["time_s", "ppg"])
            for t, r in zip(t_rel, raws):
                writer.writerow([f"{t:.4f}", int(r)])

        self._record_ppg_sample_count = int(len(t_rel))

        # 진단용 로그
        if len(buf) >= 2:
            logger.info(
                "ref.csv 회귀 저장: N=%d, slope=%.3fms/sample, duration=%.3fs",
                self._record_ppg_sample_count,
                slope * 1000.0,
                float(t_rel[-1]) if len(t_rel) else 0.0,
            )

    def _write_meta_json(self, n_frames: int):
        """녹화 종료 시 세션 메타데이터 JSON 저장."""
        if not getattr(self, "_record_meta", None):
            return
        meta = dict(self._record_meta)

        # 실제 녹화 지속 시간: chunk로 버퍼가 비워졌을 수 있으므로
        # arrival_mono 전체 누적 리스트에서 계산 (가장 견고)
        arr_mono = self._record_frame_arrivals_mono
        if len(arr_mono) >= 2:
            duration_s = float(arr_mono[-1] - arr_mono[0])
        elif self._record_frame_times:
            duration_s = float(
                self._record_frame_times[-1] - self._record_frame_times[0])
        else:
            duration_s = 0.0

        # 전체 구간 평균/표준편차 FPS
        avg_fps = float("nan")
        std_fps = float("nan")
        arrivals = self._record_frame_arrivals_mono
        if len(arrivals) >= 2:
            arr = np.asarray(arrivals, dtype=np.float64)
            span = arr[-1] - arr[0]
            if span > 0:
                avg_fps = (len(arr) - 1) / span
            diffs = np.diff(arr)
            diffs = diffs[diffs > 1e-6]
            if len(diffs) >= 2:
                inst_fps = 1.0 / diffs
                std_fps = float(np.std(inst_fps, ddof=1))

        meta.update({
            "duration_s": round(duration_s, 3),
            "camera_measured_fps_avg": (
                round(avg_fps, 2) if np.isfinite(avg_fps) else None),
            "camera_measured_fps_std": (
                round(std_fps, 3) if np.isfinite(std_fps) else None),
            "n_frames": int(n_frames),
            "n_ppg_samples": int(getattr(self, "_record_ppg_sample_count", 0)),
            "ended_time": datetime.now(timezone.utc).astimezone().isoformat(),
        })

        with open(self._record_meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
        logger.info("META 저장: %s", self._record_meta_path)

    @staticmethod
    def _interpolate_bad_times(times: list) -> tuple:
        """비단조증가 타임스탬프를 앞뒤 유효 값 사이에서 선형 보간.

        단일 중복(t, t)은 사용자가 요청한 대로 (t_prev + t_next)/2 로 치환되고,
        연속 중복도 동일 로직의 일반화로 균등 분할된다.
        말단 구간(뒤에 유효 값 없음)은 이전 평균 간격을 사용해 연장.
        """
        arr = list(times)
        n = len(arr)
        if n < 2:
            return arr, 0
        fixed = 0
        i = 1
        while i < n:
            if arr[i] > arr[i - 1]:
                i += 1
                continue
            # 비정상 구간 i ~ (j-1), j는 첫 정상값
            j = i
            while j < n and arr[j] <= arr[i - 1]:
                j += 1
            if j >= n:
                # 꼬리 전부 비정상: 평균 간격으로 연장
                if i >= 2:
                    avg = (arr[i - 1] - arr[0]) / (i - 1)
                else:
                    avg = 1.0 / 30.0
                for k in range(i, n):
                    arr[k] = arr[i - 1] + (k - i + 1) * avg
                    fixed += 1
                break
            # arr[i-1] 과 arr[j] 사이를 선형으로 나눔
            steps = j - (i - 1)
            dt = (arr[j] - arr[i - 1]) / steps
            for k in range(i, j):
                arr[k] = arr[i - 1] + (k - (i - 1)) * dt
                fixed += 1
            i = j + 1
        return arr, fixed

    def _stop_recording(self, auto: bool = False):
        if not self._recording:
            return
        self._recording = False
        # 카메라 콜백 해제
        self.camera_panel.frame_callback = None

        # PPG 버퍼 → 선형 회귀 → CSV 저장 (Gemini Step 2)
        try:
            self._write_ref_csv_regressed()
        except Exception:
            logger.exception("ref.csv 저장 실패")

        # flush QTimer 멈추고 남은 버퍼를 writer에 push
        if self._flush_timer is not None:
            self._flush_timer.stop()
        self._flush_chunk()

        # writer 스레드 종료 대기 (sentinel)
        if self._chunk_queue is not None:
            self._chunk_queue.put(None)
        if self._writer_thread is not None:
            self._writer_thread.join(timeout=60.0)
            if self._writer_thread.is_alive():
                logger.warning("writer 스레드 종료 지연 — 강제 진행")
            self._writer_thread = None
        self._chunk_queue = None

        # chunk → 최종 face.bin 병합
        n_frames_total = 0
        try:
            if self._chunk_paths:
                # chunk 헤더들에서 총 프레임 수 계산 (meta.json 용)
                for cp in self._chunk_paths:
                    try:
                        with open(cp, "rb") as f:
                            _, _, cn = struct.unpack(">QQQ", f.read(24))
                        n_frames_total += int(cn)
                    except Exception:
                        logger.exception("chunk 헤더 읽기 실패: %s", cp)
                self._merge_chunks(self._record_bin_path, self._chunk_paths)
        except Exception as e:
            logger.exception("BIN 병합 실패")
            QMessageBox.warning(self, "저장 오류", f"BIN 병합 실패:\n{e}")

        # meta.json 저장
        try:
            self._write_meta_json(n_frames_total)
        except Exception:
            logger.exception("meta.json 저장 실패")

        self._chunk_paths = []
        with self._record_buf_lock:
            self._record_frames = []
            self._record_frame_times = []
        self._record_frame_arrivals_mono = []
        self._record_ppg_buffer = []
        n_frames = n_frames_total

        # UI 복구
        self.btn_record.setText("기록 시작")
        self.btn_record.setStyleSheet("")
        self.combo_duration.setEnabled(True)
        self.edit_subject.setEnabled(True)
        self.combo_condition.setEnabled(True)
        self.combo_lighting.setEnabled(True)
        self.edit_notes.setEnabled(True)

        if auto and n_frames > 0:
            QMessageBox.information(
                self, "기록 완료",
                f"{self._format_duration(self._record_duration)} 기록 완료\n\n"
                f"폴더: {os.path.relpath(os.path.dirname(self._record_bin_path), RECORD_DIR)}\n"
                f"  - ref.csv\n"
                f"  - face.bin ({n_frames} frames)"
            )
        self._update_record_availability()

    # ─── 플롯 갱신 ───────────────────────────────────────────────────

    def _update_plot(self):
        while not self.status_queue.empty():
            try:
                msg, color = self.status_queue.get_nowait()
                self.label_status.setText(msg)
                self.label_status.setStyleSheet(f"color: {color}; font-size: 12px; padding: 2px;")
            except queue.Empty:
                break

        while not self.hr_queue.empty():
            try:
                self.current_hr = self.hr_queue.get_nowait()
                self.label_hr.setText(f"{self.current_hr:.0f} BPM")
            except queue.Empty:
                break

        while not self.finger_queue.empty():
            try:
                self.finger_on = self.finger_queue.get_nowait()
                self._current_finger_on = self.finger_on
                if self.finger_on:
                    self.label_finger.setText("ON")
                    self.label_finger.setStyleSheet("color: #27ae60; font-weight: bold;")
                else:
                    self.label_finger.setText("OFF")
                    self.label_finger.setStyleSheet("color: #e74c3c; font-weight: bold;")
            except queue.Empty:
                break

        # 각 샘플에 (raw_value, t_mono_sample) 부여.
        # - 녹화 중: Gemini dt/4 방식 (패킷 간격을 4등분해 샘플 간격 추정).
        #   버퍼에 (raw, received_idx, arr_mono) 저장. 드롭은 명시적으로 감지하지
        #   않고 회귀가 흡수 — BLE burst/지연과 실제 drop 구분이 어려워 오인식 위험.
        #   CSV 저장은 녹화 종료 시 선형회귀 후 한 번에 처리.
        # - 녹화 안 할 땐 plot용이므로 nominal 10ms 오프셋 사용.
        new_samples = []
        _nominal_offsets = [
            (SAMPLES_PER_PACKET - 1 - i) * (SAMPLE_INTERVAL_MS / 1000.0)
            for i in range(SAMPLES_PER_PACKET)
        ]
        min_sample_dt = 0.002   # 2ms: 극단 burst 보호 하한
        max_sample_dt = 0.030   # 30ms: 극단 drop/gap 상한

        while not self.data_queue.empty():
            try:
                packet: PPGPacket = self.data_queue.get_nowait()
                arr_mono = getattr(packet, "arrival_mono", None)
                if arr_mono is None:
                    arr_mono = _time.monotonic()  # 방어: 이론상 발생 안 함

                if self._recording:
                    # 단순히 받은 sample 순서대로 idx 증가. 명시적 drop 감지는 안 함
                    # (BLE burst 패턴으로 인해 실제 drop인지 단순 지연인지 구분이
                    # 어려워 오인식 가능. 회귀가 drop 구간을 균일 분배로 흡수).
                    # Gemini Step 1: 패킷 간격을 4등분해 샘플 간격 추정.
                    # 극단 burst/drop은 [2ms, 30ms]로 clamp — 최종 회귀에서 smoothing됨
                    if self._record_ppg_prev_arr >= 0:
                        raw_dt = (arr_mono - self._record_ppg_prev_arr) / SAMPLES_PER_PACKET
                        raw_dt = max(min_sample_dt, min(raw_dt, max_sample_dt))
                    else:
                        raw_dt = SAMPLE_INTERVAL_MS / 1000.0

                    for i, sample in enumerate(packet.samples):
                        t_mono_sample = arr_mono - (SAMPLES_PER_PACKET - 1 - i) * raw_dt
                        idx = self._record_ppg_expected_idx + i
                        self._record_ppg_buffer.append(
                            (int(sample.raw_value), idx, t_mono_sample))
                        new_samples.append(
                            (sample.raw_value, t_mono_sample))

                    self._record_ppg_expected_idx += SAMPLES_PER_PACKET
                    self._record_ppg_prev_arr = arr_mono
                else:
                    # 녹화 아닐 땐 plot용 — raw arrival + 10ms offset
                    for i, sample in enumerate(packet.samples):
                        t_mono_sample = arr_mono - _nominal_offsets[i]
                        new_samples.append(
                            (sample.raw_value, t_mono_sample))
            except queue.Empty:
                break

        if new_samples:
            self._last_packet_time = _time.monotonic()
            self._no_packet_handled = False
            self._got_first_packet = True
            new_values = [v for v, _t in new_samples]
            self.ring_buffer.append(new_values)
            self.sample_count += len(new_samples)
            self._rate_sample_count += len(new_samples)
            self.label_samples.setText(f"Samples: {self.sample_count}")

            # 녹화 중엔 버퍼링만 (_record_ppg_buffer에 누적돼 있음).
            # _record_t_mono_base는 첫 샘플 시각으로 초기화해 face.bin과 origin 공유.
            if self._recording and self._record_ppg_buffer:
                if self._record_t_mono_base < 0:
                    # 버퍼 첫 샘플의 arrival_mono를 origin으로
                    self._record_t_mono_base = self._record_ppg_buffer[0][2]

            data = self.ring_buffer.get_ordered()
            n = len(data)
            if n > 0:
                time_axis = np.linspace(-n / SAMPLE_RATE_HZ, 0, n)
                self.plot_curve.setData(time_axis, data)

        # 기록 카운트다운 / 자동 종료
        if self._recording:
            elapsed = _time.monotonic() - self._record_start_time
            remaining = self._record_duration - elapsed
            if remaining <= 0:
                self._stop_recording(auto=True)
            else:
                self.btn_record.setText(
                    f"기록 중 {self._format_duration(remaining)}")
        else:
            self._update_record_availability()

        timeout = PACKET_TIMEOUT_NORMAL if self._got_first_packet else PACKET_TIMEOUT_INITIAL
        if (self._is_measuring_ui
                and not self._no_packet_handled
                and self._last_packet_time > 0
                and _time.monotonic() - self._last_packet_time >= timeout):
            self._no_packet_handled = True
            self._is_measuring_ui = False
            if self._recording:
                self._stop_recording()
            self.ble_worker.request_stop()
            self.btn_stop.setEnabled(False)
            self.btn_start.setEnabled(True)
            self.finger_on = False
            self.label_finger.setText("OFF")
            self.label_finger.setStyleSheet("color: #e74c3c; font-weight: bold;")
            self.label_status.setText("손가락 제거됨 - 측정 중단")
            self.label_status.setStyleSheet("color: #e74c3c; font-size: 12px; padding: 2px;")

    def _update_rate(self):
        rate = self._rate_sample_count
        self._rate_sample_count = 0
        if rate > 0:
            self.label_rate.setText(f"Rate: {rate} Hz")

    def closeEvent(self, event):
        if self._recording:
            self._stop_recording()
        self.camera_panel.stop_camera()
        self.ble_worker.stop()
        event.accept()


# ═══════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════

def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = PPGWithCamWindow()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
