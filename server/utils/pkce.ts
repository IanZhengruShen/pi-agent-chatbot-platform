/**
 * PKCE utilities for OAuth flows.
 *
 * Generates code verifier and challenge for Proof Key for Code Exchange (RFC 7636)
 */

import { webcrypto } from "node:crypto";

/**
 * Encode bytes as base64url string.
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return Buffer.from(binary, "binary")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

/**
 * Generate PKCE code verifier and challenge.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(32);
	webcrypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await webcrypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
