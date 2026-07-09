# NetControl — Multi-Tenant (MSP) + Auto-Remediation Runbooks

Drop these files into your existing project at the matching paths (they
overwrite `middleware/auth.js`, `server.js`, `db/migrate.js`,
`routes/devices.js`, `routes/groups.js`, `routes/alerts.js` — everything
else is new). Then run:

```
node db/migrate.js
```

It's safe to run against your existing database — every step checks for
existence first and backfills a "Default Organization" containing all your
current devices/groups/schedules/alert rules/users, so nothing breaks or
disappears on upgrade.

## 1. Multi-tenant / MSP mode

**New tables:** `organizations`, `org_members`, plus a nullable `org_id`
column added to `devices`, `groups`, `schedules`, `alert_rules`, `audit_log`,
and `active_org_id` added to `users`.

**Model:** a user can belong to multiple orgs (`org_members`, with its own
`org_role` per org — an MSP tech can be `admin` on one client and `viewer`
on another). Exactly one org is "active" at a time (`users.active_org_id`),
and every tenant-scoped route filters by it via the new
`middleware/tenant.js` → `requireOrgContext`.

**New endpoints** (`routes/orgs.js`):
- `GET /api/orgs` — orgs the current user belongs to + which is active
- `POST /api/orgs` — create a new client org (creator becomes its admin)
- `POST /api/orgs/:id/switch` — the "switch client" dropdown action
- `GET /api/orgs/:id/usage` — device count vs. plan limit (billing dashboard groundwork)
- `GET/POST/DELETE /api/orgs/:id/members` — invite/remove techs from a client org
- `PUT /api/orgs/:id` — rename / change plan / device limit
- `DELETE /api/orgs/:id` — instance-admin only

**Applied to:** `devices.js` and `groups.js` fully (list/get/create/update/delete
all scoped by `org_id`, plus a device-limit check on create), and
`alerts.js` (alert rules scoped by org, including the evaluator so a
"global" rule never fires against another client's device).

**Still to extend the same pattern to** (same three-line change each time —
add `requireOrgContext` to the router's `.use()`, then filter/insert
`org_id = req.orgId` on each query): `schedules.js`, `backup.js`,
`discovery.js`, `compliance.js`, `processPolicies.js`, `filePush.js`,
`scheduledJobs.js`. None of these were touched yet, so they still show all
orgs' data until updated — don't ship multi-tenant to production until
that's done.

## 2. Auto-remediation runbooks (alert → action → notify)

**New tables:** `runbook_actions` (a named command like "restart nginx",
tied to `linux`/`windows`/`any`, with a timeout) and `runbook_run_log`
(every execution, success or failure, kept for audit).

**New endpoints** (`routes/runbooks.js`):
- `GET/POST/PUT/DELETE /api/runbooks` — manage runbooks
- `POST /api/runbooks/:id/test` — run one against a device right now, to
  validate it before wiring it into an alert rule
- `GET /api/runbooks/:id/history` — recent runs

**Wired into alerting:** `alert_rules` gained a `runbook_action_ids` column
(JSON array). When a rule breaches, `routes/alerts.js` →
`performAlertActions` now runs each referenced runbook against the
affected device via the existing SSH/WinRM services
(`services/runbookRunner.js`), logs the outcome, and folds a one-line
summary into the same webhook/notification the alert already sends — so a
Slack/Telegram message reads "CPU alert on web-01: 96% — runbook 'restart
nginx': ok" instead of just paging with no next step. Skipped for
`offline`-triggered rules for the same reachability reason the existing
wake/restart/shutdown actions already skip them.

**Example runbook you could create today:**
```json
POST /api/runbooks
{
  "name": "Restart nginx",
  "os_type": "linux",
  "command": "sudo systemctl restart nginx",
  "timeout_sec": 20
}
```
Then edit an alert rule to include this runbook's id in
`runbook_action_ids` — next time the CPU/RAM/disk rule breaches on a
matching device, it restarts nginx automatically and tells you it did.

## Suggested next steps
- Frontend: an org-switcher dropdown in the top nav calling
  `GET /api/orgs` + `POST /api/orgs/:id/switch`; a Runbooks page (list/
  create/test) similar to `ProcessPoliciesPage.jsx`; a "Runbooks" multi-select
  on the alert rule editor.
- Finish org-scoping the remaining routes listed above before treating this
  as production-ready multi-tenant.
- Consider per-org billing/Stripe hook off `GET /api/orgs/:id/usage`.
