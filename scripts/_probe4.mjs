import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[RS]") || m.type() === "error" && !t.includes("webpack-hmr")) console.log(t);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.addInitScript(() => {
  const Orig = window.ReadableStream;
  let id = 0;
  window.ReadableStream = function (source, strategy) {
    const myId = ++id;
    let bytes = 0;
    if (source && typeof source.start === "function") {
      const origStart = source.start.bind(source);
      source.start = (controller) => {
        const origEnqueue = controller.enqueue.bind(controller);
        const origClose = controller.close.bind(controller);
        const origError = controller.error.bind(controller);
        controller.enqueue = (chunk) => {
          bytes += chunk?.byteLength ?? chunk?.length ?? 0;
          return origEnqueue(chunk);
        };
        controller.close = () => {
          console.log(`[RS] stream#${myId} close after ${bytes} bytes`);
          return origClose();
        };
        controller.error = (e) => {
          console.log(`[RS] stream#${myId} error after ${bytes} bytes: ${e}`);
          return origError(e);
        };
        return origStart(controller);
      };
    }
    const stream = new Orig(source, strategy);
    setTimeout(() => {
      // app-index names the hydration stream in dev.
      if (stream.name === "hydration") console.log(`[RS] stream#${myId} is the hydration stream, ${bytes} bytes so far`);
    }, 0);
    return stream;
  };
  window.ReadableStream.prototype = Orig.prototype;
  Object.setPrototypeOf(window.ReadableStream, Orig);
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
const hydrated = await page.evaluate(() =>
  [...document.querySelectorAll("*")].some((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"))),
);
console.log("hydrated:", hydrated);
await browser.close();
