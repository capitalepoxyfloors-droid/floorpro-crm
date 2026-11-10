/**
 * Headless crew vs owner check. Local page only. Fetch is stubbed.
 * Confirms a crew session cannot see fake dollar amounts, cannot open costing,
 * and can see material requests. Owner still sees the jobs widget and costing.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = '/opt/cursor/artifacts';
fs.mkdirSync(outDir, { recursive: true });

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url !== '/' && url !== '/index.html') { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(root, 'index.html')));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const BANNED = ['$', '4821', '4,821', '19.41', '88.25', '77.13', '77.64'];
const failures = [];

function fail(msg) { failures.push(msg); console.error('FAIL', msg); }

const browserFetchStub = () => {
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rpc/')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('material_requests')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
};

async function boot(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  await page.addInitScript(browserFetchStub);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  return { page, errors };
}

async function seed(page, role) {
  await page.evaluate((role) => {
    document.getElementById('login-screen').style.display = 'none';
    localStorage.removeItem('fpCrewPreview');
    JOB_RECORDS.splice(0, JOB_RECORDS.length, {
      id: 'oak',
      customer: 'Oak Street Garage',
      status: 'in_progress',
      value: '4821.77',
      displayVal: '$4,821.77',
      startDate: '2026-11-02',
      endDate: '2026-11-02',
      phone: '314-555-0142',
      address: '10 Oak Street',
      supplierInvoices: [{ vendor: 'Acme Supply', invoiceNum: '100', amount: '88.25', description: 'Flake' }],
      commissions: [{ recipient: 'Office', amount: 10, type: 'flat' }],
      dayLogs: {
        '2026-11-02': {
          task: 'Coat the floor',
          materialsUsed: [{ name: 'Flake', qty: '4', usageUnit: 'Lbs', unitCost: 19.41, price: 77.13, amount: 77.64 }],
        },
      },
    });
    MATERIALS.splice(0, MATERIALS.length, { db_id: 'flake', name: 'Flake', unit: 'Lbs', price: '77.13', cat: 'Flake' });
    MATERIAL_REQUESTS.splice(0, MATERIAL_REQUESTS.length,
      { id: 'a', jobId: 'oak', jobName: 'Oak Street Garage', crewName: 'Seth West', submittedDate: '2026-11-08', material: 'Flake chips', qty: '2', unit: 'bag', status: 'pending', price: 77.13, unitCost: 19.41, amount: 88.25, notes: 'rush $40' },
      { id: 'b', jobId: '', jobName: 'General / Shop', crewName: 'Brendon Bennett', submittedDate: '2026-11-06', material: 'Urethane', qty: '1', unit: 'kit', status: 'ordered' },
      { id: 'c', jobId: 'oak', jobName: 'Oak Street Garage', crewName: 'Hunter Schuler', submittedDate: '2026-11-01', material: 'Quartz sand', qty: '3', unit: 'bag', status: 'received', orderedDate: '2026-11-03' },
      { id: 'd', jobId: 'oak', jobName: 'Oak Street Garage', crewName: 'Seth West', submittedDate: '2026-08-01', material: 'Old tape', qty: '1', unit: 'roll', status: 'received', orderedDate: '2026-08-02' },
      { id: 'e', jobId: '', jobName: 'General / Shop', crewName: 'Hunter Schuler', submittedDate: '2026-10-20', material: 'Topcoat $40 kit', qty: '1', unit: 'gal', status: 'pending' }
    );
    _matRequestsLoadOk = true;
    if (role === 'crew') {
      localStorage.setItem('fpRole', 'crew');
      localStorage.setItem('fpClockCrew', '0');
      localStorage.setItem('fpCvCrew', '0');
      document.body.classList.add('crew-mode');
      document.body.classList.remove('crew-preview');
      showPage('crewview');
      renderDashboard();
    } else {
      localStorage.removeItem('fpRole');
      localStorage.removeItem('fpClockCrew');
      document.body.classList.remove('crew-mode', 'crew-preview');
      showPage('dashboard');
      renderDashboard();
    }
  }, role);
}

function visibleMoney(text) {
  return BANNED.filter(bit => text.includes(bit));
}

async function crewPass(width, height, shotRequests, shotCosting) {
  const { page, errors } = await boot(width, height);
  await seed(page, 'crew');
  const calendar = await page.evaluate(() => document.body.innerText);
  const calHits = visibleMoney(calendar);
  if (calHits.length) fail(`crew ${width} calendar shows ${calHits.join(', ')}`);
  const hiddenJobs = await page.evaluate(() => ({
    jobsWidget: !!document.getElementById('dw-jobs'),
    grid: (document.getElementById('dash-grid') || {}).textContent || '',
    invoices: (document.getElementById('jc-invoice-list') || {}).textContent || '',
    costing: (document.getElementById('jc-costing-content') || {}).textContent || '',
  }));
  if (hiddenJobs.jobsWidget) fail(`crew ${width} built the dashboard jobs widget`);
  const hiddenHits = visibleMoney(hiddenJobs.grid + hiddenJobs.invoices + hiddenJobs.costing);
  if (hiddenHits.length) fail(`crew ${width} hidden money DOM has ${hiddenHits.join(', ')}`);

  await page.evaluate(() => openMatRequestModal());
  await page.waitForTimeout(100);
  const list = await page.evaluate(() => {
    const text = document.getElementById('mrq-existing-list').innerText;
    const visible = document.body.innerText;
    return { text, visible, open: document.getElementById('modal-matrequest').classList.contains('open') };
  });
  if (!list.open) fail(`crew ${width} request modal did not open`);
  for (const need of ['Flake chips', '2 bag', 'Seth West', 'Pending', 'Urethane', 'Brendon Bennett', 'Ordered', 'Quartz sand', 'Hunter Schuler', 'Received', 'Topcoat']) {
    if (!list.text.includes(need)) fail(`crew ${width} request list missing "${need}"`);
  }
  if (list.text.includes('Old tape')) fail(`crew ${width} request list showed an old received item`);
  if (list.text.includes('rush')) fail(`crew ${width} request list showed notes`);
  const listHits = visibleMoney(list.visible);
  if (listHits.length) fail(`crew ${width} request screen shows ${listHits.join(', ')}`);
  if (shotRequests) {
    await page.evaluate(() => document.getElementById('mrq-existing').scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(outDir, shotRequests), fullPage: false });
  }

  await page.evaluate(() => closeMatRequestModal());
  await page.evaluate(() => {
    openJobCard('oak');
    jcTab('costing');
    renderJobCosting();
    renderJobCostingPage();
  });
  await page.waitForTimeout(80);
  if (shotCosting) await page.screenshot({ path: path.join(outDir, shotCosting), fullPage: false });
  await page.evaluate(() => {
    const pane = document.getElementById('jc-pane-costing');
    if (pane) pane.style.display = 'block';
    const section = document.getElementById('jc-invoice-section');
    if (section) section.style.display = 'block';
    const matPane = document.getElementById('jc-pane-materials');
    if (matPane) matPane.style.display = 'block';
  });
  const forced = await page.evaluate(() => {
    const pane = document.getElementById('jc-pane-costing');
    const info = document.getElementById('jc-pane-info');
    return {
      visible: document.body.innerText,
      costing: (document.getElementById('jc-costing-content') || {}).textContent || '',
      invoices: (document.getElementById('jc-invoice-list') || {}).innerHTML || '',
      page: (document.getElementById('jc-cost-page-content') || {}).textContent || '',
      costingShown: pane && pane.style.display !== 'none' && (pane.innerText || '').trim().length > 0,
      infoActive: info && info.style.display !== 'none',
      valueShown: (document.getElementById('jc-value-group') || {}).style.display,
    };
  });
  if (forced.costingShown) fail(`crew ${width} costing pane rendered text`);
  if (!forced.infoActive) fail(`crew ${width} job card did not stay on Job Info`);
  if (forced.valueShown !== 'none') fail(`crew ${width} job value box was shown`);
  const forceHits = visibleMoney(forced.visible + forced.costing + forced.invoices + forced.page);
  if (forceHits.length) fail(`crew ${width} forced costing shows ${forceHits.join(', ')}`);
  if (forced.invoices.includes('88.25') || forced.invoices.includes('Acme')) fail(`crew ${width} invoice list was built`);
  if (errors.length) fail(`crew ${width} page errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

async function ownerPass() {
  const { page, errors } = await boot(1280, 800);
  await seed(page, 'owner');
  const dash = await page.evaluate(() => ({
    widget: !!document.getElementById('dw-jobs'),
    text: (document.getElementById('dw-jobs') || {}).innerText || '',
  }));
  if (!dash.widget) fail('owner dashboard did not build the jobs widget');
  if (!dash.text.includes('Oak Street Garage')) fail('owner jobs widget missing the job');
  if (!dash.text.includes('$') && !dash.text.includes('4,821')) fail('owner jobs widget missing the job amount');

  await page.evaluate(() => {
    openJobCard('oak');
    jcTab('costing');
  });
  await page.waitForTimeout(80);
  const cost = await page.evaluate(() => {
    const pane = document.getElementById('jc-pane-costing');
    return {
      shown: pane && pane.style.display !== 'none',
      text: (document.getElementById('jc-costing-content') || {}).innerText || '',
      invoices: (document.getElementById('jc-invoice-list') || {}).innerHTML || '',
    };
  });
  if (!cost.shown) fail('owner costing tab did not open');
  if (!cost.text.includes('$')) fail('owner costing tab did not show dollar amounts');
  if (!cost.invoices.includes('88.25')) fail('owner invoice list did not keep the amount');
  await page.screenshot({ path: path.join(outDir, 'owner-unchanged-1280.png'), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(50);
  const phone = await page.evaluate(() => {
    showPage('dashboard');
    return {
      widget: !!document.getElementById('dw-jobs'),
      text: (document.getElementById('dw-jobs') || {}).innerText || '',
    };
  });
  if (!phone.widget) fail('owner phone width dropped the jobs widget');
  if (!phone.text.includes('$') && !phone.text.includes('4,821')) fail('owner phone jobs widget missing the amount');
  if (errors.length) fail(`owner page errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

await crewPass(390, 844, 'crew-request-material-phone.png', 'crew-costing-blocked-phone.png');
await crewPass(1280, 800, null, null);
await ownerPass();

await browser.close();
server.close();

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('crew money gaps: crew phone, crew 1280, and owner passed');
