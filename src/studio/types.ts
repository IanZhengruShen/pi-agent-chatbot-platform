/**
 * Shared types for agent profiles, used by Studio pages and AgentProfilesPanel.
 */

export interface ProfileInfo {
	id: string;
	scope: string;
	owner_id: string;
	name: string;
	description: string | null;
	icon: string | null;
	system_prompt: string;
	prompt_mode: string;
	skill_ids: string[] | null;
	model_id: string | null;
	provider: string | null;
	starter_message: string | null;
	suggested_prompts: string[] | null;
	use_count: number;
	created_at: string;
}

export interface SkillInfo {
	id: string;
	name: string;
	scope: string;
	description: string;
}

export interface ProfileFormData {
	name: string;
	description: string;
	icon: string;
	scope: string;
	system_prompt: string;
	prompt_mode: string;
	skill_ids: string[];
	model_id: string;
	provider: string;
	starter_message: string;
	suggested_prompts: string[];
}

export const EMPTY_FORM: ProfileFormData = {
	name: "",
	description: "",
	icon: "",
	scope: "user",
	system_prompt: "",
	prompt_mode: "replace",
	skill_ids: [],
	model_id: "",
	provider: "",
	starter_message: "",
	suggested_prompts: [],
};
