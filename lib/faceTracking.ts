export interface FaceBox {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

/** Smooth center and scale separately, with response based on video time. */
export function smoothFaceBox(previous: FaceBox, candidate: FaceBox, elapsedSeconds: number) {
  const dt = Math.min(0.25, Math.max(0.001, elapsedSeconds));
  const size = Math.max(0.01, previous.width, previous.height);
  const dx = candidate.x + candidate.width / 2 - previous.x - previous.width / 2;
  const dy = candidate.y + candidate.height / 2 - previous.y - previous.height / 2;
  const movement = Math.hypot(dx, dy) / size;
  // Suppress sub-percent detector noise; increase response for actual movement.
  const response = Math.min(1, Math.max(0, (movement - 0.01) / 0.14));
  const confidence = Math.min(1, Math.max(0.35, candidate.confidence));
  const centerAlpha = 1 - Math.exp(-dt * (2.5 + 15 * response) * confidence);
  const scaleChange = Math.max(
    Math.abs(Math.log(candidate.width / previous.width)),
    Math.abs(Math.log(candidate.height / previous.height))
  );
  const scaleResponse = Math.min(1, Math.max(0, (scaleChange - 0.025) / 0.2));
  const scaleAlpha = 1 - Math.exp(-dt * (1.8 + 10 * scaleResponse) * confidence);
  const width = Math.min(1, Math.exp(Math.log(previous.width) + Math.log(candidate.width / previous.width) * scaleAlpha));
  const height = Math.min(1, Math.exp(Math.log(previous.height) + Math.log(candidate.height / previous.height) * scaleAlpha));
  const centerX = previous.x + previous.width / 2 + dx * centerAlpha;
  const centerY = previous.y + previous.height / 2 + dy * centerAlpha;
  return {
    id: previous.id,
    x: Math.min(Math.max(0, centerX - width / 2), 1 - width),
    y: Math.min(Math.max(0, centerY - height / 2), 1 - height),
    width,
    height,
    confidence: candidate.confidence,
  };
}

/** Require outliers to describe the same new location before accepting a jump. */
export function isConsistentFaceMove(previous: FaceBox, candidate: FaceBox) {
  const size = Math.max(0.01, previous.width, previous.height);
  const distance = Math.hypot(
    previous.x + previous.width / 2 - candidate.x - candidate.width / 2,
    previous.y + previous.height / 2 - candidate.y - candidate.height / 2
  );
  const ratio = candidate.width * candidate.height / (previous.width * previous.height);
  return distance / size < 0.2 && ratio > 0.8 && ratio < 1.25;
}
