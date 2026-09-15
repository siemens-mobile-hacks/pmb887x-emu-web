import http from "http";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const root = "/workspace/site";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const file = path.join(root, url === "/" ? "index.html" : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// harness page: renders aux + keypad for a given keyboard/variant
// (?keyboard=&variant=)
const harness = `<!doctype html><html><head><link rel="stylesheet" href="/style.css">
<style>body { margin: 20px; background: var(--bg); } .phone-panel { padding-left: 74px; }</style>
</head><body>
<section class="phone-panel">
  <div class="lcd-wrap"><canvas id="lcd" width="132" height="176" style="width:264px;height:352px;background:#000"></canvas>
  <div id="aux-keys" class="aux-keys"></div></div>
  <div id="keypad" class="keypad"></div>
</section>
<script type="module">
  import { applyKbdLayout } from "/keyboards.js";
  const q = new URLSearchParams(location.search);
  applyKbdLayout(q.get("keyboard") ?? "ke800", q.get("variant") ?? "en");
</script>
</body></html>`;
fs.writeFileSync(path.join(root, "__kbdtest.html"), harness);

const browser = await puppeteer.launch({ executablePath: "/tmp/browsers/chrome-headless-shell/linux-155.0.8043.0/chrome-headless-shell-linux64/chrome-headless-shell", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 480, height: 1000, deviceScaleFactor: 2 });
for (const variant of ["en", "ru"]) {
  await page.goto(`http://127.0.0.1:${port}/__kbdtest.html?keyboard=ke800&variant=${variant}`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `/tmp/kbd-ke800-${variant}.png` });
  console.log("shot", variant);
}
await browser.close();
server.close();
fs.unlinkSync(path.join(root, "__kbdtest.html"));
