/**
 * The tandem component set, ported as Harbor's frontend base.
 *
 * Pages are migrated onto this vocabulary one at a time; a page still on the
 * old primitives imports from `@web/design` instead. Once every page is here,
 * `@web/design` retires.
 */

export { Avatar, AvatarStack, type Presence, type UserRef } from "./Avatar.js";
export { Badge, Pulse, type Tone } from "./Badge.js";
export { Button, type ButtonProps } from "./Button.js";
export { Bracket, Empty, Panel, SectionLabel, Skeleton } from "./Panel.js";
export {
	clockTime,
	colorOf,
	compactCount,
	cx,
	initialsOf,
	listNames,
	relativeTime,
	usd,
} from "./format.js";
