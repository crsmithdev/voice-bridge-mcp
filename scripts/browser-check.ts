/**
 * The client page in a real browser (spec 7.4).
 *
 * `bun test` cannot reach the page: it needs a browser, a livekit-server and a
 * running bridge. Chromium takes a wav file as its microphone, so this drives
 * the whole thing with no human and no phone.
 *
 *   docker run -d --network host livekit/livekit-server --dev --bind 0.0.0.0
 *   bun src/main.ts serve /tmp                       # prints the pairing code
 *   sox question.wav mic.wav pad 1 25                # silence, so the loop does not repeat
 *   bun scripts/browser-check.ts http://127.0.0.1:3100 <code> mic.wav
 *
 * Add PHONE=1 to check it at phone width, which is the size that matters.
 */
import { chromium } from "playwright";

const [base, code, micWav] = process.argv.slice(2);

// There is one long-lived room in normal use, and it is somebody's actual
// conversation. A check that points at it joins that conversation, is given its
// transcript, and speaks a test question into it. Point at a bridge of your own.
if (!process.env.LIVE && /3100|lightbox2/.test(base ?? "")) {
  console.error("that looks like the live bridge. Start one of your own, or set LIVE=1 to say you meant it.");
  process.exit(2);
}
const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${micWav}`,
    "--autoplay-policy=no-user-gesture-required",
    // INSECURE=1 only for a self-signed pair. A phone will not make this
    // allowance: it refuses the microphone over a certificate it does not
    // trust, and that lands as the same silent failure as plain http.
    ...(process.env.INSECURE ? ["--ignore-certificate-errors"] : []),
  ],
});
const { devices } = await import("playwright");
const context = await browser.newContext({
  ...(process.env.PHONE ? devices["iPhone 13"] : {}),
  permissions: ["microphone"],
  ignoreHTTPSErrors: Boolean(process.env.INSECURE),
});
const page = await context.newPage();
const problems: string[] = [];
page.on("console", (m) => { const t = `${m.type()}: ${m.text()}`; console.log("  console", t); if (m.type() === "error") problems.push(t); });
page.on("pageerror", (e) => { console.log("  PAGE ERROR", e.message); problems.push(e.message); });

await page.goto(base, { waitUntil: "domcontentloaded" });
console.log("title:", await page.title());
console.log("pairing form visible:", await page.locator("#pair").isVisible());

await page.fill("#code", code);
await page.click("#go");
await page.waitForSelector("#log:not(.hidden)", { timeout: 15_000 });
console.log("paired; state:", await page.locator("#state").textContent());
await page.waitForFunction(() => document.getElementById("state")?.textContent === "listening", null, { timeout: 20_000 });
console.log("connected; dot lit:", await page.locator("#dot.on").count() === 1);
console.log("token stored for next time:", await page.evaluate(() => !!localStorage.getItem("voice-bridge-credentials")));

// the fake microphone is already playing the question into the room
await page.waitForFunction(() => document.querySelectorAll("#log .bridge").length > 0, null, { timeout: 90_000 })
  .then(() => console.log("the bridge answered"))
  .catch(() => console.log("NO ANSWER within 90s"));

const lines = await page.locator("#log .line").allTextContents();
console.log("transcript on the page:");
for (const line of lines) console.log("   ", JSON.stringify(line.slice(0, 90)));
const shot = process.env.SHOT ?? "/tmp/client.png";
await page.screenshot({ path: shot.endsWith(".png") ? shot : `${shot}.png`, fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log("horizontal overflow:", overflow);
console.log("problems:", problems.length ? problems : "none");
await browser.close();
process.exit(0);
