# PPG TFLite model

The app loads this model directly in the browser:

- Model path: `/models/model_core_v62_fp16.tflite`
- Runtime: `@tensorflow/tfjs-tflite`
- WASM path: `/tfjs-tflite-wasm/wasm/`

The analysis page collects normalized RGB face crops over time, packs them into
the model input tensor shape reported by the TFLite model, and post-processes
the output PPG/BVP signal for HR, peaks, and HRV.
