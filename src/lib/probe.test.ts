import { expect, it } from "vitest";

it("imports a route module", async () => {
	const mod = await import("../app/api/sandbox/[id]/events/route.js");
	expect(typeof mod.POST).toBe("function");
	const stream = await import("../app/api/sessions/[key]/stream/route.js");
	expect(typeof stream.GET).toBe("function");
});
