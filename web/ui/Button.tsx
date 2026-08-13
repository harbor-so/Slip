"use client";

/**
 * One button, four variants, no component library behind them. Ported from the
 * tandem shell verbatim. `settle` is the variant for buttons that resolve a
 * held instruction — visually distinct from `primary` on purpose, because those
 * decide what an agent does on behalf of two people who disagreed.
 */

import { forwardRef } from "react";
import { cx } from "./format.js";

type Variant = "primary" | "quiet" | "ghost" | "settle" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
	primary: "bg-accent text-bg hover:brightness-110 disabled:hover:brightness-100",
	quiet: "bg-raised text-text border border-line hover:border-line-strong hover:bg-line/40",
	ghost: "text-muted hover:text-text hover:bg-raised",
	settle: "bg-hold-quiet text-hold border border-hold/50 hover:bg-hold hover:text-bg",
	danger: "bg-transparent text-bad border border-bad/40 hover:bg-bad/10",
};

const SIZES: Record<Size, string> = {
	sm: "h-7 px-2.5 text-xs gap-1.5",
	md: "h-9 px-3.5 text-sm gap-2",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: Variant;
	size?: Size;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ variant = "quiet", size = "md", className, type, ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			type={type ?? "button"}
			className={cx(
				"inline-flex items-center justify-center rounded-md font-medium",
				"transition-colors duration-100 select-none",
				"disabled:opacity-40 disabled:pointer-events-none",
				SIZES[size],
				VARIANTS[variant],
				className,
			)}
			{...rest}
		/>
	);
});
