// Experimental waveform oracle, independent of the native resampler implementation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const ffmpeg:string=require('ffmpeg-static');
const folder=process.argv[2];assert.ok(folder);
const repository=fs.realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
assert.ok(folder);
const relative=path.relative(repository,fs.realpathSync(folder));
assert.ok(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative),'private input/output directory must be outside repository');
import { compareWaveforms as compare } from './meeting-waveform-oracle.mts';
// Analytical half-sample shift: independent sine functions, not interpolation by this oracle.
const signal=(t:number)=>[700,2300,5100,9100].reduce((v,f)=>v+Math.sin(2*Math.PI*f*t/24000+f/1000),0)/4;
const x=Float32Array.from({length:1024},(_,i)=>signal(i-512));
const y=Float32Array.from({length:2048},(_,i)=>signal(i-1024-0.5));
const control=compare(x,y,1);assert.ok(control.fractional>0.99);
const damaged=y.slice();for(let i=0;i<1024;i++)damaged[i]=0;
const negative=compare(x,damaged,1);assert.ok(negative.fractional<0.8,'must detect missing half-window');
console.log('ORACLE_CONTROLS',JSON.stringify({control,negative}));
const input=JSON.parse(fs.readFileSync(path.join(folder,'input.json'),'utf8')) as {epochs:{copyPath:string;source:string}[]}[];
const results=[];
for(const part of [0,2])for(let index=0;index<2;index++){
 const e=input[part].epochs[index];const base=path.join(folder,`part-${part}-${index}`);
 const raw=base+'.check.raw';const out=base+'.check.out';
 try {
  execFileSync(ffmpeg,['-v','error','-y','-i',e.copyPath,'-ar','24000','-ac','1','-f','f32le',raw]);
  const rows=fs.readFileSync(base+'.map','utf8').trim().split('\n').map(l=>l.split(' ').map(Number));
  const extent=Math.max(...rows.map(r=>r[3]));
  execFileSync(path.join(folder,'resampler'),[raw,base+'.map',out,String(extent)]);
  const a=fs.openSync(raw,'r'),b=fs.openSync(out,'r');const windows=[];
  try {
   for(let i=0;i<rows.length;i+=Math.max(1,Math.floor(rows.length/80))){
    const [first,last,start,end]=rows[i];if(last-first<2048)continue;
    const center=Math.floor((first+last)/2),target=Math.round(start+(center-first)*(end-start)/(last-first));
    const xb=Buffer.alloc(4096),yb=Buffer.alloc(8192);
    assert.equal(fs.readSync(a,xb,0,xb.length,(center-512)*4),xb.length);
    assert.equal(fs.readSync(b,yb,0,yb.length,(target-1024)*4),yb.length);
    const xa=Float32Array.from({length:1024},(_,j)=>xb.readFloatLE(j*4));
    const ya=Float32Array.from({length:2048},(_,j)=>yb.readFloatLE(j*4));
    let energy=0;for(let j=256;j<768;j+=4)energy+=xa[j]**2;if(energy<1e-6)continue;
    windows.push({range:i,...compare(xa,ya,(end-start)/(last-first))});
   }
  } finally {fs.closeSync(a);fs.closeSync(b);}
  results.push({part,source:e.source,windows});
 }finally{for(const p of [raw,out])if(fs.existsSync(p))fs.unlinkSync(p);}
}
const result={control,negative,results};fs.writeFileSync(path.join(folder,'waveform-check.json'),JSON.stringify(result,null,2));
console.log('Private waveform check completed; detailed results remain in the external input directory.');
assert.ok(results.every(r=>r.windows.every(w=>w.fractional>0.8)),'fractional waveform check failed');
