/**
 * Lazy-loaded heavy libraries. Each getter caches the module after first import
 * so subsequent calls return the same instance synchronously.
 */

// pdfjs-dist (~800KB)
let _pdfjsLib: typeof import("pdfjs-dist") | null = null;
export async function getPdfjs() {
	if (!_pdfjsLib) {
		_pdfjsLib = await import("pdfjs-dist");
		_pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
			"pdfjs-dist/build/pdf.worker.min.mjs",
			import.meta.url,
		).toString();
	}
	return _pdfjsLib;
}

// xlsx (~500KB)
let _xlsx: typeof import("xlsx") | null = null;
export async function getXlsx() {
	if (!_xlsx) {
		_xlsx = await import("xlsx");
	}
	return _xlsx;
}

// docx-preview (~200KB)
let _docxPreview: typeof import("docx-preview") | null = null;
export async function getDocxPreview() {
	if (!_docxPreview) {
		_docxPreview = await import("docx-preview");
	}
	return _docxPreview;
}

// jszip (~100KB)
let _jszip: any = null;
export async function getJSZip(): Promise<typeof import("jszip")> {
	if (!_jszip) {
		const mod = await import("jszip");
		_jszip = mod.default ?? mod;
	}
	return _jszip;
}

// @lmstudio/sdk (~300KB)
let _lmstudio: typeof import("@lmstudio/sdk") | null = null;
export async function getLMStudio() {
	if (!_lmstudio) {
		_lmstudio = await import("@lmstudio/sdk");
	}
	return _lmstudio;
}

// ollama (~50KB)
let _ollama: typeof import("ollama/browser") | null = null;
export async function getOllama() {
	if (!_ollama) {
		_ollama = await import("ollama/browser");
	}
	return _ollama;
}
