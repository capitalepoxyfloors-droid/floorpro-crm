# Forward overhead rate $20.00

This is the production procedure. Do not run it until you mean to change the live rate. It is a data write on `public.settings`, not a schema migration. It does not rewrite `job_records`.

## Where the rate lives

There is no `$15.66` constant and no rates table. Overhead $/hr is computed:

`overheadPool / (active non-owner crew with a wage × paid hours per year × utilization)`

That formula and the saved history live in `index.html` (`overheadPerHour`, `costingSetFor`). The history is the `settings` row `key = 'costing_settings'`, JSON `{history: [...]}`. Entries are append-only. The one in effect on a work date is the latest whose `effective` is on or before that date.

Each day-log person keeps `overheadRate` and `rateVersion` once `directRate` or `burdenedRate` is set. A later rate set does not rewrite those fields. A day that has no stamp yet is filled from the set in effect on its work date.

The code seed, and the test project as of this note, use pool `$86,014`, 2,080 hours, 90% utilization, owner excluded. With Cody inactive that is `$15.32/hr`, not `$15.66`. The `$15.66` figure is whatever the live `costing_settings` row divides to. This script does not need that number. It sizes a new pool so the same divisor yields `$20.00`.

Owner cost (`ownerCostPerHour`, seed `$17.25`) is copied onto the new set and is not changed.

## What a monthly refresh is today

Nothing refreshes the overhead rate on a schedule, and nothing reads Wave expenses.

- Wave sync (`sync-wave-estimates.ps1` on the office PC, plus `wave_sync_request` / `wave_sync_status` / `wave_synced_estimates`) pulls accepted estimates onto the Jobs board. It does not read a profit-and-loss or an expense account.
- The Overhead page can store monthly line items. A monthly amount is multiplied by 12 (`overheadAnnualTotal`). That is a run-rate. Editing the list does not change the rate. The rate changes only when someone saves a new rate set (`csAddRateSet`).

## Prepared rolling-12 switch

`overheadRateFromRolling12(expenses, crewHours)` is `expenses / crewHours` for the same trailing 12 months. `overheadPoolForRolling12` turns that rate into the pool the existing stamp formula expects. Neither function calls Wave. To use it later, total the last 12 months of overhead from Wave by hand (or from a future export) and the crew hours in that window, then append a rate set whose pool is `overheadPoolForRolling12(...)`. Until that number is entered, the rate stays on the saved pool.

## Backup (run this first, production only when you are ready)

```sql
insert into public.settings (key, value, updated_at)
select 'costing_settings_backup_20261109_oh20', value, now()
from public.settings
where key = 'costing_settings'
on conflict (key) do update
  set value = excluded.value, updated_at = now();
```

Confirm the backup matches the live row before the update:

```sql
select
  (select value from public.settings where key = 'costing_settings')
    is not distinct from
  (select value from public.settings where key = 'costing_settings_backup_20261109_oh20')
    as backup_matches;
```

## Apply (appends one history entry; does not edit older entries or jobs)

