import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const load = require('./load-analysis.cjs');
const { calculatePosSignal } = load('lib/posSignal.ts');
const output = path.resolve('artifacts/test3-live-120s');
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  pipe: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const gaps = points => points.slice(1).flatMap((p, i) => p[0] - points[i][0] > 0.5
  ? [{ start: points[i][0], end: p[0], seconds: p[0] - points[i][0] }] : []);
try {
  console.log('Chrome launched in an isolated diagnostic profile.');
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.POS_APP_URL || 'http://localhost:3157', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const key = suffix => 'video-analysis-account:test3-gap-diagnostic:' + suffix;
    localStorage.setItem('video-analysis-local-account', JSON.stringify({
      id: 'test3-gap-diagnostic', username: 'diagnostic', salt: 'test', passwordHash: 'test',
    }));
    sessionStorage.setItem('video-analysis-auth-session', 'test3-gap-diagnostic');
    localStorage.setItem(key('video-analysis-projects'), JSON.stringify([
      { id: 'diagnostic', name: 'Diagnostic', description: '', createdAt: now },
    ]));
    localStorage.setItem(key('video-analysis-items'), JSON.stringify([
      { id: 'diagnostic', projectId: 'diagnostic', name: 'Diagnostic', description: '', createdAt: now, updatedAt: now },
    ]));
  });
  await page.goto((process.env.POS_APP_URL || 'http://localhost:3157') + '/projects/diagnostic/analyses/diagnostic', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type=file]');
  await (await page.$('input[type=file]')).uploadFile(path.resolve('test3.mov'));
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await page.evaluate(() => {
    const end = document.querySelectorAll('.range-inputs input')[1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(end, '120');
    end.dispatchEvent(new Event('input', { bubbles: true }));
    end.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.range-info').textContent.includes('120.0'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Detect Faces').click());
  await page.waitForSelector('.face-box');
  await page.click('.face-box');
  await page.evaluate(() => {
    window.frameTimings = [];
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
      return original.call(this, (now, metadata) => {
        const start = performance.now();
        callback(now, metadata);
        window.frameTimings.push({ t: metadata.mediaTime, frames: metadata.presentedFrames, ms: performance.now() - start });
      });
    };
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Analyze Selected Person').click();
  });
  console.log('Live test3.mov playback started: 0–120 seconds.');
  await page.waitForSelector('.pulse-chart', { timeout: 210000 });
  const captured = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem('video-analysis-account:test3-gap-diagnostic:video-analysis-results'))?.[0],
    timings: window.frameTimings,
    text: document.querySelector('.collection-coverage')?.textContent,
    mediaTime: document.querySelector('video').currentTime,
  }));
  if (!captured.saved) throw new Error('No saved live result: ' + captured.text);
  fs.writeFileSync(path.join(output, 'saved-result.json'), JSON.stringify(captured.saved, null, 2));
  fs.writeFileSync(path.join(output, 'frame-timings.json'), JSON.stringify(captured.timings));
  const saved = captured.saved;
  const origin = saved.signalTimeOrigin;
  const costs = captured.timings.map(p => p.ms).sort((a, b) => a - b);
  const offlineRows = fs.readFileSync('artifacts/test3-pos-validation/frames.ndjson', 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.t < 120);
  const offline = calculatePosSignal(offlineRows.flatMap(row => row.modes.box.rgb ? [row.modes.box.rgb] : []));
  const report = {
    testedAt: new Date().toISOString(), video: 'test3.mov', range: [0, 120], errors,
    live: {
      origin, mediaEnd: captured.mediaTime, coverage: saved.coverage,
      rgbSamples: saved.rgbSignal.length, pulseSamples: saved.ppgSignal.length,
      rgbGaps: gaps(saved.rgbSignal).map(g => ({ ...g, start: g.start + origin, end: g.end + origin })),
      pulseGaps: gaps(saved.ppgSignal).map(g => ({ ...g, start: g.start + origin, end: g.end + origin })),
      rejectedRr: saved.rrRecords.filter(r => !r.accepted).map(r => ({ ...r, start: r.start + origin, end: r.end + origin })),
      processedFps: saved.rgbSignal.length / 120,
      callbackMs: { median: costs[Math.floor(costs.length / 2)], p95: costs[Math.floor(costs.length * 0.95)], max: costs.at(-1) },
      deliveredFrameGaps: gaps(captured.timings.map(p => [p.t])).filter(g => g.start < 120),
    },
    offline: {
      note: 'Previously extracted 30fps RGB; recalculated using current POS code, not live playback.',
      rgbSamples: offlineRows.length, pulseSamples: offline.signal.length,
      pulseGaps: gaps(offline.signal.map(p => [p.t])),
    },
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(output, 'page.png'), fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
