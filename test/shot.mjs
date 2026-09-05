import { launch } from "./lib/browser.mjs";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const b = await launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
await unlock(p);  /* the password gate — see test/gate.mjs */
await p.goto("file:///home/claude/repo/index.html");
await p.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
await p.evaluate(async () => { SBMM.tools.volumeOfPile("Pile 3 (Fig 2)"); const f = SBMM.store.features[0]; for (let i=0;i<100&&f.props.fill_yd3==null;i++) await new Promise(r=>setTimeout(r,100)); SBMM.store.select(f.id); });
await p.click('[data-dtab="features"]').catch(()=>{});
await p.waitForTimeout(600);
await p.screenshot({ path: "/tmp/shell.png" });
await b.close();
