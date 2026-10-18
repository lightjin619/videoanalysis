declare module "@tensorflow/tfjs-tflite/dist/tf-tflite.es2017.js" {
  export function setWasmPath(path: string): void;
  export function loadTFLiteModel(
    model: string | ArrayBuffer,
    options?: { numThreads?: number }
  ): Promise<unknown>;
}
