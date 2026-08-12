/**
 * The room's client island now lives in `web/chat/Room.tsx`, where the whole
 * polished frontend is assembled. This file stays as the route's local mount
 * point — `page.tsx` imports `./room.js` — so the wiring seam is unchanged while
 * the implementation moved to the shared `web/` layer.
 */

export { Room } from "@web/chat/Room.js";
