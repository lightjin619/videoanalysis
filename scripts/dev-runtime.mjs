import { watch, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const [sourceRoot, runtimeRoot, ...args] = process.argv.slice(2);
if (!sourceRoot || !runtimeRoot || resolve(sourceRoot) === resolve(runtimeRoot)) {
  throw new Error("Distinct source and runtime paths are required.");
}

// Next runs outside OneDrive, but its source must follow workspace edits.
const watchers = [];
const timers = new Map();
for (const directory of ["app", "components", "hooks", "lib", "public", "types"]) {
  const sourceDirectory = resolve(sourceRoot, directory);
  const runtimeDirectory = resolve(runtimeRoot, directory);
  watchers.push(watch(sourceDirectory, { recursive: true }, (_, filename) => {
    if (!filename) return;
    const source = resolve(sourceDirectory, String(filename));
    const destination = resolve(runtimeDirectory, String(filename));
    const within = relative(runtimeDirectory, destination);
    if (!within || within.startsWith("..") || isAbsolute(within)) return;
    clearTimeout(timers.get(source));
    timers.set(source, setTimeout(() => {
      timers.delete(source);
      try {
        if (existsSync(source)) {
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(source, destination, { recursive: true });
        } else {
          rmSync(destination, { recursive: true, force: true });
        }
      } catch (error) {
        console.error(`Could not sync ${directory}/${filename}: ${error.message}`);
      }
    }, 100));
  }));
}

const child = spawn(process.execPath, [
  resolve(runtimeRoot, "node_modules/next/dist/bin/next"), "dev", ...args,
], { cwd: runtimeRoot, stdio: "inherit", windowsHide: true });

function cleanup() {
  for (const watcher of watchers) watcher.close();
  for (const timer of timers.values()) clearTimeout(timer);
}
child.on("error", (error) => {
  console.error(error);
  cleanup();
  process.exitCode = 1;
});
child.on("exit", (code) => {
  cleanup();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { cleanup(); child.kill(signal); });
}
