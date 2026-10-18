import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 120000 });
const outputPath = path.join(root,'artifacts/box-playback-check.json');
const results = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath,'utf8')).results : [];
try {
  for (const videoName of process.env.BOX_TEST_VIDEO ? [process.env.BOX_TEST_VIDEO] : ['sub1.mp4', '\uC774\uBC94\uC11D_\uBC29\uC11D.mov']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      const now = new Date().toISOString();
      localStorage.setItem('video-analysis-local-account', JSON.stringify({username:'box-test',salt:'test',passwordHash:'test'}));
      sessionStorage.setItem('video-analysis-auth-session','box-test');
      localStorage.setItem('video-analysis-projects',JSON.stringify([{id:'box-test',name:'Box test',description:'',createdAt:now}]));
      localStorage.setItem('video-analysis-items',JSON.stringify([{id:'box-test',projectId:'box-test',name:'Box test',description:'',createdAt:now,updatedAt:now}]));
    });
    await page.goto((process.env.BOX_APP_URL || 'http://localhost:3140') + '/projects/box-test/analyses/box-test', {waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForSelector('input[type="file"]');
    await (await page.$('input[type="file"]')).uploadFile(path.join(root,videoName));
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Detect Faces').click());
    await page.waitForSelector('.face-box', {timeout:15000}).catch(async error => {
      console.error(await page.evaluate(() => ({text:document.body.innerText,ready:document.querySelector('video').readyState}))); throw error;
    });
    await page.click('.face-box');
    await page.evaluate(() => {
      window.deliveredFrames = [];
      const video = document.querySelector('video');
      const record = (now, metadata) => {
        window.deliveredFrames.push({mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames});
        window.frameObserver = video.requestVideoFrameCallback(record);
      };
      window.frameObserver = video.requestVideoFrameCallback(record);
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Analyze Selected Person').click();
    });
    await page.waitForFunction(() => document.querySelector('video').currentTime >= 10, {timeout:60000});
    assert.equal(await page.$('.face-mesh-overlay'),null);
    assert.ok(await page.$('.face-box'));
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Stop Analysis').click());
    await page.waitForSelector('.collection-coverage tbody tr', {timeout:60000});
    const data = await page.evaluate(() => {
      const video = document.querySelector('video');
      video.cancelVideoFrameCallback(window.frameObserver);
      const frames = window.deliveredFrames.filter(f => f.mediaTime > 0);
      const span = frames.at(-1).mediaTime - frames[0].mediaTime;
      return {width:video.videoWidth,height:video.videoHeight,frames:frames.length,span,observedFps:(frames.length-1)/span,
        presentedFps:(frames.at(-1).presentedFrames-frames[0].presentedFrames)/span,
        coverage:[...document.querySelectorAll('.collection-coverage tbody tr')].map(row => [...row.querySelectorAll('td')].map(td => td.textContent)),
        coverageText:document.querySelector('.collection-coverage').textContent};
    });
    assert.deepEqual(errors,[]);
    const rgbCount = data.coverage.reduce((sum,row) => sum+Number(row[2]),0);
    assert.ok(rgbCount > 200, 'Box tracking must collect RGB throughout playback');
    const previousIndex = results.findIndex(row => row.video === videoName);
    if (previousIndex >= 0) results.splice(previousIndex,1);
    results.push({video:videoName,...data,rgbCount,errors});
    console.log(JSON.stringify({video:videoName,fps:data.observedFps,rgbCount,coverage:data.coverage.filter(row => Number(row[1]) > 0),errors}));
    fs.writeFileSync(path.join(root,'artifacts/box-playback-check.json'),JSON.stringify({testedAt:new Date().toISOString(),secondsPerVideo:10,results},null,2));
    await page.close();
  }
  fs.writeFileSync(path.join(root,'artifacts/box-playback-check.json'),JSON.stringify({testedAt:new Date().toISOString(),secondsPerVideo:10,results},null,2));
} finally { await browser.close(); }
