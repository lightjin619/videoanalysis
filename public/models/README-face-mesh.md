# Face mesh tracking

`face_landmarker.task` is the Google MediaPipe Face Landmarker float16 model,
version 1. It is served locally; video frames remain in the browser.

- Source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
- Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js
- SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`

The analysis page uses the existing detector for person selection and recovery,
then Face Landmarker in VIDEO mode for each processed frame. It permits up to
five faces and matches the selected face by geometry instead of result index.
Ambiguous mesh matches are excluded. GPU initialization falls back to CPU.

`lib/faceMesh.ts` applies adaptive smoothing using elapsed video time. A face
oval supplies the displayed contour. Inset forehead and cheek polygons supply
the RGB mask; eye and mouth masks are excluded. The three regions have fixed
equal weights and per-channel trimmed means. All regions must remain visible
and contain at least 32 pixels in the 96 × 96 face crop. Missing meshes and
large transient movements are excluded instead of sampling a stale box.

Geometry matching is not biometric identification, and the mesh does not detect
every possible occlusion. Severe turns, small faces, and coverings can reduce
usable frames. Processing speed depends on the browser and device.

## Validation

```powershell
npx.cmd tsc --noEmit
node scripts/validate-face-tracking.cjs
node scripts/check-face-mesh.mjs
```

The browser check uses local Chrome and `sub1.mp4` by default. Set
`MESH_TEST_VIDEO` to another workspace-relative video path, or `CHROME_PATH`
to another Chrome executable. For a running development server, set
`MESH_APP_URL` (for example `http://localhost:3000`) to also verify face
selection, mesh rendering, RGB collection, and stopping on the analysis page
in an isolated browser profile.
