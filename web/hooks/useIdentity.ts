"use client";

/**
 * This device's identity, brought up once and kept.
 *
 * The whole trust model rests on the browser holding a key the server never
 * sees (`identity-browser.ts`): a person *is* their keypair. This hook is the
 * React front of that — it loads (or first-generates) the non-extractable key,
 * registers its public half with the org, and hands the rest of the UI a stable
 * pubkey to attribute by. `rename` re-registers under a new display name;
 * registration is idempotent server-side, so it just updates the label the key
 * already owns.
 */

import { useCallback, useEffect, useState } from "react";
import { ensureIdentity } from "~/lib/identity-browser.js";
import type { Keypair } from "~/lib/signing.js";

export interface UseIdentity {
	keypair: Keypair | null;
	pubkey: string | null;
	error: string | null;
	rename: (displayName: string) => Promise<void>;
}

export function useIdentity(displayName: string): UseIdentity {
	const [keypair, setKeypair] = useState<Keypair | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const loaded = await ensureIdentity(displayName);
				if (!cancelled) setKeypair(loaded);
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [displayName]);

	const rename = useCallback(async (next: string) => {
		const loaded = await ensureIdentity(next);
		setKeypair(loaded);
	}, []);

	return { keypair, pubkey: keypair?.publicKeyHex ?? null, error, rename };
}
