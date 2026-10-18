import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const outputPath = path.resolve("scripts", "tflite-test-frames.bin");
const frameSize = 36;
const maxSeconds = 30;
const targetFps = 30;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  args: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3001", { waitUntil: "networkidle0" });
  const result = await page.evaluate(
    async ({ frameSize, maxSeconds, targetFps }) => {
      const video = document.createElement("video");
      video.src = "/test.mp4";
      video.muted = true;
      video.playsInline = true;
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error("Could not load /test.mp4"));
        video.load();
      });

      const canvas = document.createElement("canvas");
      canvas.width = frameSize;
      canvas.height = frameSize;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const duration = Math.min(maxSeconds, video.duration || maxSeconds);
      const maxFrames = Math.max(1, Math.floor(duration * targetFps));
      const step = 1 / targetFps;
      const frames = new Uint8Array(maxFrames * frameSize * frameSize * 3);
      const times = new Float64Array(maxFrames);

      for (let index = 0; index < maxFrames; index += 1) {
        const currentTime = Math.min(index * step, duration);
        video.currentTime = currentTime;
        await new Promise((resolve) => {
          video.onseeked = resolve;
        });

        const scaleX = video.videoWidth / 1080;
        const scaleY = video.videoHeight / 1920;
        const sourceX = Math.round(190 * scaleX);
        const sourceY = Math.round(250 * scaleY);
        const sourceWidth = Math.round(700 * scaleX);
        const sourceHeight = Math.round(900 * scaleY);
        context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          frameSize,
          frameSize
        );
        const pixels = context.getImageData(0, 0, frameSize, frameSize).data;
        let offset = index * frameSize * frameSize * 3;
        for (let pixel = 0; pixel < pixels.length; pixel += 4) {
          frames[offset] = pixels[pixel];
          frames[offset + 1] = pixels[pixel + 1];
          frames[offset + 2] = pixels[pixel + 2];
          offset += 3;
        }
        times[index] = currentTime;
      }

      return {
        width: frameSize,
        height: frameSize,
        count: maxFrames,
        times: Array.from(times),
        frames: Array.from(frames),
      };
    },
    { frameSize, maxSeconds, targetFps }
  );

  const header = Buffer.alloc(12);
  header.writeUInt32LE(result.count, 0);
  header.writeUInt32LE(result.width, 4);
  header.writeUInt32LE(result.height, 8);
  const times = Buffer.alloc(result.count * 8);
  result.times.forEach((time, index) => times.writeDoubleLE(time, index * 8));
  const frames = Buffer.from(result.frames);
  fs.writeFileSync(outputPath, Buffer.concat([header, times, frames]));
  console.log(
    JSON.stringify({
      outputPath,
      count: result.count,
      width: result.width,
      height: result.height,
      bytes: fs.statSync(outputPath).size,
    })
  );
} finally {
  await browser.close();
}
