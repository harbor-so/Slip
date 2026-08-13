"use client";

/**
 * A face, or the initials standing in for one. Ported from the tandem shell and
 * adapted to Harbor's identity model: tandem reads a colour off a user record;
 * a Harbor identity is a public key, so when no colour is given we derive a
 * stable one from the seed (`colorOf`) — the same key is the same colour every
 * time, which is how people pick each other out of a busy member rail.
 *
 * Presence is drawn as a ring rather than a corner dot: at 24px a corner dot is
 * three pixels of signal, a ring is the whole outline.
 */

import { colorOf, cx, initialsOf } from "./format.js";

export type Presence = "typing" | "viewing" | "away" | "absent";

export interface UserRef {
	/** Stable id/seed (a pubkey, for Harbor). Used to derive a colour. */
	id: string;
	name: string;
	color?: string;
	avatarUrl?: string;
}

const SIZES = {
	sm: "size-6 text-[10px]",
	md: "size-8 text-xs",
	lg: "size-10 text-sm",
} as const;

const RING: Record<Presence, string> = {
	typing: "ring-2 ring-accent",
	viewing: "ring-2 ring-good/70",
	away: "ring-2 ring-line-strong",
	absent: "ring-0 opacity-40",
};

export function Avatar({
	user,
	size = "md",
	presence,
	className,
}: {
	user: UserRef;
	size?: keyof typeof SIZES;
	presence?: Presence;
	className?: string;
}) {
	return (
		<span
			title={user.name}
			className={cx(
				"relative inline-flex shrink-0 items-center justify-center",
				"rounded-full font-semibold text-bg ring-offset-2 ring-offset-bg",
				SIZES[size],
				presence ? RING[presence] : "",
				className,
			)}
			style={{ backgroundColor: user.color ?? colorOf(user.id || user.name) }}
		>
			{user.avatarUrl ? (
				// eslint-disable-next-line @next/next/no-img-element
				<img src={user.avatarUrl} alt="" className="size-full rounded-full object-cover" />
			) : (
				initialsOf(user.name)
			)}
		</span>
	);
}

/** Overlapping faces, for a row that has no room for a list. */
export function AvatarStack({
	users,
	max = 4,
	size = "sm",
}: {
	users: readonly UserRef[];
	max?: number;
	size?: keyof typeof SIZES;
}) {
	const shown = users.slice(0, max);
	const extra = users.length - shown.length;
	return (
		<span className="flex items-center">
			{shown.map((user) => (
				<Avatar
					key={user.id}
					user={user}
					size={size}
					className="-ml-1.5 first:ml-0 ring-2 ring-bg"
				/>
			))}
			{extra > 0 ? <span className="ml-1.5 text-[11px] text-faint nums">+{extra}</span> : null}
		</span>
	);
}
