import {mkdir, copyFile, cp, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const {version} = JSON.parse(await readFile(`${root}/package.json`,'utf8'));
await mkdir(`${root}/public/modules`,{recursive:true});
for (const file of ['batch-engine.mjs','quran-index.mjs']) await copyFile(`${root}/src/${file}`,`${root}/public/modules/${file}`);
// A clean output: files deleted from public/ must not survive in dist/.
await rm(`${root}/dist`,{recursive:true,force:true});
const excluded = /^(?:\.|qa-tmp$)/;
await cp(`${root}/public`,`${root}/dist`,{recursive:true,filter:source=>!excluded.test(source.split(/[\\/]/).pop())});
const forbidden = /(?:private|source-corpus|evaluation-cases|sources\.json|\.env)/i;
// Credential-shaped strings; a match stops the build for human inspection.
const secretPatterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, /\bhf_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/];
const textFile = /\.(?:m?js|html|css|json|txt|csv|svg|md)$/i;
const manifest = [];
async function inspect(directory, prefix = '') {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (forbidden.test(entry.name)) throw new Error(`Forbidden public output: ${entry.name}`);
    const path = `${directory}/${entry.name}`, relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) { await inspect(path, `${relative}/`); continue; }
    const bytes = await readFile(path);
    if (textFile.test(entry.name)) {
      const text = bytes.toString('utf8');
      const hit = secretPatterns.find(pattern => pattern.test(text));
      if (hit) throw new Error(`Possible secret in ${relative} (${hit}).`);
    }
    manifest.push({path:relative, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')});
  }
}
await inspect(`${root}/dist`);
const html = await readFile(`${root}/dist/index.html`,'utf8');
if (html.match(/name="mihakk-version" content="([^"]+)"/)?.[1] !== version) throw new Error('HTML version differs from package.json');
if (!html.includes('مِحَكّ')) throw new Error('Mihakk identity missing from build.');
manifest.sort((a,b)=>a.path.localeCompare(b.path));
await writeFile(`${root}/dist/build-info.json`,JSON.stringify({version,builtAt:new Date().toISOString(),baseline:'2026-10-03',privateCorpusIncluded:false,processing:'browser-local',secretScan:'passed',files:manifest},null,2));
console.log(`Static browser-local build ${version} complete: ${manifest.length} files, clean dist, secret scan passed; private corpus excluded.`);
