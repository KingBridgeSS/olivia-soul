import test from 'node:test';import assert from 'node:assert/strict';
import { MediaEngine } from '../src/renderer/media';
import { FRAME_SAMPLES, MAX_VIDEO_FRAMES } from '../src/shared/video-limits';
async function harness(run:(engine:any,events:any[],credit:()=>number)=>Promise<void>){
  const originalWindow=(globalThis as any).window,originalBitmap=globalThis.createImageBitmap;
  const events:any[]=[];let credit=0;
  (globalThis as any).window={soul:{playback:(v:any)=>events.push(v)}};
  globalThis.createImageBitmap=(async()=>({close(){}})) as any;
  const canvas={hidden:true,getContext:()=>({drawImage(){}})},portrait={hidden:false};
  const engine:any=new MediaEngine(canvas as any,portrait as any,()=>{});
  engine.player={port:{postMessage:(m:any)=>{if(m.type==='credit')credit=Math.max(credit,m.samples)}}};
  engine.receive({type:'begin',call:'test',generation:1,video:true});
  try{await run(engine,events,()=>credit)}finally{engine.clear();(globalThis as any).window=originalWindow;globalThis.createImageBitmap=originalBitmap;}
}
const flush=()=>new Promise<void>(r=>setImmediate(r));
test('sustained server 3-chunk credit plus a whole in-flight chunk does not disable video',async()=>harness(async(e,events,credit)=>{
  let next=0,peak=0;
  for(let tick=0;tick<1000;tick++){
    e.samples=Math.min(e.samples+768,credit());e.draw();
    if(tick%9===0&&next*FRAME_SAMPLES<e.samples+72*FRAME_SAMPLES){for(let j=0;j<24;j++)e.receive({type:'frame',call:'test',generation:1,index:next++,data:new Uint8Array([1])});await flush();}
    peak=Math.max(peak,e.frames.length+e.decode.length);
  }
  assert.ok(peak>80,'exercise the old overflow threshold');assert.ok(peak<MAX_VIDEO_FRAMES);assert.ok(next>700);assert.equal(e.video,true);assert.equal(events.length,0);
}));
test('a peer exceeding the bounded video window still degrades and releases frames',async()=>harness(async(e,events)=>{
  for(let index=0;index<MAX_VIDEO_FRAMES+10;index++)e.receive({type:'frame',call:'test',generation:1,index,data:new Uint8Array([1])});await flush();
  assert.equal(e.video,false);assert.equal(e.frames.length,0);assert.equal(e.decode.length,0);assert.equal(events[0].reason,'queue-overflow');
}));
