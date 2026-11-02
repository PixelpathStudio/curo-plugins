#!/usr/bin/env node
// Curo agent hook for Claude Code and Codex. Node >= 18, no dependencies.
//
//   node curo-hook.mjs claude_code   (or: codex, or auto)      hook JSON on stdin
//
// "auto" is for a plugin's hooks, shared by both hosts: Codex sets PLUGIN_ROOT
// for plugin hooks, Claude Code sets only CLAUDE_PLUGIN_ROOT.
//
// It sends a small session signal to Curo from a detached child process and
// exits 0 at once.
//
// By default the ONLY thing sent is a session start with the repo name
// ("owner/name" from the origin git remote; no remote, nothing sent). Prompt
// summaries are opt-in (CURO_AGENT_SHARE_PROMPTS=1) and are plain words only:
// no digits, paths, file names, URLs, emails, quotes or punctuation, and never
// a word that follows a credential keyword.
//
// PAIRING: the Curo connector's pair_activity_hooks tool has the assistant
// write ~/.config/curo/pairing.json ({code, apiUrl}). On its next run the hook
// trades the one-time code for its own token at that Gateway (revoking its old
// token-file token when it belongs to that same Gateway), saves the token and the
// Gateway's address under ~/.config/curo/, and removes the file.
//
// HARD RULES
//   - Print NOTHING to stdout or stderr, ever. Claude Code adds a
//     UserPromptSubmit hook's stdout to the conversation.
//   - Exit 0 on every error (missing token, no git, no network, bad input).
//   - Never send a path or a folder name: the repo comes only from a remote.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Stop and SessionEnd are deliberately not sent: they only leak activity timing.
const EVENTS = {
	SessionStart: "session_start",
	UserPromptSubmit: "prompt",
};
const TOOLS = ["claude_code", "codex"];
const SUMMARY_MAX = 200;
const SUMMARY_MAX_WORDS = 12;
const SUMMARY_MIN_WORDS = 2;
const WORD_MIN = 2;
const WORD_MAX = 30;
const REPO_MAX = 200;
const SESSION_ID_MAX = 200;
const POST_TIMEOUT_MS = 10_000;
export const DEFAULT_API_URL = "https://prodapi.curohq.com";

/** Hook event name -> Curo event, or null for an event we do not send. */
export function eventOf(hookEventName) {
	return Object.hasOwn(EVENTS, hookEventName) ? EVENTS[hookEventName] : null;
}

const NAME = "[A-Za-z0-9._-]+";
const REMOTE_PATTERNS = [
	// https://[user@]host[:port]/owner/name[.git]
	new RegExp(
		`^https?://(?:[^@/\\s]+@)?[^@/\\s]+/(${NAME})/(${NAME}?)(?:\\.git)?/?$`,
	),
	// ssh://[user@]host[:port]/owner/name[.git]
	new RegExp(
		`^ssh://(?:[^@/\\s]+@)?[^@/\\s]+/(${NAME})/(${NAME}?)(?:\\.git)?/?$`,
	),
	// scp-style: [user@]host:owner/name[.git]
	new RegExp(`^(?:[^@/:\\s]+@)?[^@/:\\s]+:(${NAME})/(${NAME}?)(?:\\.git)?/?$`),
];
const DOT_NAMES = [".", ".."];

/**
 * "owner/name" from an https, ssh:// or scp-style git remote whose owner and
 * name are each [A-Za-z0-9._-]+; anything else (file://, ~user, a deeper path,
 * a local path) is null.
 */
export function parseRemote(remoteUrl) {
	if (typeof remoteUrl !== "string") return null;
	const url = remoteUrl.trim();
	for (const pattern of REMOTE_PATTERNS) {
		const match = pattern.exec(url);
		if (!match) continue;
		const [, owner, name] = match;
		if (DOT_NAMES.includes(owner) || DOT_NAMES.includes(name)) return null;
		return `${owner}/${name}`.slice(0, REPO_MAX);
	}
	return null;
}

/** The repo to report: only ever from a git remote, never a folder name. */
export function repoOf(remoteUrl) {
	return parseRemote(remoteUrl) ?? undefined;
}

/** Prompt summaries are off unless CURO_AGENT_SHARE_PROMPTS=1. */
export function sharePromptsOf(env) {
	return env.CURO_AGENT_SHARE_PROMPTS?.trim() === "1";
}

const WORD = new RegExp(`^\\p{L}{${WORD_MIN},${WORD_MAX}}$`, "u");
const CREDENTIAL_WORDS = new Set([
	"password",
	"passwd",
	"pass",
	"pwd",
	"secret",
	"token",
	"key",
	"apikey",
	"bearer",
	"authorization",
	"auth",
	"credential",
	"credentials",
	"login",
	"username",
	"user",
]);

/** Letters only, WORD_MIN to WORD_MAX of them. */
export function isPlainWord(token) {
	return WORD.test(token);
}

/** A token with everything but its letters removed is a credential keyword. */
export function isCredentialKeyword(token) {
	return CREDENTIAL_WORDS.has(token.replace(/\P{L}/gu, "").toLowerCase());
}

