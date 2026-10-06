import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile, readFile, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));

test('build removes stale output, writes a hashed manifest and the package version', async () => {
  await mkdir(`${root}/dist`, {recursive:true});
  await writeFile(`${root}/dist/stale-from-old-build.txt`, 'old');
  execFileSync(process.execPath, ['scripts/build.mjs'], {cwd:root, stdio:'pipe'});
  await assert.rejects(access(`${root}/dist/stale-from-old-build.txt`));
  const info = JSON.parse(await readFile(`${root}/dist/build-info.json`, 'utf8'));
  const {version} = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  assert.equal(info.version, version);
  assert.equal(info.secretScan, 'passed');
  assert.ok(info.files.some(file => file.path === 'index.html' && /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.ok(!info.files.some(file => file.path.startsWith('qa-tmp/') || file.path.split('/').some(part => part.startsWith('.'))));
});
