/**
 * Local screenshots only. Uses the system Chrome and never calls Supabase.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = '/opt/cursor/artifacts/screenshots';
fs.mkdirSync(outDir, { recursive: true });

const files = {
  '/after.html': fs.readFileSync(path.join(root, 'index.html')),
  '/before.html': fs.readFileSync('/tmp/floorpro-before.html'),
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

async function shoot(which, name, prepare) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.fetch = async () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  await page.goto(`http://127.0.0.1:${port}/${which}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  if (prepare) await page.evaluate(src => { window.eval(src); }, `(${prepare.toString()})()`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, name), fullPage: false });
  await page.close();
  if (errors.length) console.log(which, name, 'pageerrors', errors.slice(0, 3));
}

const hideLogin = () => { document.getElementById('login-screen').style.display = 'none'; };

await shoot('before', 'before-crew.png', () => {
  document.getElementById('login-screen').style.display = 'none';
  showPage('installers');
});
await shoot('after', 'after-crew.png', () => {
  document.getElementById('login-screen').style.display = 'none';
  showPage('installers');
});
await shoot('after', 'after-login.png', () => {});

await shoot('after', 'after-pipeline.png', () => {
  document.getElementById('login-screen').style.display = 'none';
  LEADS = [{ name: 'Pat Example', phone: '314-555-0100', phone2: '314-555-0199', stage: 'new', jobType: 'Epoxy Flake', custType: 'Residential', value: '5000', address: '1 Main St, St. Louis', db_id: 1, detail: '', date: 'Added Jun 1' }];
  showPage('pipeline');
  renderPipeline();
});

await shoot('after', 'after-schedule.png', () => {
  document.getElementById('login-screen').style.display = 'none';
  showPage('schedule');
  renderSchedule();
});

const costPrep = () => {
  document.getElementById('login-screen').style.display = 'none';
  CREW_DATA[0].hourly = '20';
  const mi = MATERIALS.findIndex(m => m && m.name);
  const mat = MATERIALS[mi] || (MATERIALS[0] = { name: 'Polyurea', unit: '2 Gallon', price: '50', db_id: 7 });
  mat.name = mat.name || 'Polyurea';
  mat.unit = '2 Gallon';
  mat.price = '50';
  const idx = MATERIALS.indexOf(mat);
  const job = {
    id: 'cost1', customer: 'Split Shift Shop', status: 'complete', value: '2000',
    startDate: '2026-06-23', endDate: '2026-06-23', consumablesPct: 10, jobType: 'epoxy',
    dayLogs: {
      '2026-06-23': {
        fullDay: false,
        crewPresent: [
          { name: 'Seth West', crewIdx: 0, startTime: '8:00 AM', endTime: '12:00 PM' },
          { name: 'Seth West', crewIdx: 0, startTime: '1:00 PM', endTime: '4:00 PM' },
        ],
        materialsUsed: [{ matIdx: idx, name: mat.name, qty: '4', usageUnit: 'Gallon', matId: mat.db_id, unitCost: 25 }],
      },
    },
  };
  JOB_RECORDS = [job];
  _jcId = 'cost1';
  mat.price = '80';
  showPage('jobcosting');
  if (document.getElementById('jc-cost-page-content')) renderJobCostingPage();
  openJobCard('cost1');
  jcTab('costing');
  renderJobCosting();
  const box = document.getElementById('jc-costing-content');
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.textContent.includes('hrs total')) { n.parentElement.scrollIntoView({ block: 'start' }); break; }
  }
};

await shoot('before', 'before-costing.png', costPrep);
await shoot('after', 'after-costing.png', costPrep);

const payPrep = () => {
  document.getElementById('login-screen').style.display = 'none';
  CREW_DATA[0].hourly = '20';
  JOB_RECORDS = [{
    id: 'pay1', customer: 'Weekend Overtime Shop', status: 'complete', value: '1000',
    startDate: '2026-06-23', endDate: '2026-06-23',
    dayLogs: {
      '2026-06-23': {
        fullDay: false,
        crewPresent: [
          { name: 'Seth West', crewIdx: 0, startTime: '8:00 AM', endTime: '12:00 PM' },
          { name: 'Seth West', crewIdx: 0, startTime: '1:00 PM', endTime: '4:00 PM' },
        ],
        materialsUsed: [],
      },
    },
  }];
  _payrollPeriodOffset = 0;
  showPage('payroll');
  renderPayroll();
};
await shoot('before', 'before-payroll.png', payPrep);
await shoot('after', 'after-payroll.png', payPrep);

await browser.close();
server.close();
console.log('screenshots in', outDir);
