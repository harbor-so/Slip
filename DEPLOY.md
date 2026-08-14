# Deploying Harbor

Four shapes, in increasing order of effort. Pick the smallest one that fits.

Everything Harbor needs is a Node process and a Postgres database. There is no
step in this document that requires an account with anyone.

---

## 1. Your laptop

For evaluating it, and for a single engineer running agents against their own
repositories.

```bash
docker compose up -d
npm install && cp .env.example .env
openssl rand -base64 32   # HARBOR_ENCRYPTION_KEY
openssl rand -base64 32   # AUTH_SECRET
npm run db:migrate && npm run db:seed
npm run sandbox:build
npm run dev
```

Sign-in is bypassed outside production when `GITHUB_CLIENT_ID` is unset, and the
dashboard says so in a banner on every page. The bypass refuses to engage when
`NODE_ENV=production` regardless of configuration, because the failure mode of
getting that backwards is an unauthenticated dashboard on the internet.

---

## 2. One VM

The shape most teams should run. A single host with Docker, Postgres and Harbor,
behind whatever ingress you already have.

```
┌─ your VM ────────────────────────────────────┐
│  nginx / Caddy  →  Harbor (Node, :3000)      │
│                    Harbor MCP     (:8788)    │
│                    Postgres       (:5432)    │
│                    Docker socket → sandboxes │
└──────────────────────────────────────────────┘
```

**Sizing.** A sandbox is a container with a clone of your repository and its
dependencies. Budget 2 vCPU and 4 GB per concurrent session, plus 2 vCPU and 4 GB
for Harbor and Postgres. Eight concurrent sessions is comfortable on a 16-core,
64 GB box.

**The Docker socket.** Harbor's `docker` provider talks to the daemon, so the
Harbor process can create containers on that host. That is the same privilege
level as root on the machine. Run Harbor as its own user in the `docker` group on
a host that does nothing else, and read [docs/SECURITY.md](./docs/SECURITY.md)
before deciding it is acceptable.

**Ingress.** Two things need to work through your proxy: Server-Sent Events, and
long-lived connections. Nginx buffers SSE into uselessness by default; Harbor
sends `x-accel-buffering: no`, which nginx honours, but check your own config for
a `proxy_buffering on` that overrides it.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 3600s;
  proxy_set_header Connection "";
}
```

**Postgres.** Harbor opens one dedicated connection per open event stream, on top
of its pool, because `LISTEN` occupies a connection for as long as it is
listening. A `max_connections` of 100 supports roughly 80 simultaneously open
dashboards. Raise it, or put PgBouncer in front in *session* pooling mode —
**not** transaction pooling, which breaks `LISTEN/NOTIFY` and advisory locks, and
breaks them silently: the product appears to work and the dashboard simply stops
updating.

**Backups.** Everything is in Postgres. `pg_dump` is a complete backup, with one
exception: encrypted values are useless without `HARBOR_ENCRYPTION_KEY`, so store
that key somewhere your database backup is not.

---

## 3. Kubernetes

Harbor is a stateless deployment plus a Postgres you already run. The only real
decision is where sandboxes go.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: harbor
spec:
  replicas: 2            # safe: the scheduler is advisory-locked, not a singleton
  template:
    spec:
      containers:
        - name: harbor
          image: your-registry/harbor:latest
          ports: [{ containerPort: 3000 }]
          envFrom: [{ secretRef: { name: harbor-env } }]
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
          livenessProbe:
            # Note the ?probe=live. Readiness depends on Postgres; liveness must
            # not. Point the liveness probe at the readiness path and a database
            # blip restarts every replica simultaneously, turning a recoverable
            # dependency failure into a total outage plus a cold start.
            httpGet: { path: /api/health?probe=live, port: 3000 }
```

More than one replica is safe. The automation scheduler takes a Postgres advisory
lock rather than being a designated singleton, and the session runner takes one
per session, so replicas cooperate without electing a leader.

**Sandboxes on Kubernetes.** Do not mount the node's Docker socket into the Harbor
pod. Either run the Harbor deployment on a dedicated node pool with the `docker`
provider and accept that the pod is effectively node-root there, or use one of the
eleven remote providers, none of which needs a local container runtime at all. A
first-class Kubernetes Job provider is the obvious contribution — it is the only
way to get a real isolation boundary that stays inside your own cluster — and the
provider contract test suite is what proves one correct.

The full provider list is `SANDBOX_PROVIDER_NAMES` in `src/sandbox/registry.ts`,
and there are no stubs in it: a provider that is not listed does not partially
exist, and every provider that is listed has passed the contract suite.

---

## 4. Hosted Postgres

Change one line.

