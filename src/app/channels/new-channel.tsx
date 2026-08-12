/**
 * Channel creation folded into `web/chat/NewChannelDialog.tsx` (title + kind in a
 * proper modal) as part of the shared frontend. Re-exported under the original
 * name so any lingering import keeps working against the single implementation.
 */

export { NewChannelDialog as NewChannel } from "@web/chat/NewChannelDialog.js";
