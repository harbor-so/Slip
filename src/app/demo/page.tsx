/**
 * The reference chat screen — tandem's transcript recreated with a hardcoded
 * Priya conversation. Static on purpose; the live version is the real Room.
 */

import { DemoTranscript } from "@web/chat/DemoTranscript.js";

export const dynamic = "force-dynamic";

export default function DemoPage() {
	return <DemoTranscript />;
}
