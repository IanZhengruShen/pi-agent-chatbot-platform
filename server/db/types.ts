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

export interface ProviderKeyRow {
	id: string;
	team_id: string;
	provider: string;
	encrypted_dek: Buffer;
	encrypted_key: Buffer;
	iv: Buffer;
	key_version: number;
	created_at: Date;
	updated_at: Date;
}

export interface SkillRow {
	id: string;
	scope: "platform" | "team" | "user";
	owner_id: string;
	name: string;
	description: string;
	format: "md" | "zip";
	storage_key: string;
	created_at: Date;
	updated_at: Date;
}

export interface UserFileRow {
	id: string;
	user_id: string;
	filename: string;
	content_type: string | null;
	size_bytes: number | null;
	storage_key: string;
	created_at: Date;
}

export interface ScheduledJobRow {
	id: string;
	owner_type: "user" | "team";
	owner_id: string;
	name: string;
	description: string | null;
	cron_expr: string;
	next_run_at: Date;
	prompt: string;
	skill_ids: string[] | null;
	file_ids: string[] | null;
	model_id: string | null;
	provider: string | null;
	delivery: { type: "email"; to: string } | { type: "teams"; webhook: string };
	enabled: boolean;
	last_run_at: Date | null;
	last_status: string | null;
	last_error: string | null;
	failure_count: number;
	created_at: Date;
	updated_at: Date;
	created_by: string;
}

export interface JobRunRow {
	id: string;
	job_id: string;
	started_at: Date;
	finished_at: Date | null;
	status: "running" | "success" | "failed" | "timeout";
	result: any;
	error: string | null;
	usage: any;
	delivery_status: "pending" | "sent" | "failed" | null;
	delivery_error: string | null;
}
