/**
 * Human-friendly model name mappings.
 *
 * Translates raw model IDs (e.g. "claude-sonnet-4-20250514") into
 * display-friendly labels (e.g. "Claude Sonnet 4").
 */

export const MODEL_LABELS: Record<string, string> = {
	// Anthropic
	"claude-opus-4-20250514": "Claude Opus 4",
	"claude-sonnet-4-20250514": "Claude Sonnet 4",
	"claude-sonnet-4-5-20250514": "Claude Sonnet 4.5",
	"claude-sonnet-4-6": "Claude Sonnet 4.6",
	"claude-opus-4-6": "Claude Opus 4.6",
	"claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
	"claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
	"claude-3-opus-20240229": "Claude 3 Opus",
	"claude-3-haiku-20240307": "Claude 3 Haiku",
	// OpenAI
	"gpt-4o": "GPT-4o",
	"gpt-4o-mini": "GPT-4o Mini",
	"gpt-4-turbo": "GPT-4 Turbo",
	"gpt-4": "GPT-4",
	"o1-preview": "o1 Preview",
	"o1-mini": "o1 Mini",
	"o3-mini": "o3 Mini",
	// Google
	"gemini-2.0-flash": "Gemini 2.0 Flash",
	"gemini-2.0-pro": "Gemini 2.0 Pro",
	"gemini-1.5-pro": "Gemini 1.5 Pro",
	"gemini-1.5-flash": "Gemini 1.5 Flash",
	// Groq
	"llama-3.3-70b-versatile": "Llama 3.3 70B",
	"llama-3.1-8b-instant": "Llama 3.1 8B",
	// xAI
	"grok-2": "Grok 2",
	"grok-beta": "Grok Beta",
};

/** Get a human-friendly label for a model ID, or the raw ID if unknown. */
export function getModelLabel(modelId: string): string {
	return MODEL_LABELS[modelId] || modelId;
}
