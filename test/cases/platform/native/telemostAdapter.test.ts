import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { build } from "esbuild";

test("Telemost prejoin and shell controls never invent a connected call or confirmed Leave", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-telemost-dom-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const bundle = await build({
    entryPoints: [path.resolve("extension/src/telemostAdapter.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "adapter",
    write: false,
  });

  const fixture = fs.readFileSync("test/fixtures/telemost/v1/prejoin.html", "utf8");
  const connected = fs.readFileSync("test/fixtures/telemost/v1/in-call.html", "utf8");
  const entry = path.join(directory, "fixture.cjs");
  fs.writeFileSync(
    entry,
    `const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(directory, "profile"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
try {
const run=async html=>{await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));return win.webContents.executeJavaScript(${JSON.stringify(bundle.outputFiles[0].text)}+';adapter.readTelemostContext([document],"1000")');};
const prejoin=await run(${JSON.stringify(fixture)}); assert.equal(prejoin.presence,'not-in-call');assert.equal(prejoin.micMuted,null);assert.equal(prejoin.confirmedLeave,false);
const shell=await run('<button data-test-tag="call-widget-end">End</button><button data-test-tag="call-widget-audio"><svg><use href="#micro-on-solid-sm"></use></svg></button>');
assert.equal(shell.presence,'unknown');assert.equal(shell.micMuted,null);assert.equal(shell.confirmedLeave,false);
const home=await run('<h1 id="home-hub-page-title">Unrelated localized heading</h1>');assert.equal(home.presence,'not-in-call');assert.equal(home.confirmedLeave,false);
const lost=await run('<div>Connection lost</div>');assert.equal(lost.presence,'unknown');assert.equal(lost.confirmedLeave,false);assert.deepEqual(lost.activeParticipantIds,[]);
const connected=await run(${JSON.stringify(connected)});
assert.equal(connected.presence,'in-call');assert.equal(connected.micMuted,true);assert.equal(connected.confirmedLeave,false);
assert.equal(connected.participants.length,2);assert.equal(connected.participants[0].self,'local');
assert.deepEqual(connected.activeParticipantIds,[connected.participants[1].id]);
const check=code=>win.webContents.executeJavaScript(code);
assert.equal(await check('adapter.isTelemostLeaveControl(document.querySelector(\\'button[data-testid="end-call-button"]\\'))'),true);
assert.equal(await check('adapter.isTelemostLeaveControl(document.querySelector(\\'button[data-testid="end-call-alt-button"]\\'))'),true);
const unchanged=await check('adapter.readTelemostContext([document],"2000")');assert.equal(unchanged.participants[1].id,connected.participants[1].id);
await check('document.querySelector(\\'#toolbar [data-testid="turn-on-mic-button"]\\').setAttribute("data-testid","turn-off-mic-button")');
assert.equal((await check('adapter.readTelemostContext([document],"3000")')).micMuted,false);
await check('document.querySelector(".speaking").classList.remove("speaking")');
assert.deepEqual((await check('adapter.readTelemostContext([document],"4000")')).activeParticipantIds,[]);
await check('document.querySelectorAll(".overlay")[1].classList.add("speaking");document.querySelector("[data-video-root] > div").append(document.querySelectorAll(".tile")[1].cloneNode(true))');
assert.deepEqual((await check('adapter.readTelemostContext([document],"5000")')).activeParticipantIds,[]);
await check('document.querySelectorAll("video")[1].setAttribute("data-g_track_id","remote-track");document.querySelectorAll("video")[2].setAttribute("data-g_track_id","remote-track")');
const deduped=await check('adapter.readTelemostContext([document],"5100")');
assert.equal(deduped.participants.length,2);assert.deepEqual(deduped.activeParticipantIds,[deduped.participants[1].id]);
await check('document.querySelectorAll("video")[2].setAttribute("data-g_track_id","other-track")');
assert.equal((await check('adapter.readTelemostContext([document],"5200")')).participants.length,3);
await check('document.querySelectorAll(".tile")[2].remove();document.querySelectorAll(".tile")[1].remove()');
const departed=await check('adapter.readTelemostContext([document],"5300")');
assert.equal(departed.participants.length,1);assert.deepEqual(departed.activeParticipantIds,[]);
await check('Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});void 0');
assert.equal((await check('adapter.readTelemostContext([document],"6000",true)')).health,'unreadable');
await run('<h1 id="home-hub-page-title">Home</h1>');
assert.equal((await check('adapter.readTelemostContext([document],"7000",true)')).confirmedLeave,true);
await run('<div>Disconnected</div>');assert.equal((await check('adapter.readTelemostContext([document],"8000",true)')).confirmedLeave,false);
console.log('telemost DOM fixtures passed');
} finally {win.destroy();app.quit();}}).catch(error=>{console.error(error);app.exit(1);});`
  );
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  const executable: string = require("electron");

  const output = await new Promise<string>((resolve, reject) =>
    execFile(executable, [entry], { env, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    })
  );

  assert.match(output, /telemost DOM fixtures passed/);
});
