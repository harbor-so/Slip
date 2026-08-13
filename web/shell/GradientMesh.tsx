/**
 * The ambient background — large, heavily-blurred orbs drifting slowly behind
 * everything. Recreated from the reference demo's GradientMesh: it is most of
 * why the app feels alive rather than flat. Fixed, non-interactive, z-0.
 */

const ORBS = [
	{ w: "60vw", h: "60vh", top: "-10%", left: "-15%", hue: "oklch(0.62 0.01 250)", blur: 80, anim: "orb-float-1 25s ease-in-out infinite", opacity: 0.12 },
	{ w: "50vw", h: "55vh", top: "-5%", right: "-15%", hue: "oklch(0.56 0.008 255)", blur: 90, anim: "orb-float-2 30s ease-in-out infinite", opacity: 0.1 },
	{ w: "55vw", h: "50vh", bottom: "-15%", left: "5%", hue: "oklch(0.52 0.006 245)", blur: 100, anim: "orb-float-3 35s ease-in-out infinite", opacity: 0.1 },
	{ w: "35vw", h: "40vh", top: "30%", right: "5%", hue: "oklch(0.7193 0.1317 39.95)", blur: 90, anim: "orb-float-1 28s ease-in-out infinite", opacity: 0.06 },
] as const;

export function GradientMesh() {
	return (
		<div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
			{ORBS.map((orb, index) => (
				<div
					key={index}
					className="absolute rounded-full"
					style={{
						width: orb.w,
						height: orb.h,
						top: "top" in orb ? orb.top : undefined,
						bottom: "bottom" in orb ? (orb as { bottom: string }).bottom : undefined,
						left: "left" in orb ? (orb as { left: string }).left : undefined,
						right: "right" in orb ? (orb as { right: string }).right : undefined,
						background: `radial-gradient(circle, ${orb.hue} 0%, transparent 70%)`,
						filter: `blur(${orb.blur}px)`,
						animation: orb.anim,
						opacity: orb.opacity,
					}}
				/>
			))}
		</div>
	);
}
