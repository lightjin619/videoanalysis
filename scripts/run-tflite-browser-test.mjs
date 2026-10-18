import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-web-security",
    "--allow-file-access-from-files",
  ],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.goto("http://localhost:3001/tflite-test", {
    waitUntil: "networkidle0",
  });
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#result")?.textContent?.trim();
      return Boolean(text);
    },
    { timeout: 180000 }
  );
  const status = await page.$eval("#status", (node) => node.textContent);
  const result = await page.$eval("#result", (node) => node.textContent);
  console.log(JSON.stringify({ status, result: JSON.parse(result || "{}") }));
} finally {
  await browser.close();
}
