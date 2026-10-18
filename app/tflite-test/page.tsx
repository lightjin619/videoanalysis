"use client";

import { useEffect, useRef, useState } from "react";
import {
  extractTflitePpg,
  getTflitePpgModelInfo,
  inspectTflitePpgOutputs,
  type TflitePpgFrame,
} from "@/lib/tflitePpg";

const FRAME_SIZE = 36;
const MAX_SECONDS = 30;
const TARGET_FPS = 30;

export default function TfliteTestPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("Preparing test.mp4...");
  const [result, setResult] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      canvas.width = FRAME_SIZE;
      canvas.height = FRAME_SIZE;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Could not load /test.mp4"));
        video.src = "/test.mp4";
        video.muted = true;
        video.playsInline = true;
        video.load();
      });

      const frames: TflitePpgFrame[] = [];
      const duration = Math.min(MAX_SECONDS, video.duration || MAX_SECONDS);
      const maxFrames = Math.max(1, Math.floor(duration * TARGET_FPS));
      const step = 1 / TARGET_FPS;

      for (let index = 0; index < maxFrames && !cancelled; index += 1) {
        const currentTime = Math.min(index * step, duration);
        video.currentTime = currentTime;
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
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
          FRAME_SIZE,
          FRAME_SIZE
        );
        const pixels = context.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE).data;
        const data = new Uint8Array(FRAME_SIZE * FRAME_SIZE * 3);
        for (
          let pixelIndex = 0, targetIndex = 0;
          pixelIndex < pixels.length;
          pixelIndex += 4, targetIndex += 3
        ) {
          data[targetIndex] = pixels[pixelIndex];
          data[targetIndex + 1] = pixels[pixelIndex + 1];
          data[targetIndex + 2] = pixels[pixelIndex + 2];
        }
        frames.push({
          t: currentTime,
          width: FRAME_SIZE,
          height: FRAME_SIZE,
          data,
        });

        if (index % 30 === 0) {
          setStatus(`Collected ${index + 1}/${maxFrames} frames...`);
        }
      }

      setStatus("Loading TFLite PPG model...");
      const modelInfo = await getTflitePpgModelInfo();
      const outputInspection = await inspectTflitePpgOutputs(frames);
      setStatus("Running TFLite PPG model...");
      const analysis = await extractTflitePpg(frames);
      if (!analysis) {
        setResult({ ok: false, frames: frames.length, reason: "No result" });
        setStatus("TFLite PPG returned no result.");
        return;
      }

      setResult({
        ok: true,
        modelInfo,
        outputInspection,
        frames: frames.length,
        sampleRate: analysis.sampleRate,
        bpm: analysis.heartRate,
        peakFrequency: analysis.peakFrequency,
        peakCount: analysis.peaks.length,
        hrv: analysis.hrv,
        firstPeaks: analysis.peaks.slice(0, 10),
      });
      setStatus("Done.");
    };

    run().catch((error) => {
      getTflitePpgModelInfo()
        .catch(() => null)
        .then((modelInfo) =>
          setResult({
        ok: false,
        modelInfo,
        error: error instanceof Error ? error.message : String(error),
          })
        );
      setStatus("Failed.");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>TFLite PPG test</h1>
      <p id="status">{status}</p>
      <pre id="result">{result ? JSON.stringify(result, null, 2) : ""}</pre>
      <video ref={videoRef} style={{ maxWidth: 320 }} controls muted />
      <canvas ref={canvasRef} hidden />
    </main>
  );
}