/**
 * True when every token is a plain word and none is a credential keyword.
 * Mirrored by the Gateway's summaryIsPlainWords.
 */
export function isWordsOnly(text) {
	const tokens = text.split(/\s+/).filter(Boolean);
	return (
		tokens.length > 0 &&
		tokens.every((t) => isPlainWord(t) && !isCredentialKeyword(t))
	);
}

/** Plain words of one line; a credential keyword and the token after it are dropped. */
export function plainWordsOf(line) {
	const words = [];
	let dropNext = false;
	for (const raw of line.split(/\s+/).filter(Boolean)) {
		if (dropNext) {
			dropNext = false;
			continue;
		}
		if (isCredentialKeyword(raw)) {
			dropNext = true;
			continue;
		}
		const token = raw.replace(/[.,!?:;]+$/, "");
		if (isPlainWord(token)) words.push(token);
	}
	return words;
}

/** The first words that fit the word and length limits, never cut mid-word. */
function takeWithinLimits(words) {
	const kept = [];
	let length = 0;
	for (const word of words) {
		const next = length + (kept.length ? 1 : 0) + word.length;
		if (kept.length >= SUMMARY_MAX_WORDS || next > SUMMARY_MAX) break;
		kept.push(word);
		length = next;
	}
	return kept;
}

/** Plain words of the prompt's first non-empty line, or undefined when under two. */
export function summaryOf(prompt) {
	if (typeof prompt !== "string") return undefined;
	const line = prompt.split(/\r?\n/).find((l) => l.trim().length > 0);
	if (!line) return undefined;
	const words = takeWithinLimits(plainWordsOf(line));
	if (words.length < SUMMARY_MIN_WORDS) return undefined;
	return words.join(" ");
}

function isKnownTool(tool) {
	return TOOLS.includes(tool);
}

function sessionIdOf(input) {
	return typeof input.session_id === "string"
		? input.session_id.slice(0, SESSION_ID_MAX)
		: "";
}

/** Only a prompt event carries any of the user's text, and only when opted in. */
function summaryForEvent(event, input, sharePrompts) {
	return event === "prompt" && sharePrompts
		? summaryOf(input.prompt)
		: undefined;
}

/** The body to POST for one hook input, or null when nothing should be sent. */
export function buildSignal(
	tool,
	input,
	remoteUrl,
	now = new Date(),
	sharePrompts = false,
) {
	if (!isKnownTool(tool) || !input || typeof input !== "object") return null;
	const event = eventOf(input.hook_event_name);
	const sessionId = sessionIdOf(input);
	if (!event || !sessionId) return null;
	const repo = repoOf(remoteUrl);
	if (event === "session_start" && !repo) return null;
	const summary = summaryForEvent(event, input, sharePrompts);
	if (event === "prompt" && !summary) return null;
	const signal = { tool, event, sessionId, observedAt: now.toISOString() };
	if (repo) signal.repo = repo;
	if (summary) signal.summary = summary;
	return signal;
}

const configDir = (home) => join(home, ".config", "curo");

function readConfigFile(home, name) {
	try {
		return readFileSync(join(configDir(home), name), "utf8").trim();
	} catch {
		return "";
	}
}

/**
 * The API base. A token travels with its Gateway: a paired token (in the file)
 * goes to the Gateway that issued it (api-url), whatever CURO_API_URL says.
 * Otherwise CURO_API_URL, else the public Gateway.
 */
export function apiUrlOf(env, home = "") {
	const paired = !env.CURO_AGENT_TOKEN?.trim() && home ? readConfigFile(home, "api-url") : "";
	return paired || env.CURO_API_URL?.trim() || DEFAULT_API_URL;
}

/** CURO_AGENT_TOKEN, else ~/.config/curo/agent-token, else "". */
export function readToken(env, home) {
	return env.CURO_AGENT_TOKEN?.trim() || readConfigFile(home, "agent-token");
}

/** A Gateway the hook may hand a token to: https, or plain http only on this machine (a local Gateway). */
export function isGatewayUrl(raw) {
	try {
		const url = new URL(raw);
		if (url.protocol === "https:") return true;
		return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	} catch {
		return false;
	}
}

/** The pairing the connector asked for ({code, apiUrl}), or null when there is none or it is unreadable. */
export function readPairing(home) {
	try {
		const pairing = JSON.parse(readConfigFile(home, "pairing.json"));
		const apiUrl = typeof pairing?.apiUrl === "string" ? pairing.apiUrl.trim() : "";
		if (typeof pairing?.code !== "string" || !isGatewayUrl(apiUrl)) return null;
		return { code: pairing.code, apiUrl: apiUrl.replace(/\/+$/, "") };
	} catch {
		return null;
	}
}

/** What a pairing answer means for the pairing file: a token saved, the code dead (drop it), or try again later. */
export function pairingStep(status) {
	if (status === 201) return "paired";
	return status === 400 || status === 409 ? "drop" : "retry";
}

