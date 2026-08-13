"use client";

/**
 * Scene 1 — the "New goal" cold open, recreated one-for-one from the reference
 * demo (harbor-app/apps/demo), with Harbor's names. A goal, not a ticket: a
 * centered composer, an attachment, the model line, and a Start that opens the
 * multiplayer session card with the people already in it.
 */

import { ArrowRight, FileAudio, Link2, Paperclip, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const PRODUCT = "Harbor";
const COMPANY = { name: "Acme Corp", size: "40 people" };
const INTERPRETED_GOAL =
	"Add public read-only share links to project boards — view-only, no account required.";

const PEOPLE = [
	{ id: "priya", name: "Priya Shah", initials: "PS", color: "#8b5cf6", tag: "owner" },
	{ id: "maya", name: "Maya Chen", initials: "MC", color: "#e8825a", tag: "joined" },
];

export function DemoGoal() {
	const router = useRouter();
	const [value, setValue] = useState("");
	const [started, setStarted] = useState(false);

	return (
		<div className="flex min-h-[85vh] flex-col overflow-hidden">
			<div className="flex h-14 items-center justify-between border-b border-border px-6">
				<h1 className="font-montreal-medium text-xl tracking-tight">New goal</h1>
				<span className="text-sm text-muted-foreground">
					{COMPANY.name} · {COMPANY.size}
				</span>
			</div>

			<div className="flex flex-1 flex-col items-center justify-center px-8">
				<div className="w-full max-w-2xl">
					<h2 className="mb-4 font-montreal-medium text-lg tracking-tight">
						What should {PRODUCT} take on?
					</h2>

					<div className="rounded-xl border border-border bg-background">
						<textarea
							className="min-h-32 w-full resize-none bg-transparent px-5 pt-4 pb-2 text-left text-sm leading-relaxed outline-none placeholder:text-muted-foreground/50"
							disabled={started}
							onChange={(event) => setValue(event.target.value)}
							placeholder="Ask or build anything"
							value={value}
						/>

						<div className="flex flex-wrap gap-1.5 px-4 pb-3">
							<div className="flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-xs">
								<FileAudio className="size-3.5 text-muted-foreground" />
								<span className="text-foreground">northwind-call.m4a</span>
								<span className="text-muted-foreground/60">3:41 · sales sync</span>
							</div>
						</div>

						<div className="flex min-h-12 items-center justify-between gap-3 border-t border-border px-3 py-2">
							<div className="flex items-center gap-1 text-muted-foreground">
								<span className="inline-flex size-7 items-center justify-center rounded-lg hover:bg-muted/60">
									<Paperclip className="size-4" />
								</span>
								<span className="font-mono text-[11px]">claude opus 4.5</span>
							</div>

							{started ? (
								<button
									className="inline-flex h-8 shrink-0 items-center gap-2 rounded-xl bg-primary/15 px-3 font-medium text-primary text-sm"
									type="button"
								>
									<span className="size-2 animate-pulse rounded-full bg-primary" />
									Agent started
								</button>
							) : (
								<button
									className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
									onClick={() => setStarted(true)}
									type="button"
								>
									Start agent
									<ArrowRight className="size-4" />
								</button>
							)}
						</div>
					</div>
				</div>

				<AnimatePresence>
					{started ? (
						<motion.div
							animate={{ opacity: 1 }}
							className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
							exit={{ opacity: 0 }}
							initial={{ opacity: 0 }}
						>
							<motion.div
								animate={{ opacity: 1, scale: 1, y: 0 }}
								className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-popover"
								initial={{ opacity: 0, scale: 0.96, y: 8 }}
							>
								<div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
									<h3 className="font-montreal-medium text-base tracking-tight">Session #147</h3>
									<span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
										<Users className="size-3" />
										Multiplayer
									</span>
								</div>
								<div className="space-y-3 px-5 py-4">
									<motion.div
										animate={{ opacity: 1 }}
										className="rounded-lg border border-border bg-muted/30 px-3 py-2"
										initial={{ opacity: 0 }}
										transition={{ delay: 0.1 }}
									>
										<p className="text-[10px] uppercase tracking-wide text-muted-foreground">
											Understood as
										</p>
										<p className="mt-0.5 text-sm">{INTERPRETED_GOAL}</p>
									</motion.div>
									<div className="flex items-center gap-2.5">
										{PEOPLE.map((person, index) => (
											<motion.div
												animate={{ opacity: 1, scale: 1 }}
												className="flex items-center gap-2"
												initial={{ opacity: 0, scale: 0.6 }}
												key={person.id}
												transition={{ delay: 0.25 + index * 0.4 }}
											>
												<span
													className="flex size-6 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white"
													style={{ backgroundColor: person.color }}
												>
													{person.initials}
												</span>
												<span className="text-sm">
													{person.name.split(" ")[0]}
													<span className="ml-1 text-muted-foreground text-xs">{person.tag}</span>
												</span>
											</motion.div>
										))}
									</div>
									<motion.p
										animate={{ opacity: 1 }}
										className="flex items-center gap-1.5 text-muted-foreground text-xs"
										initial={{ opacity: 0 }}
										transition={{ delay: 1.1 }}
									>
										<Link2 className="size-3.5" />
										Link shared to #product — anyone at {COMPANY.name} can join or steer.
									</motion.p>
								</div>
								<div className="flex justify-end border-t border-border px-5 py-3">
									<button
										className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
										onClick={() => router.push("/demo/session")}
										type="button"
									>
										Open session
										<ArrowRight className="size-4" />
									</button>
								</div>
							</motion.div>
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>
		</div>
	);
}
