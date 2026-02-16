import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** 300 req/min per user for general API routes */
export const apiRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 300,
	keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req),
	standardHeaders: true,
	legacyHeaders: false,
	message: { success: false, error: "Too many requests, please try again later" },
});

/** 60 req/min per user for chat message endpoints */
export const chatRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 60,
	keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req),
	standardHeaders: true,
	legacyHeaders: false,
	message: { success: false, error: "Too many messages, please slow down" },
});

/** 10 req/min per IP for auth endpoints (login/register) */
export const authRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 10,
	keyGenerator: (req) => ipKeyGenerator(req),
	standardHeaders: true,
	legacyHeaders: false,
	message: { success: false, error: "Too many auth attempts, please try again later" },
});
