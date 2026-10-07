import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import assert from 'node:assert/strict';
const port=19229,dir=path.resolve('.cache/portable-userdata');
async function main(){
  await new Promise<void>((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(()=>resolve()))});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.resolve(`release/Olivia-Soul-${JSON.parse(fs.readFileSync('package.json','utf8')).version}-win-x64.exe`),[`--user-data-dir=${dir}`,`--remote-debugging-port=${port}`,'--import-env',path.resolve('.env')],{env,windowsHide:true,stdio:'ignore'});
  try{
    const limit=Date.now()+60000;while(true){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(r.ok)break;}catch{}if(Date.now()>limit)throw Error('Portable launch timeout');await new Promise(r=>setTimeout(r,300));}
    const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try{
      const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('file:'))!;await page.waitForFunction(()=>!!(window as any).soul);
      const s=await page.evaluate(()=>(window as any).soul.state());assert.equal(s.connected,false);assert.equal(s.configured,true);assert.ok(s.preferences.dshBaseUrl);
      assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('main')!).backgroundColor),'rgb(255, 255, 255)');
      await page.screenshot({path:'test-results/portable-white.png',omitBackground:true});console.log('PORTABLE_EXE_EXTRACTION_AND_WHITE_UI_VERIFIED');
      // tsx preserves nested function names with this helper; provide it only in the CDP test context.
      await page.evaluate('globalThis.__name = (value) => value');
      const audio=await page.evaluate(async()=>{
        const context=new AudioContext({latencyHint:'interactive'});
        try{
          await context.audioWorklet.addModule(new URL('./audio-worklet.js',location.href));
          const player=new AudioWorkletNode(context,'soul-player',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
          const gain=context.createGain();gain.gain.value=0;player.connect(gain).connect(context.destination);
          const events:any[]=[];player.port.onmessage=e=>events.push(e.data);await context.resume();
          const wait=async(check:()=>boolean)=>{const deadline=performance.now()+10000;while(!check()){if(performance.now()>deadline)throw Error('Packaged audio worklet timeout');await new Promise(r=>setTimeout(r,20));}};
          const id={call:'portable-buffer-test',generation:1};
          player.port.postMessage({type:'begin',...id,video:true});
          for(let i=0;i<18;i++){const data=new Int16Array(24000*30).buffer;player.port.postMessage({type:'audio',...id,data},[data]);}
          await wait(()=>events.some(m=>m.written===24000*540));
          const full=events.find(m=>m.written===24000*540);
          if(full.samples!==0||full.buffered!==24000*540||events.some(m=>m.type==='overflow'))throw Error('540-second buffer was not accepted');
          const excess=new Int16Array(1).buffer;player.port.postMessage({type:'audio',...id,data:excess},[excess]);
          await wait(()=>events.some(m=>m.type==='overflow'));
          player.port.postMessage({type:'fallback',...id});
          await wait(()=>events.some(m=>m.type==='progress'&&m.samples>=2400));
          player.port.postMessage({type:'interrupt',...id});
          player.port.postMessage({type:'begin',call:id.call,generation:2,video:false});
          const next=new Int16Array(4800).buffer;
          player.port.postMessage({type:'audio',call:id.call,generation:2,data:next},[next]);
          player.port.postMessage({type:'end',call:id.call,generation:2});
          await wait(()=>events.some(m=>m.generation===2&&m.type==='ended'));
          const ended=events.find(m=>m.generation===2&&m.type==='ended');
          if(ended.samples!==4800||events.filter(m=>m.type==='overflow').length!==1)throw Error('Interrupt did not reset the audio buffer');
          return{bufferSeconds:full.buffered/24000,overflowProtected:true,actualPlaybackStarted:true,interruptAndNextReply:true};
        }finally{await context.close();}
      });
      console.log('PORTABLE_AUDIO_BUFFER_VERIFIED',JSON.stringify(audio));
      fs.writeFileSync('test-results/portable-audio-buffer.json',JSON.stringify(audio,null,2));
      // A test-only CDP command requests normal app shutdown. No task or call was started.
      const cdp=await browser.newBrowserCDPSession();await cdp.send('Browser.close').catch(()=>{});
    }finally{await browser.close().catch(()=>{});}
  }finally{
    if(child.exitCode===null&&child.pid){await new Promise(r=>setTimeout(r,1200));if(child.exitCode===null)execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
