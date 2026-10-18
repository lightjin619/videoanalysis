import type { FaceBox } from "./faceTracking";

export interface MeshPoint { x: number; y: number; z: number }
export interface TrackedMesh { box: FaceBox; points: MeshPoint[] }
export const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const SKIN_REGIONS = [
  [103,67,109,10,338,297,332,333,296,336,9,107,66,104],
  [117,118,101,36,206,205,50],
  [346,347,330,266,426,425,280],
];
const EXCLUDED_REGIONS = [
  [33,160,158,133,153,144], [362,385,387,263,373,380],
  [61,40,37,0,267,270,291,321,314,17,84,91],
];

export function polygonArea(points: MeshPoint[]) {
  return Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0)) / 2;
}

export function containsPoint(points: MeshPoint[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function region(points: MeshPoint[], indices: number[], inset = 1) {
  const polygon = indices.map(i => points[i]);
  const cx = polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length;
  const cy = polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length;
  return polygon.map(p => ({ ...p, x: cx + (p.x - cx) * inset, y: cy + (p.y - cy) * inset }));
}

export function skinPolygons(points: MeshPoint[]) {
  return SKIN_REGIONS.map(indices => region(points, indices, 0.82));
}

export function createFaceMesh(points: MeshPoint[], id: number): TrackedMesh | null {
  if (points.length < 468 || points.some(p => !Number.isFinite(p.x + p.y + p.z))) return null;
  const oval = FACE_OVAL.map(i => points[i]);
  const x = Math.max(0, Math.min(...oval.map(p => p.x)));
  const y = Math.max(0, Math.min(...oval.map(p => p.y)));
  const right = Math.min(1, Math.max(...oval.map(p => p.x)));
  const bottom = Math.min(1, Math.max(...oval.map(p => p.y)));
  if (right - x < 0.01 || bottom - y < 0.01) return null;
  return { points, box: { id, x, y, width: right - x, height: bottom - y, confidence: 1 } };
}

/** Match geometry, never the result-array index; reject ambiguous nearby faces. */
export function matchFaceMesh(candidates: TrackedMesh[], reference: FaceBox, recovering = false) {
  const size = Math.max(reference.width, reference.height, 0.01);
  const ranked = candidates.flatMap(mesh => {
    const b = mesh.box;
    const intersection = Math.max(0, Math.min(b.x+b.width, reference.x+reference.width)-Math.max(b.x, reference.x))
      * Math.max(0, Math.min(b.y+b.height, reference.y+reference.height)-Math.max(b.y, reference.y));
    const area = b.width*b.height, previousArea = reference.width*reference.height;
    const iou = intersection / (area + previousArea - intersection);
    const distance = Math.hypot(b.x+b.width/2-reference.x-reference.width/2, b.y+b.height/2-reference.y-reference.height/2) / size;
    const ratio = Math.min(area, previousArea) / Math.max(area, previousArea);
    if (ratio < 0.4 || (iou < 0.15 && distance > (recovering ? 2 : 0.65))) return [];
    return [{ mesh, score: iou * 0.65 + Math.max(0, 1-distance) * 0.25 + ratio * 0.1 }];
  }).sort((a,b) => b.score-a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 0.08)) return null;
  return { ...ranked[0].mesh, box: { ...ranked[0].mesh.box, id: reference.id } };
}

export function meshDisplacement(previous: TrackedMesh, next: TrackedMesh) {
  const size = Math.max(previous.box.width, previous.box.height, 0.01);
  return Math.sqrt(FACE_OVAL.reduce((sum, i) => sum + (next.points[i].x-previous.points[i].x)**2
    + (next.points[i].y-previous.points[i].y)**2, 0) / FACE_OVAL.length) / size;
}

/** One shared adaptive response preserves the shape of the mesh. */
export function smoothFaceMesh(previous: TrackedMesh, candidate: TrackedMesh, dt: number) {
  if (previous.points.length !== candidate.points.length) {
    return { ...candidate, box: { ...candidate.box, id: previous.box.id } };
  }
  const movement = meshDisplacement(previous, candidate);
  const response = Math.min(1, Math.max(0, (movement-0.005) / 0.08));
  const alpha = 1-Math.exp(-Math.min(0.25, Math.max(0.001, dt)) * (4+28*response));
  const points = candidate.points.map((p,i) => ({
    x: previous.points[i].x + (p.x-previous.points[i].x)*alpha,
    y: previous.points[i].y + (p.y-previous.points[i].y)*alpha,
    z: previous.points[i].z + (p.z-previous.points[i].z)*alpha,
  }));
  return createFaceMesh(points, previous.box.id)!;
}

export function hasUsableSkinRegions(mesh: TrackedMesh) {
  const polygons = skinPolygons(mesh.points);
  if (polygons.some(polygon => polygon.some(p => p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1)
    || polygonArea(polygon) < mesh.box.width*mesh.box.height*0.008)) return false;
  const cheekRatio = polygonArea(polygons[1]) / polygonArea(polygons[2]);
  return cheekRatio > 0.25 && cheekRatio < 4;
}

/** Precompute the mask once per frame, rather than rebuilding polygons per pixel. */
export function createSkinMask(mesh: TrackedMesh, width: number, height: number) {
  const polygons = skinPolygons(mesh.points);
  const excluded = EXCLUDED_REGIONS.map(indices => region(mesh.points, indices, 1.15));
  const mask = new Int8Array(width*height).fill(-1);
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const px = mesh.box.x + (x+0.5)/width*mesh.box.width;
    const py = mesh.box.y + (y+0.5)/height*mesh.box.height;
    if (!excluded.some(p => containsPoint(p, px, py))) mask[y*width+x] = polygons.findIndex(p => containsPoint(p, px, py));
  }
  return mask;
}
