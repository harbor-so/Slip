# ADR 0007 — Per-repo prebuilt images are a produced, published pointer a spawn reads

**Status:** accepted
**Date:** 2026-08-13

## Context

Harbor shipped the *consumer* of prebuilt images and none of the producer. `repo_image`
was in `BOOT_MODES`, `boot-decisions.ts` already skipped `setup.sh` for it — and nothing
ever built such an image or selected the mode, so the branch was dead. That dead branch
is the largest remaining cold-start gap: every session pays a full dependency install
before the agent does any work.

The technique that closes it is to rebuild a per-repo image on an interval with
dependencies already installed, and have sessions boot the *previous* image. Build time
then falls entirely outside the spawn path — it is never on a user's clock — and the
cost is bounded staleness: the checkout and the installed dependencies are at most one
interval old.

Building this touches four decisions where the obvious answer is the wrong one, and
each is the kind that passes review and fails later.

**Image-building looks like an optional method.** The obvious shape is one method and
one boolean on the base provider:

```ts
interface SandboxProviderBase {
  capabilities: { supportsImages: boolean; /* ... */ };
  buildImage?(config): Promise<BuiltImage>;
}
// caller:
if (provider.capabilities.supportsImages) await provider.buildImage!(cfg);
```

Nothing ties the boolean to the method. `local` sets `supportsImages: false` and omits
`buildImage`, and the day a caller forgets the guard, `provider.buildImage?.(cfg)`
returns `undefined` and the repo's image simply never appears, with no error anywhere.
A capability the compiler cannot check is one that silently degrades in production, and
this is the exact failure mode the whole provider abstraction exists to prevent. The
convention here is explicit: *capability is a type, not a boolean.*

**The pointer looks like an append-only log.** "Write every build to a table, read the
latest by `built_at`" is one partial write away from reading a half-finished failed row
as the current image — and the entire value of the feature is that a failed build
degrades nothing.

**Concurrency looks like a check.** Two ticks, "is a build already running for this
repo? no → start one", races under READ COMMITTED: both read no, both build. A mock
passes it every time.

**Freshness looks like re-cloning.** It is tempting to bake dependencies and then
`git pull` the latest code at boot so the checkout is never stale. That is
`read-before-sync`, explicitly out of scope here, and conflating it with image-building
is what makes the two modes hard to reason about. A prebuilt image bakes the checkout at
the build SHA and boots it as-is; catching a workspace up to recent commits is the job
of the *filesystem-snapshot* path, which Harbor already models separately as
`snapshot_restore`. Keeping them distinct is what lets each one be explained on its own.

## Decision

**Image-building is a separate capability interface, discovered by a type guard.**

```ts
interface ImageBuildingProvider {
  readonly buildsImages: true;                 // discriminant, not a capability bag
  buildImage(config): Promise<BuiltImage>;
  pruneImages(prefix, keep): Promise<string[]>;
}
function isImageBuildingProvider(p: SandboxProvider): p is SandboxProvider & ImageBuildingProvider {
  return "buildsImages" in p && p.buildsImages === true;
}
```

`docker` implements it; `local` does not, so `localProvider().buildImage(...)` is a
**compile error**, and a `SandboxProvider` from the registry cannot call `buildImage`
without narrowing through the guard. It is not a fourth `kind`: `docker` is already
`kind: "snapshot"`, and image-building is an *orthogonal* axis — a fourth discriminant
would force docker to be either a snapshot provider or an image builder, when it is
both. The consume side (booting a `repo_image`) is gated on the same guard: the
capability to boot a per-repo image is co-located with the capability to build one, so
a provider that cannot build images is never handed one to boot, and that gate is a
type check, not a `capabilities` branch.

**The pointer and the schedule are one row, advanced on success only.** `repo_images`
holds both the published pointer (`image_ref`, `built_from_sha`, `built_at`, nullable
until the first success) and the schedule state (`next_build_at`, `consecutive_failures`,
`paused_reason`) — the single-table `automations` model. The pointer columns are written
only inside the transaction that finalises a `success`; a failed, timed-out or
in-flight build touches the schedule columns and leaves the pointer exactly as the last
good build left it. `image_builds` is the append-only attempt ledger.

