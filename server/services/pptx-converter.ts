/**
 * Convert PPTX files to PNG slide images using LibreOffice + pdftoppm.
 *
 * Flow: PPTX → PDF (LibreOffice headless) → PNG per page (pdftoppm)
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Convert a PPTX file to an array of base64-encoded PNG slide images.
 */
export async function convertPptxToSlideImages(pptxPath: string): Promise<string[]> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pptx-convert-"));
	const basename = path.basename(pptxPath, path.extname(pptxPath));

	try {
		// Step 1: PPTX → PDF via LibreOffice headless
		// Use isolated user profile to avoid lock conflicts between concurrent conversions
		const profileDir = `file://${path.join(tmpDir, "lo_profile")}`;
		await execFileAsync("soffice", [
			"--headless",
			"--norestore",
			`-env:UserInstallation=${profileDir}`,
			"--convert-to", "pdf",
			"--outdir", tmpDir,
			pptxPath,
		], { timeout: 30_000 });

		const pdfPath = path.join(tmpDir, `${basename}.pdf`);
		await fs.access(pdfPath); // verify it was created

		// Step 2: PDF → PNG per page via pdftoppm
		const slidePrefix = path.join(tmpDir, "slide");
		await execFileAsync("pdftoppm", [
			"-png",
			"-r", "200", // 200 DPI — good balance of quality vs size
			pdfPath,
			slidePrefix,
		], { timeout: 60_000 });

		// Step 3: Read all generated slide PNGs (sorted by page number)
		const files = await fs.readdir(tmpDir);
		const slideFiles = files
			.filter((f) => f.startsWith("slide-") && f.endsWith(".png"))
			.sort();

		const slides: string[] = [];
		for (const file of slideFiles) {
			const buffer = await fs.readFile(path.join(tmpDir, file));
			slides.push(buffer.toString("base64"));
		}

		if (slides.length === 0) {
			throw new Error("LibreOffice produced no slide images");
		}

		console.log(`[pptx-converter] Converted ${slides.length} slide(s) from ${path.basename(pptxPath)}`);
		return slides;
	} finally {
		// Clean up temp directory
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
