/**
 * Live preview of a profile as it would appear in chat.
 * Updates in real-time as the user edits the profile form.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ProfileFormData, SkillInfo } from "./types.js";

@customElement("profile-preview")
export class ProfilePreview extends LitElement {
	static override styles = css`
		:host {
			display: block;
		}
		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(4px); }
			to { opacity: 1; transform: translateY(0); }
		}
		.preview {
			animation: fadeIn 0.25s ease-out;
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
			height: 100%;
		}
		.preview-label {
			font-size: 0.7rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--muted-foreground, #6b7280);
		}
		.chat-mockup {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.75rem;
			background: var(--background, #fff);
			overflow-y: auto;
		}
		.profile-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding-bottom: 0.75rem;
			border-bottom: 1px solid var(--border, #e5e7eb);
		}
		.profile-icon {
			font-size: 1.5rem;
			width: 2.25rem;
			height: 2.25rem;
			display: flex;
			align-items: center;
			justify-content: center;
			background: var(--muted, #f3f4f6);
			border-radius: 0.5rem;
		}
		.profile-name {
			font-weight: 600;
			font-size: 0.95rem;
		}
		.profile-desc {
			font-size: 0.8rem;
			color: var(--muted-foreground, #6b7280);
		}
		.starter-message {
			padding: 0.75rem;
			border-radius: 0.5rem;
			background: var(--muted, #f3f4f6);
			font-size: 0.85rem;
			line-height: 1.5;
			white-space: pre-wrap;
		}
		.suggested-prompts {
			display: flex;
			flex-wrap: wrap;
			gap: 0.375rem;
		}
		.prompt-chip {
			padding: 0.375rem 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 1rem;
			font-size: 0.8rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			cursor: default;
		}
		.info-section {
			display: flex;
			flex-direction: column;
			gap: 0.375rem;
			padding-top: 0.5rem;
			border-top: 1px solid var(--border, #e5e7eb);
		}
		.info-row {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font-size: 0.75rem;
		}
		.info-label {
			color: var(--muted-foreground, #6b7280);
			font-weight: 500;
			min-width: 5rem;
		}
		.info-value {
			color: var(--foreground, #111);
		}
		.skill-tag {
			padding: 0.125rem 0.375rem;
			background: var(--muted, #f3f4f6);
			border-radius: 0.25rem;
			font-size: 0.7rem;
		}
		.empty-state {
			flex: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.85rem;
		}
	`;

	@property({ type: Object })
	form!: ProfileFormData;

	@property({ type: Array })
	availableSkills: SkillInfo[] = [];

	override render() {
		const f = this.form;
		if (!f) return html`<div class="preview"><div class="empty-state">No profile data</div></div>`;

		const hasContent = f.name || f.starter_message || f.suggested_prompts.length > 0;
		const selectedSkills = f.skill_ids.length > 0
			? this.availableSkills.filter(s => f.skill_ids.includes(s.id))
			: [];

		return html`
			<div class="preview">
				<div class="preview-label">Chat Preview</div>
				<div class="chat-mockup">
					${!hasContent ? html`
						<div class="empty-state">Start filling in the form to see a preview</div>
					` : html`
						<!-- Profile header -->
						<div class="profile-header">
							<div class="profile-icon">${f.icon || "\u{1F916}"}</div>
							<div>
								<div class="profile-name">${f.name || "Untitled"}</div>
								${f.description ? html`<div class="profile-desc">${f.description}</div>` : nothing}
							</div>
						</div>

						<!-- Starter message -->
						${f.starter_message ? html`
							<div class="starter-message">${f.starter_message}</div>
						` : nothing}

						<!-- Suggested prompts -->
						${f.suggested_prompts.length > 0 ? html`
							<div class="suggested-prompts">
								${f.suggested_prompts.map(p => html`<span class="prompt-chip">${p}</span>`)}
							</div>
						` : nothing}

						<!-- Info section -->
						<div class="info-section">
							${f.prompt_mode ? html`
								<div class="info-row">
									<span class="info-label">Prompt mode</span>
									<span class="info-value">${f.prompt_mode === "replace" ? "Replace default" : "Append to default"}</span>
								</div>
							` : nothing}
							${f.provider ? html`
								<div class="info-row">
									<span class="info-label">Provider</span>
									<span class="info-value">${f.provider}</span>
								</div>
							` : nothing}
							${f.model_id ? html`
								<div class="info-row">
									<span class="info-label">Model</span>
									<span class="info-value">${f.model_id}</span>
								</div>
							` : nothing}
							${selectedSkills.length > 0 ? html`
								<div class="info-row">
									<span class="info-label">Skills</span>
									<span class="info-value">
										${selectedSkills.map(s => html`<span class="skill-tag">${s.name}</span> `)}
									</span>
								</div>
							` : nothing}
						</div>
					`}
				</div>
			</div>
		`;
	}
}
