# Web-Compatible PPG Model Export Notes

The current `model_core_v62_fp16.tflite` runs correctly with Python
`tf.lite.Interpreter`, but it does not produce matching outputs through
`@tensorflow/tfjs-tflite@0.0.1-alpha.10`.

Observed with the exact same 900 `36x36 RGB` frames from `test.mp4`:

| Runtime | BPM | Peaks | Raw output |
| --- | ---: | ---: | --- |
| Python `tf.lite.Interpreter` | 100.51 | 50 | normal `ppg_100`, `peak_logits`, `ppg_30` |
| Web `tfjs-tflite` | 94.44 | 46 | invalid values, e.g. `6.67e+35`; outputs appear corrupted |

Current TFLite signature:

```text
serving_default
inputs:
  frames:     [1, 451, 36, 36, 3] uint8
  timestamps: [1, 451] float32
outputs:
  peak_logits: [1, 1500] float32
  ppg_100:     [1, 1500] float32
  ppg_30:      [1, 450] float32
```

The web package exposes `execute()`, but it throws:

```text
execute() of TFLiteModel is not supported yet.
```

## Recommended Web Export

Export a browser-specific model that avoids signature/multi-output handling:

1. Keep the same inputs:
   - `frames`: `[1, 451, 36, 36, 3]`
   - `timestamps`: `[1, 451]`
2. Prefer `float32` frames in range `0..255` or `0..1`.
   Avoid `uint8` input if possible, because TFJS maps unsupported integer
   tensors through `int32` compatibility.
3. Return a single named tensor, for example:

```text
web_output: [1, 3450] float32
```

Layout:

```text
web_output[:, 0:1500]     = ppg_100
web_output[:, 1500:3000]  = peak_logits
web_output[:, 3000:3450]  = ppg_30
```

The frontend can then split this single tensor deterministically without relying
on TFLite signature output names or unsupported `execute()`.

## Validation Target

For the current `test.mp4` crop fixture, the web export should match Python:

```text
BPM:       about 100.51
peakCount: 50
firstPeaks: 0.34, 0.65, 0.97, 1.27, 1.58 ...
```

Use:

```powershell
uv run python scripts\compare-python-tflite.py
```

to reproduce the Python reference result after exporting the same browser
frames with:

```powershell
node scripts\export-tflite-test-frames.mjs
```
