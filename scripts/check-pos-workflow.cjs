const assert = require("node:assert/strict");
const load = require("./load-analysis.cjs");

(async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const baseUrl = process.env.POS_APP_URL || "http://localhost:3157";
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
    timeout: 20000,
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const pos = load("lib/posSignal.ts");
    const pulse = pos.calculatePulseSignalFromSamples(Array.from({ length: 2700 }, (_, i) => ({
      t: i / 30, value: Math.sin(2 * Math.PI * 1.2 * i / 30),
    })), 30);
    const saved = {
      id: "fixture", projectId: "test", analysisId: "test", fileName: "fixture.mp4",
      createdAt: new Date().toISOString(), duration: pulse.signal.at(-1).t, sampleRate: 30,
      heartRate: pulse.heartRate, peakFrequency: pulse.peakFrequency, refinementBand: pulse.refinementBand,
      signalPipeline: pos.POS_SIGNAL_PIPELINE, ppgSignal: pulse.signal.map(p => [p.t, p.value]),
      rrRecords: [], hrv: null,
    };
    // A separate headless browser profile keeps these fixtures out of the user's data.
    await page.evaluate(saved => {
      const now = new Date().toISOString(), key = suffix => "video-analysis-account:workflow:" + suffix;
      localStorage.setItem("video-analysis-local-account", JSON.stringify({ id: "workflow", username: "test", salt: "s", passwordHash: "p" }));
      sessionStorage.setItem("video-analysis-auth-session", "workflow");
      localStorage.setItem(key("video-analysis-projects"), JSON.stringify([{ id: "test", name: "test", description: "", createdAt: now }]));
      localStorage.setItem(key("video-analysis-items"), JSON.stringify([{ id: "test", projectId: "test", name: "test", description: "", createdAt: now, updatedAt: now }]));
      localStorage.setItem(key("video-analysis-results"), JSON.stringify([saved]));
    }, saved);
    await page.goto(baseUrl + "/projects/test/within-subject", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".analysis-selector input:checked");
    assert.equal(await page.$(".pulse-chart"), null);
    assert.deepEqual(await page.$$eval(".window-options label", els => els.map(e => e.textContent.trim())), ["30 sec window", "60 sec window"]);
    await page.waitForFunction(() => document.querySelectorAll(".segment-controls input")[1]?.value === "30");
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Run comparison").click());
    await page.waitForFunction(() => !document.querySelector(".comparison-table tbody").textContent.includes("N/A"));
    console.log("Within browser passed: full-signal RR statistics, existing 30/60s windows, no 15s waveform.");

    await page.goto(baseUrl + "/projects/test/analyses/test", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("input[type=file]");
    await (await page.$("input[type=file]")).uploadFile(require("node:path").resolve("sub1.mp4"));
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    await page.evaluate(() => {
      const end = document.querySelectorAll(".range-inputs input")[1];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(end, "18");
      end.dispatchEvent(new Event("input", { bubbles: true }));
      end.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector(".range-info").textContent.includes("18.0"));
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Detect Faces").click());
    await page.waitForSelector(".face-box", { timeout: 20000 });
    await page.click(".face-box");
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Analyze Selected Person").click());
    await page.waitForSelector(".pulse-chart", { timeout: 40000 });
    const result = await page.evaluate(() => JSON.parse(localStorage.getItem("video-analysis-account:workflow:video-analysis-results"))[0]);
    assert.equal(result.signalPipeline, pos.POS_SIGNAL_PIPELINE);
    assert.equal(result.rrPipeline, pos.POS_RR_PIPELINE);
    assert.ok(result.heartRateWindows.every(w => Math.abs(w.refinementBand.low - w.peakFrequency + .2) < 1e-12
      && Math.abs(w.refinementBand.high - w.peakFrequency - .2) < 1e-12));
    assert.ok(result.rgbSignal.length >= 20 && result.ppgSignal.length >= 20);
    assert.ok(Array.isArray(result.motionIntervals));
    assert.ok(result.duration > 16 && result.duration < 19);
    assert.ok(await page.$eval(".pulse-segment-controls", e => e.textContent.includes("Segment 1 / 2")));
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Next 15s").click());
    assert.ok(await page.$eval(".pulse-segment-controls", e => e.textContent.includes("Segment 2 / 2")));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ video: "sub1.mp4", seconds: result.duration,
      rgbSamples: result.rgbSignal.length, pulseSamples: result.ppgSignal.length,
      video15sNavigation: "passed", errors }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
