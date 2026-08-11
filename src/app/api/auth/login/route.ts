import { NextResponse } from "next/server";
import { oauthConfigured } from "../../../../lib/session.js";

export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json(
			{ error: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." },
			{ status: 503 },
		);
	}
	const callback = new URL("/api/auth/callback", request.url).toString();
	const authorize = new URL("https://github.com/login/oauth/authorize");
	authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
	authorize.searchParams.set("redirect_uri", callback);
	// `read:user` only. Slip needs an identity to attach a session to and nothing
	// else — it never reads repositories through a user token.
	authorize.searchParams.set("scope", "read:user");
	return NextResponse.redirect(authorize.toString());
}
