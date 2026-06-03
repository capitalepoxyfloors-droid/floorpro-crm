# FloorPro CRM — Development Guidelines

## CRITICAL: Verification Required on Every Change

This is a production app used daily with live business data. **Every change must be verified before and after** to ensure no unintended side effects.

---

## Pre-Change Checklist (do before writing any code)

1. **Read the target function in full** — never edit from memory or grep snippets alone.
2. **Find all callers** — grep for the function name. Check every call site for signature/behavior compatibility.
3. **Identify shared state** touched by the change:
   - `newSlots[ci][w][d]` / `getSlot()` / `getNew()` — schedule slot store
   - `ptoSlots[ci][w][d]` — PTO blocks
   - `SLOT_JOB_MAP[jcSlotKey(ci,w,d)]` — slot→jobId map (can be stale; always label-verify)
   - `JOB_RECORDS` — all job data (saved as single JSON blob)
   - `CREW_DATA` / `CREW` — crew members
   - `BASE` / `getMonday(wOff)` — week offset anchoring
4. **List which rendered views could be affected** and note them — check them all after the change.

---

## Post-Change Checklist (do after every edit)

1. **Re-read the changed section** in full. Confirm intent matches implementation.
2. **Check every caller** identified in step 2 above still works.
3. **Run a cross-view impact check** (see table below).
4. **Sync both files**: `cp "FloorPro CRM.html" floorpro-crm/index.html`
5. **Push to GitHub Pages** and hard-refresh (Ctrl+Shift+R) after ~2 min.
6. **Take a screenshot** and compare visually to the expected result.

---

## Cross-View Impact Table

When you touch...                  | Also verify...
-----------------------------------|--------------------------------------------------
`buildWeekGrid`                    | Install schedule, **Dashboard schedule** (uses same fn)
`cvGetWeekSpanEvents` / `cvBuildWeek` | Crew view (all 4 weeks)
`renderJobCosting`                 | Job card Costing tab AND Job Costing summary page
`renderJobCostingPage`             | Job Costing summary page (standalone page)
`jcGetBurdenedRate`                | Both costing renderers above
`openSlotEdit`                     | Clicking any slot in install/sales schedule
`approvePtoRequest`                | Crew view PTO display, install schedule PTO display
`buildWeekGrid` PTO logic          | Crew view PTO display (separate renderer — check both)
`saveJobRecords` / `loadJobRecords`| Any tab that reads job data
`SLOT_JOB_MAP` writes              | All three click handlers that read the map
`getMonday` / `BASE` / week math   | All schedule views; use `Math.floor` not `Math.round`

---

## Known High-Risk Patterns

### SLOT_JOB_MAP can be stale
Always label-verify before trusting: confirm `jr.customer === slot.l` before using the mapped jobId. Fall back to `JOB_RECORDS.find(j=>j.customer===slot.l)`. This pattern is in three places: `buildWeekGrid`, `cvGetWeekSpanEvents`, `openSlotEdit`.

### Run algorithm in `buildWeekGrid` (Pass 1)
The `_runs` collection feeds `suppressedRunIdxs`, `mergedExtraSpans`, gradient logic (`fadeToNext`/`fadeFromPrev`), AND the `isDone` / color lookup. **Any change to what Pass 1 collects changes `startDay`**, which changes `SLOT_JOB_MAP` lookups, which changes bar colors. Never alter Pass 1 logic without verifying all downstream effects.

### `isExtra` flag
Affects whether a bar gets the `.extension` class (opacity 0.32) AND whether two adjacent runs form a gradient. Incorrect `isExtra` = wrong opacity or missing gradient.

### Math.floor vs Math.round for week offsets
`Math.floor((date - BASE) / weekMs)` is correct. `Math.round` shifts Fridays to the wrong week (4/7 = 0.571 rounds up). Every date→wOff conversion must use `Math.floor`.

### Single-file app — all functions share global scope
A rename or signature change to any function breaks every caller silently. Always grep for all usages before changing function signatures.

### Both files must stay in sync
- Source: `C:\Users\Will Bradford\Desktop\FloorPro CRM.html`
- Deploy: `C:\Users\Will Bradford\Desktop\floorpro-crm\index.html`
- Always copy after editing, always push after copying.

---

## Architecture Quick Reference

```
newSlots[ci][w][d]          — primary scheduled slot
multiSlots["ci_w_d"]        — extra (double-booked) slots
ptoSlots[ci][w][d]          — PTO blocks
SLOT_JOB_MAP["ci_w_d"]      — slot → jobId (can be stale)
JOB_RECORDS[]               — job data: dayLogs, extraDays, prevailingWage, etc.
job.dayLogs[dateStr]        — daily log: crewPresent, task, materialsUsed, startTime, endTime
crewPresent[i].burdenedRate — per-crew-per-day wage
BASE = getCurrentMonday()   — week-0 anchor, computed once at page load
```

## Deployment
- GitHub Pages: `https://capitalepoxyfloors-droid.github.io/floorpro-crm/`
- Deploy lag: ~2 minutes after `git push`
- Always hard-refresh after deploying: Ctrl+Shift+R
