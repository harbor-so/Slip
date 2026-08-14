# The container image every Harbor session boots into on Cloudflare.
#
# Cloudflare fixes a Container's image at deploy time, so this is where the Harbor
# sandbox image is baked in. It must extend the @cloudflare/sandbox base image
# (which ships the container-side control server the Sandbox Durable Object talks
# to) and add whatever the Harbor agent needs.
#
# Keep the base image tag in sync with the @cloudflare/sandbox version in
# package.json — the container server and the SDK are versioned together.
FROM docker.io/cloudflare/sandbox:0.12.5

# Bring in the Harbor supervisor / entrypoint. Adjust the source paths to your
# build context (the repo root `sandbox/` and `runtime/` trees), or install the
# published Harbor agent, so that `/harbor/boot` exists and starts the supervisor.
# COPY sandbox/ /harbor/
# RUN chmod +x /harbor/boot

# The @cloudflare/sandbox base sets its own ENTRYPOINT (the control server); the
# Harbor agent is started as a process by the Worker via `startProcess`, not as
# PID 1, so no CMD override is required here.
