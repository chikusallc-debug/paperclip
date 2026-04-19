---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Paperclip supports two runtime modes with different security profiles. Reachability is configured separately with `bind`.

## `local_trusted`

The default mode. Optimized for single-operator local use.

- **Host binding**: loopback only (localhost)
- **Bind**: `loopback`
- **Authentication**: no login required
- **Use case**: local development, solo experimentation
- **Board identity**: auto-created local board user

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN).

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required
- **Bind**: choose `loopback`, `lan`, `tailnet`, or `custom`

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor
- **Bind**: usually `loopback` behind a reverse proxy; `lan/custom` is advanced

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, Paperclip emits a one-time claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin
- Ensures active company membership for the claiming user

## Changing Modes

Update the deployment mode:

```sh
pnpm paperclipai configure --section server
```

Runtime override via environment variable:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```

## Runtime Readiness Probes

Paperclip exposes three HTTP probes so monitors, reverse proxies, and
orchestrators can distinguish "process is up" from "deployment is usable".

| Path | Purpose | DB probe | Expected codes |
|------|---------|----------|----------------|
| `/api/health/live` | Liveness probe (always cheap) | no | `200` |
| `/api/health`      | Overall health + bootstrap status | yes | `200`, `503` |
| `/api/health/ready` | Deployment readiness snapshot | yes | `200`, `503` |

`/api/health/ready` runs the same class of checks as `paperclipai doctor`, but
from the *running* server's perspective:

- database reachable
- auth runtime initialized (in `authenticated` mode)
- `BETTER_AUTH_SECRET` present, not a known dev default, sufficient length
- secrets provider usable (for `local_encrypted`: key file present with mode
  `0600` on POSIX, or key supplied via `PAPERCLIP_SECRETS_MASTER_KEY`)
- storage provider writable (for `local_disk`) or bucket set (for `s3`)
- bind host is consistent with deployment mode (loopback for `local_trusted`,
  warn on `0.0.0.0` without reverse proxy for `authenticated/public`)
- backup directory writable when automatic backups are enabled
- publicBaseUrl present, `https://`, and allowed for `authenticated/public`

The response shape:

```json
{
  "overall": "ready" | "degraded" | "not_ready",
  "checkedAt": "2026-04-19T18:50:00.000Z",
  "version": "...",
  "checks": [
    { "name": "database",   "status": "pass", "message": "Database reachable" },
    { "name": "auth_secret","status": "pass", "message": "BETTER_AUTH_SECRET present with adequate length" },
    { "name": "storage",    "status": "pass", "message": "local_disk storage is writable (/paperclip/storage)",
      "details": { "baseDir": "/paperclip/storage" } }
  ]
}
```

HTTP status:

- `overall: "ready"` or `"degraded"` → `200`
- `overall: "not_ready"` → `503`

In `authenticated` mode, anonymous callers receive the same structural
response but with `details` omitted and passing-check messages compressed to
`"ok"`, so monitoring can still read the overall status without leaking paths
or hostnames. Authenticated board/agent actors receive the full report.

### Startup preflight

The same readiness report is logged at startup. Set
`PAPERCLIP_STRICT_STARTUP_CHECKS=true` to refuse to boot when any check is a
hard fail. This is recommended for production `authenticated/public`
deployments so misconfiguration surfaces at deploy time rather than as
partial outages.

```sh
PAPERCLIP_STRICT_STARTUP_CHECKS=true node server/dist/index.js
```
