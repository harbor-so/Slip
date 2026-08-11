import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { oauthConfigured } from "../../../../lib/session.js";

/**
 * Start GitHub OAuth, with a state parameter.
 *
 * The state was missing, which made this login-CSRF-able: a victim who loaded
 * the attacker's callback URL got a session for the ATTACKER's account, and any
 * API key they then minted landed in the attacker's org. The random value goes
 * into a short-lived httpOnly cookie and is compared in constant time on the way
 * back, so a callback that did not originate here is refused.
 */
export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json(
			{ error: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." },
			{ status: 503 },
		);
	}

	const state = randomBytes(32).toString("base64url");
	const callback = new URL("/api/auth/callback", request.url).toString();
	const authorize = new URL("https://github.com/login/oauth/authorize");
	authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID as string);
	authorize.searchParams.set("redirect_uri", callback);
	// `read:user` only. Slip needs an identity to attach a session to and nothing
	// else — it never reads repositories through a user token.
	authorize.searchParams.set("scope", "read:user");
	authorize.searchParams.set("state", state);

	const response = NextResponse.redirect(authorize.toString());
	response.cookies.set("slip_oauth_state", state, {
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: 600,
	});
	return response;
}
