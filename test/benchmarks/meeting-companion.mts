// Run: node test/benchmarks/meeting-companion.mts [git-ref]
// Two isolated Electron renderers, real component/hook/CSS, deterministic level input.
// Optional git ref replaces only the measured component and hook for an A/B run.
import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { MEETING_COMPANION_SIZE } from "../../src/helpers/meetingCompanionPolicy.ts";
const require = createRequire(import.meta.url);
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-companion-bench-"));
const ref = process.argv[2];
const sources = ["src/components/MeetingCompanion.tsx", "src/hooks/useMeetingCompanionSync.ts"];
const baseline = new Map(sources.map(file => [path.join(root, file), ref ? execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" }) : fs.readFileSync(file, "utf8")]));
const server = await createServer({
  configFile: path.join(root, "src/vite.config.mjs"),
  root: path.join(root, "src"), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-i18next", "i18next"] },
  optimizeDeps: { include: ["react", "react-dom/client", "react-i18next", "i18next"] },
  server: { hmr: false, port: 0, strictPort: false, host: "127.0.0.1", fs: { allow: [root, temp] } },
  plugins: [{ name: "benchmark-input", enforce: "pre",
    resolveId(id) {
      if (/stores\/meetingRecordingStore(?:\.ts)?$/.test(id)) return "\0bench-recording";
      if (/stores\/settingsStore(?:\.ts)?$/.test(id)) return "\0bench-settings";
    },
    load(id) {
      if (id === "\0bench-settings") return "export const useSettingsStore = s => s({meetingCompanionEnabled:true});";
      if (id === "\0bench-recording") return `
        const state={isRecording:true,capturePhase:'recording',recordingNoteId:1,recordingFolderId:null,recordingNoteTitle:'Benchmark',micCaptureStatus:'active',manualMicMuted:false,platformMicMuted:false};
        export const useMeetingRecordingStore=s=>s(state);useMeetingRecordingStore.getState=()=>state;
        export const setManualMicMuted=async()=>{};
        export const getSystemAudioLevel=()=>0;
        export const getMicAnalyser=()=>({fftSize:256,getFloatTimeDomainData(buf){const t=performance.now()/1000;buf.fill(0.04*(1+Math.sin(t*3))*(1+Math.sin(t*1.3)));}});`;
      return baseline.get(id);
    },
  }],
});
fs.writeFileSync(path.join(temp, "entry.tsx"), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import i18n from 'i18next';
import {I18nextProvider} from 'react-i18next';
import Companion from '${root}/src/components/MeetingCompanion.tsx';
import {useMeetingCompanionSync} from '${root}/src/hooks/useMeetingCompanionSync.ts';
import '${root}/src/index.css';
await i18n.init({lng:'en',resources:{en:{translation:{}}}});
function Panel(){useMeetingCompanionSync();return null;}
const root = globalThis.__companionBenchmarkRoot ??= createRoot(document.getElementById('root'));
root.render(<I18nextProvider i18n={i18n}>{location.search.includes('panel')?<Panel/>:<Companion/>}</I18nextProvider>);
`);
fs.writeFileSync(path.join(temp, "index.html"), `<html><body style="margin:0;background:transparent"><div id="root"></div><script type="module" src="/@fs${temp}/entry.tsx"></script></body></html>`);
fs.writeFileSync(path.join(temp, "preload.cjs"), `
const {contextBridge,ipcRenderer}=require('electron');
const subscribe=(event,cb)=>{const f=(_e,v)=>cb(v);ipcRenderer.on(event,f);return()=>ipcRenderer.removeListener(event,f)};
contextBridge.exposeInMainWorld('electronAPI',{
 onMeetingCompanionState:cb=>subscribe('state',cb),onMeetingCompanionLevel:cb=>subscribe('level',cb),
 onMeetingCompanionLevelDemand:cb=>{const off=subscribe('demand',cb);ipcRenderer.send('watch');return off},
 sendMeetingCompanionLevel:v=>ipcRenderer.send('level',v),updateMeetingCompanion:()=>{},
 onMeetingCompanionToggleMic:()=>()=>{},meetingCompanionReady:()=>ipcRenderer.send('ready'),
 meetingCompanionDragStart:()=>{},meetingCompanionDragMove:()=>{},openMeetingCompanionNote:()=>{},meetingCompanionToggleMic:()=>{}
});
`);
await server.listen();
const htmlPath = path.join(temp, "index.html");
fs.writeFileSync(htmlPath, await server.transformIndexHtml("/index.html", fs.readFileSync(htmlPath, "utf8")));
const address = server.httpServer!.address();
if (!address || typeof address === "string") throw new Error("Missing benchmark server address");
const url = `http://127.0.0.1:${address.port}/@fs${temp}/index.html`;
fs.writeFileSync(path.join(temp, "main.cjs"), `
const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('fs');
app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});app.dock?.hide();
let levels=0;let panel,bubble;let needed=true;const samples=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const webPreferences={preload:${JSON.stringify(path.join(temp, "preload.cjs"))},contextIsolation:true,sandbox:false,backgroundThrottling:false};
 panel=new BrowserWindow({show:false,width:200,height:100,webPreferences});
 bubble=new BrowserWindow({show:false,width:${MEETING_COMPANION_SIZE.width},height:${MEETING_COMPANION_SIZE.height},x:20,y:100,frame:false,transparent:true,hasShadow:false,focusable:false,alwaysOnTop:true,webPreferences});
 ipcMain.on('level',(_e,v)=>{levels++;if(needed)bubble.webContents.send('level',v)});
 ipcMain.on('watch',()=>panel.webContents.send('demand',needed));
 ipcMain.on('ready',()=>bubble.webContents.send('state',{active:true,paused:false,waitingForMic:false,micMuted:false,noteId:1,folderId:null,title:'Benchmark'}));
 for(const w of [panel,bubble])w.webContents.on('console-message',e=>{if(e.message.includes('Error'))process.stderr.write(e.message+'\\n')});
 await panel.loadURL(${JSON.stringify(url + "?panel")});await bubble.loadURL(${JSON.stringify(url)});bubble.showInactive();
 await wait(5000);
 fs.writeFileSync(${JSON.stringify(path.join(temp, "visible.png"))},(await bubble.webContents.capturePage()).toPNG());
 app.getAppMetrics();
 for(const mode of ['visible','hidden']){
  needed=mode==='visible';if(!needed)bubble.hide();panel.webContents.send('demand',needed);
  await wait(1000);levels=0;
  for(let i=0;i<10;i++){await wait(1000);samples.push({mode,metrics:app.getAppMetrics().map(m=>({pid:m.pid,type:m.type,cpu:m.cpu.percentCPUUsage,wakeups:m.cpu.idleWakeupsPerSecond}))});}
  if(mode==='visible'&&levels<10)throw new Error('Benchmark renderer did not produce levels');
  if(mode==='hidden'&&${!ref}&&levels!==0)throw new Error('Hidden companion still polls audio');
  process.stdout.write('LEVELS '+mode+' '+levels+'\\n');
 }
 fs.writeFileSync(${JSON.stringify(path.join(temp, "metrics.json"))},JSON.stringify(samples,null,2));
 process.stdout.write('REPORT '+${JSON.stringify(path.join(temp, "metrics.json"))}+'\\n');app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(temp, "main.cjs")], { env, stdio: "inherit" });
  const timeout = setTimeout(() => child.kill(), 90000);
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Benchmark Electron exited ${code}`);
} finally { await server.close(); }
