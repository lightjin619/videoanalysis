import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { calculatePosSignal } from "../lib/posSignal.ts";
import type { RgbPoint } from "../components/RgbLiveChart.tsx";

const videoPath = resolve(process.argv[2] ?? "test.mp4");
const ffmpegPath =
  process.env.FFMPEG_PATH ??
  "C:\\Users\\Deepmedi\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const ffprobePath = ffmpegPath.replace("ffmpeg.exe", "ffprobe.exe");

const probe = spawnSync(
  ffprobePath,
  [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate,nb_frames,duration",
    "-of",
    "json",
    videoPath,
  ],
  { encoding: "utf8" }
);

if (probe.status !== 0) {
  throw new Error(probe.stderr || "ffprobe failed");
}

const stream = JSON.parse(probe.stdout).streams[0];
const [rateNumerator, rateDenominator] = stream.avg_frame_rate
  .split("/")
  .map(Number);
const frameRate = rateNumerator / rateDenominator;

// Coordinates target stable skin regions in the auto-rotated 1080x1920 video.
const rois = [
  { name: "forehead", x: 380, y: 370, width: 320, height: 180 },
  { name: "left-cheek", x: 245, y: 690, width: 220, height: 270 },
  { name: "right-cheek", x: 615, y: 690, width: 220, height: 270 },
];

function extractRoi(roi: (typeof rois)[number]) {
  const filter = [
    `crop=${roi.width}:${roi.height}:${roi.x}:${roi.y}`,
    "scale=1:1:flags=area",
    "format=rgb24",
  ].join(",");
  const extraction = spawnSync(
    ffmpegPath,
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-an",
      "-vf",
      filter,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: null, maxBuffer: 10 * 1024 * 1024 }
  );

  if (extraction.status !== 0) {
    throw new Error(extraction.stderr?.toString() || `${roi.name} failed`);
  }

  const bytes = extraction.stdout;
  const points: RgbPoint[] = [];
  for (let index = 0; index + 2 < bytes.length; index += 3) {
    const frame = index / 3;
    points.push({
      t: frame / frameRate,
      r: bytes[index],
      g: bytes[index + 1],
      b: bytes[index + 2],
    });
  }
  return points;
}

const roiSignals = rois.map((roi) => ({
  roi,
  points: extractRoi(roi),
}));
const frameCount = Math.min(...roiSignals.map(({ points }) => points.length));
const combined: RgbPoint[] = Array.from({ length: frameCount }, (_, index) => ({
  t: roiSignals[0].points[index].t,
  r:
    roiSignals.reduce((sum, { points }) => sum + points[index].r, 0) /
    roiSignals.length,
  g:
    roiSignals.reduce((sum, { points }) => sum + points[index].g, 0) /
    roiSignals.length,
  b:
    roiSignals.reduce((sum, { points }) => sum + points[index].b, 0) /
    roiSignals.length,
}));

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const robustCombined: RgbPoint[] = Array.from(
  { length: frameCount },
  (_, index) => ({
    t: roiSignals[0].points[index].t,
    r: median(roiSignals.map(({ points }) => points[index].r)),
    g: median(roiSignals.map(({ points }) => points[index].g)),
    b: median(roiSignals.map(({ points }) => points[index].b)),
  })
);

const foreheadLeft: RgbPoint[] = Array.from(
  { length: frameCount },
  (_, index) => ({
    t: roiSignals[0].points[index].t,
    r: (roiSignals[0].points[index].r + roiSignals[1].points[index].r) / 2,
    g: (roiSignals[0].points[index].g + roiSignals[1].points[index].g) / 2,
    b: (roiSignals[0].points[index].b + roiSignals[1].points[index].b) / 2,
  })
);

function analyze(label: string, points: RgbPoint[]) {
  const result = calculatePosSignal(points);
  return {
    label,
    frames: points.length,
    duration: points.length
      ? points[points.length - 1].t - points[0].t
      : 0,
    sampleRate: result?.sampleRate ?? null,
    bpm: result?.heartRate ?? null,
    peakHz: result?.peakFrequency ?? null,
    refinementBand: result?.refinementBand ?? null,
    hrv: result?.hrv ?? null,
  };
}

const results = [
  analyze("combined-full", combined),
  analyze("robust-median-full", robustCombined),
  analyze("forehead-left-full", foreheadLeft),
  ...roiSignals.map(({ roi, points }) => analyze(`${roi.name}-full`, points)),
];

for (let start = 0; start + 20 <= combined.at(-1)!.t; start += 10) {
  const end = start + 20;
  const withinWindow = (point: RgbPoint) =>
    point.t >= start && point.t < end;
  results.push(
    analyze(
      `robust-median-${start}-${end}s`,
      robustCombined.filter(withinWindow)
    ),
    analyze(
      `forehead-${start}-${end}s`,
      roiSignals[0].points.filter(withinWindow)
    ),
    analyze(
      `left-cheek-${start}-${end}s`,
      roiSignals[1].points.filter(withinWindow)
    ),
    analyze(
      `right-cheek-${start}-${end}s`,
      roiSignals[2].points.filter(withinWindow)
    )
  );
}

console.log(
  JSON.stringify(
    {
      videoPath,
      sourceFrameRate: frameRate,
      sourceFrames: Number(stream.nb_frames),
      analyzedFrames: frameCount,
      rois,
      results,
    },
    null,
    2
  )
);
