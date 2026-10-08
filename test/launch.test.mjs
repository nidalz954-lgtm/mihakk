import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const root=fileURLToPath(new URL('../',import.meta.url));
function launch(port){const child=spawn(process.execPath,['launch.mjs'],{cwd:root,env:{...process.env,PORT:String(port),MIHAKK_NO_BROWSER:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);return{child,get output(){return output;}};}
async function waitFor(check,describe){const until=Date.now()+8000;while(Date.now()<until){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error(`Launcher readiness timed out: ${describe()}`);}
test('launcher skips an unrelated occupied port, serves this version and safely reuses it',async()=>{
 // Root cause of past flakiness: another Mihakk of the same version already listening within the launcher's
 // 20-port search window (a parallel test run or a local copy) is correctly "reused", so the launcher never starts.
 // Choose a base port whose window holds no Mihakk instance before starting.
 const mihakkAt=async p=>{try{return (await(await fetch(`http://127.0.0.1:${p}/health`,{signal:AbortSignal.timeout(300)})).json()).appId==='mihakk-browser-review';}catch{return false;}};
 let unrelated,port;
 for(let attempt=0;attempt<10;attempt++){
  unrelated=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',processing:'browser-local',version}));});await new Promise(resolve=>unrelated.listen(0,'127.0.0.1',resolve));
  port=unrelated.address().port;
  const busy=(await Promise.all(Array.from({length:20},(_,i)=>mihakkAt(port+1+i)))).some(Boolean);
  if(!busy&&port+20<=65535)break;
  await new Promise(resolve=>unrelated.close(resolve));unrelated=null;
 }
 assert.ok(unrelated,'no port window free of other Mihakk instances after 10 attempts');
 let started,reused;
 try{started=launch(port);const actual=Number(await waitFor(()=>started.output.match(/Mihakk [0-9.]+(?:-[0-9A-Za-z.-]+)?: http:\/\/127\.0\.0\.1:(\d+)/)?.[1],()=>`exit=${started.child.exitCode}; output=${started.output}`));assert.ok(actual>port&&actual<=port+20);const health=await(await fetch(`http://127.0.0.1:${actual}/health`)).json();assert.equal(health.appId,'mihakk-browser-review');assert.equal(health.version,version);assert.equal((await fetch(`http://127.0.0.1:${actual}/modules/revision-review.mjs`)).status,200);assert.equal((await fetch(`http://127.0.0.1:${actual}/assets/fonts/ReadexPro.ttf`)).headers.get('content-type'),'font/ttf');
  reused=launch(actual);const exit=await new Promise(resolve=>reused.child.once('exit',resolve));assert.equal(exit,0,reused.output);assert.match(reused.output,/already running/);assert.equal((await(await fetch(`http://127.0.0.1:${port}/health`)).json()).appId,undefined);
 }finally{started?.child.kill();reused?.child.kill();await new Promise(resolve=>unrelated.close(resolve));}
});
