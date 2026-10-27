# The source declaration owns every per-source fact

Every source has one declaration in code: priority, description, active/retired, historical-only, enumerable, trusted rate basis, schedule, freshness, and its editorial label, license and upstream. `source_priorities` rows are synced from those declarations after migrations run on web pod start. Migrations no longer insert or update per-source facts. Rows with no declaration are logged and left in place, never deleted.

Until 2026-10, tasks upserted their own row on every run (`active = EXCLUDED.active`), while migrations set flags and retired sources. The two writers disagreed: descriptions drifted (aomori-dam: "7 dams" in 0059, "11" in the task), and a retired source was kept inactive only because its task had been deleted. Keeping migrations as the owner was rejected: each per-source change would need a dated SQL file, and the facts would still be split from the schedule and the editorial text.
