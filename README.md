# Face-qualified POS analysis

Both the Next.js project page and the standalone `main.html` use
`public/rppg.mjs`. Serve the standalone page over HTTP from the repository
root so its relative module import resolves. Next.js serves the project page
with `npm run dev`.

1. Load a video and choose a range of at least 8 seconds.
2. Detect and select the intended face (multiple faces require selection).
3. Run analysis. Each sampled timestamp is sought and decoded before MediaPipe
   Face Mesh runs; analysis is offline and can take longer than the video.
4. Only qualified, continuous 8-second POS windows are displayed. Cancellation
   discards the partial run.

MediaPipe is loaded from a pinned jsDelivr release. Model loading failures
are shown in the UI. RGB is extracted from landmark polygons on cheeks and
forehead, excluding clipped/small faces, strong rotation, abrupt movement,
shadow/highlight pixels, and abrupt color changes. Matching uses bounding-box
overlap, not biometric identity; crossing faces or long occlusions may require
a new selection.

The shared algorithm splits at rejected frames and timestamp gaps, resamples
within each run at 30 Hz, performs standard 1.6-second normalized POS
overlap-add, and qualifies 8-second windows using a Hann spectrum. The
0.7–3 Hz band defines the heart-rate range. At least 50% of total spectral
power must lie within one bin of the dominant cardiac frequency. Accepted
pulse plots reconstruct that cardiac band. Heart-rate resolution is 7.5 BPM
for the current 8-second FFT; these heuristics require validation on recorded
videos and reference measurements.

No full-frame fallback, gap concatenation, fabricated heartbeat series, or
HRV values are used in the new analysis path. The standalone demo's old
HRV/statistics UI remains separate; new POS results are displayed in the
workspace and are not saved as legacy HRV results.

Validation: `node --test tests/rppg.test.mjs` and `npm run build`.
The tests cover a synthetic 75 BPM pulse, no-face/unmatched-face rejection,
flat/invalid inputs, short runs, timestamp gaps and reversed time.
