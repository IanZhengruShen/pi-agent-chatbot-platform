import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Database } from "../db/types.js";
import type { AuthResponse, JwtPayload } from "./types.js";

const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = "7d";

function getJwtSecret(): string {
	const secret = process.env.JWT_SECRET;
	if (!secret) {
		throw new Error("JWT_SECRET environment variable is not set");
	}
	return secret;
}

/** Sign a JWT token from user data. */
export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">): string {
	return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

/** Verify and decode a JWT token. Returns null if invalid/expired. */
export function verifyJwt(token: string): JwtPayload | null {
	try {
		return jwt.verify(token, getJwtSecret()) as JwtPayload;
	} catch {
		return null;
	}
}

/**
 * Register a new user.
 * - If teamName is provided, creates a new team and the user becomes admin.
 * - If no teamName, creates a "Personal" team and the user becomes admin.
 * - First user in a team is always admin.
 */
export async function registerUser(
	db: Database,
	email: string,
	password: string,
	displayName?: string,
	teamName?: string,
): Promise<AuthResponse> {
	// Check for existing user
	const { rows: existing } = await db.query(
		"SELECT id FROM users WHERE email = $1",
		[email],
	);
	if (existing.length > 0) {
		throw new ConflictError("A user with this email already exists");
	}

	const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
	const client = await db.getClient();

	try {
		await client.query("BEGIN");

		// Create team
		const { rows: teamRows } = await client.query(
			"INSERT INTO teams (name) VALUES ($1) RETURNING id, name",
			[teamName || "Personal"],
		);
		const team = teamRows[0];

		// First user in team is admin
		const role = "admin";

		const { rows: userRows } = await client.query(
			`INSERT INTO users (team_id, email, password_hash, display_name, role)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, email, display_name, role, team_id`,
			[team.id, email, passwordHash, displayName || null, role],
		);
		const user = userRows[0];

		await client.query("COMMIT");

		const token = signJwt({
			sub: user.id,
			teamId: user.team_id,
			email: user.email,
			role: user.role,
		});

		return {
			token,
			user: {
				id: user.id,
				email: user.email,
				displayName: user.display_name,
				role: user.role,
				teamId: user.team_id,
				teamName: team.name,
			},
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

/**
 * Login an existing user with email/password.
 * Updates last_login timestamp.
 */
export async function loginUser(
	db: Database,
	email: string,
	password: string,
): Promise<AuthResponse> {
	const { rows } = await db.query(
		`SELECT u.id, u.email, u.password_hash, u.display_name, u.role, u.team_id, t.name as team_name
		 FROM users u
		 JOIN teams t ON t.id = u.team_id
		 WHERE u.email = $1`,
		[email],
	);

	if (rows.length === 0) {
		throw new AuthError("Invalid email or password");
	}

	const user = rows[0];

	if (!user.password_hash) {
		throw new AuthError("This account uses SSO login");
	}

	const valid = await bcrypt.compare(password, user.password_hash);
	if (!valid) {
		throw new AuthError("Invalid email or password");
	}

	// Update last_login
	await db.query("UPDATE users SET last_login = now() WHERE id = $1", [
		user.id,
	]);

	const token = signJwt({
		sub: user.id,
		teamId: user.team_id,
		email: user.email,
		role: user.role,
	});

	return {
		token,
		user: {
			id: user.id,
			email: user.email,
			displayName: user.display_name,
			role: user.role,
			teamId: user.team_id,
			teamName: user.team_name,
		},
	};
}

/** Custom error for 409 Conflict (duplicate registration). */
export class ConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConflictError";
	}
}

/** Custom error for 401 Unauthorized (bad credentials). */
export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}
