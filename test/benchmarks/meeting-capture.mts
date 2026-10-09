// Run after pnpm run build:main. Synthetic audio by default; --microphone requires existing permission.
// No provider calls or production profile.
import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const microphone = process.argv.includes("--microphone");
const ref = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const soakSeconds = Number(process.argv.find((arg) => arg.startsWith("--soak-seconds="))?.split("=")[1] ?? 0);
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 7200 || (ref && soakSeconds) || (microphone && (ref || soakSeconds)))
  throw new Error("Use a Git ref or --soak-seconds=1..7200");
const pipelineFile = path.join(root, "src/helpers/meetingAudioPipeline.ts");
const baseline = ref ? execFileSync("git", ["show", `${ref}:src/helpers/meetingAudioPipeline.ts`], { encoding: "utf8" }) : null;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-capture-runtime-"));
const server = await createServer({
  configFile: path.join(root, "src/vite.config.mjs"),
  root: path.join(root, "src"), logLevel: "error",
  plugins: [{ name: "capture-benchmark-reference", enforce: "pre", load(id) { return id === pipelineFile ? baseline : null; } }],
  server: { hmr: false, host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } },
});
fs.writeFileSync(path.join(temp, "index.html"), `<html><body><script type="module" src="/@fs${temp}/renderer.ts"></script></body></html>`);
fs.writeFileSync(path.join(temp, "renderer.ts"), `
import {createAudioPipeline,createMeetingCaptureAudioContext,flushAndDisconnectProcessor,setAudioPipelineGate} from '${root}/src/helpers/meetingAudioPipeline.ts';
import {MeetingCaptureWriteQueue} from '${root}/src/helpers/meetingCaptureWriteQueue.ts';
let activeContext;let maxPendingFrames=0;let endToEndAckMs=[];
const originalWrite=MeetingCaptureWriteQueue.prototype.write;
MeetingCaptureWriteQueue.prototype.write=function(value,frames){
 const result=originalWrite.call(this,value,frames);maxPendingFrames=Math.max(maxPendingFrames,this.unacknowledgedFrames);
 return result.then(()=>{endToEndAckMs.push(Math.max(0,activeContext.currentTime*1000-(value.packet.sourceFrameStart+frames)/24));});
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const helper='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const alignment=frame=>{
 const ns=String(1e9+Math.round(frame/24000*1e9));
 return {sourceGeneration:1,sourceFrame:frame,timelineFrame:frame,rate:1,uncertaintyFrames:2,helperGeneration:helper,sourceNs:ns,helperNs:ns,sampledSourceStartNs:ns,sampledSourceEndNs:ns,freshnessSourceNs:ns};
};
window.runScenario=async scenario=>{
 const id=await window.bench.invoke('start');
 const micStream=${microphone} ? await navigator.mediaDevices.getUserMedia({audio:true}) : null;
 const context=createMeetingCaptureAudioContext();activeContext=context;maxPendingFrames=0;endToEndAckMs=[];
 const oscillator=context.createOscillator();oscillator.frequency.value=440;
 const destination=context.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();
 const failures=[];const acks={};let boundary;const pipes={};
 const started=performance.now();
 try {
  if(!scenario.coldStart){await context.resume();await wait(200);}
  for(const source of ['mic','system']) pipes[source]=await createAudioPipeline({
   context,stream:source==='mic'&&micStream?micStream:destination.stream,source,sessionId:id,epochIndex:0,renderOriginFrame:0,sourceGeneration:1,
   alignmentAtRenderFrame:alignment,onAck:sequence=>acks[source]=sequence,
   onMicrophoneBoundary:value=>boundary=value,onFailure:error=>failures.push({source,error:error.message})
  });
  await wait(1200);
  if(scenario.mute){
   for(const [sequence,muted] of [[1,true],[2,false]]){
    const gate=await setAudioPipelineGate(pipes.mic.processor,muted,sequence);
    await window.bench.invoke('intent',{sequence,sourceGeneration:1,manualMuted:muted,platformMuted:false,boundaryFrame:gate.ack.boundaryFrame,boundaryAlignment:gate.ack.boundaryAlignment});
    gate.commit();await wait(350);
   }
  }
  if(scenario.delayMs) await window.bench.invoke('delay',scenario.delayMs);
  if(scenario.stallMs){const until=performance.now()+scenario.stallMs;while(performance.now()<until){};}
  await wait(scenario.seconds ? Math.max(0,scenario.seconds*1000-1200) : (scenario.delayMs||0)+1200);
  for(const source of ['mic','system']){
   try {acks[source]=await flushAndDisconnectProcessor(pipes[source].processor);}
   catch(error){failures.push({source,error:error.message});}
  }
  const result=await window.bench.invoke('stop',{lastSequence:acks,microphoneBoundary:boundary,errorCode:failures.length?'capture-write-failed':null});
  return {scenario,failures,wallMs:performance.now()-started,maxPendingFrames,endToEndAckMs,...result};
 } finally {
  for(const pipe of Object.values(pipes)){pipe.source.disconnect();pipe.processor.disconnect();}
  micStream?.getTracks().forEach(track=>track.stop());oscillator.stop();destination.stream.getTracks().forEach(track=>track.stop());await context.close();
 }
};
window.bench.ready();
`);
fs.writeFileSync(path.join(temp, "preload.cjs"), `
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('electronAPI',{meetingTranscriptionSend:(...args)=>ipcRenderer.invoke('samples',...args)});
contextBridge.exposeInMainWorld('bench',{invoke:(...args)=>ipcRenderer.invoke(...args),ready:()=>ipcRenderer.send('ready')});
`);

