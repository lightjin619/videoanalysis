# Video Analysis Lab

브라우저에서 얼굴 영상의 RGB 변화를 바탕으로 맥파(PPG/BVP)를 추정하고,
심박수(HR)·심박변이도(HRV)를 프로젝트 단위로 비교하는 Next.js 애플리케이션입니다.

## 실행

사전 요구 사항: Node.js와 npm

```powershell
npm install
& "C:\Program Files\nodejs\npm.cmd" run dev
```

기본 개발 명령은 `scripts/dev-local.ps1`을 통해 OneDrive 밖의 로컬 런타임에서
실행됩니다. OneDrive 환경에서는 `.next` 정리 시 `readlink` 오류가 날 수 있으므로
`npm run dev:direct`는 사용하지 않습니다.

## 주요 흐름

1. 첫 화면에서 브라우저 로컬 계정을 만들거나 로그인합니다.
2. 프로젝트와 영상 분석 항목을 생성합니다.
3. 분석 화면에서 비디오 프레임의 얼굴 영역을 추적하고 정규화된 RGB crop을 수집합니다.
4. POS 기반 신호를 후처리하여 PPG, HR, peak, RR, HRV를 산출합니다.
5. 결과를 브라우저 `localStorage`에 저장하고, 개별(Within)·그룹 간(Between) 비교 화면에서 확인합니다.

## 현재 POS·RR 분석 규칙 (2026-10-18)

- 선택한 분석 범위에서 수집된 **모든 유효 프레임의 ROI RGB 시계열**을 사용합니다. RGB는 기존 48×48 얼굴 상단 ROI의 채널별 10% trimmed mean이며, 화면 전체 픽셀이나 추적 실패 프레임을 포함한다는 뜻은 아닙니다.
- ROI 중심 이동이 얼굴 크기의 0.55배를 넘거나 면적이 1.6배 이상 변하는 **흔들린 프레임도 검출된 얼굴에서 RGB를 수집해 POS 심박 신호 추출에 포함**합니다. 흔들림은 별도 표시 정보로 기록하며, 맥파와 RR 그래프에 주황색 음영으로 표시합니다. 얼굴 미검출·선택 인물 추적 실패·픽셀 읽기 실패는 RGB 공백으로 남습니다.
- 0.5초 이하 RGB 공백만 보간하고 긴 공백은 연속 구간으로 분리합니다. 각 구간 전체를 등간격화한 후 1.6초 POS 창을 한 샘플씩 이동·중첩하여 맥파를 추출합니다. 15초마다 POS를 새로 시작하지 않습니다.
- 전체 연속 맥파에 **0.8–3Hz filtfilt**를 한 번 적용합니다. Butterworth band-pass biquad를 반사 패딩과 정상상태 초기조건으로 정·역방향 적용합니다. 이 결과 자체를 맥파 그래프와 저장에 사용하며, RR 검출에는 별도 복사본을 아래와 같이 재필터링합니다.
- **Video Analysis에서만** 맥파와 RR 그래프를 15초씩 넘겨 봅니다. 마지막 짧은 구간이나 추적 공백도 동일한 15초 축에 표시합니다. 표시 구간 경계에서 신호 처리나 RR 추출을 다시 시작하지 않습니다. HR 추정은 기존처럼 **15초마다** Hann FFT와 포물선 보간으로 수행합니다(48–180BPM).
- 마지막 15초 미만은 직전 HR을 재사용합니다. 전체 연속 구간이 15초 미만이면 임시 FFT 추정치를 사용합니다. 전체 표시 HR은 창 길이에 비례해 평균합니다.
- **각 15초 창의 스펙트럼 심박 주파수 `HR/60 ±0.2Hz`로 filtfilt 재필터링**한 신호에서 타코그램·HRV용 피크를 검출합니다. 필터 안정화용 주변 신호를 포함하고 경계 전후 0.5초씩 cosine crossfade로 연결합니다. 연속 구간 전체에서 한 번 피크를 검출하고 포물선 보간해 인접 피크 간격(ms)을 구하므로 15초 경계를 가로지르는 RR도 유지합니다. 먼저 생리학적 범위(250–2000ms)와 해당 창의 기대 RR(0.5–1.75배)을 검사하고, 이후 `RR / 기대 RR`의 중앙값·MAD로 이상치를 제거합니다. 판정 한계는 `max(0.2, 중앙값×0.2, 3.5×1.4826×MAD, 80ms/기대RR)`입니다. 정상 RR을 평활화하거나 제거된 RR을 만들어 채우지 않습니다.
- `rrRecords`에 원래 RR의 시작·끝·연속 구간 ID·기대 RR·채택 여부·제외 사유를 보존하고, `rrIntervals`에는 채택한 값만 저장합니다. HRV를 계산하기에 표본이 적어도 수집한 RR은 유지합니다.
- RGB 원본 시계열, 0.8–3Hz 필터 결과, 신호의 원본 영상 시작 시각, 움직임 구간, 수집 상태 요약과 파이프라인 버전을 함께 저장합니다. 신호와 움직임 시간은 저장 신호 시작 기준이고, coverage는 원본 영상 시각입니다. 파형과 피크 시각은 반올림 없이 저장합니다.
- **Within-subject에 진입하면 저장된 전체 필터 신호에서 동일한 ±0.2Hz 방식으로 RR 목록을 먼저 계산**하고, 이 목록에 기존 **30초·60초 시간창, 전체 구간, A/B 구간 비교, Cohen’s d** 방법을 적용합니다. 움직임 표시는 신호나 RR을 자동 제외하지 않습니다. 기존 0.8–3Hz 저장 파형도 읽을 때 새 RR 방식으로 메모리에서 재계산해 이력 요약·Within·Between에 적용합니다. 저장 파형이 없는 과거 결과는 보존하며 재계산에는 영상 재분석이 필요합니다. 새 결과에는 `rrPipeline: spectral-15s-filtfilt-pm0.2-v1`을 저장합니다.
- 분석 요약·타코그램·Within/Between 통계는 정제 RR을 사용합니다. RMSSD/pNN50은 원래 인접했던 RR 쌍만 사용하고, LF/HF는 정제 RR에 끊김이 있으면 반환하지 않습니다.

