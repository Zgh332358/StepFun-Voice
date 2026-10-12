// Channels and the Key saved by the first-run setup in the voice panel.
// The Key is stored only after it passed a live check, in a file readable by the
// current user alone. Environment variables keep working as before.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Verified 2026-10-12 against the live API with one platform Key. */
export const CHANNELS = Object.freeze({
	api: Object.freeze({
		id: "api",
		label: "开放平台 API",
		billing: "按调用量计费",
		baseUrl: "https://api.stepfun.com/v1",
		realtimeModel: "stepaudio-3-realtime-preview",
		ttsModel: "stepaudio-3-tts",
		asrModel: "stepaudio-3-asr-max",
		keyUrl: "https://platform.stepfun.com/interface-key",
	}),
	step_plan: Object.freeze({
		id: "step_plan",
		label: "Step Plan",
		billing: "使用 Step Plan 订阅套餐额度",
		baseUrl: "https://api.stepfun.com/step_plan/v1",
		realtimeModel: "stepaudio-2.5-realtime",
		ttsModel: "stepaudio-2.5-tts",
		asrModel: "stepaudio-2.5-asr",
		keyUrl: "https://platform.stepfun.com/interface-key",
		subscribeUrl: "https://platform.stepfun.com/step-plan",
	}),
});
export const CHANNEL_IDS = Object.freeze(Object.keys(CHANNELS));

export function isChannel(value) { return typeof value === "string" && Object.hasOwn(CHANNELS, value); }

/** Channel implied by an API base URL (official hosts only; validated elsewhere). */
export function channelFromBaseUrl(baseUrl) {
	try { return new URL(baseUrl).pathname.replace(/\/+$/, "").startsWith("/step_plan") ? "step_plan" : "api"; }
	catch { return "api"; }
}

export function credentialsDir(env = process.env) {
	return env.STEP_VOICE_HOME || join(env.HOME || homedir(), ".stepcode", "step-voice");
}
export function credentialsFile(env = process.env) { return join(credentialsDir(env), "credentials.json"); }

export function validKeyShape(key) {
	return typeof key === "string" && key.length >= 16 && key.length <= 2048 && /^[\x21-\x7e]+$/.test(key);
}

/** Saved setup, or undefined. A file with loose permissions or bad content is ignored. */
export function loadSavedCredentials(env = process.env) {
	const file = credentialsFile(env);
	try {
		const info = lstatSync(file);
		if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return undefined;
		if (info.mode & 0o077) chmodSync(file, 0o600);
		const data = JSON.parse(readFileSync(file, "utf8"));
		if (data?.version !== 1 || !isChannel(data.channel)) return undefined;
		const apiKey = typeof data.apiKey === "string" ? data.apiKey.trim() : "";
		return { channel: data.channel, apiKey: validKeyShape(apiKey) ? apiKey : "", savedAt: String(data.savedAt || "") };
	} catch {
		return undefined;
	}
}

/**
 * Save the setup. `apiKey` may be empty when the user chose to keep using the
 * Key from the environment; then only the channel is remembered.
 */
export function saveCredentials({ channel, apiKey = "" }, env = process.env) {
	if (!isChannel(channel)) throw new Error("接入通道无效。");
	if (apiKey && !validKeyShape(apiKey)) throw new Error("API Key 格式无效。");
	const dir = credentialsDir(env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const file = credentialsFile(env);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ version: 1, channel, apiKey, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, file);
	return file;
}

export function clearCredentials(env = process.env) {
	const file = credentialsFile(env);
	if (existsSync(file)) rmSync(file, { force: true });
}

/** Last four characters only, for "检测到 …abcd" style hints. */
export function keyHint(key) {
	return typeof key === "string" && key.length >= 8 ? `…${key.slice(-4)}` : "";
}