/** Writes a file under ~/.config/curo/ readable only by the user, even when it (or the folder) already existed. */
export function writeConfigFile(home, name, text) {
	mkdirSync(configDir(home), { recursive: true, mode: 0o700 });
	chmodSync(configDir(home), 0o700);
	const path = join(configDir(home), name);
	writeFileSync(path, `${text}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/** Removes the pairing file if it still holds this code: a newer pairing written meanwhile stays. */
export function dropPairing(home, code) {
	if (readPairing(home)?.code !== code) return;
	try {
		unlinkSync(join(configDir(home), "pairing.json"));
	} catch {
		// already gone
	}
}

/**
 * The token a pairing may name for revoking: only the token file's (never
 * CURO_AGENT_TOKEN, which would stay in use), and only when it belongs to the
 * Gateway the pairing goes to, so a token is never handed to another host.
 */
export function replaceableToken(env, home, pairing) {
	if (!pairing || env.CURO_AGENT_TOKEN?.trim()) return "";
	const token = readConfigFile(home, "agent-token");
	return token && apiUrlOf(env, home).replace(/\/+$/, "") === pairing.apiUrl ? token : "";
}

/** POSTs the code (and the token it replaces) to the Gateway that made it; the answer's status and token. */
async function requestPairedToken(pairing, oldToken) {
	const res = await fetch(`${pairing.apiUrl}/api/agent-tokens/pair`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code: pairing.code, ...(oldToken ? { replaces: oldToken } : {}) }),
		signal: AbortSignal.timeout(POST_TIMEOUT_MS),
	});
	const step = pairingStep(res.status);
	const token = step === "paired" ? (await res.json().catch(() => ({}))).token : undefined;
	return { step, token: typeof token === "string" ? token : "" };
}

/**
 * Trades the pairing code for the hook's own token. Once the Gateway has
 * answered for good (paired, used, expired) the code is spent, so the file goes;
 * a token is saved with its Gateway. Returns {token, url}, or null.
 */
async function pairWith(pairing, home, oldToken) {
	const { step, token } = await requestPairedToken(pairing, oldToken);
	if (step === "retry") return null;
	dropPairing(home, pairing.code);
	if (!token) return null;
	writeConfigFile(home, "agent-token", token);
	writeConfigFile(home, "api-url", pairing.apiUrl);
	return { token, url: pairing.apiUrl };
}

function gitRemote(cwd) {
	if (typeof cwd !== "string" || !cwd) return "";
	try {
		return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		});
	} catch {
		return "";
	}
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/** The detached child: reads {url, token, body, pairing, home, replaces} from stdin, pairs first if asked, then POSTs. No output. */
async function deliverSignalFromStdin() {
	try {
		const { url: heldUrl, token: heldToken, body, pairing, home, replaces } = JSON.parse(readStdin());
		const paired = pairing ? await pairWith(pairing, home, replaces).catch(() => null) : null;
		const { token, url } = paired ?? { token: heldToken, url: heldUrl };
		if (!token || !body) return;
		await fetch(`${url.replace(/\/+$/, "")}/api/agent-signals`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(POST_TIMEOUT_MS),
		});
	} catch {
		// silent by design
	}
}

function startDetachedPost({ url, token, body, pairing, home, replaces }) {
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), "--post"],
		{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
	);
	child.on("error", () => process.exit(0));
	child.stdin.on("error", () => {});
	child.stdin.end(JSON.stringify({ url, token, body, pairing, home, replaces }), () => {
		child.unref();
		process.exit(0);
	});
}

/** The tool a hook runs under: an explicit name, or for "auto" the host that set PLUGIN_ROOT (Codex) or not (Claude Code). */
export function toolOf(arg, env) {
	if (arg !== "auto") return arg;
	return env.PLUGIN_ROOT ? "codex" : "claude_code";
}

export function main(argv = process.argv.slice(2), env = process.env) {
	try {
		if (argv[0] === "--post") {
			deliverSignalFromStdin().finally(() => process.exit(0));
			return;
		}
		const tool = toolOf(argv[0], env);
		const home = homedir();
		const token = readToken(env, home);
		const pairing = readPairing(home);
		const url = apiUrlOf(env, home);
		// Nothing is ever sent without a token, or a pairing that gets one.
		if (!token && !pairing) return process.exit(0);
		let input;
		try {
			input = JSON.parse(readStdin());
		} catch {
			return process.exit(0);
		}
		const body = buildSignal(
			tool,
			input,
			gitRemote(input?.cwd),
			new Date(),
			sharePromptsOf(env),
		);
		// A pairing goes ahead even for an event with nothing to send, so the next one can.
		if (!body && !pairing) return process.exit(0);
		startDetachedPost({ url, token, body, pairing, home, replaces: replaceableToken(env, home, pairing) });
		// Safety net if the child never accepts the write.
		setTimeout(() => process.exit(0), 2000).unref();
	} catch {
		process.exit(0);
	}
}

function runsDirectly() {
	try {
		return (
			Boolean(process.argv[1]) &&
			realpathSync(process.argv[1]) ===
				realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (runsDirectly()) main();
