// Experimental only: copied real metadata, canonical alignment selection, candidate joins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { compareWaveforms } from './meeting-waveform-oracle.mts';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { alignedAudioRanges } from '../../src/helpers/meetingAudioAlignment.ts';
import type { MeetingRecordingEpochDto } from '../../src/contracts/meetingRecording.ts';
const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const folder = process.argv[2];
const repository=fs.realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
assert.ok(folder);
const relative=path.relative(repository,fs.realpathSync(folder));
assert.ok(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative),'private input/output directory must be outside repository');
assert.ok(folder && fs.existsSync(path.join(folder, 'input.json')));
const helper = path.join(folder,'resampler');
const flags=execFileSync('pkg-config',['--cflags','--libs','libswresample','libavutil'],{encoding:'utf8'}).trim().split(/\s+/);
execFileSync('clang',['-O2','-Wall','-Wextra','-Werror','test/benchmarks/meeting-resampler-joins.c',...flags,'-o',helper]);
const owned = new Set<ReturnType<typeof spawn>>();
function kill() { for(const c of owned) if(c.pid) try { process.kill(-c.pid,'SIGKILL'); } catch {} }
process.once('SIGINT',kill);process.once('SIGTERM',kill);
async function run(command:string,args:string[]) {
 const c=spawn(command,args,{detached:true,stdio:['ignore','pipe','pipe']});owned.add(c);
 let out='',err='';c.stdout.on('data',d=>out=(out+d).slice(-16000));c.stderr.on('data',d=>err=(err+d).slice(-16000));
 const timer=setTimeout(()=>{if(c.pid)try{process.kill(-c.pid,'SIGKILL')}catch{}},120000);
 try { await new Promise<void>((resolve,reject)=>{c.once('error',reject);c.once('close',code=>code===0?resolve():reject(new Error(err)));});return out; }
 finally {clearTimeout(timer);owned.delete(c);}
}
type Epoch=MeetingRecordingEpochDto & {copyPath:string;sha256:string};
type Row={first:number;last:number;start:number;end:number};
// Hypothesis, not a production rule: within an epoch accepted by the canonical selector,
// reconcile adjacent ranges only when their boundary uncertainty intervals overlap.
// Explicit discontinuities must be passed separately, never inferred solely from size.
function reconcile(rows:Row[], uncertainty:number[], breaks=new Set<number>()) {
 const result=rows.map(r=>({...r}));let joined=0;let maxCorrection=0;
 for(let i=1;i<rows.length;i++){
  const delta=rows[i].start-rows[i-1].end;
  if(!breaks.has(i) && Math.abs(delta)<=uncertainty[i-1]+uncertainty[i]) {
   assert.ok(rows[i].start>result[i-1].start,'nonmonotone anchor');
   result[i-1].end=rows[i].start;joined++;maxCorrection=Math.max(maxCorrection,Math.abs(delta));
  }
 }
 return {rows:result,joined,maxCorrection};
}
function correlate(input:string, output:string, map:string) {
 const rows=fs.readFileSync(map,'utf8').trim().split('\n').map(line=>line.split(' ').map(Number));
 const a=fs.openSync(input,'r'),b=fs.openSync(output,'r');let checked=0,quiet=0,minCorrelation=1,maxLag=0;const failures:Array<{range:number;correlation:number;lag:number;energy:number}>=[];
 try {for(let i=0;i<rows.length;i+=Math.max(1,Math.floor(rows.length/80))) {
  const [first,last,start,end]=rows[i];if(last-first<2048)continue;
  const center=Math.floor((first+last)/2),target=Math.round(start+(center-first)*(end-start)/(last-first));
  const x=Buffer.alloc(1024*4),y=Buffer.alloc(2048*4);
  assert.equal(fs.readSync(a,x,0,x.length,(center-512)*4),x.length);
  assert.equal(fs.readSync(b,y,0,y.length,(target-1024)*4),y.length);
  let energy=0;for(let j=256;j<768;j+=4)energy+=x.readFloatLE(j*4)**2;
  if(energy<1e-6){quiet++;continue;}
  const xa=Float32Array.from({length:1024},(_,j)=>x.readFloatLE(j*4));
  const ya=Float32Array.from({length:2048},(_,j)=>y.readFloatLE(j*4));
  const measured=compareWaveforms(xa,ya,(end-start)/(last-first));
  const best=measured.fractional,lagBest=measured.lag;
  if(!(best>0.8))failures.push({range:i,correlation:best,lag:lagBest,energy});checked++;minCorrelation=Math.min(minCorrelation,best);maxLag=Math.max(maxLag,Math.abs(lagBest));
 }} finally{fs.closeSync(a);fs.closeSync(b);}
 return {checked,quiet,minCorrelation,maxLagFrames:maxLag,passed:failures.length===0,failures};
}
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const input=JSON.parse(fs.readFileSync(path.join(folder,'input.json'),'utf8')) as {epochs:Epoch[]}[];
const report:unknown[]=[];
try {
 // Independent truth: unit-rate input with one explicit 2-sample gap, and a
 // no-gap generation boundary. Calibration noise must not remove either event.
 const rows:Row[]=[], truth:number[]=[], breaks=new Set([10,20]);
 const frames=30*96000;const raw=Buffer.alloc(frames*4);
 for(let i=0;i<30;i++) {
  const offset=i>=10?2:0;
  const jitter=[0,9,10,19,20,29].includes(i)?0:[-50,-1,1,50][i%4];
  rows.push({first:i*96000,last:(i+1)*96000,start:i*96000+offset+jitter+100,end:(i+1)*96000+offset+jitter+100});
  truth.push(i*96000+48000+offset+100);
  for(let j=0;j<96000;j++) {
   const n=i*96000+j;const d=j-48000;
   raw.writeFloatLE(0.015*Math.sin(2*Math.PI*317*n/24000)+0.65*Math.exp(-0.5*(d/48)**2)*Math.cos(2*Math.PI*1700*d/24000),n*4);
  }
 }
 const smooth=reconcile(rows,rows.map(()=>50),breaks);
 const base=path.join(folder,'synthetic');fs.writeFileSync(base+'.raw',raw);
 fs.writeFileSync(base+'.map',smooth.rows.map((r,i)=>`${r.first} ${r.last} ${r.start} ${r.end} ${breaks.has(i)?1:0}`).join('\n')+'\n');
 const usage=JSON.parse(await run(helper,[base+'.raw',base+'.map',base+'.out',String(frames+202)]));
 assert.equal(usage.continuousRuns,3,'preserve true gap and generation reset');
 const rendered=fs.readFileSync(base+'.out');let maxMarkerError=0;
 for(const center of truth) {
  let best=-1,at=0;
  for(let lag=-96;lag<=96;lag++) {
   let energy=0;for(let j=-24;j<=24;j++)energy+=rendered.readFloatLE((center+lag+j)*4)**2;
   if(energy>best){best=energy;at=lag;}
  }
  assert.ok(best>1);maxMarkerError=Math.max(maxMarkerError,Math.abs(at));
 }
 assert.ok(maxMarkerError<=60,'jitter output departs from independent truth');
 assert.equal(rendered.readFloatLE((960000+100)*4),0);
 assert.equal(rendered.readFloatLE((960000+101)*4),0);
 let maxStep=0;
 for(let i=1;i<rows.length;i++)if(!breaks.has(i))for(let j=-64;j<64;j++) {
  const n=smooth.rows[i].start+j;maxStep=Math.max(maxStep,Math.abs(rendered.readFloatLE(n*4)-rendered.readFloatLE((n-1)*4)));
 }
 assert.ok(maxStep<0.02,'artificial step at smoothed boundary');
 report.push({synthetic:true,maxMarkerErrorFrames:maxMarkerError,maxBoundaryStep:maxStep,trueTwoSampleGapPreserved:true,noGapGenerationReset:true,usage});
 for(let part=0;part<input.length;part++) {
  const prepared:Array<{e:Epoch;base:string;extent:number;statistics:{part:number;index:number;source:string;ranges:number;nonzeroJoins:number;minJoin:number;maxJoin:number;joined:number;maxCorrection:number}}>=[];
  for(const [index,e] of input[part].epochs.entries()) {
   let ranges;try{ranges=alignedAudioRanges(e);}catch(error){report.push({part,index,source:e.source,status:'alignment-rejected',error:String(error)});continue;}
   const rows=ranges.map(r=>({first:r.fileStartFrame,last:r.fileStartFrame+r.frameCount,start:r.timelineStartFrame,end:r.timelineStartFrame+Math.round(r.frameCount*r.rate)}));
   // Recover uncertainty only from eligible segments which reproduce the selected range.
   const uncertainty=ranges.map(r=>{
    if(e.timelineStartFrame!==null && (e.sourceGeneration===null || !e.alignmentSegments.length))return 0;
    const cursor=e.sourceStartFrame!+r.fileStartFrame;
    const matches=e.alignmentSegments.filter(s=>s.sourceGeneration===e.sourceGeneration && s.uncertaintyStartFrames<=600 && s.uncertaintyEndFrames<=600 && BigInt(s.freshnessSourceNs)>=BigInt(s.sampledSourceEndNs) && BigInt(s.freshnessSourceNs)-BigInt(s.sampledSourceEndNs)<=5000000000n && BigInt(s.sourceStartNs)>=BigInt(s.sampledSourceStartNs)-5000000000n && BigInt(s.sourceEndNs)<=BigInt(s.sampledSourceEndNs)+5000000000n && s.sourceStartFrame<=cursor && s.sourceEndFrame>=cursor+r.frameCount && s.rate===r.rate && s.timelineStartFrame+Math.round((cursor-s.sourceStartFrame)*s.rate)===r.timelineStartFrame);
    assert.ok(matches.length,'selected segment provenance missing');
    return Math.min(...matches.map(s=>Math.min(s.uncertaintyStartFrames,s.uncertaintyEndFrames)));
   });
   const candidate=reconcile(rows,uncertainty);
   report.push({part,index,source:e.source,status:'mapped',joined:candidate.joined,ranges:rows.length});
   const mismatches=rows.slice(1).map((r,i)=>r.start-rows[i].end);
   const base=path.join(folder,`part-${part}-${index}`);
   fs.writeFileSync(base+'.map',candidate.rows.map(r=>`${r.first} ${r.last} ${r.start} ${r.end} 0`).join('\n')+'\n');
   prepared.push({e,base,extent:Math.max(...candidate.rows.map(r=>r.end)),statistics:{part,index,source:e.source,ranges:rows.length,nonzeroJoins:mismatches.filter(Boolean).length,minJoin:Math.min(0,...mismatches),maxJoin:Math.max(0,...mismatches),joined:candidate.joined,maxCorrection:candidate.maxCorrection}});
  }
  // A partial part must not be represented as a successfully prepared meeting.
  if(prepared.length!==input[part].epochs.length){report.push({part,status:'part-blocked'});continue;}
  let referenceHashes:string[]|undefined;
  for(const mode of ['sequential','parallel']) {
   const started=performance.now();
   const decode=async (p:typeof prepared[number])=>run(ffmpeg,['-v','error','-y','-i',p.e.copyPath,'-ar','24000','-ac','1','-f','f32le',p.base+'.raw']);
   if(mode==='parallel') {
    const settled=await Promise.allSettled(prepared.map(p=>decode(p).catch(e=>{kill();throw e;})));
    for(const r of settled)if(r.status==='rejected')throw r.reason;
   } else for(const p of prepared)await decode(p);
   const decodeMs=performance.now()-started;
   const outputs=[];
   for(const p of prepared){
    const usage=JSON.parse(await run(helper,[p.base+'.raw',p.base+'.map',p.base+'.out',String(p.extent)]));
    assert.equal(hash(p.e.copyPath),p.e.sha256);
    outputs.push({...p.statistics,usage,correlation:correlate(p.base+'.raw',p.base+'.out',p.base+'.map'),hash:hash(p.base+'.out')});
   }
   const extent=Math.max(...prepared.map(p=>p.extent));
   const wav=path.join(folder,`part-${part}.wav`);
   await run(ffmpeg,['-v','error','-y',...prepared.flatMap(p=>['-f','f32le','-ar','24000','-ac','1','-i',p.base+'.out']),'-filter_complex',`[0:a]apad=whole_len=${extent},atrim=end_sample=${extent}[a];[1:a]apad=whole_len=${extent},atrim=end_sample=${extent}[b];[a][b]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[out]`,'-map','[out]','-c:a','pcm_s16le',wav]);
   const hashes=outputs.map(o=>o.hash);if(referenceHashes)assert.deepEqual(hashes,referenceHashes);else referenceHashes=hashes;
   report.push({part,mode,decodeMs,wallMs:performance.now()-started,outputs,wavBytes:fs.statSync(wav).size});
   fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
   for(const p of prepared)fs.rmSync(p.base+'.raw');
  }
 }
}finally{kill();fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));process.removeListener('SIGINT',kill);process.removeListener('SIGTERM',kill);}
console.log('Private experiment completed; detailed results remain in the external input directory.');
assert.ok(report.every((entry)=>{ const r=entry as {outputs?:Array<{correlation:{passed:boolean}}>}; return !r.outputs || r.outputs.every(o=>o.correlation.passed); }), 'real-audio waveform check failed');
