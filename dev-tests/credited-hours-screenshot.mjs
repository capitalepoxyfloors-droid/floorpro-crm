/**
 * Local screenshots of the credited-hours control. Fake names only. No network.
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
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errors = [];
page.on('pageerror', err => errors.push(String(err)));
await page.addInitScript(() => {
  window.fetch = async () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(250);

const DAY = '2026-06-23';
await page.evaluate((DAY) => {
  document.getElementById('login-screen').style.display = 'none';
  const names = [['Avery', 'Avery Cole'], ['Blake', 'Blake Diaz'], ['Casey', 'Casey Ng'], ['Drew', 'Drew Patel'], ['Eden', 'Eden Brooks']];
  names.forEach(([first, full], i) => {
    if (!CREW_DATA[i]) return;
    CREW_DATA[i].name = first;
    CREW_DATA[i].full = full;
    CREW_DATA[i].hourly = '';
    if (CREW[i]) { CREW[i].name = first; CREW[i].full = full; }
  });
  localStorage.setItem('fpOfficeUser', 'Ops Reviewer');
  localStorage.removeItem('fpRole');
  const row = (idx, start, end) => ({ crewIdx: idx, name: CREW_DATA[idx].full, startTime: start, endTime: end });
  JOB_RECORDS.splice(0, JOB_RECORDS.length,
    {
      id: 'harbor', customer: 'Harbor Hall', status: 'in_progress', startDate: DAY, endDate: DAY, value: '',
      dayLogs: {
        [DAY]: {
          startTime: '9:00 AM', endTime: '3:10 PM',
          crewPresent: [row(0, '7:50 AM', '3:10 PM'), row(1, '9:00 AM', '3:10 PM'), row(2, '9:00 AM', '3:10 PM')],
          hourAdjustments: [{
            crewIdx: 0, name: 'Avery Cole', creditedTenths: 80,
            reason: 'Count the short clock as a full day',
            at: '2026-06-23T18:00:00.000Z', by: 'Ops Reviewer',
          }],
        },
      },
    },
    {
      id: 'ridge', customer: 'Ridge Hall', status: 'in_progress', startDate: DAY, endDate: DAY, value: '',
      dayLogs: {
        [DAY]: {
          startTime: '7:45 AM', endTime: '8:15 AM',
          crewPresent: [row(1, '7:45 AM', '8:15 AM'), row(2, '7:45 AM', '8:15 AM')],
          hourAdjustments: [
            {
              crewIdx: 1, name: 'Blake Diaz', creditedTenths: 18,
              reason: 'Bring the counted day to 8.0h',
              at: '2026-06-23T18:05:00.000Z', by: 'Ops Reviewer',
              balance: { dayTargetTenths: 80, otherJobsTenths: 62 },
            },
            {
              crewIdx: 2, name: 'Casey Ng', creditedTenths: 18,
              reason: 'Bring the counted day to 8.0h',
              at: '2026-06-23T18:05:00.000Z', by: 'Ops Reviewer',
              balance: { dayTargetTenths: 80, otherJobsTenths: 62 },
            },
          ],
        },
      },
    },
  );
  saveJobRecords = () => Promise.resolve(true);
}, DAY);

async function shoot(jobId, file, after) {
  await page.evaluate((jobId) => {
    _jcId = jobId;
    openModal('jobcard');
    jcTab('log');
    const name = document.getElementById('jc-name');
    if (name) name.textContent = getJobRecord(jobId).customer;
  }, jobId);
  if (after) await page.evaluate(after);
  await page.waitForTimeout(100);
  const logs = page.locator('#jc-day-logs');
  await logs.screenshot({ path: path.join(outDir, file) });
}

await shoot('harbor', 'credited-harbor-clock-vs-credit.png');
await shoot('ridge', 'credited-ridge-balance-and-exact-duration.png', () => {
  const input = document.getElementById('jccm-20260623-0');
  if (input) input.value = '1:50';
  jcPreviewMinuteCredit('2026-06-23', 0);
  const note = document.getElementById('jccn-20260623-0');
  if (note) note.scrollIntoView({ block: 'center' });
});

await browser.close();
server.close();
if (errors.length) {
  console.log('pageerrors', errors.slice(0, 5));
  process.exit(1);
}
console.log('wrote screenshots');