```bash
DATABASE_URL=postgres://user:pass@db.example.neon.tech/harbor?sslmode=require
```

Nothing else in the codebase constructs a database client, so Supabase, Neon, RDS
and Cloud SQL all work unchanged. Two caveats:

- **`LISTEN/NOTIFY` must survive your pooler.** Supabase's pooled connection
  string (port 6543) is transaction-pooled and will break live updates. Use the
  direct connection string (port 5432).
- **Connection limits are lower than you think** on serverless tiers. See the
  note above about one connection per open stream.

---

## Configuration

Every tunable is an environment variable with a documented default. On a running
deployment:

```bash
curl -s localhost:3000/api/health/config | jq '.settings[] | {key, value, source}'
```

That prints the resolved value, whether it came from a repository override, an
environment variable or the default, and the prose reason the default is what it
is. The alternative is archaeology across a Helm chart and a Dockerfile at 2am
while sandboxes are dying.

The three to look at first:

| Variable | Default | Change it when |
|---|---|---|
| `HARBOR_SANDBOX_BOOT_TIMEOUT_MS` | 480000 | your repository takes longer than eight minutes to clone and install |
| `HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS` | 2100000 | the single largest lever on cost |
| `HARBOR_MAX_SPEND_PER_DAY_MICRO_USD` | 50000000 | $50/day per org is not your number |

Per-repository overrides live in `repos.config` and beat the environment, so one
slow monorepo does not make every other repository wait.

---

## Monitoring

```bash
curl -s localhost:3000/api/metrics
```

Prometheus text format, scrapeable by Prometheus and by every OTLP collector and
agent you might already run. Set `HARBOR_METRICS_TOKEN` to require a bearer token;
unset, the endpoint is open, which is right for a sidecar scraper on a private
network and is why it is the default.

The four alerts worth having on day one:

| Alert | Expression | Means |
|---|---|---|
| Provider down | `harbor_circuit_breaker_open > 0` | the sandbox provider is failing; sessions are being refused |
| Boots degrading | `harbor_sandbox_time_to_ready_seconds{quantile="0.99"} > 300` | one user in a hundred is waiting five minutes, which is enough for them to stop using it |
| Approaching the cap | `harbor_spend_today_micro_usd / on(org) harbor_spend_cap_micro_usd > 0.8` | new claims will start being refused today |
| Provider flapping | `increase(harbor_circuit_breaker_trips_total[1h]) > 2` | the breaker keeps opening; a gauge alone misses trips that close between scrapes |
| Agents dying | `rate(harbor_claim_expiries_total[1h]) > 0` | leases lapsing means agents are crashing mid-task, or the lease default is too short for the work |

---

## Upgrading

```bash
git pull && npm install && npm run db:migrate
```

Migrations are forward-only and additive. Restart replicas one at a time; the
advisory locks make a mixed-version fleet safe for the duration of a rolling
restart.

---

## Sandbox images

`npm run sandbox:build` produces `harbor-sandbox:latest`: Debian, Node 22, git,
and the Harbor runtime. Agent CLIs are build arguments, so the base image is
usable without any of them.

```bash
docker build -f sandbox/Dockerfile \
  --build-arg INSTALL_CLAUDE_CODE=1 \
  --build-arg INSTALL_CODEX=1 \
  -t harbor-sandbox:latest .
```

For a faster first prompt, bake your repository's dependencies in. Harbor also
runs `.harbor/setup.sh` from your repository on a fresh boot — non-fatal, so a
broken provisioning step still leaves a usable box — and `.harbor/start.sh` on
every boot, which is strict, because a broken runtime step means the agent works
in an environment that lies to it and produces confidently wrong work.

---

## Troubleshooting

**Sandboxes die seconds after becoming ready.** `HARBOR_SANDBOX_STALE_HEARTBEAT_MS`
is at or below `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS`. `validateConfig()` refuses
this at startup, so you will have seen the error — it names both variables and the
symptom.

**The dashboard stops updating but the API works.** `LISTEN/NOTIFY` is not
reaching you. Almost always a transaction-pooled connection string, or
`proxy_buffering on` in front of the SSE endpoint.

**Every spawn is refused with `circuit_open`.** The shared breaker is open for
that provider. `curl localhost:3000/api/metrics | grep circuit` shows which and
how many failures. It closes itself after the cooldown; if it reopens immediately,
`harbor_provider_errors_total` says whether the failures are `transient` (wait) or
`invalid_config` (fix your image or credentials).

**A pull request was opened by the bot instead of by a person.** That user has no
source-control token, and Harbor warned about it at use time. The self-approval
guarantee does not hold for that PR. Have them sign in through GitHub rather than
SSO.
