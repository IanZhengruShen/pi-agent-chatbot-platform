/**
 * Reusable profile card for grid display in the Agent Studio.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ProfileInfo, SkillInfo } from "./types.js";

@customElement("profile-card")
export class ProfileCard extends LitElement {
	static override styles = css`
		:host {
			display: block;
		}
		.card {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.75rem;
			background: var(--card, #fff);
			cursor: pointer;
			transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
			height: 100%;
		}
		.card:hover {
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
			border-color: var(--primary, #2563eb);
			transform: scale(1.02);
		}
		.card.selected {
			border-color: var(--primary, #2563eb);
			box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary, #2563eb) 20%, transparent);
		}
		.card-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}
		.card-icon {
			font-size: 1.5rem;
			line-height: 1;
			width: 2rem;
			height: 2rem;
			display: flex;
			align-items: center;
			justify-content: center;
			background: var(--muted, #f3f4f6);
			border-radius: 0.5rem;
			flex-shrink: 0;
		}
		.card-icon.empty {
			font-size: 1rem;
			color: var(--muted-foreground, #6b7280);
		}
		.card-title {
			font-weight: 600;
			font-size: 0.9rem;
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.scope-badge {
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-size: 0.6rem;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			flex-shrink: 0;
		}
		.scope-badge.platform {
			background: color-mix(in srgb, #3b82f6 15%, var(--muted, #f3f4f6));
			color: #1d4ed8;
		}
		.scope-badge.team {
			background: color-mix(in srgb, #8b5cf6 15%, var(--muted, #f3f4f6));
			color: #6d28d9;
		}
		.scope-badge.user {
			background: color-mix(in srgb, #22c55e 15%, var(--muted, #f3f4f6));
			color: #15803d;
		}
		.card-desc {
			font-size: 0.8rem;
			color: var(--muted-foreground, #6b7280);
			overflow: hidden;
			text-overflow: ellipsis;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			line-height: 1.4;
			min-height: 0;
		}
		.card-meta {
			display: flex;
			gap: 0.5rem;
			align-items: center;
			font-size: 0.7rem;
			color: var(--muted-foreground, #6b7280);
			flex-wrap: wrap;
			margin-top: auto;
		}
		.meta-item {
			display: flex;
			align-items: center;
			gap: 0.25rem;
		}
		.card-actions {
			display: flex;
			gap: 0.375rem;
			justify-content: flex-end;
			margin-top: 0.25rem;
		}
		button {
			padding: 0.25rem 0.75rem;
			border: none;
			border-radius: 0.375rem;
			font-size: 0.75rem;
			cursor: pointer;
			font-weight: 500;
		}
		.btn-edit {
			background: transparent;
			color: var(--primary, #2563eb);
			border: 1px solid var(--primary, #2563eb);
		}
		.btn-edit:hover {
			background: color-mix(in srgb, var(--primary, #2563eb) 10%, transparent);
		}
		.btn-danger {
			background: transparent;
			color: var(--destructive, #dc2626);
			border: 1px solid var(--destructive, #dc2626);
		}
		.btn-danger:hover {
			background: color-mix(in srgb, var(--destructive, #dc2626) 10%, transparent);
		}
		/* Compact mode (for dropdown/list usage) */
		:host([compact]) .card {
			flex-direction: row;
			align-items: center;
			padding: 0.5rem 0.75rem;
			gap: 0.75rem;
		}
		:host([compact]) .card-desc {
			-webkit-line-clamp: 1;
		}
		:host([compact]) .card-meta {
			margin-top: 0;
		}
	`;

	@property({ type: Object })
	profile!: ProfileInfo;

	@property({ type: Array })
	availableSkills: SkillInfo[] = [];

	@property({ type: Boolean, reflect: true })
	selected = false;

	@property({ type: Boolean, reflect: true })
	compact = false;

	@property({ type: Boolean })
	showActions = false;

	private _dispatch(name: string) {
		this.dispatchEvent(new CustomEvent(name, { detail: { profile: this.profile }, bubbles: true, composed: true }));
	}

	override render() {
		const p = this.profile;
		if (!p) return nothing;

		const skillNames = p.skill_ids
			? this.availableSkills.filter(s => p.skill_ids!.includes(s.id)).map(s => s.name)
			: [];

		return html`
			<div class="card ${this.selected ? "selected" : ""}" @click=${() => this._dispatch("select")}>
				<div class="card-header">
					<div class="card-icon ${p.icon ? "" : "empty"}">
						${p.icon || "\u{1F916}"}
					</div>
					<span class="card-title">${p.name}</span>
					<span class="scope-badge ${p.scope}">${p.scope}</span>
				</div>
				${p.description ? html`<div class="card-desc">${p.description}</div>` : nothing}
				<div class="card-meta">
					${p.model_id ? html`<span class="meta-item">${p.model_id}</span>` : nothing}
					${skillNames.length > 0 ? html`<span class="meta-item">${skillNames.length} skill${skillNames.length > 1 ? "s" : ""}</span>` : nothing}
					<span class="meta-item">${p.use_count} use${p.use_count !== 1 ? "s" : ""}</span>
				</div>
				${this.showActions ? html`
					<div class="card-actions">
						<button class="btn-edit" @click=${(e: Event) => { e.stopPropagation(); this._dispatch("edit"); }}>Edit</button>
						<button class="btn-danger" @click=${(e: Event) => { e.stopPropagation(); this._dispatch("delete"); }}>Delete</button>
					</div>
				` : nothing}
			</div>
		`;
	}
}
