import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 3137;
const sampleFps = Number(process.env.SAMPLE_FPS || 30);
const confidence = Number(process.env.FACE_CONFIDENCE || 0.65);
const maxSeconds = process.env.MAX_SECONDS ? Number(process.env.MAX_SECONDS) : null;
const verbose = process.env.VERBOSE === "1";
const videoSrc = process.env.VIDEO_SRC || "/test.mp4";

const mimeByExt = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".tflite", "application/octet-stream"],
  [".mp4", "video/mp4"],
]);

function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidates = [
    path.join(rootDir, "public", decoded),
    path.join(rootDir, decoded),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(rootDir)) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

const html = `<!doctype html>
<meta charset="utf-8" />
<video id="video" src="${videoSrc}" muted playsinline preload="auto"></video>
<script type="module">
  import { FaceDetector, FilesetResolver } from "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";

  const video = document.getElementById("video");

  function waitFor(target, eventName) {
    if (eventName === "loadedmetadata" && target.readyState >= 1) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for " + eventName)), 15000);
      target.addEventListener(eventName, () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async function seekTo(seconds) {
    if (Math.abs(video.currentTime - seconds) < 0.0005) return;
    const done = waitFor(video, "seeked");
    video.currentTime = seconds;
    await done;
  }

  window.runFaceBboxScan = async ({ sampleFps, confidence, maxSeconds }) => {
    if (${JSON.stringify(verbose)}) console.log("scan: waiting metadata");
    await waitFor(video, "loadedmetadata");
    if (${JSON.stringify(verbose)}) console.log("scan: metadata", video.videoWidth, video.videoHeight, video.duration);
    if (${JSON.stringify(verbose)}) console.log("scan: resolving vision wasm");
    const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    if (${JSON.stringify(verbose)}) console.log("scan: creating detector");
    let delegate = "GPU";
    let detector;
    try {
      detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "/models/blaze_face_short_range.tflite",
          delegate,
        },
        runningMode: "VIDEO",
        minDetectionConfidence: confidence,
        minSuppressionThreshold: 0.3,
      });
    } catch (error) {
      if (${JSON.stringify(verbose)}) console.log("scan: gpu failed, retrying cpu", String(error));
      delegate = "CPU";
      detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "/models/blaze_face_short_range.tflite",
          delegate,
        },
        runningMode: "VIDEO",
        minDetectionConfidence: confidence,
        minSuppressionThreshold: 0.3,
      });
    }
    if (${JSON.stringify(verbose)}) console.log("scan: detector ready", delegate);

    const duration = Math.min(video.duration, maxSeconds || video.duration);
    const step = 1 / sampleFps;
    const count = Math.floor(duration * sampleFps) + 1;
    const missing = [];
    const detected = [];
    let minScore = Infinity;
    let maxScore = -Infinity;
    let timestampMs = 0;

    for (let index = 0; index < count; index += 1) {
      if (${JSON.stringify(verbose)} && index % Math.max(1, Math.floor(sampleFps * 5)) === 0) {
        console.log("scan: frame", index, "of", count);
      }
      const t = Math.min(index * step, Math.max(0, duration - 0.001));
      await seekTo(t);
      const result = detector.detectForVideo(video, timestampMs);
      timestampMs += step * 1000;
      const boxes = result.detections.flatMap((detection) => {
        const box = detection.boundingBox;
        if (!box) return [];
        const left = Math.max(0, box.originX);
        const top = Math.max(0, box.originY);
        const right = Math.min(video.videoWidth, box.originX + box.width);
        const bottom = Math.min(video.videoHeight, box.originY + box.height);
        if (right <= left || bottom <= top) return [];
        return [{
          score: detection.categories?.[0]?.score ?? 0,
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        }];
      });
      if (boxes.length === 0) {
        missing.push({ index, t });
      } else {
        const best = boxes.reduce((a, b) => (b.score > a.score ? b : a), boxes[0]);
        minScore = Math.min(minScore, best.score);
        maxScore = Math.max(maxScore, best.score);
        detected.push({ index, t, count: boxes.length, best });
      }
    }

    detector.close();
    return {
      delegate,
      duration,
      sampleFps,
      confidence,
      totalFrames: count,
      detectedFrames: detected.length,
      missingFrames: missing.length,
      minScore: Number.isFinite(minScore) ? minScore : null,
      maxScore: Number.isFinite(maxScore) ? maxScore : null,
      missing,
      detected,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    };
  };
</script>`;

function summarizeMissing(missing, step) {
  const ranges = [];
  for (const item of missing) {
    const last = ranges[ranges.length - 1];
    if (last && item.index === last.endIndex + 1) {
      last.endIndex = item.index;
      last.end = item.t;
      last.count += 1;
    } else {
      ranges.push({
        startIndex: item.index,
        endIndex: item.index,
        start: item.t,
        end: item.t,
        count: 1,
      });
    }
  }
  return ranges.map((range) => ({
    ...range,
    approxDuration: range.count * step,
  }));
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/scan") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  const filePath = resolveRequestPath(req.url || "");
  if (!filePath) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeByExt.get(ext) || "application/octet-stream";
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start <= end && start >= 0 && end < stat.size) {
        res.writeHead(206, {
          "content-type": contentType,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(stat.size),
    "accept-ranges": "bytes",
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
if (verbose) console.error("[node] server ready");

let browser;
try {
  if (verbose) console.error("[node] launching browser");
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    timeout: 0,
    protocolTimeout: 240000,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
  if (verbose) console.error("[node] browser launched");
  const page = await browser.newPage();
  if (verbose) console.error("[node] page opened");
  if (verbose) {
    page.on("console", (msg) => console.error("[browser]", msg.text()));
    page.on("pageerror", (error) => console.error("[pageerror]", error.stack || error.message));
  }
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);
  if (verbose) console.error("[node] navigating");
  await page.goto(`http://127.0.0.1:${port}/scan`, {
    waitUntil: "domcontentloaded",
    timeout: 0,
  });
  if (verbose) console.error("[node] running scan");
  const result = await page.evaluate(
    (args) => window.runFaceBboxScan(args),
    { sampleFps, confidence, maxSeconds }
  );
  const missingRanges = summarizeMissing(result.missing, 1 / sampleFps);
  console.log(JSON.stringify({
    ...result,
    missing: undefined,
    detected: undefined,
    missingRanges,
    firstDetections: result.detected.slice(0, 3),
    lastDetections: result.detected.slice(-3),
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
