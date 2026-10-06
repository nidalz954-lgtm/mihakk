import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.txt':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8','.wasm':'application/wasm','.ttf':'font/ttf'};
export const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; connect-src 'self' https://api.quranpedia.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
/** Demo build only (`npm run start:demo`): adds the ElevenLabs widget (pinned on unpkg), its blob: audio worklet and its API. */
export const DEMO_CSP = CSP
  .replace("script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net;", "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com/@elevenlabs/;")
  .replace("https://cdn.jsdelivr.net; object-src", "https://cdn.jsdelivr.net https://*.elevenlabs.io wss://*.elevenlabs.io; object-src");
export function createStaticHandler({root = publicPath, csp = CSP} = {}) {
  return async (request, response) => {
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy','same-origin');
    response.setHeader('Cache-Control','no-cache');
    // Microphone only for this origin: the on-page guide accepts spoken questions after a disclosure.
    response.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
    if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405, {'Allow':'GET, HEAD'}); response.end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname); }
    catch { response.writeHead(400); response.end('Invalid URL'); return; }
    if (pathname === '/health') { response.writeHead(200,{'Content-Type':'application/json'}); response.end(JSON.stringify({status:'ok',appId:'mihakk-browser-review',version,processing:'browser-local',bundledReligiousCorpus:false,bundledQuranText:{purpose:'display-only',source:'quranpedia.net mushaf 1 (Hafs, King Fahd Complex edition)',dumpVersion:'2026-10-06',file:'data/quran-hafs-quranpedia.json'},challengeBaselineDate:'2026-10-03'})); return; }
    if (pathname.startsWith('/api/')) { response.writeHead(410,{'Content-Type':'application/json'}); response.end(JSON.stringify({error:'Legacy private corpus endpoints are not deployed.'})); return; }
    const target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(resolve(root) + sep) || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) { response.writeHead(403); response.end('Forbidden'); return; }
    try {
      const bytes = await readFile(target);
      response.writeHead(200, {'Content-Type':types[extname(target)] ?? 'application/octet-stream'});
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404); response.end('Not found'); }
  };
}