**Concurrency is a partial unique index, not a check.** `one_active_build_per_repo` on
`(repo_id) where finished_at is null` — the shape of `one_active_lease_per_scope`. Two
ticks both INSERT a `running` row, Postgres serialises them, one lands and the loser
records a `skipped` outcome. `onConflictDoNothing` with the target columns repeated and
`where` matching the partial predicate, or Postgres raises 42P10.

**`next_build_at` advances before the build runs.** A crash mid-build then costs one
skipped interval instead of a rebuild every tick — the automations rule, for the same
failure.

**Staleness is an interval, an unchanged-HEAD skip, and a freshness cutoff.**
`imageBuildIntervalMs` bounds how stale baked dependencies may get; a rebuild is skipped
when the default-branch HEAD still equals `built_from_sha`; and `imageMaxAgeMs` is the
cutoff past which a spawn will not boot from the pointer and falls through to `fresh`.
`validateConfig` refuses `imageMaxAgeMs < imageBuildIntervalMs` — that combination makes
every image stale on arrival and silently disables the feature while still paying the
build bill.

**Boot semantics: bake the checkout and dependencies, boot as-is.** The `build` mode
clones the pinned SHA and runs `setup.sh` fatally; `repo_image` boots that image, skips
`setup.sh` (baked) and runs `start.sh`, and does not re-clone. Repo state is therefore
at most `imageBuildIntervalMs` stale. That is the trade this ADR accepts deliberately:
bounded staleness in exchange for a cold start that costs no install, and it keeps
`read-before-sync` out.

**Spend is attributed.** Builds reserve budget under a new `image_build` cost kind with
`actor: "harbor"` and `repo_id` set, so the fourth amplification path — a build loop
with no human in it — rolls up to the org cap and an org already over its cap is
refused, rather than being the one unbounded thing. `cost.ts` already named periodic
image rebuilds as a path it must cover.

**Disk is pruned.** After a publish, images under the repo's tag prefix beyond
`imageRetentionCount` and not currently pointed at are removed. Best-effort: an image
still backing a running container refuses removal, which is the safe direction.

## Consequences

### Positive

- A failed or in-progress build cannot degrade a session: there is no code path from a
  build failure to a pointer update, so a spawn mid-build boots the previous image.
- Two concurrent ticks for one repo produce exactly one build and one recorded loser,
  guaranteed by an index rather than by code a mock can fool.
- Adding an image-building provider is a type obligation, not a checklist: implement the
  interface or the guard returns false.
- Off by default, per-repo opt-in via `repos.config`, so an upgrade adds no standing
  compute bill until an operator turns it on for a repo whose cold start hurts.

### Negative — the accepted costs

- **Repo state is up to one interval stale.** An agent may branch from a default-branch
  HEAD that moved in the last `imageBuildIntervalMs`. This is deliberate; freshening at
  boot is `read-before-sync`, a separate unit of work.
- **A new dependency lags by up to one interval.** A dependency added since the last
  build is absent until the next one; `imageMaxAgeMs` bounds how long a session keeps
  booting the old image before falling back to a cold boot that re-runs `setup.sh`.
- **The clone URL is derived for github.com / gitlab.com only.** A GitHub Enterprise or
  self-hosted GitLab host is not yet reconstructed by the scheduler's HEAD resolver; the
  resolver is injectable, so such a deployment supplies its own. Private-repo build
  credentials ride the same credential-helper path a session uses and require the build
  container to reach the control plane; a build with no reachable credentials clones only
  what is public.
- **Build spend is reserved at a zero estimate.** v1 has no price for a build, so the
  reservation enforces the cap without charging a number — a spend report shows the
  build happened, not what it cost, until a price list exists.
- **A wedged build holds its slot until swept.** A `running` row with a null
  `finished_at` blocks new builds for that repo, which is the safe direction, but a
  build whose process died without writing a terminal status needs the same kind of
  sweep the sandbox saga has; that sweep is not yet written for builds.