await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === "string") throw new Error("No benchmark server address");
const url = `http://127.0.0.1:${address.port}/@fs${temp}/index.html`;
fs.writeFileSync(path.join(temp, "main.cjs"), `
const {app,BrowserWindow,ipcMain,powerSaveBlocker,systemPreferences}=require('electron');const fs=require('fs');const {spawn}=require('node:child_process');const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.dock?.hide();
const percentile=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.min(s.length-1,Math.ceil(s.length*p)-1)]:0};
app.whenReady().then(async()=>{
 if(${microphone}&&systemPreferences.getMediaAccessStatus('microphone')!=='granted')throw new Error('Electron microphone permission is not already granted; no permission request was sent');
 const {DatabaseManager}=require(${JSON.stringify(path.join(root, "dist-main/src/helpers/database.js"))});
 const {MeetingCaptureSession}=require(${JSON.stringify(path.join(root, "dist-main/src/helpers/meetingCaptureSession.js"))});
 const {MeetingRecordingStorage}=require(${JSON.stringify(path.join(root, "dist-main/src/helpers/meetingRecordingStorage.js"))});
 const {getFFmpegPath}=require(${JSON.stringify(path.join(root, 'dist-main/src/helpers/ffmpegUtils.js'))});
 const blocker=powerSaveBlocker.start('prevent-app-suspension');
 const db=new DatabaseManager();const storage=new MeetingRecordingStorage();
 let capture,holdUntil=0,frames,timings,metrics=[];const reports=[];
 ipcMain.handle('start',()=>{
  const note=db.saveNote('Synthetic runtime capture','','meeting').note;
  capture=MeetingCaptureSession.create(db,storage,note.id,null);frames={mic:0,system:0};timings=[];holdUntil=0;
  capture.setMonotonicOriginNs('1000000000');return capture.recordingId;
 });
 ipcMain.handle('delay',(_e,ms)=>{holdUntil=performance.now()+ms});
 ipcMain.handle('intent',(_e,intent)=>capture.setMicIntent(intent));
 ipcMain.handle('samples',async(_e,bytes,source,id,packet)=>{
  assert.equal(id,capture.recordingId);const arrival=performance.now();
  if(holdUntil>arrival)await new Promise(r=>setTimeout(r,holdUntil-arrival));
  const start=performance.now();capture.appendRendererSamples(source,packet,Buffer.from(bytes));
  timings.push({writeMs:performance.now()-start,ackMs:performance.now()-arrival});frames[source]+=bytes.byteLength/2;
  return {success:true,sequence:packet.sequence};
 });
 ipcMain.handle('stop',async(_e,input)=>{
  const result=await capture.stop(input);const epochs=db.listMeetingRecordingEpochs(capture.recordingId);
  const saved={mic:0,system:0};for(const epoch of epochs)saved[epoch.source]+=epoch.frameCount;
  assert.deepEqual(saved,frames,'Every accepted PCM frame must survive encoder finalization');
  for(const source of ['mic','system']){
   const epoch=epochs.filter(e=>e.source===source).sort((a,b)=>b.frameCount-a.frameCount)[0];assert.ok(epoch.frameCount>0);
   const decoded=await new Promise((resolve,reject)=>{
    const child=spawn(getFFmpegPath(),['-v','error','-i',storage.epochFilePath(capture.recordingId,source,epoch.epochIndex),'-f','s16le','-ar','24000','-ac','1','pipe:1']);
    let bytes=0,energy=0,tail=Buffer.alloc(0),stderr='';
    child.stdout.on('data',chunk=>{bytes+=chunk.length;const data=tail.length?Buffer.concat([tail,chunk]):chunk;const end=data.length-data.length%2;for(let i=0;i<end;i+=2)energy+=data.readInt16LE(i)**2;tail=data.subarray(end);});
    child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
    child.on('close',code=>code===0?resolve({frames:bytes/2,rms:Math.sqrt(energy/(bytes/2))}):reject(new Error('Decode failed: '+stderr)));
   });
   assert.equal(decoded.frames,epoch.frameCount,'Decoded Opus must have the exact accepted frame count');
   if(!${microphone}||source==='system')assert.ok(decoded.rms>100,'The synthetic tone must survive encoding');
  }
  return {result,frames,saved,epochs:epochs.map(e=>({source:e.source,epoch:e.epochIndex,state:e.state,frames:e.frameCount,startFrame:e.sourceStartFrame,error:e.errorCode})),writeMs:{median:percentile(timings.map(t=>t.writeMs),.5),p95:percentile(timings.map(t=>t.writeMs),.95),max:percentile(timings.map(t=>t.writeMs),1)},ackMs:{median:percentile(timings.map(t=>t.ackMs),.5),p95:percentile(timings.map(t=>t.ackMs),.95),max:percentile(timings.map(t=>t.ackMs),1)}};
 });
 const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.join(temp, "preload.cjs"))},sandbox:false,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')console.error(e.message)});
 const ready=new Promise(r=>ipcMain.once('ready',r));await win.loadURL(${JSON.stringify(url)});await ready;
 const startedAt=performance.now();
 const timer=setInterval(()=>metrics.push({elapsedMs:performance.now()-startedAt,processes:app.getAppMetrics().map(m=>({pid:m.pid,type:m.type,cpu:m.cpu.percentCPUUsage,memory:m.memory}))}),1000);
 const progress=setInterval(()=>console.log('CAPTURE_PROGRESS',JSON.stringify({seconds:Math.round((performance.now()-startedAt)/1000),frames,writeP95Ms:percentile(timings.slice(-600).map(t=>t.writeMs),.95),epochs:capture?db.db.prepare('SELECT COUNT(*) count FROM meeting_recording_epochs WHERE recording_id=?').get(capture.recordingId).count:0,memory:process.memoryUsage()})),30000);
 try {
  for(const scenario of ${microphone ? JSON.stringify([{name:'microphone-normal',coldStart:true}]) : soakSeconds ? JSON.stringify([{name:'soak',seconds:soakSeconds}]) : "[{name:'normal'},{name:'restart-mute',mute:true},{name:'ack-1s',delayMs:1000},{name:'ack-3s',delayMs:3000},{name:'ack-6s',delayMs:6000},{name:'renderer-1s',stallMs:1000},{name:'renderer-3s',stallMs:3000},{name:'renderer-6s',stallMs:6000}]"}){
   const report=await win.webContents.executeJavaScript('window.runScenario('+JSON.stringify(scenario)+')');reports.push(report);
   const ack=report.endToEndAckMs;report.endToEndAckMs={median:percentile(ack,.5),p95:percentile(ack,.95),max:percentile(ack,1)};
   console.log('CAPTURE_RUNTIME',JSON.stringify(report));
   if(scenario.seconds){for(const source of ['mic','system'])assert.ok(report.saved[source]>=scenario.seconds*24000*.999-2400,'Soak must retain wall-time audio within 0.1% clock drift and one startup packet');}
   if(${Boolean(ref)}){if(report.failures.some(f=>f.error.includes('out of order')))break;else continue;}
   if(Math.max(scenario.stallMs||0,scenario.delayMs||0)<5000){assert.deepEqual(report.failures,[]);assert.equal(report.result.captureState,'ready','A bounded startup clock gap must not mark normal capture incomplete');assert.equal(report.result.errorCode,null);}
   else assert.ok(report.failures.some(f=>f.error==='capture-queue-overflow'),'A renderer stall longer than the buffer must be detected');
  }
  if(${Boolean(ref)})assert.ok(reports.some(r=>r.failures.some(f=>f.error.includes('out of order'))),'Reference must reproduce packet ordering failure');
 } finally {clearInterval(timer);clearInterval(progress);powerSaveBlocker.stop(blocker);db.db.close();fs.writeFileSync(${JSON.stringify(path.join(temp, "report.json"))},JSON.stringify({reports,metrics},null,2));}
 console.log('REPORT',${JSON.stringify(path.join(temp, "report.json"))});win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(temp, "main.cjs")], { env, stdio: "inherit" });
  const timeout = setTimeout(() => child.kill(), (soakSeconds + 120) * 1000);
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Capture benchmark exited ${code}; profile: ${temp}`);
} finally { await server.close(); }
