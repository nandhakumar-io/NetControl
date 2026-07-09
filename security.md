# Security Policy

NetControl gives whoever holds valid credentials the ability to run power
actions, open remote shells, and read credentials for every device it
manages. If you self-host an instance reachable from the internet, please
report vulnerabilities privately instead of filing a public GitHub issue.

## Reporting a Vulnerability

**Do not open a public issue for security reports.** Public issues are
scanned by bots and other attackers long before a maintainer can respond,
and a working exploit against a management tool like this one is
immediately dangerous to every other instance running the same code.

Instead, please report privately using one of these channels:

- **Preferred:** open a [GitHub Security Advisory](../../security/advisories/new)
  for this repository (Security tab → "Report a vulnerability"). This
  creates a private discussion thread visible only to you and the
  maintainers.
- **Alternative:** email the maintainer directly. If no dedicated security
  address is listed for this repository, use the address on the
  maintainer's GitHub profile and put `[SECURITY]` in the subject line.

Please include:

- A description of the vulnerability and its impact (what an attacker
  could do, and what access they'd need to start).
- Steps to reproduce, or a proof-of-concept if you have one.
- The affected version/commit.
- Whether you've found this on a public deployment (do not include another
  operator's real data, tokens, or credentials in the report).

### What to expect

- Acknowledgement within **5 business days**.
- An initial assessment (severity, affected versions) within **14 days**.
- Coordinated disclosure: we'll work with you on a fix timeline and credit
  you in the release notes/advisory, unless you'd prefer to stay anonymous.
- Please give us a reasonable window to ship a fix before any public
  disclosure. If a fix is taking unusually long, we'll tell you why.

## Scope

In scope:
- The backend API (`backend/`) — auth, session/token handling, the agent
  and API-key auth paths, credential storage/encryption (`services/crypto.js`),
  SSRF/path-traversal in device actions, backup/file-push handling, SQL
  injection, SSH/WinRM/relay handling.
- The frontend (`frontend/`) — XSS, CSRF, auth bypass, exposure of
  another user's data across accounts/roles.
- The Docker/Compose deployment as shipped in this repo (misconfigurations
  that are the *default*, not misconfigurations an operator introduced
  themselves, e.g. leaving `CORS_ORIGIN` pointed at `*` on purpose).

Out of scope:
- Vulnerabilities that require an attacker to already have `admin` access
  to a fully-trusted instance (admin is, by design, trusted with broad
  power — see the permission bit map in `middleware/auth.js`).
- Denial-of-service via raw traffic volume against a self-hosted instance
  with no rate limiting/reverse proxy in front of it — please still report
  gaps in NetControl's *own* rate limiting (see `middleware/rateLimiter.js`),
  just not "I can flood an unprotected box."
- Issues in third-party dependencies — please report those upstream; we'll
  track and update accordingly if you let us know.
- Social engineering, physical access to a managed device, or an operator
  choosing to run this with `NODE_ENV` unset in production.

## Supported Versions

This project does not yet publish numbered releases with a formal support
window. Security fixes are applied to the default branch; if you're
running a fork or an older commit, please update before reporting, if
practical, so we can confirm the issue still reproduces on current code.

## For self-hosters

If you're deploying NetControl for real use:

- Change `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `DB_PASSWORD`, and
  `ACTION_PIN_HASH` from any example/default values before going live —
  `server.js` will refuse to start if the required secrets are unset, but
  it can't tell a weak or copy-pasted-from-a-tutorial secret from a strong
  one.
- Run the first-run setup (`POST /api/auth/setup`, or the in-app setup
  wizard) to create your first admin account rather than relying on any
  bundled default credentials.
- Put a reverse proxy with TLS in front of both the frontend and backend;
  set `TRUST_PROXY_HOPS` to match your actual proxy chain (see the comment
  above `app.set('trust proxy', ...)` in `server.js`) or rate limiting will
  silently misbehave.
- Rotate agent keys and personal API keys (`/api/api-keys`) periodically,
  and revoke ones you no longer recognize.

Thank you for helping keep NetControl and the people who rely on it safe.
