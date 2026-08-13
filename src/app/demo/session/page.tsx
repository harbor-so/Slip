/**
 * The demo's session/chat view — the multiplayer transcript after a goal opens
 * a session. Matches harbor-app/apps/demo's session scene, Harbor's names.
 */

import { DemoSession } from "@web/chat/DemoSession.js";

export const dynamic = "force-dynamic";

export default function DemoSessionPage() {
	return <DemoSession />;
}
