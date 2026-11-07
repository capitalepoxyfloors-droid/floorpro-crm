/**
 * Build the test-only preview page from index.html.
 * The preview never contains the live project address. Query args cannot switch it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = 'cngbsmmdfxmerlqnkate';
const TEST = 'nndjnywtkgxwvxajwztg';

export function buildTestPreview(html) {
  const keyMatch = html.match(/const _fpTestKey = '([^']+)'/);
  if (!keyMatch) throw new Error('test anon key block not found');
  const block = html.match(/const _fpLiveUrl = [\s\S]*?document\.body\.insertBefore\(_fpTestBanner, document\.body\.firstChild\);\n\}/);
  if (!block) throw new Error('project switch block not found');
  const replacement = `const SUPABASE_URL = 'https://${TEST}.supabase.co';
const SUPABASE_KEY = '${keyMatch[1]}';
const _fpUseTest = true;
{
  const _fpEnvNote = document.getElementById('login-env');
  if (_fpEnvNote) { _fpEnvNote.style.display = 'block'; _fpEnvNote.textContent = 'Test project only'; }
  const _fpTestBanner = document.createElement('div');
  _fpTestBanner.id = 'fp-test-banner';
  _fpTestBanner.textContent = 'TEST PROJECT — floorpro-crm-test, not the live app';
  document.body.insertBefore(_fpTestBanner, document.body.firstChild);
}`;
  let out = html.replace(block[0], replacement);
  const authFrom = `function _pinAuthKey(){ return 'fpAuth_v2'; }`;
  const authTo = `function _pinAuthKey(){ return 'fpAuth_test_${TEST}'; }`;
  if (!out.includes(authFrom)) throw new Error('auth key not found');
  out = out.replace(authFrom, authTo);
  const guard = `<script>
(function(){
  var prefix='fpTestNnd:';
  var g=localStorage.getItem.bind(localStorage), s=localStorage.setItem.bind(localStorage), r=localStorage.removeItem.bind(localStorage);
  function map(k){ return (typeof k==='string' && k.indexOf('fp')===0) ? prefix+k : k; }
  localStorage.getItem=function(k){ return g(map(k)); };
  localStorage.setItem=function(k,v){ return s(map(k), v); };
  localStorage.removeItem=function(k){ return r(map(k)); };
  var ofetch=window.fetch.bind(window);
  window.fetch=function(input, init){
    var u=typeof input==='string'?input:(input&&input.url)||'';
    if(String(u).indexOf('${LIVE}')!==-1) return Promise.reject(new TypeError('Blocked live project from the test preview'));
    return ofetch(input, init);
  };
})();
</script>
`;
  if (!out.includes('<head>')) throw new Error('head not found');
  out = out.replace('<head>', '<head>\n' + guard);
  const outsideGuard = out.replace(guard, '');
  if (outsideGuard.includes(LIVE)) throw new Error('live project id still in the preview');
  if (!out.includes(TEST)) throw new Error('test project id missing');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const outDir = path.join(root, 'preview');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), buildTestPreview(html));
  fs.writeFileSync(path.join(outDir, 'README.md'), `# Test preview

This page is pinned to floorpro-crm-test (${TEST}). It does not contain the live project address. Sign-in storage is prefixed so it does not share a session with the live app.

Open preview/index.html from this branch. A query string cannot switch it to production.

Do not use the live GitHub Pages site for this build. That site publishes main only.
`);
}
