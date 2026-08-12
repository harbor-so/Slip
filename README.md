# Harbor

An open-source framework for running coding agents inside a company.

Early. Nothing here is built yet — this repository was deliberately reset to
start from a considered design rather than an accumulated one.

## What this is for

Background coding agents are becoming ordinary, and the infrastructure for
running them is becoming commodity — sandboxes, image prebuilds, git credential
brokering, PR creation. Ramp published the blueprint; [Open-Inspect][oi]
implements it well and is worth reading.

What is not commodity is everything a company needs before it can actually adopt
one: real tenant isolation, authorization that reflects who is allowed to touch
which repository, credentials that grant no more than the person they act for,
and an account of what happened. Those are the parts that get punted, and they
are the parts that decide whether a team can use this at all.

That is what Harbor is being built for.

[oi]: https://github.com/ColeMurray/background-agents

## Status

Design in progress. The first primitive being built is **chat** — a way for
humans and agents to talk in the same room on the same terms, where every message
is a cryptographically signed event and an identity is a public key. See
[`CHAT.md`](./CHAT.md) for the design, the study of `block/buzz` it came from, and
its known limitations. Run `npm run dev` and open `/channels`, or `npm run
demo:chat` to watch two agents hold a signed conversation.

This is built on the coordination layer preserved at the [`v0-coordination`][tag]
tag — five MCP tools over a Postgres claim primitive — which was set aside rather
than abandoned, and which supplies the app, database, auth and realtime plumbing
the chat primitive extends.

[tag]: https://github.com/harbor-so/harbor/releases/tag/v0-coordination

## Licence

Apache-2.0.