```sql
begin;

-- Refuse to run twice.
do $$
begin
  if exists (
    select 1
    from public.settings s
    cross join lateral jsonb_array_elements(s.value::jsonb -> 'history') e
    where s.key = 'costing_settings'
      and e ->> 'id' = 'cs_20261109_oh20'
  ) then
    raise exception 'cs_20261109_oh20 is already in costing_settings';
  end if;
end $$;

with src as (
  select s.value::jsonb as doc
  from public.settings s
  where s.key = 'costing_settings'
),
ranked as (
  select e.value as entry, e.ord
  from src
  cross join lateral jsonb_array_elements(src.doc -> 'history') with ordinality as e(value, ord)
  where coalesce((e.value ->> 'paidHoursPerYear')::numeric, 0) > 0
    and coalesce((e.value ->> 'utilization')::numeric, 0) > 0
    and e.value ->> 'effective' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and e.value ->> 'effective' <= to_char(current_date, 'YYYY-MM-DD')
),
cur as (
  select entry
  from ranked
  order by entry ->> 'effective' desc, ord desc
  limit 1
),
inactive as (
  select coalesce(value::jsonb, '{}'::jsonb) as doc
  from public.settings
  where key = 'crew_inactive'
),
divisor as (
  select count(*)::numeric as n
  from public.crew c
  join public.crew_private p on p.crew_id = c.id
  where coalesce(private.fp_to_num(p.hourly), 0) > 0
    and not (
      coalesce((select (entry ->> 'excludeOwnerFromDivisor')::boolean from cur), true)
      and coalesce(p.is_owner, false)
    )
    and not (coalesce((select doc from inactive), '{}'::jsonb) ? c.sort_order::text)
),
built as (
  select
    cur.entry
      || jsonb_build_object(
        'id', 'cs_20261109_oh20',
        'effective', to_char(current_date, 'YYYY-MM-DD'),
        'overheadMode', 'pool',
        'overheadPool', round(20 * divisor.n * (cur.entry ->> 'paidHoursPerYear')::numeric * (cur.entry ->> 'utilization')::numeric, 2),
        'note', 'Forward overhead $20.00 per crew-hour. Older history entries and existing day-log stamps are unchanged.'
      ) as entry,
    divisor.n as crew_n
  from cur
  cross join divisor
  where divisor.n > 0
)
update public.settings s
set value = jsonb_set(
      s.value::jsonb,
      '{history}',
      (s.value::jsonb -> 'history') || jsonb_build_array(built.entry)
    )::text,
    updated_at = now()
from built
where s.key = 'costing_settings';

commit;
```

`private.fp_to_num` is the same helper the stamp trigger uses. If that function is not on the database you are reading, stop. Do not invent a different divisor.

## Check, without rewriting jobs

```sql
-- New set yields $20. The previous model set is unchanged.
with hist as (
  select e.value as entry
  from public.settings s
  cross join lateral jsonb_array_elements(s.value::jsonb -> 'history') e
  where s.key = 'costing_settings'
)
select entry ->> 'id' as id,
       entry ->> 'effective' as effective,
       entry ->> 'overheadPool' as pool,
       entry ->> 'ownerCostPerHour' as owner_cost
from hist
order by effective, id;

-- A person already stamped at $15.66 is returned unchanged.
-- A blank person on today's date is filled at $20.00. This SELECT does not save.
select
  private.fp_fill_labor_stamp(
    '{"crewIdx":0,"name":"Seth West","directRate":40.27,"overheadRate":15.66,"rateVersion":"cs_20261020","burdenedRate":"55.93"}'::jsonb,
    to_char(current_date, 'YYYY-MM-DD'),
    coalesce((select value::jsonb from public.settings where key = 'crew_history'), '{}'::jsonb),
    (select value::jsonb -> 'history' from public.settings where key = 'costing_settings'),
    coalesce((select value::jsonb from public.settings where key = 'crew_inactive'), '{}'::jsonb),
    coalesce((select value::jsonb -> 'items' from public.settings where key = 'overhead'), '[]'::jsonb)
  ) ->> 'overheadRate' as already_stamped_stays,
  private.fp_fill_labor_stamp(
    '{"crewIdx":0,"name":"Seth West"}'::jsonb,
    to_char(current_date, 'YYYY-MM-DD'),
    coalesce((select value::jsonb from public.settings where key = 'crew_history'), '{}'::jsonb),
    (select value::jsonb -> 'history' from public.settings where key = 'costing_settings'),
    coalesce((select value::jsonb from public.settings where key = 'crew_inactive'), '{}'::jsonb),
    coalesce((select value::jsonb -> 'items' from public.settings where key = 'overhead'), '[]'::jsonb)
  ) ->> 'overheadRate' as new_stamp;
```

`already_stamped_stays` must be `15.66`. `new_stamp` must be `20`.

## Restore

```sql
update public.settings live
set value = bak.value, updated_at = now()
from public.settings bak
where live.key = 'costing_settings'
  and bak.key = 'costing_settings_backup_20261109_oh20';
```
