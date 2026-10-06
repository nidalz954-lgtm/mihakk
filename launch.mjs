import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createStaticHandler} from './src/static-app.mjs';
const {version}=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
if(nodeMajor<20||nodeMajor===20&&nodeMinor<12)throw new Error('Node.js 20.12 or newer is required for secure compressed XLSX import.');
const requested=Number(process.env.PORT||3200),first=Number.isInteger(requested)&&requested>0&&requested<=65535?requested:3200;
const open=url=>{if(process.env.MIHAKK_NO_BROWSER==='1')return;if(process.platform==='win32'){const child=spawn('cmd.exe',['/d','/c','start','',url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>process.stdout.write(`Open ${url}\n`));child.unref();}else process.stdout.write(`Open ${url}\n`);};
let started=false;
for(let port=first;port<=Math.min(first+20,65535);port++){
  const url=`http://127.0.0.1:${port}/`;
  try{const health=await(await fetch(`${url}health`,{signal:AbortSignal.timeout(800)})).json();if(health.appId==='mihakk-browser-review'&&health.version===version&&health.processing==='browser-local'){console.log(`Mihakk ${version} is already running: ${url}`);open(url);started=true;break;}}catch{/* Free port or another application. */}
  const server=createServer(createStaticHandler());
  const listening=await new Promise((resolve,reject)=>{const error=e=>{if(['EADDRINUSE','EACCES'].includes(e.code))resolve(false);else reject(e);};server.once('error',error);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',error);resolve(true);});});
  if(!listening)continue;
  server.requestTimeout=10000;server.headersTimeout=12000;server.keepAliveTimeout=5000;
  console.log(`Mihakk ${version}: ${url}\nKeep this window open. Ctrl+C stops this server.`);open(url);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
  started=true;break;
}
if(!started)throw new Error('No free local port found. Close your previous Mihakk window or set PORT to another free port.');
