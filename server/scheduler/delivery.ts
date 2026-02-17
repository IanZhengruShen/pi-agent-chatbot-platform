/**
 * Delivery Service: send job results via email or Teams webhook.
 *
 * Supports:
 * - Email via SMTP (nodemailer)
 * - Microsoft Teams via webhook
 * - Retry logic: 3 attempts with exponential backoff (0s, 30s, 120s)
 * - Strict mode: delivery failures cause job failure
 */

import nodemailer from "nodemailer";
import type { JobExecutionResult } from "./job-executor.js";

export interface DeliveryResult {
	status: "sent" | "failed";
	error?: string;
}

type DeliveryConfig = { type: "email"; to: string } | { type: "teams"; webhook: string };

const RETRY_DELAYS_MS = [0, 30_000, 120_000]; // 0s, 30s, 120s

/**
 * Deliver job result via configured delivery method.
 */
export async function deliverResult(
	delivery: DeliveryConfig,
	jobName: string,
	result: JobExecutionResult,
): Promise<DeliveryResult> {
	for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
		// Wait before retry (except first attempt)
		if (attempt > 0) {
			await sleep(RETRY_DELAYS_MS[attempt]);
		}

		try {
			if (delivery.type === "email") {
				await sendEmail(delivery.to, jobName, result);
			} else if (delivery.type === "teams") {
				await sendTeamsWebhook(delivery.webhook, jobName, result);
			}

			return { status: "sent" };
		} catch (err: any) {
			const isLastAttempt = attempt === RETRY_DELAYS_MS.length - 1;
			console.error(
				`[delivery] Attempt ${attempt + 1}/${RETRY_DELAYS_MS.length} failed for ${delivery.type}:`,
				err.message,
			);

			if (isLastAttempt) {
				return {
					status: "failed",
					error: `Failed after ${RETRY_DELAYS_MS.length} attempts: ${err.message}`,
				};
			}
		}
	}

	return { status: "failed", error: "Delivery failed unexpectedly" };
}

/**
 * Send email via SMTP using nodemailer.
 */
async function sendEmail(to: string, jobName: string, result: JobExecutionResult): Promise<void> {
	const smtpHost = process.env.SMTP_HOST;
	const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
	const smtpSecure = process.env.SMTP_SECURE === "true";
	const smtpUser = process.env.SMTP_USER;
	const smtpPassword = process.env.SMTP_PASSWORD;
	const fromAddress = process.env.EMAIL_FROM_ADDRESS || "noreply@chatbot-platform.local";

	if (!smtpHost) {
		throw new Error("SMTP_HOST not configured");
	}

	const transporter = nodemailer.createTransport({
		host: smtpHost,
		port: smtpPort,
		secure: smtpSecure,
		auth: smtpUser ? { user: smtpUser, pass: smtpPassword } : undefined,
	});

	const subject = `[Scheduled Job] ${jobName} - ${result.status}`;
	const timestamp = new Date().toISOString();

	const body = `
Job: ${jobName}
Status: ${result.status}
Executed at: ${timestamp}

${result.status === "success" ? "Result:" : "Error:"}
${result.status === "success" ? result.output || "(no output)" : result.error || "(no error message)"}

${result.usage ? `\nUsage:\nInput tokens: ${result.usage.input}\nOutput tokens: ${result.usage.output}` : ""}
`.trim();

	await transporter.sendMail({
		from: fromAddress,
		to,
		subject,
		text: body,
	});

	console.log(`[delivery] Email sent to ${to} for job "${jobName}"`);
}

/**
 * Send Microsoft Teams webhook message.
 */
async function sendTeamsWebhook(webhook: string, jobName: string, result: JobExecutionResult): Promise<void> {
	const timestamp = new Date().toISOString();

	// Truncate output/error if too long for Teams
	const content = result.status === "success"
		? (result.output || "(no output)")
		: (result.error || "(no error message)");
	const truncatedContent = content.length > 1000 ? content.substring(0, 997) + "..." : content;

	const themeColor = result.status === "success" ? "00FF00" : "FF0000";

	const payload = {
		"@type": "MessageCard",
		"@context": "https://schema.org/extensions",
		themeColor,
		title: `Scheduled Job: ${jobName}`,
		text: `Status: ${result.status}`,
		sections: [
			{
				facts: [
					{ name: "Status", value: result.status },
					{ name: "Executed at", value: timestamp },
				],
				text: truncatedContent,
			},
		],
	};

	const response = await fetch(webhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Teams webhook returned ${response.status}: ${await response.text()}`);
	}

	console.log(`[delivery] Teams webhook sent for job "${jobName}"`);
}

/**
 * Sleep helper for retry delays.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
