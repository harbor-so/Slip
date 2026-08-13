# Harbor Cloudflare Sandbox control shim

Cloudflare Sandbox runs as a **Durable Object + Container** (`@cloudflare/sandbox`)
and can only be driven from *inside* a Worker via `getSandbox(env.Sandbox, id)` —
there is no external control-plane REST API, and Durable Objects are not
enumerable. Harbor's control plane is an external Node server, so it cannot call
that binding directly.

This Worker bridges the gap. It exposes Harbor's four sandbox operations over a
small bearer-token-protected HTTP API, backed by:

- the **`Sandbox` Durable Object** for the actual box (create/inspect/stop), and
- a **KV namespace** (`HARBOR_SANDBOX_INDEX`) as the enumerable registry that
  makes reconciliation (`findByAttemptId`, `listManaged`) possible, since DOs
  cannot be listed.

Harbor's `cloudflare` provider (`src/sandbox/providers/cloudflare.ts`) is an
ordinary `fetch` client pointed at this Worker's URL.

## HTTP API

All routes require `Authorization: Bearer <AUTH_TOKEN>`.

| Method & path | Purpose |
|---|---|
| `POST /sandboxes` | create — body `{ sandboxId, attemptId, sessionId, image?, env?, command? }` |
| `GET /sandboxes/:externalId` | inspect — `404` when absent |
| `DELETE /sandboxes/:externalId` | stop — `{ outcome: stopped \| already_stopped \| absent }` |
| `GET /sandboxes?attempt=<id>` | find by attempt id (reconciliation) |
| `GET /sandboxes?managed=true` | list managed live boxes (reconciliation) |

Any unexpected failure returns `5xx`, so the Harbor side **fails closed** (throws
`transient`) rather than reading an empty list as "no orphans".

## Deploy

```sh
cd integrations/cloudflare-sandbox-worker
npm install

# 1. Create the registry KV namespace and paste its id into wrangler.jsonc.
npx wrangler kv namespace create HARBOR_SANDBOX_INDEX

# 2. Build the Harbor sandbox image into ./Dockerfile (see comments there).

# 3. Set the shared secret Harbor will present.
npx wrangler secret put AUTH_TOKEN

# 4. Deploy.
npx wrangler deploy
```

Then point Harbor at it:

```sh
HARBOR_SANDBOX_PROVIDER=cloudflare
CLOUDFLARE_SANDBOX_WORKER_URL=https://harbor-cloudflare-sandbox.<your-subdomain>.workers.dev
CLOUDFLARE_SANDBOX_WORKER_TOKEN=<the AUTH_TOKEN you set>
```

## Constraints (what this does NOT do)

- **Image is fixed at deploy time.** A Cloudflare Container image is chosen in
  `wrangler.jsonc`/`Dockerfile`, not per create call. The `image` Harbor sends is
  recorded for provenance only. Build the Harbor sandbox image into this Worker.
- **Reconciliation is only as good as the KV index.** If the Worker fails to
  write KV after starting a box (a create that dies mid-flight), that box is not
  discoverable. The index is written immediately after `startProcess`, keeping the
  window small, but it is not the atomic label-on-the-box that Fly/Docker get.
- **No snapshot/resume.** Advertised `ephemeral`; a stopped box is gone.
