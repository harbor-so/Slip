"use client";

/**
 * A channel room — the whole multiplayer surface in one client island.
 *
 * The server component that mounts this only proves the viewer is in the org and
 * hands down the room's key and title; everything live happens here, driven by
 * `useChannel`: identity, join, history, the SSE stream, and signing on send. The
 * layout puts the conversation and composer under one column and a member rail
 * beside it, so "who is in this room" (which, because membership is the access
 * gate, is also "who can read this") is always in view next to what is said.
 */

import { useState } from "react";
import { Badge, Dialog, Empty, PresenceDot } from "@web/design/index.js";
import { useChannel } from "@web/hooks/useChannel.js";
import { useIdentity } from "@web/hooks/useIdentity.js";
import type { RoomEvent } from "@web/lib/events.js";
import { LaunchAgentForm } from "@web/runs/LaunchAgentForm.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";
import { MemberRail } from "./MemberRail.js";
import { IdentityPanel } from "./IdentityPanel.js";

export function Room(props: {
	channelKey: string;
	channelId: string;
	channelKind: string;
	title: string;
	viewerName: string;
	/** Whether the host-spawn runner is enabled — gates the "launch agent here" seam. */
	runnerEnabled?: boolean;
}) {
	const { channelKey, channelId, title, channelKind, viewerName, runnerEnabled = false } = props;
	const room = useChannel(channelKey, channelId, viewerName);
	const identity = useIdentity(viewerName);
	const [replyTo, setReplyTo] = useState<RoomEvent | null>(null);
	const [showIdentity, setShowIdentity] = useState(false);
	const [showLaunch, setShowLaunch] = useState(false);

	async function onSend(text: string) {
		await room.send(text, replyTo?.id);
		setReplyTo(null);
	}

	return (
		<div className="space-y-6">
			<div>
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-semibold">{title}</h1>
					<Badge tone={channelKind === "direct" ? "neutral" : "claimed"}>{channelKind}</Badge>
					<div className="ml-auto flex items-center gap-4">
						<PresenceDot live={room.live} />
						<button
							className="text-xs text-muted-foreground hover:text-foreground"
							onClick={() => setShowLaunch(true)}
							type="button"
						>
							launch agent here
						</button>
						<button
							className="text-xs text-muted-foreground hover:text-foreground"
							onClick={() => setShowIdentity(true)}
							type="button"
						>
							identity
						</button>
						<ShareLink channelKey={channelKey} />
					</div>
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{room.pubkey ? (
						<>
							You are <span className="text-foreground">{viewerName}</span> — key{" "}
							<span className="nums">{room.pubkey.slice(0, 8)}…</span>. Every message you send is
							signed with it.
						</>
					) : (
						"Setting up your key on this device…"
					)}
				</p>
			</div>

			{room.status === "error" ? (
				<Empty title="Could not open the room" hint={room.error ?? undefined} />
			) : (
				<div className="flex gap-6">
					<div className="min-w-0 flex-1 space-y-4">
						<MessageList
							events={room.events}
							members={room.members}
							myPubkey={room.pubkey}
							status={room.status}
							onReact={room.react}
							onReply={setReplyTo}
						/>
						<Composer
							disabled={room.status !== "ready"}
							typing={room.typing}
							replyTo={replyTo}
							members={room.members}
							error={room.error}
							onSend={onSend}
							onType={() => room.signalTyping()}
							onCancelReply={() => setReplyTo(null)}
						/>
					</div>
					<MemberRail members={room.members} myPubkey={room.pubkey} typing={room.typing} />
				</div>
			)}

			<IdentityPanel
				open={showIdentity}
				onClose={() => setShowIdentity(false)}
				pubkey={identity.pubkey}
				displayName={viewerName}
				onRename={identity.rename}
			/>

			<Dialog open={showLaunch} onClose={() => setShowLaunch(false)} title={`Launch an agent into ${title}`}>
				<div className="space-y-3">
					<LaunchAgentForm
						enabled={runnerEnabled}
						channel={{ key: channelKey, title }}
						onLaunched={() => setShowLaunch(false)}
					/>
					{runnerEnabled ? (
						<p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
							The agent is launched with the prompt above and asked to join this room. Full
							participation — an agent posting its own signed events here — needs a chat keypair
							wired into the run, which is a backend follow-up; until then the launch is real but
							the agent will not appear as a member automatically.
						</p>
					) : null}
				</div>
			</Dialog>
		</div>
	);
}

function ShareLink({ channelKey }: { channelKey: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			className="text-xs text-muted-foreground hover:text-foreground"
			onClick={() => {
				void navigator.clipboard.writeText(`${window.location.origin}/c/${channelKey}`);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
			type="button"
		>
			{copied ? "link copied" : "copy share link"}
		</button>
	);
}
