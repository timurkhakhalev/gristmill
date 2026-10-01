import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { build } from "esbuild";

test("Meet adapter reads real isolated DOM: RU/EN, mute, multi-active, unknown UI, Leave and Companion mode", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-meet-dom-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = await build({ entryPoints: [path.resolve("extension/src/meetAdapter.ts")], bundle: true, platform: "browser", format: "iife", globalName: "adapter", write: false });
  const adapter = bundle.outputFiles[0].text;
  const fixtures = ["en", "ru"].map((lang) => fs.readFileSync(path.resolve(`test/fixtures/meet/v1/${lang}.html`), "utf8"));
  const entry = path.join(directory, "fixture.cjs");
  fs.writeFileSync(entry, `const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(directory, "profile"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
try {
const run=async(html,leave=false)=>{await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html)); return win.webContents.executeJavaScript(${JSON.stringify(adapter)}+'; adapter.readMeetContext([document], "1000", '+leave+')');};
const en=await run(${JSON.stringify(fixtures[0])}); assert.equal(en.presence,'in-call'); assert.equal(en.micMuted,false); assert.deepEqual(en.activeParticipantIds,['alice']); assert.equal(en.participants[1].self,'local'); assert.equal(en.rosterComplete,false);
const ru=await run(${JSON.stringify(fixtures[1])}); assert.equal(ru.micMuted,true); assert.deepEqual(ru.activeParticipantIds,['alice','bob']);
const liveRu=await run('<button jsname="CQylAd" aria-label="任意"></button><button jsname="hw0c9" data-is-muted="false" aria-label="अन्य"></button>'); assert.equal(liveRu.presence,'in-call'); assert.equal(liveRu.micMuted,false);
const liveMuted=await run('<button jsname="CQylAd"></button><button jsname="hw0c9" data-is-muted="true"></button><button jsname="psRWwc" data-is-muted="false"></button>'); assert.equal(liveMuted.micMuted,true);
const click=await win.webContents.executeJavaScript(${JSON.stringify(adapter)}+'; adapter.isMeetLeaveControl(document.querySelector("button"))'); assert.equal(click,true);
const companion=await run('<button jsname="CQylAd"></button><p>Companion mode</p>'); assert.equal(companion.mode,'unknown'); assert.equal(companion.micMuted,null);
const unknown=await run('<h1>Moving to another room</h1>',true); assert.equal(unknown.health,'unrecognized'); assert.equal(unknown.confirmedLeave,false); assert.equal(unknown.micMuted,null);
const left=await run('<h1 jsname="r4nke">任意</h1><button jsname="W6suGc">任意</button>',true); assert.equal(left.confirmedLeave,true); assert.equal(left.presence,'not-in-call');
const labelsOnly=await run('<button aria-label="Leave call"></button><button aria-label="Turn off microphone"></button><h1>You left the meeting</h1>',true); assert.equal(labelsOnly.health,'unrecognized'); assert.equal(labelsOnly.confirmedLeave,false);
const disconnected=await run('<h1 jsname="r4nke">任意</h1><button jsname="W6suGc">任意</button>'); assert.equal(disconnected.confirmedLeave,false);
const duplicate=await run(${JSON.stringify(fixtures[0])}+'<section data-participant-id="other" data-participant-name="Alice"></section>'); assert.equal(duplicate.participants.filter(p=>p.name==='Alice').length,2);
console.log('meet DOM fixtures passed');
} finally {win.destroy(); app.quit();}}).catch(error=>{console.error(error);app.exit(1);});`);
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  const executable: string = require("electron");
  const output = await new Promise<string>((resolve, reject) => execFile(executable, [entry], { env, timeout: 20_000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`)); else resolve(stdout);
  }));
  assert.match(output, /meet DOM fixtures passed/);
});
