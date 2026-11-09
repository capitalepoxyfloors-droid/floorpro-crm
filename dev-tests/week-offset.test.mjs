/**
 * Daylight-time Mondays must land on the schedule week the grid paints.
 * BASE is a local Monday midnight. Flooring (date - BASE) / (7*24h) is one hour
 * short across a CDT/CST boundary, so floor drops a whole week. These cases run
 * with TZ=America/Chicago regardless of the machine timezone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

if (process.env.TZ !== 'America/Chicago') {
  test('week offsets rerun with TZ=America/Chicago', { timeout: 180000 }, () => {
    const env = { ...process.env, TZ: 'America/Chicago' };
    // A nested `node --test` inherits this and skips the file as a recursive run.
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', here], {
      env,
      encoding: 'utf8',
    });
    const out = (r.stdout || '') + '\n' + (r.stderr || '');
    assert.equal(r.status, 0, out);
    assert.match(out, /BASE Monday Nov 9 2026/);
    assert.match(out, /BASE Monday Oct 26 2026/);
  });
} else {
  function installPinnedNow(window, localIso) {
    const RealDate = window.Date;
    const fixed = new RealDate(localIso);
    function PinnedDate(...args) {
      if (args.length === 0) return new RealDate(fixed.getTime());
      return new RealDate(...args);
    }
    PinnedDate.prototype = RealDate.prototype;
    PinnedDate.now = () => fixed.getTime();
    PinnedDate.parse = RealDate.parse.bind(RealDate);
    PinnedDate.UTC = RealDate.UTC.bind(RealDate);
    window.Date = PinnedDate;
  }

  function loadPage(fixedLocal) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    return new JSDOM(html, {
      url: 'http://127.0.0.1/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        installPinnedNow(window, fixedLocal);
        window.fetch = () => Promise.resolve(new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
        window.AbortController = AbortController;
        window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
        window.confirm = () => true;
      },
    });
  }

  function pos(w, iso) {
    return JSON.parse(w.eval(`JSON.stringify(seDateToPos(${JSON.stringify(iso)}))`));
  }
  function week(w, iso) {
    return w.eval(`weekOffsetOf(new Date(${JSON.stringify(iso)}+'T00:00:00'))`);
  }
  function baseIso(w) {
    return w.eval(`BASE.getFullYear()+'-'+String(BASE.getMonth()+1).padStart(2,'0')+'-'+String(BASE.getDate()).padStart(2,'0')`);
  }
  function slotIso(w, weekOff, dayIdx) {
    return w.eval(`(() => { const dt=seSlotToDate(${weekOff}, ${dayIdx}); return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0'); })()`);
  }

  test('schedule week math no longer floors raw millisecond weeks', () => {
    assert.match(html, /function weekOffsetOf\(d\)/);
    assert.match(html, /function calendarDaysBetween\(a,b\)/);
    assert.doesNotMatch(html, /Math\.floor\(\([^;\n]*BASE[^;\n]*\)\s*\/\s*\(7\*24\*60\*60\*1000\)\)/);
    assert.doesNotMatch(html, /BASE\.getTime\(\)\s*\+/);
    assert.doesNotMatch(html, /Math\.floor\(\(today-anchor\)\/86400000\)/);
    // These round to the nearest week and already survive a one-hour DST skew.
    assert.match(html, /Math\.round\(\(BASE - storedBase\)\/\(7\*24\*60\*60\*1000\)\)/);
    assert.match(html, /Math\.round\(\(startMon-BASE\)\/\(7\*24\*60\*60\*1000\)\)/);
    assert.match(html, /Math\.round\(\(mon-BASE\)\/\(7\*24\*60\*60\*1000\)\)/);
  });

  test('BASE Monday Nov 9 2026 (CST) maps daylight Mondays to the grid week', { timeout: 60000 }, () => {
    const dom = loadPage('2026-11-09T12:00:00');
    const w = dom.window;
    try {
      assert.equal(baseIso(w), '2026-11-09');
      assert.equal(w.eval('BASE.getTimezoneOffset()'), 360);
      assert.equal(w.eval('BASE.getDay()'), 1);

      // The old millisecond floor is one week early. The helper must not be.
      assert.equal(w.eval(`Math.floor((new Date('2026-10-26T00:00:00')-BASE)/(7*24*60*60*1000))`), -3);
      assert.equal(week(w, '2026-10-26'), -2);
      assert.deepEqual(pos(w, '2026-10-26'), { w: -2, d: 0 });
      assert.equal(w.eval(`cvDateToSlot(new Date('2026-10-26T00:00:00')).w`), -2);

      assert.equal(week(w, '2026-10-27'), -2);
      assert.deepEqual(pos(w, '2026-10-27'), { w: -2, d: 1 });
      assert.equal(week(w, '2026-10-19'), -3);
      assert.deepEqual(pos(w, '2026-10-19'), { w: -3, d: 0 });

      // Mar 9 is the Monday after the spring-forward. Millisecond floor piles it onto Mar 2.
      assert.equal(w.eval(`Math.floor((new Date('2026-03-09T00:00:00')-BASE)/(7*24*60*60*1000))`), -36);
      assert.equal(week(w, '2026-03-02'), -36);
      assert.equal(week(w, '2026-03-09'), -35);
      assert.deepEqual(pos(w, '2026-03-09'), { w: -35, d: 0 });

      assert.equal(week(w, '2027-03-15'), 18);
      assert.deepEqual(pos(w, '2027-03-15'), { w: 18, d: 0 });
      assert.equal(week(w, '2027-03-29'), 20);
      assert.deepEqual(pos(w, '2027-03-29'), { w: 20, d: 0 });
      assert.equal(week(w, '2027-04-05'), 21);
      assert.deepEqual(pos(w, '2027-04-05'), { w: 21, d: 0 });

      // Floor of days/7, not round: Friday (day 4) stays in its week, including a CDT Friday.
      assert.deepEqual(pos(w, '2026-11-13'), { w: 0, d: 4 });
      assert.deepEqual(pos(w, '2026-10-30'), { w: -2, d: 4 });

      for (const iso of ['2026-10-26', '2026-10-27', '2026-10-19', '2026-03-09', '2027-03-15', '2027-03-29', '2027-04-05', '2026-11-13', '2026-10-30']) {
        const p = pos(w, iso);
        assert.equal(slotIso(w, p.w, p.d), iso, iso);
        assert.equal(w.eval(`getMonday(${p.w}).getDay()`), 1);
      }

      // Payroll period length and a spring-forward span stay on calendar days.
      assert.equal(w.eval(`calendarDaysBetween(new Date('2026-06-21T00:00:00'), new Date('2026-11-09T00:00:00'))`), 141);
      assert.equal(w.eval(`calendarDaysBetween(new Date('2026-01-05T00:00:00'), new Date('2026-03-09T00:00:00'))`), 63);
      assert.equal(w.eval(`Math.floor((new Date('2026-03-09T00:00:00')-new Date('2026-01-05T00:00:00'))/86400000)`), 62);

      // Payroll PTO walks BASE with setDate. Week -2 day 0 is Oct 26, and the ISO date matches.
      assert.equal(w.eval(`(() => { const dt=new Date(BASE); dt.setDate(dt.getDate()+(-2)*7+0); return dt.toISOString().slice(0,10); })()`), '2026-10-26');
      assert.equal(slotIso(w, -2, 0), '2026-10-26');
    } finally {
      w.close();
    }
  });

  test('BASE Monday Oct 26 2026 (CDT) maps Nov 9 onto week 2', { timeout: 60000 }, () => {
    const dom = loadPage('2026-10-26T12:00:00');
    const w = dom.window;
    try {
      assert.equal(baseIso(w), '2026-10-26');
      assert.equal(w.eval('BASE.getTimezoneOffset()'), 300);
      assert.equal(week(w, '2026-11-09'), 2);
      assert.deepEqual(pos(w, '2026-11-09'), { w: 2, d: 0 });
      assert.equal(slotIso(w, 2, 0), '2026-11-09');
      assert.deepEqual(pos(w, '2026-10-26'), { w: 0, d: 0 });
      assert.deepEqual(pos(w, '2026-10-30'), { w: 0, d: 4 });
      // Search bound uses calendar weeks. Raw ceil is one week long when the span is 1h over.
      assert.equal(w.eval(`Math.ceil(calendarDaysBetween(BASE, new Date('2026-11-09T00:00:00'))/7)`), 2);
      assert.equal(w.eval(`Math.ceil((new Date('2026-11-09T00:00:00')-BASE)/(7*24*60*60*1000))`), 3);
    } finally {
      w.close();
    }
  });
}
