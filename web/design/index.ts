/**
 * The frontend's presentation vocabulary, in one import.
 *
 * The existing dashboard primitives (`Badge`, `Card`, `Empty`, `SectionLabel`,
 * `Stat`, `cn`) already carry Harbor's visual language through the design tokens
 * in `globals.css`, so they are re-exported here rather than reinvented — a
 * component in `web/` pulls everything it paints with from `@web/design`, and the
 * new interaction pieces (Avatar, Dialog, PresenceDot, RelTime) sit beside them
 * as one surface.
 */

export { Avatar } from "./Avatar.js";
export { Dialog } from "./Dialog.js";
export { PresenceDot } from "./PresenceDot.js";
export { RelTime } from "./RelTime.js";
export { Badge, Card, Empty, SectionLabel, Stat, cn, type Tone } from "~/components/ui.js";
