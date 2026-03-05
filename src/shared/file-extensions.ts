/** Binary file extensions that require base64 encoding for transport. */
export const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
	"pdf", "xlsx", "xls", "docx", "pptx", "ppt",
]);

/** Text-based file extensions the artifacts panel can render. */
const TEXT_EXTENSIONS = new Set([
	"html", "htm", "svg", "md", "markdown",
	"txt", "json", "xml", "yaml", "yml", "csv",
	"js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h",
	"css", "scss", "sass", "less", "sh",
]);

/** All file extensions the artifacts panel can render (binary + text). */
export const RENDERABLE_EXTENSIONS = new Set([...BINARY_EXTENSIONS, ...TEXT_EXTENSIONS]);

/**
 * Extensions that should auto-create artifact tabs when detected in tool args.
 * Limited to "final output" types (documents, presentations, images, rich visuals)
 * to avoid cluttering the panel with intermediate code/config/skill files.
 */
export const ARTIFACT_AUTO_DETECT_EXTENSIONS = new Set([
	// Documents & presentations
	"pdf", "xlsx", "xls", "docx", "pptx", "ppt",
	// Images
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
	// Rich visual content
	"html", "htm", "svg",
]);
