/** Populated by auth middleware onto req.user */
export interface AuthUser {
	userId: string;
	teamId: string;
	email: string;
	role: "admin" | "member";
	displayName?: string;
}

/** Extend Express Request */
declare global {
	namespace Express {
		interface Request {
			user?: AuthUser;
		}
	}
}

/** JWT payload (stored in token) */
export interface JwtPayload {
	sub: string; // userId
	teamId: string;
	email: string;
	role: "admin" | "member";
	iat: number;
	exp: number;
}

/** Login request body */
export interface LoginRequest {
	email: string;
	password: string;
}

/** Register request body */
export interface RegisterRequest {
	email: string;
	password: string;
	displayName?: string;
	teamName?: string;
}

/** Auth response (login + register) */
export interface AuthResponse {
	token: string;
	user: {
		id: string;
		email: string;
		displayName: string | null;
		role: "admin" | "member";
		teamId: string;
		teamName: string;
	};
}
