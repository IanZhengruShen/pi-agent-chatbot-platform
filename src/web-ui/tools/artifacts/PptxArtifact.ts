import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import JSZip from "jszip";
import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { i18n } from "../../utils/i18n.js";
import { ArtifactElement } from "./ArtifactElement.js";

interface SlideData {
	texts: string[];
	imageBlobs: string[]; // data URLs for embedded images
}

const IMAGE_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

/**
 * PPTX slide viewer.
 *
 * Prefers server-rendered PNG slide images (JSON array of base64 strings)
 * produced by LibreOffice. Falls back to client-side JSZip parsing when
 * the server returns raw base64 PPTX content (e.g. LibreOffice not installed).
 */
@customElement("pptx-artifact")
export class PptxArtifact extends ArtifactElement {
	@property({ type: String }) private _content = "";
	@state() private error: string | null = null;
	/** Server-rendered slide images (preferred path) */
	@state() private slideImages: string[] = [];
	/** Client-parsed slide data (JSZip fallback) */
	@state() private slides: SlideData[] = [];
	@state() private currentSlide = 0;
	/** Which rendering mode is active */
	@state() private mode: "images" | "parsed" | null = null;

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		this._content = value;
		this.error = null;
		this.currentSlide = 0;
		this.slideImages = [];
		this.slides = [];
		this.mode = null;
		this.parseContent();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
	}

	private decodeBase64(): Uint8Array {
		let base64Data = this._content;
		if (this._content.startsWith("data:")) {
			const base64Match = this._content.match(/base64,(.+)/);
			if (base64Match) {
				base64Data = base64Match[1];
			}
		}

		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	public getHeaderButtons() {
		return html`
			<div class="flex items-center gap-1">
				${DownloadButton({
					content: this.mode === "parsed" ? this.decodeBase64() : this._content,
					filename: this.filename,
					mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
					title: i18n("Download"),
				})}
			</div>
		`;
	}

	private async parseContent() {
		if (!this._content) return;

		// Try JSON first (server-rendered slide images)
		try {
			const slides = JSON.parse(this._content);
			if (Array.isArray(slides) && slides.length > 0) {
				this.slideImages = slides.map((b64: string) => `data:image/png;base64,${b64}`);
				this.mode = "images";
				return;
			}
		} catch {
			// Not JSON — fall through to JSZip parsing
		}

		// Fallback: parse raw PPTX with JSZip
		await this.parsePptxFallback();
	}

	private async parsePptxFallback() {
		try {
			const zip = await JSZip.loadAsync(this.decodeBase64());

			const slideFiles: string[] = [];
			zip.forEach((p) => {
				if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
			});
			slideFiles.sort((a, b) => {
				return parseInt(a.match(/slide(\d+)/)?.[1] || "0") - parseInt(b.match(/slide(\d+)/)?.[1] || "0");
			});

			const parsedSlides: SlideData[] = [];
			for (const slideFile of slideFiles) {
				const slideXml = await zip.file(slideFile)?.async("text");
				if (!slideXml) continue;

				const texts: string[] = [];
				for (const paragraph of slideXml.split("</a:p>")) {
					const runs = [...paragraph.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
					const text = runs.map((m) => m[1]).join("").trim();
					if (text) texts.push(text);
				}

				const imageBlobs: string[] = [];
				const slideNum = slideFile.match(/slide(\d+)/)?.[1];
				const relsXml = await zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`)?.async("text");
				if (relsXml) {
					for (const m of relsXml.matchAll(/Target="([^"]*\.(png|jpg|jpeg|gif|bmp|webp))"/gi)) {
						let imagePath = m[1];
						if (imagePath.startsWith("../")) imagePath = "ppt/" + imagePath.replace("../", "");
						else if (!imagePath.startsWith("ppt/")) imagePath = "ppt/slides/" + imagePath;

						const imageFile = zip.file(imagePath);
						if (imageFile) {
							const data = await imageFile.async("base64");
							const mime = IMAGE_MIME[m[2].toLowerCase()] || "image/png";
							imageBlobs.push(`data:${mime};base64,${data}`);
						}
					}
				}

				parsedSlides.push({ texts, imageBlobs });
			}

			this.slides = parsedSlides;
			this.mode = "parsed";
			if (this.slides.length === 0) {
				this.error = "No slides found in the presentation";
			}
		} catch (err: any) {
			console.error("Error parsing PPTX:", err);
			this.error = err?.message || "Failed to parse PowerPoint file";
		}
	}

	private get totalSlides(): number {
		return this.mode === "images" ? this.slideImages.length : this.slides.length;
	}

	private goToSlide(index: number) {
		if (index >= 0 && index < this.totalSlides) {
			this.currentSlide = index;
		}
	}

	override render(): TemplateResult {
		if (this.error) {
			return html`
				<div class="h-full flex items-center justify-center bg-background p-4">
					<div class="bg-destructive/10 border border-destructive text-destructive p-4 rounded-lg max-w-2xl">
						<div class="font-medium mb-1">${i18n("Error loading document")}</div>
						<div class="text-sm opacity-90">${this.error}</div>
					</div>
				</div>
			`;
		}

		if (this.totalSlides === 0) {
			return html`
				<div class="h-full flex items-center justify-center bg-background">
					<div class="text-muted-foreground text-sm">Loading presentation...</div>
				</div>
			`;
		}

		return html`
			<div class="h-full flex flex-col bg-background overflow-hidden">
				<!-- Slide content -->
				<div class="flex-1 overflow-auto flex items-center justify-center p-4">
					${this.mode === "images" ? this.renderImageSlide() : this.renderParsedSlide()}
				</div>

				<!-- Navigation -->
				${this.totalSlides > 1
					? html`
							<div class="flex items-center justify-center gap-3 py-3 border-t border-border bg-background">
								<button
									class="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
									?disabled=${this.currentSlide === 0}
									@click=${() => this.goToSlide(this.currentSlide - 1)}
								>
									Prev
								</button>
								<span class="text-sm text-muted-foreground">
									Slide ${this.currentSlide + 1} of ${this.totalSlides}
								</span>
								<button
									class="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
									?disabled=${this.currentSlide === this.totalSlides - 1}
									@click=${() => this.goToSlide(this.currentSlide + 1)}
								>
									Next
								</button>
							</div>
						`
					: ""}
			</div>
		`;
	}

	/** Render a server-rendered PNG slide image */
	private renderImageSlide(): TemplateResult {
		return html`
			<img
				src="${this.slideImages[this.currentSlide]}"
				class="max-w-full max-h-full object-contain rounded-lg shadow-lg"
				alt="Slide ${this.currentSlide + 1}"
			/>
		`;
	}

	/** Render a client-parsed slide (JSZip fallback) */
	private renderParsedSlide(): TemplateResult {
		const slide = this.slides[this.currentSlide];
		return html`
			<div
				class="w-full bg-white text-black rounded-lg shadow-lg overflow-hidden"
				style="max-width: 960px; aspect-ratio: 16/9;"
			>
				<div class="w-full h-full flex flex-col justify-center p-8 overflow-auto">
					${slide.imageBlobs.length > 0
						? html`
								<div class="flex flex-wrap gap-2 justify-center mb-4">
									${slide.imageBlobs.map(
										(src) => html` <img src="${src}" class="max-h-48 max-w-full object-contain rounded" /> `,
									)}
								</div>
							`
						: ""}
					${slide.texts.map((text, idx) => {
						if (idx === 0 && slide.texts.length > 1) {
							return html`<div class="text-2xl font-bold mb-4 text-center">${text}</div>`;
						}
						return html`<div class="text-base mb-2 ${idx === 0 ? "text-xl font-semibold text-center" : ""}">${text}</div>`;
					})}
					${slide.texts.length === 0 && slide.imageBlobs.length === 0
						? html`<div class="text-gray-400 text-center italic">Empty slide</div>`
						: ""}
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"pptx-artifact": PptxArtifact;
	}
}
