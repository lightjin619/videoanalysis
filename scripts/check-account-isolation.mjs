import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.ACCOUNT_APP_URL || "http://localhost:3151";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
  protocolTimeout: 30000,
});
const errors = [];
let page;
try {
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  const goto = path => page.goto(baseUrl + path, { waitUntil: "networkidle0" });
  const waitText = async text => {
    try {
      await page.waitForFunction(value => document.body.innerText.includes(value), {}, text);
    } catch (error) {
      throw new Error(`Expected page text: ${text}`, { cause: error });
    }
  };
  const fillLogin = async (password, confirm = false) => {
    await page.waitForSelector('input[autocomplete="username"]');
    await page.type('input[autocomplete="username"]', "isolation-test");
    const fields = await page.$$('input[type="password"]');
    await fields[0].type(password);
    if (confirm) await fields[1].type(password);
    await page.click('button[type="submit"]');
  };
  await goto("/");
  await page.evaluate(async () => {
    const now = new Date().toISOString();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("legacy-salt:old-password"));
    const passwordHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("video-analysis-local-account", JSON.stringify({ username: "isolation-test", salt: "legacy-salt", passwordHash }));
    sessionStorage.setItem("video-analysis-auth-session", "isolation-test");
    localStorage.setItem("video-analysis-projects", JSON.stringify([{ id: "legacy-project", name: "Previous account work", description: "", createdAt: now }]));
    localStorage.setItem("video-analysis-items", JSON.stringify([{ id: "legacy-analysis", projectId: "legacy-project", name: "Previous analysis", description: "", createdAt: now, updatedAt: now }]));
    localStorage.setItem("video-analysis-results", JSON.stringify([{ id: "legacy-result", projectId: "legacy-project", analysisId: "legacy-analysis", fileName: "previous.mp4", createdAt: now, duration: 30, sampleRate: 30, heartRate: 72, peakFrequency: 1.2, refinementBand: { low: 1.1, high: 1.3 }, hrv: null }]));
    localStorage.setItem("between-subject-assignments:legacy-project", JSON.stringify([{ analysisId: "legacy-analysis", selected: true, participant: "Legacy participant", group: "Legacy group", condition: "Legacy condition" }]));
  });
  await goto("/projects");
  await waitText("Previous account work");
  const oldAccountId = await page.evaluate(() => JSON.parse(localStorage.getItem("video-analysis-local-account")).id);
  assert.ok(oldAccountId);
  await goto("/projects/legacy-project/analyses/legacy-analysis");
  await waitText("previous.mp4");
  await goto("/projects/legacy-project/between-subject");
  await page.waitForFunction(() => [...document.querySelectorAll("input")].some(input => input.value === "Legacy participant"));
  console.log("Legacy projects, results and assignments migrated.");

  // A normal logout/login and reload must retain that account's data.
  await page.click(".header-logout");
  await fillLogin("old-password");
  await waitText("Previous account work");
  await page.reload({ waitUntil: "networkidle0" });
  await waitText("Previous account work");

  // Keep an old authenticated tab open while resetting and reusing the username.
  console.log("Logout/login and reload retained existing work.");
  const staleTab = await browser.newPage();
  staleTab.setDefaultTimeout(10000);
  staleTab.on("pageerror", error => errors.push(error.message));
  await staleTab.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await staleTab.evaluate(id => sessionStorage.setItem("video-analysis-auth-session", id), oldAccountId);
  await staleTab.goto(baseUrl + "/projects", { waitUntil: "networkidle0" });
  await staleTab.waitForFunction(() => document.body.innerText.includes("Previous account work"));
  console.log("Second tab opened with the original account.");

  await page.bringToFront();
  await page.click(".header-logout");
  await page.waitForSelector(".login-reset");
  await page.click(".login-reset");
  await waitText("Create a Local Account");
  console.log("Original account reset.");
  await fillLogin("new-password", true);
  await waitText("No projects yet.");
  assert.equal(await page.$(".project-card"), null);
  const newAccountId = await page.evaluate(() => JSON.parse(localStorage.getItem("video-analysis-local-account")).id);
  assert.notEqual(newAccountId, oldAccountId, "reusing a username must create a fresh workspace");
  await staleTab.waitForFunction(() => location.pathname === "/" && document.body.innerText.includes("Sign In"), { polling: 100 });
  console.log("Re-registration starts empty and invalidates the previous tab.");
  assert.equal(await staleTab.$(".project-card"), null, "old tabs must lose access when the account changes");

  for (const path of ["/projects/legacy-project", "/projects/legacy-project/analyses/legacy-analysis", "/projects/legacy-project/within-subject", "/projects/legacy-project/between-subject"]) {
    await goto(path);
    await waitText("Project not found.");
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes("previous.mp4"));
  }
  await goto("/projects");
  await page.type('input[placeholder="Project name"]', "New account work");
  await page.click('button[type="submit"]');
  await waitText("New account work");
  await page.click(".project-card");
  await page.waitForSelector(".analysis-create-fields input");
  await page.type(".analysis-create-fields input", "New analysis");
  await page.click('.analysis-create-form button[type="submit"]');
  await waitText("New analysis");
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes("previous.mp4"));
  await page.click(".header-logout");
  await fillLogin("new-password");
  await waitText("New account work");
  const storage = await page.evaluate(({ oldId, newId }) => {
    const key = (id, suffix) => `video-analysis-account:${encodeURIComponent(id)}:${suffix}`;
    return {
      oldProjects: JSON.parse(localStorage.getItem(key(oldId, "video-analysis-projects"))),
      oldResults: JSON.parse(localStorage.getItem(key(oldId, "video-analysis-results"))),
      oldAssignments: JSON.parse(localStorage.getItem(key(oldId, "between-subject-assignments:legacy-project"))),
      newProjects: JSON.parse(localStorage.getItem(key(newId, "video-analysis-projects"))),
      newItems: JSON.parse(localStorage.getItem(key(newId, "video-analysis-items"))),
      newResults: localStorage.getItem(key(newId, "video-analysis-results")),
    };
  }, { oldId: oldAccountId, newId: newAccountId });
  assert.equal(storage.oldProjects[0].name, "Previous account work");
  assert.equal(storage.oldResults[0].fileName, "previous.mp4");
  assert.equal(storage.oldAssignments[0].participant, "Legacy participant");
  assert.equal(storage.newProjects.length, 1);
  assert.equal(storage.newProjects[0].name, "New account work");
  assert.equal(storage.newItems.length, 1);
  assert.equal(storage.newItems[0].name, "New analysis");
  assert.equal(storage.newResults, null);
  assert.deepEqual(errors, []);
  console.log("Account isolation passed: legacy migration, saved results, group assignments, logout/login, reset, same username registration, stale tabs, direct URLs, new work persistence.");
} catch (error) {
  console.error({ url: page?.url(), text: await page?.evaluate(() => document.body.innerText).catch(() => "Unavailable"), errors });
  throw error;
} finally {
  await browser.close();
}
