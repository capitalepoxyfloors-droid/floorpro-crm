# One job record — proposal only

No table changes in this round. This is the note for a later pass.

## What drifts

CrewBoard keeps the same job in two places.

- `public.jobs` is the Jobs board (the Wave / pipeline card). Office and the owner can read it. Crew cannot. A row has a status such as scheduled, in progress, complete, or invoiced.
- `settings.job_records` is one JSON blob. That is the schedule card: customer, dates, crew names, crew days, day logs, and the job value. The install schedule does not store a job id on the slot. It stores the customer name, and `SLOT_JOB_MAP` tries to remember which card that slot belongs to. That map can point at the wrong card, so the page checks the name before it trusts the id.

The page tries to keep the board and the card in step by matching the customer name, and by saving `boardRowId` on the card when it finds a match. That match is why the same customer has shown up twice on the board (the George Belchik case in the job-card code). A rename, a second phase with a similar name, or a save that lands before the other page has refreshed can leave the board and the schedule disagreeing. Messages already avoid this blob. They store the card id as plain text and do not point at `public.jobs`.

## How to unify

Give the schedule card its own table, `job_cards`, with one row per card id the page already uses. Columns that are not secret (customer, dates, status, address, scope, crew names) live on the row. Day logs, crew days, and materials stay in JSON on that row at first, so the screen code changes less. Pay stamps and the job value stay out of any column crew can select, the same way `crew_private` and `materials_private` work today.

`public.jobs` becomes a board pointer: `job_card_id` plus the board-only fields (invoiced, Wave ids). The board stops matching on the customer name. The schedule slot stores `job_card_id` instead of hoping the name map is right.

Crew still read and write through functions, not by selecting the whole row. Those functions keep stripping value, rates, and wage stamps.

## Migration risk

The blob is the live source of truth, and phones save it while the office has it open. A copy into a new table has to happen while nobody is saving, from a backup taken that same hour. The first release should read the new table and still write the blob, then switch writes once a day of use matches. Rolling back is dropping the new table and shipping the previous page, as long as the blob was still being written. Do this on the test project first, with a real job that has day logs and a board card, and check crew still cannot read the value or a wage.
