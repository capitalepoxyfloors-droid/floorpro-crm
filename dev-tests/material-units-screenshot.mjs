/**
 * Before/after shots of the owner job-cost view. Local files only. No Supabase.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = '/opt/cursor/artifacts';
fs.mkdirSync(outDir, { recursive: true });

const files = {
  '/before.html': fs.readFileSync('/tmp/floorpro-before.html'),
  '/after.html': fs.readFileSync(path.join(root, 'index.html')),
};

const server = http.createServer((req, res) => {
  const file = files[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(file);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

function prepare() {
  document.getElementById('login-screen').style.display = 'none';
  localStorage.removeItem('fpRole');
  MATERIALS.splice(0, MATERIALS.length,
    { db_id: 'rs', name: 'Rapid Set 100', unit: '2 Gallon', price: '93.32' },
    { db_id: 'e15', name: 'Epoxy 15', unit: '15 Gallon', price: '700' },
    { db_id: 'stick', name: 'Wall Base', unit: '4-ft stick', price: '8' },
    { db_id: 'sand', name: 'Broadcast Sand', unit: 'Lbs', price: '2.50' }
  );
  const ds = '2026-11-18';
  JOB_RECORDS = [{
    id: 'wallace', customer: 'Wallace - Garage', status: 'in_progress', value: '2400',
    startDate: ds, endDate: ds, jobType: 'epoxy',
    dayLogs: { [ds]: { materialsUsed: [
      { matIdx: 0, name: 'Rapid Set 100', qty: '32', usageUnit: 'Oz', matId: 'rs', unitCost: 46.66 },
      { matIdx: 1, name: 'Epoxy 15', qty: '6', usageUnit: 'Gallon', matId: 'e15', unitCost: 0 },
      { matIdx: 2, name: 'Wall Base', qty: '22', usageUnit: 'LF', matId: 'stick' },
      { matIdx: 3, name: 'Broadcast Sand', qty: '16', usageUnit: 'Oz', matId: 'sand', unitCost: 2.5 },
    ], crewPresent: [], task: 'Garage floor', startTime: '7:00 AM', endTime: '3:00 PM' } },
  }];
  _jcId = 'wallace';
  openJobCard('wallace');
  renderJobCosting();
  // Phone width hides this tab on purpose. The shot still shows the costing
  // pane at that width so the material lines can be checked.
  const force = document.createElement('style');
  force.textContent = 'body:not(.crew-mode) #jc-tab-costing,body:not(.crew-mode) #jc-pane-costing{display:block !important;}';
  document.head.appendChild(force);
  document.getElementById('jc-pane-info').style.display = 'none';
  document.getElementById('jc-pane-log').style.display = 'none';
  document.getElementById('jc-pane-materials').style.display = 'none';
  document.getElementById('jc-tab-info').classList.remove('active');
  const costTab = document.getElementById('jc-tab-costing');
  costTab.classList.add('active');
  costTab.scrollIntoView({ inline: 'end', block: 'nearest' });
  const modal = document.querySelector('#modal-jobcard .modal');
  const label = [...document.querySelectorAll('#jc-costing-content *')].find(el => el.childNodes.length === 1 && el.textContent.trim() === 'Material Cost');
  if (label && modal) {
    const y = label.getBoundingClientRect().top - modal.getBoundingClientRect().top + modal.scrollTop;
    modal.scrollTop = Math.max(0, y - 12);
  }
}

async function shoot(which, name, viewport) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => {
    window.fetch = async () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  await page.goto(`http://127.0.0.1:${port}/${which}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  await page.evaluate(src => { window.eval(src); }, `(${prepare.toString()})()`);
  await page.waitForTimeout(200);
  const layout = await page.evaluate(() => {
    const pane = document.getElementById('jc-pane-costing');
    const modal = document.querySelector('#modal-jobcard .modal');
    const cs = getComputedStyle(pane);
    return { display: cs.display, h: pane.offsetHeight, scroll: modal ? modal.scrollTop : -1, modalH: modal ? modal.clientHeight : -1 };
  });
  console.log(which, name, layout);
  const text = await page.locator('#jc-costing-content').innerText();
  await page.screenshot({ path: path.join(outDir, name), fullPage: false });
  await page.close();
  const interesting = text.split('\n').filter(line => /Rapid|Epoxy|Wall|Sand|Material|Review|unit check|Total Materials/i.test(line));
  console.log('\n==', name, '==');
  console.log(interesting.join('\n'));
  if (errors.length) console.log('pageerrors', errors.slice(0, 4));
}

await shoot('before', 'before-cost-desktop.png', { width: 1280, height: 900 });
await shoot('after', 'after-cost-desktop.png', { width: 1280, height: 900 });
await shoot('before', 'before-cost-phone.png', { width: 390, height: 844 });
await shoot('after', 'after-cost-phone.png', { width: 390, height: 844 });

await browser.close();
server.close();
console.log('wrote screenshots to', outDir);
