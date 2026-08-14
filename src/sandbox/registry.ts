/**
 * Name → provider. One switch, and what is deliberately not in it.
 *
 * There are no stubs here. The obvious way to write a provider registry is to
 * list every backend anyone intends to support and have the unimplemented ones
 * throw a "not implemented yet" at call time — and the result is a product whose
 * configuration reference advertises six providers, five of which fail on the
 * first spawn, after the operator has already written their compose file and
 * their secrets. A provider that does not exist is simply absent from the union,
 * so `HARBOR_SANDBOX_PROVIDER=kubernetes` fails at the first call with a message
 * that lists what actually works, and `providerFor` cannot return something that
 * is not a working provider because there is nothing for it to return.
 *
 * Adding a backend is therefore three edits: the name goes in the array, the
 * case goes in the switch (omitting it is a compile error, by construction), and
 * the contract suite in `providers/provider-contract.test.ts` runs against it.
 * That last one is not optional — the suite is what "implements the interface"
 * means here, since TypeScript can only check the shape of the methods and not
 * that `stop` is idempotent or that `findByAttemptId` fails closed.
 */

import { setting } from "../config.js";
import { SandboxProviderError, assertNever } from "./provider.js";
import type { SandboxProvider } from "./provider.js";
import { dockerProvider } from "./providers/docker.js";
import { flyProvider } from "./providers/fly.js";
import { localProvider } from "./providers/local.js";

/**
 * The backends that exist. The order is the order they are offered to an operator
 * choosing one, so `docker` is first: it is the default, it needs no account, and
 * it is an isolation boundary. `fly` is the remote option — a hardware VM in
 * someone else's datacentre for a deployment that has outgrown one host — and it
 * costs a Fly account. `local` is last and is not a sandbox at all; it runs the
 * agent as the server user and exists only for the single-operator case.
 */
export const SANDBOX_PROVIDER_NAMES = ["docker", "fly", "local"] as const;
export type SandboxProviderName = (typeof SANDBOX_PROVIDER_NAMES)[number];

export function isSandboxProviderName(name: string): name is SandboxProviderName {
	return (SANDBOX_PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * Instances are cached because they are stateless and because a provider
 * constructed per call would re-read `HARBOR_DOCKER_BIN` on every spawn — cheap,
 * but it also means an identity comparison (`provider === other`) that a caller
 * might reasonably make would silently be false.
 */
const instances = new Map<SandboxProviderName, SandboxProvider>();

export function providerFor(name: string): SandboxProvider {
	if (!isSandboxProviderName(name)) {
		throw new SandboxProviderError({
			message:
				`Unknown sandbox provider ${JSON.stringify(name)}. Available: `
				+ `${SANDBOX_PROVIDER_NAMES.join(", ")}. Set HARBOR_SANDBOX_PROVIDER to one of them.`,
			errorType: "invalid_config",
			provider: name,
			operation: "create",
		});
	}

	const cached = instances.get(name);
	if (cached) return cached;

	const created = construct(name);
	instances.set(name, created);
	return created;
}

/** No `default` branch: a name added to the union without a case fails the build. */
function construct(name: SandboxProviderName): SandboxProvider {
	switch (name) {
		case "docker":
			return dockerProvider();
		case "fly":
			return flyProvider();
		case "local":
			return localProvider();
	}
	return assertNever(name, "construct");
}

/**
 * The provider this deployment runs unless a session says otherwise.
 *
 * Resolved at call time from `setting("sandboxProvider")` rather than captured at
 * import, for the reason given in src/config.ts: a module-level read happens
 * before a test can set the variable, and every test then silently exercises the
 * production default.
 */
export function defaultProvider(): SandboxProvider {
	return providerFor(setting("sandboxProvider"));
}
