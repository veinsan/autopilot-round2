# HR policy configuration v2

`policy_config.json` is the reviewed canonical seed for Round 1 and Round 2 HR
policy. Supabase `policy_config` is the legacy runtime-compatible EAV copy, while
`policy_versions.config_snapshot` is the governed source read by new and amended
Auto Operators. Airtable is not a source of truth.

## Contract

- `reason_codes` contains the complete engineering registry. Business policy may
  activate or tune rules but must not invent or rename codes.
- `as_of_date=null` means live time; a pinned ISO date is only for reproducible
  tests and demos.
- `demo_mode` chooses `retry_demo_profile`; production uses `retry`.
- Jurisdiction-aware thresholds require an explicit `default` and may add `MY`,
  `SG`, `AU`, `IN`, or `PH` overrides.
- Routing and templates may contain only non-sensitive destinations and copy.
  Never interpolate pulse comments, confidential payloads, or payroll details.

Round 2 editable thresholds are:

- `work_auth_expiry_at_risk_days` and `compliance_at_risk_days` for OP-05;
- `first_payroll_cutoff_days` for OP-06;
- `nudge_cadence_days`, `manager_acknowledgment_deadline_days`,
  `manager_action_deadline_days`, and `manager_max_reminders` for OP-07;
- `bottleneck_min_workers`, `bottleneck_min_percent`, and
  `minimum_cohort_size` for privacy-safe cohort insights.

Defaults are conservative demo values, not legal advice or an authoritative
payroll calendar. Review jurisdiction overrides before activation.

## Seed and activate

```powershell
python scripts/seed_loader/seed_policy_config.py
python scripts/seed_policy_version.py
```

The first command idempotently synchronizes the EAV compatibility table. The
second creates immutable `policy_round2_v1`; when an older policy is active it
creates a draft and never mutates or retires that active version.

Complete the lifecycle in Policy Studio with an authorized human identity:

1. simulate the draft;
2. approve it (confidential-routing changes require the additional confidential
   approver);
3. activate it as Admin.

Do not use development auth bypass to manufacture these approvals.
