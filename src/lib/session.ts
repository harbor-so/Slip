/**
 * Who is looking at the dashboard.
 *
 * GitHub OAuth, because the target user already has a GitHub account and
 * building email infrastructure for a pilot is work that teaches you nothing.
 *
 * There is a development bypass, and it is deliberate and narrow. Without it the
 * dashboard cannot be opened at all until someone registers an OAuth app, which
 * means `docker compose up && npm run dev` — the ten-minute path the README
 * promises — would not actually show anything. So: when `GITHUB_CLIENT_ID` is
 * unset AND `NODE_ENV` is not production, the dashboard resolves to the first
 * org in the database and says so in the header.
 *
 * The bypass refuses to engage in production even if the env var is missing,
 * because the failure mode of getting that backwards is an unauthenticated
 * dashboard on the internet. A missing client id in production is a
 * misconfiguration and is treated as one.
 */

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";

const COOKIE = "slip_session";
const MAX_AGE_SECONDS = 30 * 86_400;

export interface Session {
	orgId: string;
	orgName: string;
	userName: string | null;
	/** True when this session came from the dev bypass rather than a real login. */
	unauthenticated: boolean;
}

function secret(): string {
	return process.env.AUTH_SECRET ?? "slip-dev-secret-not-for-production";
}

/** `<userId>.<hmac>` — signed, not encrypted; it carries no secret of its own. */
export function signSession(userId: string): string {
	const mac = createHmac("sha256", secret()).update(userId).digest("base64url");
	return `${userId}.${mac}`;
}

export function verifySession(token: string | undefined): string | null {
	if (!token) return null;
	const cut = token.lastIndexOf(".");
	if (cut <= 0) return null;
	const userId = token.slice(0, cut);
	const supplied = Buffer.from(token.slice(cut + 1));
	const expected = Buffer.from(
		createHmac("sha256", secret()).update(userId).digest("base64url"),
	);
	if (supplied.length !== expected.length) return null;
	return timingSafeEqual(supplied, expected) ? userId : null;
}

export const sessionCookie = {
	name: COOKIE,
	options: {
		httpOnly: true,
		sameSite: "lax" as const,
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: MAX_AGE_SECONDS,
	},
};

export function oauthConfigured(): boolean {
	return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export async function currentSession(): Promise<Session | null> {
	const token = (await cookies()).get(COOKIE)?.value;
	const userId = verifySession(token);

	if (userId) {
		const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
		if (user) {
			const org = await db.query.orgs.findFirst({ where: eq(orgs.id, user.orgId) });
			if (org) {
				return {
					orgId: org.id,
					orgName: org.name,
					userName: user.name,
					unauthenticated: false,
				};
			}
		}
	}

	if (oauthConfigured() || process.env.NODE_ENV === "production") return null;

	const [org] = await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1);
	if (!org) return null;
	return { orgId: org.id, orgName: org.name, userName: null, unauthenticated: true };
}
