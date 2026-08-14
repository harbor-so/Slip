# The container image every Harbor session boots into on Cloudflare.
#
# Cloudflare fixes a Container's image at deploy time, so this is where the Harbor
# sandbox image is baked in — `HARBOR_SANDBOX_IMAGE` is ignored by the cloudflare
# provider, and this file is what it is ignored in favour of.
#
# ---------------------------------------------------------------------------
# `/harbor/boot` is the contract
# ---------------------------------------------------------------------------
#
# `src/index.ts` runs `sandbox.startProcess("/harbor/boot")`. That path used to be
# a commented-out placeholder here, with an instruction to "adjust the source
# paths to your build context" — which nobody could follow, because the repository
# root's `sandbox/` directory contains only a Dockerfile and no boot script. The
# Cloudflare provider therefore could not boot anything as shipped. This file now
# builds the real thing.
#
# The Harbor runtime is copied out of the published sandbox image rather than
# compiled again here, so there is exactly one definition of what a Harbor sandbox
# contains. Point HARBOR_SANDBOX_IMAGE_REF at whatever `npm run sandbox:push`
# published:
#
#   docker build \
#     --build-arg HARBOR_SANDBOX_IMAGE_REF=ghcr.io/<you>/harbor-sandbox:v1 \
#     -t <your-registry>/harbor-cloudflare-sandbox:v1 \
#     integrations/cloudflare-sandbox-worker
#
# Keep the cloudflare/sandbox tag in sync with the @cloudflare/sandbox version in
# package.json — the container server and the SDK are versioned together.

ARG HARBOR_SANDBOX_IMAGE_REF=ghcr.io/harbor-so/harbor-sandbox:latest

FROM ${HARBOR_SANDBOX_IMAGE_REF} AS harbor

FROM docker.io/cloudflare/sandbox:0.12.5

# The compiled runtime, and the git credential helper git looks up by name. Both
# come from the Harbor sandbox image verbatim; nothing is rebuilt.
COPY --from=harbor /opt/harbor /opt/harbor
COPY --from=harbor /usr/local/bin/git-credential-harbor /usr/local/bin/git-credential-harbor

# The boot shim the Worker starts. A file rather than a CMD because the
# @cloudflare/sandbox base image owns PID 1 — its control server is the
# entrypoint, and the Harbor supervisor is started *by* that server as a child
# process, so it needs a path to exec rather than a container command.
#
# `exec` so the supervisor replaces the shell and receives SIGTERM directly;
# without it the shell holds the signal and the bridge never gets to drain.
# `mkdir -p /harbor` first: the cloudflare/sandbox base image has no /harbor
# directory, so writing the shim straight in fails the build with "Directory
# nonexistent". That is the whole reason this file is built in CI rather than
# trusted — the previous version's instructions could not have worked either.
RUN mkdir -p /harbor \
	&& printf '#!/bin/sh\nexec node /opt/harbor/runtime/supervisor.js "$@"\n' > /harbor/boot \
	&& chmod 0755 /harbor/boot

# Fail the build here rather than at first boot if the base image has no node.
# A missing interpreter would otherwise surface as a sandbox that starts, reports
# nothing and is reaped by the connecting watchdog — the single least diagnosable
# failure in the system.
RUN node --version && test -f /opt/harbor/runtime/supervisor.js

ENV HARBOR_WORKSPACE_ROOT=/workspace \
	NO_COLOR=1 \
	GIT_TERMINAL_PROMPT=0
