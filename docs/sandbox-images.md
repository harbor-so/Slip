# Getting the sandbox image to your provider

Harbor boots every session into the image built by `sandbox/Dockerfile`. With the
default `docker` provider that image lives on the same host and nothing else needs
to happen:

```bash
npm run sandbox:build        # tags harbor-sandbox:latest locally
```

Every **other** provider boots an image *the vendor* pulls or forks. A local tag is
not a smaller version of the right thing there — it is unusable, and the failure
is a pull error from the vendor that Harbor cannot diagnose for you.

```bash
HARBOR_SANDBOX_IMAGE=ghcr.io/<you>/harbor-sandbox:v1 npm run sandbox:push
```

That builds `linux/amd64,linux/arm64` and pushes. arm64 is not optional in
practice: several vendors run arm, and an amd64-only image fails at boot with an
exec-format error that reads like a Harbor bug.

> **GHCR packages are private by default.** After the first push, make the package
> public. Harbor has no per-provider registry credential to offer — `HARBOR_SANDBOX_IMAGE`
> is a bare reference — so a private image means every remote provider fails its
> first pull with an authentication error and no way to fix it from Harbor's side.

---

## What `HARBOR_SANDBOX_IMAGE` means, per provider

A registry push is **sufficient** for five of the eleven remote providers and only
a **prerequisite** for the rest. Saying "push to GHCR and you're done" would be
true for less than half of them.

Each row is what the provider actually sends, read out of its source.

### Bucket 1 — a registry reference. The push is all you need.

| Provider | `config.image` becomes | Source |
|---|---|---|
| `fly` | the Machine's `config.image` | `providers/fly.ts` |
| `modal` | `client.images.fromRegistry(...)` | `providers/modal.ts:260` |
| `blaxel` | `spec.runtime.image` | `providers/blaxel.ts:304` |
| `vercel` | `params.image` (optional; Vercel has a default) | `providers/vercel.ts:359` |
| `northflank` | `deployment.external.imagePath` | `providers/northflank.ts:339` |

Set `HARBOR_SANDBOX_IMAGE=ghcr.io/<you>/harbor-sandbox:v1` and you are done.

### Bucket 2 — a vendor artefact. The push is necessary but not sufficient.

These take a vendor-side id, not an OCI reference. You publish the image, then run
one vendor command to convert it into their object, then set
`HARBOR_SANDBOX_IMAGE` to the **id that command returns**.

| Provider | `config.image` must be | Source |
|---|---|---|
| `e2b` | an E2B **template id** | `providers/e2b.ts:223` |
| `daytona` | a Daytona **snapshot** ref | `providers/daytona.ts:267` |
| `runloop` | a Runloop **blueprint id** | `providers/runloop.ts:264` |
| `morph` | a MorphCloud **snapshot id** | `providers/morph.ts:244` |
| `codesandbox` | a CodeSandbox **template/sandbox id** to fork — not OCI at all | `providers/codesandbox.ts` |

> The exact vendor CLI invocation for each conversion is deliberately not written
> here. What Harbor sends is verified from its own source; the vendor's command is
> not something this repository can test, and a confidently wrong command copied
> from a changelog costs more time than an honest pointer. Use each vendor's
> current "build a template/snapshot from a container image" documentation, then
> come back and set the id.

**CodeSandbox is the worst-matched of the eleven** and is worth avoiding as a first
choice: it takes no OCI image, it cannot accept environment variables at create
time (`create` forks a template and then delivers env over a data-plane session),
and its `shutdown` hibernates rather than destroys.

### Bucket 3 — baked at deploy time

| Provider | What happens |
|---|---|
| `cloudflare` | `HARBOR_SANDBOX_IMAGE` is **ignored**. Cloudflare fixes a Container's image at deploy time, so the Harbor runtime is baked into the Worker shim's image. |

Build and deploy the shim first — see
[`integrations/cloudflare-sandbox-worker/README.md`](../integrations/cloudflare-sandbox-worker/README.md):

```bash
docker build \
  --build-arg HARBOR_SANDBOX_IMAGE_REF=ghcr.io/<you>/harbor-sandbox:v1 \
  -t <your-registry>/harbor-cloudflare-sandbox:v1 \
  integrations/cloudflare-sandbox-worker
```

---

## The other thing that must be right: `HARBOR_PUBLIC_URL`

A sandbox reports everything it does by calling Harbor back. On a remote provider
that call crosses the public internet, so the address has to be publicly
resolvable — and the advice for the `docker` provider is actively wrong there:

| Deployment | `HARBOR_PUBLIC_URL` |
|---|---|
| Docker Desktop | `http://host.docker.internal:3000` |
| Docker on Linux | `http://172.17.0.1:3000` (the docker0 gateway) |
| **Any remote provider** | `https://harbor.example.com` — a real, public HTTPS origin |

A remote sandbox pointed at `host.docker.internal` or a private address does not
error. It hangs until the boot timeout and is reaped, and the symptom —
"sandboxes always time out" — is a long way from the cause. This is the single
most common first-remote-spawn failure, which is why the spawn refuses outright
when the variable is unset rather than guessing.

`HARBOR_AGENT_MCP_URL` has the same requirement, with a gentler failure: unset
means the agent simply runs without Harbor's tools.

---

## Agent CLIs

Off by default in both the build and the push, because ADR 0005's "bring your own
agent" claim is false the moment the published image has one baked in:

```bash
HARBOR_SANDBOX_IMAGE=ghcr.io/<you>/harbor-sandbox:v1 \
INSTALL_CLAUDE_CODE=1 \
  npm run sandbox:push
```

The alternative is installing your own CLI from `.harbor/setup.sh` in the
repository, which needs no image build at all.