**해석 범위:** 영상 피크 간격은 엄밀히는 맥파 간격(PPI/PRV)입니다. 아래 검증은 처리·데이터 연결의 검증이며, ECG/접촉 PPG 기준 신호 없이 HR/HRV 정확도나 개선을 입증하지 않습니다. HRV에는 평균 HR보다 정밀한 박동 시각 검증이 필요합니다([Gudi et al., 2020](https://arxiv.org/abs/2012.15846)). POS 근거: [Wang et al., 2017](https://doi.org/10.1109/TBME.2016.2609282).

과거 ±0.1/±0.2Hz 처리의 수치와 보고서는 아래 작업 기록과 artifacts에 남겨둡니다. 현재 구현은 타코그램·HRV에 ±0.2Hz 재필터를 사용하며, 맥파 그래프와 저장 파형은 0.8–3Hz 결과를 유지합니다.

### 재현 검증

```powershell
node scripts/validate-pos.cjs
node scripts/validate-rr-statistics.cjs
node scripts/validate-motion.cjs
node scripts/validate-saved-pos.cjs
$env:QUALITY_VIDEO='test3.mov'
$env:QUALITY_FPS='30'
$env:QUALITY_BOX_ONLY='1'
$env:QUALITY_DELEGATE='CPU'
$env:QUALITY_OUTPUT='artifacts/test3-pos-validation'
node scripts/compare-face-quality.mjs
node scripts/validate-test3-pos.cjs
npm.cmd run build
```

`compare-face-quality.mjs`는 브라우저에서 전체 영상을 30fps 시각 간격으로 seek하여 기존 앱과 같은 ROI·추적 규칙으로 RGB를 기록합니다. 실제 재생의 프레임 처리율이나 원본의 모든 디코딩 프레임을 보장하는 테스트는 아닙니다. `validate-test3-pos.cjs`는 기록을 현재 앱 코드로 재분석하고 RR 정제·통계 일치 여부를 검사합니다. 결과: [test3 검증 보고서](artifacts/test3-pos-validation/REPORT.md).

## 코드 구성

| 경로 | 역할 |
| --- | --- |
| `app/` | Next.js App Router 화면. 로그인, 프로젝트, 분석, within/between 비교 페이지를 포함합니다. |
| `components/` | 헤더, 보호 라우트, 분석 범위 선택, PPG/타코그램, 추세·구간 비교 차트 UI입니다. |
| `hooks/` | 로컬 인증과 프로젝트·분석 항목·결과의 `localStorage` 상태를 관리합니다. |
| `lib/posSignal.ts` | RGB 기반 POS 신호 추정, band-pass/FFT, 심박·peak·HRV 계산입니다. |
| `lib/tflitePpg.ts` | 이전 TFLite PPG 호환성 진단용 코드입니다. 현재 분석 화면에서는 사용하지 않습니다. |
| `lib/withinSubject.ts`, `lib/betweenSubject.ts` | 구간 지표, 추세, LF/HF, 효과크기·Welch t 계산입니다. |
| `public/models/` | PPG·얼굴 검출 TFLite 모델 및 웹 런타임 호환성 문서입니다. |
| `scripts/` | 프레임 export, Python/TFLite 비교, 얼굴 영역 점검, 심박 검증 보조 도구입니다. |

## 데이터와 보안 범위

- 계정 정보는 브라우저 `localStorage`에 저장되며, 비밀번호는 SHA-256 해시와 salt로 보관합니다.
- 로그인 상태는 `sessionStorage`에 보관됩니다.
- 프로젝트, 분석 메타데이터, 결과도 서버가 아닌 현재 브라우저의 `localStorage`에 저장됩니다.
- 프로젝트·영상 분석 항목·분석 결과·그룹 비교 설정은 가입 시 생성되는 계정 ID별로 분리됩니다. 계정을 초기화하고 같은 아이디로 다시 가입해도 새 작업 공간에서 시작합니다. 일반 로그아웃·재로그인은 해당 계정의 작업을 유지합니다.
- 기존 공용 저장 데이터는 수정 적용 시 등록되어 있는 기존 계정으로 이관합니다. 계정 초기화 후 이전 데이터는 보관되지만 새 계정에 연결하지 않으며, 계정이 없는 상태에서 남은 공용 데이터도 새 가입자에게 자동 배정하지 않습니다.
- 따라서 다른 브라우저/기기와 데이터가 동기화되지 않으며, 브라우저 저장소를 지우면 데이터가 사라질 수 있습니다.

## 모델 관련 참고

현재 분석 화면은 TFLite PPG 모델을 사용하지 않고 POS만 사용합니다. 얼굴 검출에는
TFLite 모델이 계속 필요합니다. 이전 PPG 모델의 웹 런타임 호환성 진단 자료는
[public/models/README-web-export.md](public/models/README-web-export.md)에 보관합니다.

## 작업 기록 운영 원칙

이 저장소에서 수행하는 모든 코드 작업은 완료 시 이 README의 **작업 기록**에
목적, 변경 파일, 검증 결과, 남은 제약 사항을 한국어로 요약합니다. 코드 변경이
없는 조사·검토 작업도 기록합니다.

## 작업 기록

### 2026-10-18 — 타코그램·HRV에 15초 스펙트럼 HR ±0.2Hz 적용

- 각 15초 창의 스펙트럼 심박 주파수를 중심으로 ±0.2Hz filtfilt 재필터링한 신호에서 피크·RR·HRV를 계산합니다. 주변 신호를 포함해 필터를 안정화하고 경계 전후 0.5초를 cosine crossfade로 연결한 뒤 연속 구간 전체에서 피크를 검출합니다. 맥파 그래프와 저장 파형은 0.8–3Hz 결과를 유지합니다.
- 새 결과에 RR 처리 버전을 저장합니다. 기존 0.8–3Hz 저장 파형은 읽을 때 새 RR 방식으로 재계산하여 이력 요약·Within·Between에 반영하며 브라우저 원본 저장 데이터는 유지합니다.
- 검증: POS·RR 통계·저장 파형·움직임 회귀 검사, TypeScript 검사, production build 통과. 별도 headless Chrome에서 기존 저장 파형의 Within 재계산·30/60초 창·A/B 비교를 확인했습니다. `sub1.mp4` 앞 18초 실제 분석에서 RGB 370개·맥파 538개·17.894초 결과 저장, 각 창의 ±0.2Hz 대역과 RR 버전, 15초 페이지 이동을 확인했고 브라우저 오류는 없었습니다. 빌드에는 기존 Webpack 캐시 snapshot 경고가 있었습니다.

### 2026-10-18 — test3.mov 0~120초 그래프 공백 조사

- 30~45초에서 맥파·RR 그래프가 함께 비는 현상을 조사했습니다. 분석 로직은 변경하지 않았으며 별도 headless Chrome 계정으로 실제 0~120초 재생을 검사했습니다.
- `scripts/diagnose-test3-gaps.mjs`를 추가했습니다. 실제 앱의 수집 결과·프레임 콜백 시간·RGB/맥파 공백·RR 제외 기록과 기존 RGB의 현재 POS 재계산 결과를 `artifacts/test3-live-120s/`에 보존합니다. 실행은 `node scripts/diagnose-test3-gaps.mjs`이며 앱 기본 주소는 `http://localhost:3157`, 변경은 `POS_APP_URL`로 지정합니다.
- 검증: 실제 재생 RGB 2,843개, 맥파 3,598개, 0.5초 초과 공백 없음, 브라우저 오류 없음. 30~45초는 RGB 363개·맥파 450개이며, 실제 차트 시간축 30.07~45.07초에는 RR 23개가 있었습니다. production canvas 함수로 30~45초 및 45~60초 그래프를 렌더링하고 두 선이 그려지는지 픽셀과 이미지로 확인했습니다. 스크립트 구문 검사 통과.
- 제약: 사용자가 공백을 본 실행의 저장 데이터에는 접근하지 않았으므로 원인은 확정하지 못했습니다. 얼굴 미검출·매칭 실패 또는 브라우저 프레임 전달 중단으로 RGB가 끊기면 맥파와 RR에 함께 공백이 생길 수 있습니다. 해당 실행의 30~45초 `Collected Data Coverage` 행과 원본 RGB 시간 간격을 비교해야 구분할 수 있습니다. [조사 보고서](artifacts/test3-live-120s/REPORT.md).

### 2026-10-18 — POS 0.8–3Hz 신호 저장과 전체 RR 기반 Within 분석

- RGB → POS → 0.8–3Hz filtfilt 결과 자체를 표시·저장하도록 변경했습니다. HR 주변 ±0.2Hz 재필터를 제거하고, 필터 초기조건을 정상상태로 맞췄습니다. RGB·필터 파형·움직임 구간·영상 시간 원점·처리 버전을 함께 보존합니다.
- 15초 표시는 Video Analysis의 맥파·RR 그래프에만 적용합니다. 표시용 보간·평탄 꼬리 삭제를 제거하고 15초 시간축을 고정해 추적 공백도 그대로 보입니다. Within은 전체 저장 신호에서 RR 목록을 먼저 구하고 기존 30/60초 창·전체 구간·A/B 비교 방법을 유지합니다.
- 변경 파일: `lib/posSignal.ts`, `lib/withinSubject.ts`, Video Analysis·Within 페이지, `components/PulseWaveChart.tsx`, `types/analysis.ts`, `hooks/useAnalysisResults.ts`, POS 검증 스크립트와 `scripts/check-pos-workflow.cjs`, README.
- 검증: POS·RR 통계·움직임 검증, 저장 신호 검증, TypeScript 검사와 production build 통과. 저장 신호 검증은 필터 전달함수의 진폭·위상, 추가 필터·정규화 없음, 15초 경계를 가로지르는 RR, 추적 공백 단절, 움직임 구간 RR 유지, 저장 후 기존 30/60초 통계 연결을 검사합니다. 별도 headless Chrome에서 Within 전체 RR 재계산·기존 30/60초 창·A/B 비교와 15초 파형 없음도 확인했습니다. `sub1.mp4` 앞 18초를 실제 분석해 RGB 305개·POS 269개·17.861초 신호 저장과 Video Analysis의 15초 이전/다음 이동을 확인했고 브라우저 오류는 없었습니다. 브라우저 검사는 실행 중인 앱 URL을 `POS_APP_URL`로 지정한 뒤 `node scripts/check-pos-workflow.cjs`로 재현합니다(기본 URL `http://localhost:3157`).
- 제약: 과거 협대역 결과는 새 0.8–3Hz 데이터와 구분하므로 Within에 사용하려면 영상을 재분석해야 합니다. 전체 실제 영상 재추출은 이번 작업에서 수행하지 않았으며 기존 보고서는 과거 설정 결과입니다. 브라우저 저장 한도에 따른 저장 실패는 화면에 알립니다. 빌드에는 기존 Webpack 캐시 snapshot 경고가 있었습니다.

### 2026-10-18 — 움직임 구간 표시 유지·RR 재필터 ±0.2Hz

- 움직임이 있는 프레임을 RGB·POS 분석에 포함하는 현재 동작을 확인했습니다. 움직임을 수집 성공 여부와 별도로 기록하고 맥파·RR 그래프에 주황색 음영, 15초별 표에 프레임 수로 표시합니다. 수집 현황에는 전체 움직임 프레임 수와 시간도 추가했습니다. 얼굴 미검출·선택 인물 매칭 실패·픽셀 읽기 실패는 계속 데이터 공백으로 처리합니다. RR 범위·MAD 이상치 정제는 유지합니다.
- RR 피크 추출용 재필터를 `HR/60 ±0.1Hz`에서 **±0.2Hz**로 수정했습니다. 1차 0.8–3Hz 필터와 15초 HR 추정은 유지합니다. 차트 설명·회귀 검사·재현 스크립트도 갱신했습니다. 오프라인 추출기의 box 모드도 움직임 RGB를 유지하고 별도 motion 표시를 기록하도록 맞췄습니다.
- 변경 파일: `lib/posSignal.ts`, `components/PulseWaveChart.tsx`, `components/AnalysisCoverage.tsx`, `scripts/validate-motion.cjs`, `scripts/validate-rr-statistics.cjs`, `scripts/validate-test3-pos.cjs`, `scripts/compare-face-quality.mjs`, 이 README 및 test3 결과물.
- 검증: POS·RR 통계·production frame callback 움직임 회귀 검사 통과. 오프라인 box 모드에서도 움직임 프레임의 현재 검출 ROI를 유지하고 미검출 시 해제하는지 확인했습니다. 기존 test3 전체 RGB 18,190개를 새 설정으로 재분석하여 평균 HR 71.81BPM, RR 714개 중 679개 채택·35개 제외(범위 3, MAD 32), RMSSD 80.83ms를 산출했습니다. 저장 후 요약·Within·Between 통계 일치 검사도 통과했습니다. 상세 결과는 [test3 보고서](artifacts/test3-pos-validation/REPORT.md)에 갱신했습니다. `npm.cmd run build` 통과(타입 검사·정적 페이지 생성 포함, 기존 Webpack 캐시 snapshot 경고).
- 제약: test3는 기존 전체 RGB를 재사용한 검증이며 움직임 구간 RGB 유지·음영 표시는 별도 합성 검출/실제 production callback으로 검증했습니다. 새 흔들림 정보를 보려면 영상을 다시 분석해야 합니다. ±0.2Hz에서도 합성 신호의 실제 RMSSD 35.03ms가 13.63ms로 억제되어 기준 ECG/PPG 정확도 검증은 여전히 필요합니다.

### 2026-10-18 — 재가입 시 이전 계정 작업 노출 수정

- 원인: 계정 초기화는 로그인 정보만 제거하고, 프로젝트·분석 항목·결과·그룹 설정은 브라우저 공용 키를 계속 사용했습니다. 새 가입자도 이전 작업을 읽는 구조였습니다.
- 가입마다 고유 계정 ID를 만들고 모든 작업 데이터를 해당 ID의 저장 공간으로 분리했습니다. 로그인 세션도 사용자명 대신 계정 ID를 확인하며, 계정 변경 시 기존 화면과 실행 중 분석 상태를 초기화합니다. 이전 계정에서 시작된 저장 요청은 계정 변경 후 거부합니다.
- 기존 계정 데이터는 복사 완료 후 저장 키를 전환하며, 이관 중 저장 실패 시 원본을 보존합니다. 계정 초기화 안내에 새 계정은 빈 작업 공간에서 시작하고 이전 작업에 접근할 수 없음을 반영했습니다.
- 변경 파일: `lib/accountStorage.ts`, `hooks/useAccountStorage.ts`, 인증·프로젝트·분석 항목·결과 훅, `components/ProtectedRoute.tsx`, 로그인 화면, 그룹 비교 화면, 계정 검증 스크립트 2개, `README.md`.
- 검증: `node scripts/validate-account-storage.cjs`로 이관 실패·재시도, 세션 전환, 로그아웃, 지연 저장 차단, 같은 사용자명 분리, 소유자 없는 데이터 비연결을 확인했습니다. `node scripts/check-account-isolation.mjs`로 실제 Chrome에서 기존 프로젝트·결과·그룹 설정 이관, 재로그인·새로고침 유지, 같은 아이디 재가입 시 빈 작업 공간, 기존 탭 로그아웃, 이전 프로젝트 URL 접근 차단, 새 프로젝트·분석 생성과 재로그인 후 유지를 확인했습니다. TypeScript 검사와 프로덕션 빌드 통과.
- 제약: 기존처럼 브라우저당 현재 등록 계정 하나를 사용하는 로컬 인증입니다. 초기화된 계정의 작업을 새 계정에서 복구하는 기능은 제공하지 않으며, 과거 공용 데이터에는 원래 소유자 정보가 없어 현재 등록된 기존 계정 기준으로만 이관합니다.

### 2026-10-18 — 흔들림 구간 RGB 유지 및 그래프 표시

- 흔들림 때문에 RGB 수집을 건너뛰던 조건을 변경했습니다. 큰 움직임이 감지되면 이전 고정 위치 대신 현재 검출된 얼굴 위치에서 RGB를 수집하고, 기존 POS·심박 추출 과정에 포함합니다.
- 프레임별 흔들림 여부를 수집 성공 여부와 분리했습니다. 15초별 수집 표에는 흔들림 프레임 수를 표시하고, 맥파·RR 그래프에는 해당 시간 범위를 주황색으로 표시합니다. 흔들림 구간은 결과와 함께 저장하며, 그래프용 시간은 영상 시각, 저장된 파형용 시간은 파형 시작 기준으로 맞춥니다.
- 변경 파일: 분석 페이지, `components/PulseWaveChart.tsx`, `components/AnalysisCoverage.tsx`, `lib/analysisCoverage.ts`, `types/analysis.ts`, `scripts/validate-motion.cjs`, `README.md`.
- 검증: POS·RR 통계 검사, TypeScript 검사, `npm.cmd run build` 통과. 새 회귀 검사에서 큰 움직임·재고정 중 120개 프레임의 RGB가 모두 유지되고 POS에 전달되는지, 미검출 시 이전 ROI를 수집하지 않는지, 흔들림 시간 경계와 두 그래프의 음영 좌표가 맞는지 확인했습니다.
- 제약: 기존 저장 결과에는 새 흔들림 정보가 없어 영상을 다시 분석해야 표시됩니다. 기존 얼굴 매칭 기준과 RR 이상치 정제 규칙은 유지하며, 흔들림 표시만으로 신호 품질이나 정확도를 판정하지 않습니다.

### 2026-10-18 — POS 0.8–3Hz·15초 HR·±0.1Hz·정제 RR 통계 연결

- README와 기존 코드 검토 후 요청한 흐름을 적용했습니다. 기존 고정 Q high/low-pass 조합이 좁은 대역을 제대로 구현하지 못하는 문제를 대역폭 기반 Butterworth band-pass로 수정했습니다.
- 피크 시각 보간, 창 길이 가중 HR, 원시 RR 판정 기록 저장을 추가했습니다. 기존 비교 통계가 정제된 RR을 무시하고 피크에서 다시 RR을 만드는 문제를 수정했습니다. 타코그램도 같은 채택 RR을 표시합니다.
- 변경 파일: `lib/posSignal.ts`, `lib/withinSubject.ts`, `lib/betweenSubject.ts`, `types/analysis.ts`, 분석 페이지, `components/PulseWaveChart.tsx`, `scripts/load-analysis.cjs`, `scripts/validate-rr-statistics.cjs`, `scripts/validate-test3-pos.cjs`, 이 README와 test3 검증 보고서.
- 검증: 기존 POS 회귀 검사와 RR·통계 회귀 검사 통과. `npm.cmd run build` 성공(타입 검사·정적 페이지 생성 포함; 기존 Webpack 캐시 snapshot 경고만 발생). `test3.mov` 전체 606.321초를 30fps 시각 간격으로 검사해 RGB 18,190/18,190개를 수집했습니다. 평균 HR 71.81BPM, 원시 RR 719개 중 700개 채택·19개 MAD 제외, Mean RR 834.36ms·SDNN 117.62ms·RMSSD 46.50ms·pNN50 15.54%를 산출했습니다. 저장 후 요약·Within·Between HRV 일치 검사를 통과했습니다. LF/HF는 제외 RR로 끊김이 있어 반환하지 않았습니다. 상세 수치·창별 HR·원본 RGB·RR 판정·재현 명령은 [test3 보고서](artifacts/test3-pos-validation/REPORT.md)에 보관합니다.
- 합성 기준 검증: 정확한 피크의 RMSSD 35.03ms가 ±0.1Hz 처리 후 4.95ms로 줄어드는 변동 억제를 재현했습니다. 요청 파이프라인은 구현했으나, 이 결과에 따라 해당 협대역 설정을 HRV 연구의 기본 측정법으로 권장하지 않습니다.
- 제약: ±0.1Hz의 HRV 변동 억제 가능성, 짧은 마지막 창의 HR 재사용, 기준 ECG/PPG 미제공. 기존 미커밋 작업은 보존했습니다.

### 2026-10-01 — POS 단독 분석 및 HRV RR 정제

- 분석 화면에서 TFLite PPG 추론과 fallback 분기를 제거하고, 얼굴 상단 중앙 ROI의 RGB를 채널별 10% trimmed mean으로 수집해 POS 입력으로 사용하도록 변경했습니다. GPU 얼굴 검출 실패 시 CPU 재시도 동작은 유지했습니다.
- 모든 연속 구간에서 POS를 먼저 추출하고 **0.8~4 Hz**로 필터링합니다. **15초마다** Hann-window FFT로 HR을 구한 뒤 각 구간의 HR 주파수 **±0.2 Hz**로 zero-phase 재필터링해 peak 및 RR(ms)을 추출합니다. 구간 경계는 주변 신호와 겹침 블렌딩으로 연결하며 추적 공백을 가로지르는 RR은 제외합니다. 마지막 15초 미만 구간은 직전 HR을 재사용하고, 전체가 15초 미만이면 짧은 구간 스펙트럼을 임시 추정치로 사용합니다. 구간별 HR과 RR도 분석 결과에 저장합니다.
- RR interval은 생리학적 범위와 FFT 기대 범위를 먼저 확인한 뒤, 중앙값·MAD 기반의 적응형 기준으로 큰 이상치를 제외합니다. 제외된 interval 양쪽을 이어 RMSSD/pNN50 차이를 만들지 않도록 처리했습니다.
- HR은 15초 단위로 추정합니다. 짧은 구간도 1.6초 이상의 유효 신호가 있으면 파형을 계산하며, HRV는 유효한 연속 RR 개수에 따라 산출합니다.
- 얼굴 추적 ROI는 중심·크기를 EMA(α=0.25)로 평활화합니다. 이전 안정 ROI와 비교해 중심이 얼굴 너비의 0.55배 이상 이동하거나 면적이 1.6배 이상 변하면 해당 프레임을 POS 입력에서 제외하며, 변화가 5회 연속 지속될 때만 새 위치로 재고정합니다.
- ROI 제외로 생긴 0.5초 이하의 짧은 RGB 공백은 안정 프레임 양끝값으로만 보간하고, 더 긴 추적 손실은 별도 구간으로 처리합니다.
- 연속 미검출 때는 화면상 ROI를 숨기더라도 마지막 안정 ROI를 추적 기준으로 유지하고, 넓힌 거리 기준으로 동일 얼굴을 재획득합니다. 이 과정에서 불안정 프레임은 POS 입력에 넣지 않습니다.
- 변경 파일: `app/projects/[projectId]/analyses/[analysisId]/page.tsx`, `lib/posSignal.ts`, `components/PulseWaveChart.tsx`, `README.md`.
- 검증: `npm.cmd run build` 성공(타입 검사 및 정적 페이지 생성 완료). Webpack 의존성 캐시 snapshot 경고는 있었으나 빌드는 정상 완료되었습니다.
- 제약: POS 및 영상 기반 HRV는 움직임·조명·얼굴 가림에 영향을 받으며 의료 진단 용도로 사용할 수 없습니다. TFLite PPG 진단 코드와 관련 모델 파일은 호환성 조사 용도로 보존되어 있습니다.

### 2026-09-17 — TFLite PPG 로딩·추론 실패 진단

- **결론:** 기본 PPG 모델 `model_core_v62_fp16.tflite`는 Python TFLite에서는 열리지만, 브라우저의 `@tensorflow/tfjs-tflite@0.0.1-alpha.10`에서 안정적으로 추론되지 않습니다. 이는 단순 파일 누락보다 런타임 호환성 문제입니다.
- Python TFLite 메타데이터 검증 결과 모델 signature는 `frames` (`uint8`, `[1, 451, 36, 36, 3]`)와 `timestamps` (`float32`, `[1, 451]`) 두 입력, `peak_logits`·`ppg_100`·`ppg_30` 세 출력을 사용합니다.
- 현 웹 런타임은 `execute()`를 지원하지 않아 `predict()`로 돌아가며, 기존 fixture 검증에서 Python 결과와 달리 비정상적으로 큰 출력값이 확인돼 있습니다. 상세 결과는 `public/models/README-web-export.md`에 있습니다.
- `lib/tflitePpg.ts`의 대체 후보인 `/models/model_core_web.tflite`는 현재 저장소에 없습니다. 또한 대체 로직은 **모델 로드 실패** 때만 다음 후보를 시도하므로, v62처럼 로드는 성공하고 추론 결과가 깨지는 경우에는 대체 모델로 넘어가지 않습니다.
- 로딩 promise가 한 번 거절되면 같은 브라우저 세션에서 재시도하지 않는 구조이고, Python 모델의 `uint8` 프레임 입력과 웹 텐서 dtype 변환도 웹 export 시 명시적으로 검증해야 합니다.
- 앱 화면은 TFLite 예외 시 POS 신호 추정으로 fallback하도록 구현되어 있습니다. 따라서 현재 신뢰 가능한 임시 동작은 POS fallback이며, TFLite 결과를 임상/분석 결과로 사용하면 안 됩니다.
- 별도로 `/tflite-test` 진단 페이지는 `/test.mp4`를 요청하지만 현재 `test.mp4`는 프로젝트 루트에 있고 Next.js 정적 공개 경로인 `public/` 아래에 없습니다. 이 상태에서는 테스트 영상 자체를 불러오지 못하므로, 모델 검증 전에 `public/test.mp4`로 옮기거나 테스트 페이지의 입력 방식을 바꿔야 합니다.
- 검증: `npm run build` 성공. Python TFLite로 v62의 signature·입출력 형식을 확인했습니다. 자동 브라우저 검증은 테스트 페이지 이동이 30초 제한에서 timeout되어 동일 fixture의 웹 출력을 이번 세션에서 새로 수집하지 못했습니다. 개발 서버는 OneDrive의 `.next` 정리 과정에서 `readlink` 오류가 발생했습니다.
- **권장 조치 순서:** (1) 단일 `float32` 출력 텐서를 반환하는 웹 전용 `model_core_web.tflite`를 export·추가, (2) Python과 브라우저의 동일 입력 fixture 비교를 CI/스크립트로 고정, (3) 추론 출력의 유한값·범위·길이 검증 실패 시 웹 모델 또는 POS로 명시적 fallback, (4) 실패한 `modelPromise`를 초기화해 재시도 가능하게 변경.

### 2026-09-17 — 초기 코드 구조 파악 및 문서화

- 코드 변경 없이 애플리케이션 구조, 데이터 흐름, 모델 문서, 현재 작업 트리를 점검했습니다.
- 이 프로젝트는 Next.js 14 / React 18 기반의 클라이언트 중심 영상 생체신호 분석 앱이며, 영속 데이터는 브라우저 저장소를 사용합니다.
- `lib/posSignal.ts`의 POS 경로와 `lib/tflitePpg.ts`의 TFLite 경로가 HR·HRV 산출의 핵심입니다.
- 기존 수정 사항은 보존했습니다. 현재 분석 화면·TFLite 런타임·검증 스크립트·모델 문서에 미커밋 변경이 있으며, 테스트 영상 파일도 추적되지 않은 상태입니다.
- 검증: `npm run build`가 TypeScript 검사와 정적 페이지 생성을 포함해 성공했습니다. Webpack 의존성 캐시 스냅샷 경고는 있었으나 빌드는 완료되었습니다.
