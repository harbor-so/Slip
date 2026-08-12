/**
 * The live/offline dot, factored out of the three places that hand-rolled it.
 *
 * A filled success dot means the stream is connected and signed events are
 * arriving; a muted dot means the client is reconnecting. It says nothing about
 * whether anyone is *talking* — only whether this tab would hear them if they
 * did. That honesty matters: a dot that stayed green while the socket was down
 * would be the UI quietly lying about liveness.
 */

export function PresenceDot({ live, label }: { live: boolean; label?: string }) {
	return (
		<span
			className="flex items-center gap-1.5 text-xs text-muted-foreground"
			title={live ? "Live — signed events stream in" : "Reconnecting…"}
		>
			<span
				className={`inline-block h-1.5 w-1.5 rounded-full ${
					live ? "bg-success" : "bg-muted-foreground/40"
				}`}
			/>
			{label ?? (live ? "live" : "offline")}
		</span>
	);
}
