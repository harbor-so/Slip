/**
 * Small formatters, kept out of components so they can be tested and so two
 * screens never disagree about what "2m ago" means. Ported from the tandem
 * shell as part of adopting its frontend; kept verbatim so behaviour is shared.
 */

export function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0];
	if (!first) return "?";
	const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
	const second = last?.[0] ?? "";
	return (first[0] ?? "?").concat(second).toUpperCase();
}

export function relativeTime(at: number, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 10) return "now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export function usd(amount: number): string {
	if (amount < 0.01 && amount > 0) return "<$0.01";
	return `$${amount.toFixed(2)}`;
}

export function compactCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Join names the way a person would, so a banner reads as a sentence. */
export function listNames(names: readonly string[]): string {
	if (names.length === 0) return "nobody";
	if (names.length === 1) return names[0] ?? "nobody";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Tailwind-safe conditional class joining. */
export function cx(...parts: (string | false | null | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}

/** A stable oklch colour derived from a string, for identities with no colour. */
export function colorOf(seed: string): string {
	let hash = 0;
	for (let index = 0; index < seed.length; index += 1) {
		hash = (hash * 31 + seed.charCodeAt(index)) % 360;
	}
	return `oklch(0.7 0.13 ${hash})`;
}
