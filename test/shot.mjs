import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
await p.goto("file:///home/claude/repo/index.html");
await p.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
await p.evaluate(async () => { SBMM.tools.volumeOfPile("Pile 3 (Fig 2)"); const f = SBMM.store.features[0]; for (let i=0;i<100&&f.props.fill_yd3==null;i++) await new Promise(r=>setTimeout(r,100)); SBMM.store.select(f.id); });
await p.click('[data-dtab="features"]').catch(()=>{});
await p.waitForTimeout(600);
await p.screenshot({ path: "/tmp/shell.png" });
await b.close();
