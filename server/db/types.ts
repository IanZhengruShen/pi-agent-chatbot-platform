import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/** Database access interface */
export interface Database {
	pool: Pool;
	query<T extends QueryResultRow = QueryResultRow>(
		text: string,
		params?: any[],
	): Promise<QueryResult<T>>;
	getClient(): Promise<PoolClient>;
}

/** Row types matching the PostgreSQL schema */

export interface TeamRow {
	id: string;
	azure_tid: string | null;
	name: string;
	settings: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

export interface UserRow {
	id: string;
	azure_oid: string | null;
	team_id: string;
	email: string;
	password_hash: string | null;
	display_name: string | null;
	role: "admin" | "member";
	settings: Record<string, unknown>;
	created_at: Date;
	last_login: Date | null;
}

export interface SessionRow {
	id: string;
	user_id: string;
	title: string;
	model_id: string | null;
	provider: string | null;
	thinking_level: string;
	message_count: number;
	preview: string;
	deleted_at: Date | null;
	created_at: Date;
	last_modified: Date;
}

export interface MessageRow {
	id: string;
	session_id: string;
	ordinal: number;
	role: string;
	content: any;
	stop_reason: string | null;
	usage: any | null;
	created_at: Date;
}
