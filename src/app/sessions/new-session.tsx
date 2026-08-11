"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewSessionButton() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function create() {
		const title = window.prompt("What is this session about?");
		if (!title?.trim()) return;
		setBusy(true);
		try {
			const response = await fetch("/api/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title }),
			});
			const body = (await response.json()) as { key?: string };
			if (body.key) router.push(`/s/${body.key}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<button
			className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
			disabled={busy}
			onClick={create}
			type="button"
		>
			{busy ? "Creating…" : "New session"}
		</button>
	);
}
