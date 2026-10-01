/**
 * clm-context.ts — Context Language Model (CLM) plugin for OpenCode.
 *
 * Core mechanism (arXiv 2609.37725): the model owns its own context.
 *
 *   1. Every request the outgoing conversation is MIRRORED to an editable file
 *        <projectDirectory>/.clm/LIVE_CTX_<sessionID>.txt
 *   2. The model edits that file with its ordinary tools (edit/write/shell).
 *   3. On the next request the file is PARSED back into the outgoing message
 *      list, with a protected prefix, a fit/shrink gate, receipts, a budget
 *      meter, threshold nudges, and a system-prompt doctrine section.
 *
 * The file is organised so one core implementation serves both plugin APIs:
 *
 *   - V2 (the active host, OpenCode 2.x):  `export default { id, server, setup }`
 *       setup(ctx) -> ctx.session.hook("context"), ctx.tool.hook("execute.after"),
 *                     ctx.permission.hook("evaluate"), ctx.tool.transform,
 *                     event.system.push(...)
 *   - V1 (legacy hosts):                   `server()` returns Hooks
 *       experimental.chat.messages.transform / experimental.chat.system.transform
 *       tool.execute.after / permission.ask
 *
 * Everything between "pure core" and "adapters" is platform-independent and is
 * exercised by clm-selftest.mjs (imported with --experimental-strip-types).
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

/* ============================================================================
 * 0. Constants
 * ==========================================================================*/

export const PLUGIN_ID = "clm-context";

/** Deterministic id of the standing meter message (msg_ prefix = host id shape). */
export const METER_ID_PREFIX = "msg_clm_meter_";
/** Marker used to detect that the doctrine was already pushed this request. */
export const DOCTRINE_MARKER = "[CLM_DOCTRINE";
/** Marker used to detect an already-appended tool budget line. */
export const BUDGET_LINE_MARKER = "[context: ~";
/** Marker used to find our meter message even if the id was rewritten. */
export const METER_TEXT_MARKER = "[context: ~";

export const DEFAULT_BUDGET = 100000;
export const DEFAULT_GATE: GateMode = "fit";

/** Spec: read overrides from this file if present (simple JSON, comments tolerated). */
export const CLM_CONFIG_PATH = join(homedir(), ".config", "opencode", "clm.jsonc");

/* ============================================================================
 * 1. Pure core — model
 * ==========================================================================*/

export type ClmPart =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "misc"; text: string }
    | { type: "tool"; name: string; args: string; output: string; callId?: string };

/**
 * Neutral message. `original` holds the host-native message (V1 {info,parts}
 * or V2 LLM.Message) so protected / since-render messages are re-emitted
 * byte-identically and their tool pairing is never rebuilt.
 *
 * `display` is the ROLE written in the mirror header. Parsing folds every
 * non-assistant header role to logical role "user" (paper rule), but keeps the
 * header role in `display` so re-rendering the file reproduces exactly what the
 * model saw (render/parse round-trip stability) without ever handing a
 * role="tool" message to the provider.
 */
export interface ClmMessage {
    role: string;
    display?: string;
    parts: ClmPart[];
    key: string;
    original?: unknown;
    synthetic?: boolean;
}

interface Block {
    role: string;
    body: string;
}

/* ============================================================================
 * 2. Pure core — small utilities
 * ==========================================================================*/

/** FNV-1a 32-bit → 8 hex chars. Deterministic, dependency-free. */
export function fnv1a(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

export function hashKey(seed: string): string {
    return `clm_${fnv1a(seed)}`;
}

/** Canonical body form: no trailing whitespace (keeps render/parse idempotent). */
export function normalizeBody(text: string): string {
    return text.replace(/[ \t\r\n]+$/, "");
}

function headerRole(role: string): string {
    return /^[A-Za-z]+$/.test(role) ? role : "user";
}

function joinArgs(input: unknown): string {
    if (typeof input === "string") return input;
    if (input === undefined || input === null) return "";
    try {
        const s = JSON.stringify(input);
        return s === undefined ? "" : s;
    } catch {
        return String(input);
    }
}

/**
 * Split one message's parts into mirror blocks.
 *
 * Real message shape (verified from storage, see report): tool calls AND their
 * results are parts inside the SAME assistant message (`type:"tool"`,
 * `state.output`). Per the design rule every tool output must be individually
 * compressible, so each tool part becomes its own synthetic `role=tool` block
 * that follows the block holding `name(arguments)`. On parse those blocks fold
 * back into plain text — the rebuilt region therefore contains no tool parts at
 * all, so no orphaned tool_use/tool_result pair can be produced.
 */
export function blocksOf(message: ClmMessage): Block[] {
    const role = headerRole(message.display ?? message.role);
    const blocks: Block[] = [];
    let current = "";

    const append = (chunk: string) => {
        if (chunk === "") return;
        current = current === "" ? chunk : `${current}\n\n${chunk}`;
    };
    const flush = () => {
        if (current !== "") blocks.push({ role, body: current });
        current = "";
    };

    for (const part of message.parts) {
        if (part.type === "text") {
            append(part.text);
        } else if (part.type === "reasoning") {
            append(part.text === "" ? "" : `[reasoning] ${part.text}`);
        } else if (part.type === "misc") {
            append(part.text);
        } else if (part.type === "tool") {
            append(`${part.name}(${part.args})`);
            flush();
            const output = normalizeBody(part.output);
            if (output !== "") blocks.push({ role: "tool", body: output });
            current = "";
        }
    }
    flush();
    return blocks;
}

/* ============================================================================
 * 3. Pure core — render (context → file)
 * ==========================================================================*/

/**
 * messages[0] is the protected prefix: rendered as a single `[[PROTECTED]]`
 * block, never numbered, never accepted back from the file.
 * Turn numbering is 1-based over the EDITABLE region only.
 */
export function renderMirror(messages: ClmMessage[]): string {
    const sections: string[] = [];

    if (messages.length > 0) {
        const protectedBody = normalizeBody(
            blocksOf(messages[0])
                .map((b) => b.body)
                .join("\n\n"),
        );
        sections.push(`[[PROTECTED]]\n${protectedBody}`);
    }

    const blocks: Block[] = [];
    for (let i = 1; i < messages.length; i++) {
        for (const block of blocksOf(messages[i])) {
            const body = normalizeBody(block.body);
            if (body === "") continue;
            const last = blocks[blocks.length - 1];
            // Consecutive same effective role collapse into one turn; this makes
            // render ∘ parse a fixed point (round-trip stability).
            if (last && last.role === block.role) last.body = `${last.body}\n\n${body}`;
            else blocks.push({ role: block.role, body });
        }
    }

    blocks.forEach((block, index) => {
        sections.push(`[[CTX_TURN ${index + 1} role=${block.role}]]\n${block.body}`);
    });

    if (sections.length === 0) return "";
    return `${sections.join("\n\n")}\n`;
}

/* ============================================================================
 * 4. Pure core — parse (file → context)
 * ==========================================================================*/

/** Spec-mandated header shape (line anchored, multiline). */
export const TURN_HEADER_RE = /^\[\[CTX_TURN\s+(\d+)\s+role=([A-Za-z]+)\]\][ \t]*\r?$/gm;
export const PROTECTED_HEADER_RE = /^\[\[PROTECTED\]\][ \t]*\r?$/gm;

interface HeaderHit {
    index: number;
    end: number;
    protected: boolean;
    role: string;
}

function collectHeaders(text: string): HeaderHit[] {
    const hits: HeaderHit[] = [];
    TURN_HEADER_RE.lastIndex = 0;
    for (const m of text.matchAll(TURN_HEADER_RE)) {
        hits.push({ index: m.index, end: m.index + m[0].length, protected: false, role: m[2] });
    }
    PROTECTED_HEADER_RE.lastIndex = 0;
    for (const m of text.matchAll(PROTECTED_HEADER_RE)) {
        hits.push({ index: m.index, end: m.index + m[0].length, protected: true, role: "protected" });
    }
    hits.sort((a, b) => a.index - b.index);
    return hits;
}

function skipOneLineEnding(text: string, at: number): number {
    if (text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10) return at + 2;
    if (text.charCodeAt(at) === 10 || text.charCodeAt(at) === 13) return at + 1;
    return at;
}

function turnMessage(headerRoleName: string, body: string): ClmMessage {
    const logical = headerRoleName === "assistant" ? "assistant" : "user";
    return {
        role: logical,
        display: headerRoleName,
        parts: [{ type: "text", text: body }],
        key: hashKey(`turn|${headerRoleName}|${body}`),
        synthetic: true,
    };
}

function noteMessage(body: string): ClmMessage {
    return {
        role: "user",
        display: "user",
        parts: [{ type: "text", text: body }],
        key: hashKey(`note|${body}`),
        synthetic: true,
    };
}

export interface ParsedMirror {
    turns: ClmMessage[];
    protectedSeen: boolean;
    strays: number;
}

/**
 * Parse the mirror. Header NUMBERS are display-only: order comes from file
 * order. Role folding: assistant → assistant, everything else → user (the
 * original header role is preserved in `display` for faithful re-rendering).
 * Empty bodies are dropped. Consecutive turns with the same effective role are
 * merged with "\n\n". Stray text before the first header becomes a user note.
 * The `[[PROTECTED]]` block content is ignored entirely (re-pinned verbatim).
 */
export function parseMirror(text: string): ParsedMirror {
    const headers = collectHeaders(text);
    const turns: ClmMessage[] = [];
    let strays = 0;
    let protectedSeen = false;

    if (headers.length === 0) {
        const stray = normalizeBody(text.trim());
        if (stray !== "") {
            turns.push(noteMessage(stray));
            strays = 1;
        }
        return { turns, protectedSeen, strays };
    }

    const beforeFirst = normalizeBody(text.slice(0, headers[0].index));
    if (beforeFirst.trim() !== "") {
        turns.push(noteMessage(beforeFirst));
        strays = 1;
    }

    for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        if (header.protected) {
            protectedSeen = true;
            continue; // protected content never enters the rebuilt list
        }
        const bodyStart = skipOneLineEnding(text, header.end);
        const bodyEnd = i + 1 < headers.length ? headers[i + 1].index : text.length;
        const body = normalizeBody(text.slice(bodyStart, bodyEnd));
        if (body === "") continue; // emptying a body drops that turn
        turns.push(turnMessage(header.role, body));
    }

    // Consecutive same effective role merged with "\n\n".
    const merged: ClmMessage[] = [];
    for (const turn of turns) {
        const last = merged[merged.length - 1];
        const sameRole = last !== undefined && (last.display ?? last.role) === (turn.display ?? turn.role);
        if (sameRole) {
            last.parts = [...last.parts, ...turn.parts];
            last.key = hashKey(`${last.key}|${turn.key}`);
        } else {
            merged.push(turn);
        }
    }

    return { turns: merged, protectedSeen, strays };
}

/** Rebuild the outgoing list: protected (verbatim) + parsed turns + since-render. */
export function rebuildMessages(
    protectedMessage: ClmMessage | undefined,
    turns: ClmMessage[],
    sinceRender: ClmMessage[],
): ClmMessage[] {
    const out: ClmMessage[] = [];
    if (protectedMessage) out.push(protectedMessage);
    out.push(...turns);
    out.push(...sinceRender);
    return out;
}

/** Text of one message as the provider would see it (used by adapters too). */
export function messageText(message: ClmMessage): string {
    const chunks: string[] = [];
    for (const part of message.parts) {
        if (part.type === "text" || part.type === "reasoning" || part.type === "misc") {
            if (part.text !== "") chunks.push(part.text);
        } else if (part.type === "tool") {
            chunks.push(`${part.name}(${part.args})`);
            if (part.output !== "") chunks.push(part.output);
        }
    }
    return chunks.join("\n\n");
}

/* ============================================================================
 * 5. Pure core — token estimate, gate, receipts
 * ==========================================================================*/

/** Cheap approximation stated as approximate in the doctrine: ~1 token / 4 chars. */
export function estimateTokens(messages: ClmMessage[]): number {
    let chars = 0;
    for (const message of messages) chars += messageText(message).length;
    return Math.ceil(chars / 4);
}

export type GateMode = "fit" | "shrink";

export interface GateResult {
    accept: boolean;
    rule: GateMode;
    ruleText: string;
}

export function gateText(rule: GateMode, limit: number): string {
    return rule === "shrink"
        ? "A compaction must SHRINK context"
        : `An edit must FIT the ${limit}-token limit`;
}

/** Paper `edit_gate.py`. fit (default): reject if after > budget.
 *  shrink: reject if after >= before. */
export function applyGate(mode: GateMode, before: number, after: number, budget: number): GateResult {
    if (mode === "shrink") {
        return { accept: after < before, rule: "shrink", ruleText: gateText("shrink", budget) };
    }
    return { accept: after <= budget, rule: "fit", ruleText: gateText("fit", budget) };
}

export type ReceiptKind = "applied" | "grew" | "stillover" | "nochange" | "rejected";

export interface ReceiptParams {
    before: number;
    after: number;
    baseline?: number;
    limit: number;
    turns: number;
    rule?: GateMode;
}

/** Paper-verbatim receipt wording, adapted to our paths and ~T notation. */
export function receiptFor(kind: ReceiptKind, p: ReceiptParams): string {
    switch (kind) {
        case "applied":
            return `[LIVE_CTX: edit applied — context ~${p.before}->${p.after} tokens, ${p.turns} turns]`;
        case "grew":
            return (
                `[LIVE_CTX: edit applied but it GREW context ~${p.baseline ?? p.before}->${p.after} tokens ` +
                `(it fits, so it was kept). If you meant to condense, you likely duplicated content instead of replacing it.]`
            );
        case "stillover":
            return (
                `[LIVE_CTX: edit applied — context ~${p.before}->${p.after} tokens, but STILL OVER the ~${p.limit}-token limit. ` +
                `Compact more NOW (delete stale turns/outputs) or you'll get one final turn and the session ends.]`
            );
        case "nochange":
            return (
                `[LIVE_CTX: NO change — your edit matched nothing, so context is still ~${p.before} tokens. ` +
                `Match text you have already seen, or target the real turn headers, which look like ` +
                `[[CTX_TURN 12 role=assistant]] (turn index first, then role).]`
            );
        case "rejected":
        default:
            return (
                `[LIVE_CTX: edit REJECTED — ${p.rule ?? "fit"}: your edit was NOT applied (still ~${p.before}). ` +
                `${gateText(p.rule ?? "fit", p.limit)}. ` +
                `You likely duplicated/appended content — replace stale text with a SHORTER summary instead.]`
            );
    }
}

/* ============================================================================
 * 6. Pure core — budget meter + threshold nudges
 * ==========================================================================*/

export interface NudgeState {
    25: boolean;
    50: boolean;
    75: boolean;
}

export const freshNudgeState = (): NudgeState => ({ 25: false, 50: false, 75: false });

export const NUDGE_TEXT: Record<25 | 50 | 75, (tokens: number, budget: number) => string> = {
    25: (tokens, budget) =>
        `CONTEXT BUDGET NUDGE: context is at ~25% of your ${budget}-token budget (${tokens} tokens). ` +
        `No action needed. Before your next few searches, make sure your notes record which queries and documents you already tried.`,
    50: (tokens, budget) =>
        `CONTEXT BUDGET NUDGE: context is at ~50% of your ${budget}-token budget (${tokens} tokens). ` +
        `Finish the unit of work in flight, then tidy ONCE. When you write a replacement note, COPY facts forward from the text you are replacing (quote them): ` +
        `every RULED OUT candidate with its reason and the words 'do not retry'; the exact queries/commands already tried; ` +
        `exact values marked VERIFIED or UNVERIFIED; and a NEXT line.`,
    75: (tokens, budget) =>
        `CONTEXT BUDGET NUDGE: context is at ~75% of your ${budget}-token budget (${tokens} tokens) — close to the limit. ` +
        `Compact settled spans now — but do NOT wipe: edits keeping under 25% of the region they touch are usually followed by re-doing the deleted work. ` +
        `(Same note contract as at 50%.)`,
};

export function urgentNudge(tokens: number, budget: number): string {
    return (
        `CONTEXT BUDGET NUDGE (URGENT): You are at ${tokens}/${budget} tokens — over your hard context limit. ` +
        `Compact your context THIS TURN (do nothing else). Replace stale regions with short summaries.`
    );
}

/**
 * Thresholds 25/50/75% are one-shot and re-arm when tokens drop back below the
 * threshold. Over-budget is standing until under budget. Returns the nudge text
 * ("" when nothing fires) and the updated state.
 */
export function pickNudge(tokens: number, budget: number, state: NudgeState): { text: string; state: NudgeState } {
    const next: NudgeState = { ...state };
    if (budget <= 0) return { text: "", state: next };
    const ratio = tokens / budget;

    for (const thr of [25, 50, 75] as const) {
        if (ratio < thr / 100) next[thr] = false; // re-arm below threshold
    }

    if (ratio > 1) {
        // Standing urgent nudge; lower thresholds count as consumed.
        next[25] = true;
        next[50] = true;
        next[75] = true;
        return { text: urgentNudge(tokens, budget), state: next };
    }

    const order = [75, 50, 25] as const;
    for (const thr of order) {
        if (ratio >= thr / 100 && !next[thr]) {
            // Fire the highest crossed threshold; mark every LOWER one as
            // crossed too (a jump past 50% must not later fire the 25% nudge).
            for (const lower of order) {
                if (lower <= thr) next[lower] = true;
            }
            return { text: NUDGE_TEXT[thr](tokens, budget), state: next };
        }
    }
    return { text: "", state: next };
}

export function meterId(sessionID: string): string {
    return `${METER_ID_PREFIX}${sessionID}`;
}

export interface MeterInput {
    tokens: number;
    budget: number;
    mirrorPath: string;
    receipt?: string;
    nudge?: string;
}

/** ONE standing synthetic user message, rewritten every request. */
export function meterText(input: MeterInput): string {
    const pct = input.budget > 0 ? Math.round((input.tokens / input.budget) * 100) : 0;
    let text = `[context: ~${input.tokens}/${input.budget} tokens (${pct}%)] · mirror: ${input.mirrorPath}`;
    if (input.receipt) text += `\n${input.receipt}`;
    if (input.nudge) text += `\n${input.nudge}`;
    return text;
}

/** V1 `tool.execute.after` / V2 `tool.execute.after` budget line. */
export function budgetLine(tokens: number, budget: number): string {
    return `\n${BUDGET_LINE_MARKER}${tokens}/${budget} tokens]`;
}

export function appendBudgetLine(existing: string, tokens: number, budget: number): string {
    if (existing.includes(BUDGET_LINE_MARKER)) return existing;
    return `${existing}${budgetLine(tokens, budget)}`;
}

/* ============================================================================
 * 7. Pure core — config (clm.jsonc)
 * ==========================================================================*/

/** Strip // and /* *\/ comments while respecting string literals. */
export function stripJsonComments(text: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

export interface ClmConfig {
    budget: number;
    gate: GateMode;
}

export function parseClmConfig(text: string): ClmConfig {
    const config: ClmConfig = { budget: DEFAULT_BUDGET, gate: DEFAULT_GATE };
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonComments(text));
    } catch {
        return config;
    }
    if (parsed && typeof parsed === "object") {
        const raw = parsed as Record<string, unknown>;
        if (typeof raw.budget === "number" && Number.isFinite(raw.budget) && raw.budget > 0) {
            config.budget = Math.floor(raw.budget);
        }
        if (raw.gate === "fit" || raw.gate === "shrink") config.gate = raw.gate;
    }
    return config;
}

export function loadConfig(path: string = CLM_CONFIG_PATH): ClmConfig {
    try {
        return parseClmConfig(readFileSync(path, "utf8"));
    } catch {
        return { budget: DEFAULT_BUDGET, gate: DEFAULT_GATE };
    }
}

/* ============================================================================
 * 8. Pure core — paths
 * ==========================================================================*/

export function mirrorPathFor(directory: string, sessionID: string): string {
    return join(directory, ".clm", `LIVE_CTX_${sessionID}.txt`);
}

/** True when `target` lives inside `<root>/.clm/` (permission passthrough). */
export function insideClmDir(target: string | undefined, root: string | undefined): boolean {
    if (!target || !root) return false;
    const cleaned = target.replace(/\\/g, "/").toLowerCase();
    const rootCleaned = `${root.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "")}/.clm/`;
    let absolute = cleaned;
    if (!absolute.startsWith("/")) {
        if (!isAbsolute(target)) absolute = `${rootCleaned.split("/").slice(0, -2).join("/")}/${cleaned}`;
    }
    return absolute.startsWith(rootCleaned);
}

/* ============================================================================
 * 9. Per-session state + the request pipeline (shared by both adapters)
 * ==========================================================================*/

export interface SessionState {
    directory?: string;
    /** Exact bytes we last wrote to the mirror. */
    lastRender?: string;
    /** Keys of the INPUT message list at the last render (since-render basis). */
    renderKeys?: string[];
    /** True once the model has applied an edit — the file is then authoritative. */
    viewAuthoritative: boolean;
    /** Receipt produced during this request, surfaced in this request's meter. */
    pendingReceipt?: string;
    /** Cached token estimate for the tool budget line. */
    tokens: number;
    nudges: NudgeState;
}

export const createSessionState = (): SessionState => ({
    viewAuthoritative: false,
    tokens: 0,
    nudges: freshNudgeState(),
});

export interface RunInput {
    sessionID: string;
    directory: string;
    /** Outgoing messages with the meter already stripped. Never empty. */
    messages: ClmMessage[];
    config: ClmConfig;
    state: SessionState;
}

export interface RunOutput {
    /** Outgoing messages with the meter appended at the END. */
    messages: ClmMessage[];
    mirrorPath: string;
    meterBody: string;
    tokens: number;
    /** What happened this request, for logging/self-test. */
    action: "init" | "normal" | "applied" | "rejected" | "nochange";
    receipt?: string;
}

function readIfExists(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

function writeAtomically(path: string, content: string): void {
    try {
        mkdirSync(join(path, ".."), { recursive: true });
    } catch {
        /* ignore */
    }
    try {
        writeFileSync(path, content, "utf8");
    } catch {
        /* ignore: a read-only tree must never break the request */
    }
}

/**
 * The whole CLM pipeline for one request. Adapters convert to/from ClmMessage,
 * call this, then build the meter message from `meterBody`.
 */
export function runClm(input: RunInput): RunOutput {
    const { state, config, messages, sessionID, directory } = input;
    const mirrorPath = mirrorPathFor(directory, sessionID);
    state.directory = directory;

    if (messages.length === 0) {
        const tokens = 0;
        state.tokens = tokens;
        return {
            messages,
            mirrorPath,
            meterBody: meterText({ tokens, budget: config.budget, mirrorPath }),
            tokens,
            action: "normal",
        };
    }

    const protectedMessage = messages[0];
    const renderKeys = state.renderKeys;
    const lastKeys = renderKeys ? new Set(renderKeys) : undefined;
    // index 0 is always re-emitted as the protected prefix, never as "since".
    const sinceRender = lastKeys
        ? messages.filter((message, index) => index !== 0 && !lastKeys.has(message.key))
        : [];

    const disk = readIfExists(mirrorPath);
    const changed = disk !== null && state.lastRender !== undefined && disk !== state.lastRender;

    // Divergence guard: messages that were part of the last render but have since
    // vanished from the durable list (session compaction / history rewrite). The
    // mirror's turns would then duplicate or resurrect removed content, so drop
    // the mirror view and re-render from the durable messages (safe fallback;
    // an edit pending against the stale view is discarded and reported as init).
    const keySet = new Set(messages.map((message) => message.key));
    const removed = renderKeys ? renderKeys.filter((key) => !keySet.has(key)).length : 0;
    const diverged = removed > 0 && state.viewAuthoritative;

    let view: ClmMessage[] = messages;
    let action: RunOutput["action"] = "normal";
    let receipt: string | undefined;

    const buildFrom = (content: string): ClmMessage[] =>
        rebuildMessages(protectedMessage, parseMirror(content).turns, sinceRender);

    if (disk === null) {
        // Missing mirror → normal path; drop back to the durable view and reset.
        state.viewAuthoritative = false;
        action = "init";
    } else if (state.lastRender === undefined || diverged) {
        // First contact with a pre-existing mirror (fresh process) or a rewritten
        // history: we cannot attribute the file's content, so keep the durable
        // view and re-render it over the file.
        state.viewAuthoritative = false;
        action = "init";
    } else if (changed) {
        const parsed = parseMirror(disk);
        const proposed = rebuildMessages(protectedMessage, parsed.turns, sinceRender);
        const currentView = state.viewAuthoritative ? buildFrom(state.lastRender) : messages;
        const before = estimateTokens(currentView);
        const after = estimateTokens(proposed);

        if (renderMirror(proposed) === renderMirror(currentView)) {
            // The bytes moved but the conversation did not (header renumbering,
            // an oldString that matched nothing, an edit confined to the
            // [[PROTECTED]] block, line-ending churn, ...).
            view = currentView;
            action = "nochange";
            receipt = receiptFor("nochange", { before, after: before, limit: config.budget, turns: 0 });
        } else {
            const gate = applyGate(config.gate, before, after, config.budget);
            if (gate.accept) {
                view = proposed;
                state.viewAuthoritative = true;
                action = "applied";
                const turns = countTurns(renderMirror(proposed));
                receipt =
                    after > config.budget
                        ? receiptFor("stillover", { before, after, limit: config.budget, turns })
                        : after > before
                          ? receiptFor("grew", {
                                before,
                                after,
                                baseline: before,
                                limit: config.budget,
                                turns,
                            })
                          : receiptFor("applied", { before, after, limit: config.budget, turns });
            } else {
                view = currentView;
                action = "rejected";
                receipt = receiptFor("rejected", {
                    before,
                    after: before,
                    limit: config.budget,
                    turns: 0,
                    rule: gate.rule,
                });
            }
        }
    } else if (state.viewAuthoritative) {
        // No new edit, but an edit was applied earlier: the file IS the context.
        view = buildFrom(disk);
        action = "normal";
    }

    // Keep the mirror in sync with what we are actually sending.
    const rendered = renderMirror(view);
    if (rendered !== "") writeAtomically(mirrorPath, rendered);
    state.lastRender = rendered;
    state.renderKeys = messages.map((m) => m.key);

    const tokens = estimateTokens(view);
    state.tokens = tokens;

    if (receipt) state.pendingReceipt = receipt;

    const nudgeResult = pickNudge(tokens, config.budget, state.nudges);
    state.nudges = nudgeResult.state;

    const pending = state.pendingReceipt;
    state.pendingReceipt = undefined;
    const meterBodyValue = meterText({
        tokens,
        budget: config.budget,
        mirrorPath,
        receipt: pending,
        nudge: nudgeResult.text,
    });

    return {
        messages: [...view],
        mirrorPath,
        meterBody: meterBodyValue,
        tokens,
        action,
        receipt: pending,
    };
}

export function countTurns(rendered: string): number {
    let n = 0;
    TURN_HEADER_RE.lastIndex = 0;
    for (const _ of rendered.matchAll(TURN_HEADER_RE)) n++;
    return n;
}

/* ============================================================================
 * 10. System doctrine
 * ==========================================================================*/

export function doctrineText(options: { mirrorPath: string; budget: number; gate: GateMode }): string {
    const { mirrorPath, budget, gate } = options;
    return `${DOCTRINE_MARKER} v1]
## Managing your context

You own your own context. The conversation you are holding is mirrored to an
editable file:

  ${mirrorPath}

That file IS the context you will hold on your next turn. Edit it with your
ordinary tools — the \`edit\`/\`write\` tools or a PowerShell + python one-liner —
and the next request sends whatever the file says. The system prompt and the
first task message are protected for you: the first task message appears under
\`[[PROTECTED]]\` and is re-pinned verbatim on every turn, and the system prompt
never appears in the file at all.

FORMAT
  [[PROTECTED]]
  <first task message — readable, not editable>

  [[CTX_TURN 1 role=user]]
  <turn body>

  [[CTX_TURN 2 role=assistant]]
  <turn body>
* Turn numbering starts at 1 at the FIRST EDITABLE turn. \`[[PROTECTED]]\` is
  not numbered, so turn 1 is the first editable turn.
* Headers are display-only and MUST be kept for every turn you keep. File order
  IS conversation order — move a block to reorder the conversation; the numbers
  are re-derived for you.
* Emptying a turn's body (deleting all of its text) drops that turn.
* Tool outputs live in their own \`[[CTX_TURN n role=tool]]\` block, right after
  the block holding \`name(arguments)\`, so ONE output can be deleted or replaced
  without retyping the rest of the turn.
* Token counts are approximate: ~1 token per 4 characters of visible text.

EDITING — Windows, shell is PowerShell, interpreter is \`python\` (NOT \`python3\`)
(a) Use the native \`edit\` tool on the mirror file:
      filePath: ${mirrorPath}
      oldString: "text you have already seen in context"
      newString: "SHORT replacement summary"
(b) Scripted edit with python -c (verified in PowerShell 5.1, one line):
      python -c "import re,sys;p=sys.argv[1];s=open(p,encoding='utf-8').read();s=re.sub(r'(\\[\\[CTX_TURN 7 [^\\]]*\\]\\]).*?(?=\\n\\[\\[CTX_TURN|\\Z)','',s,flags=re.S);open(p,'w',encoding='utf-8',newline='').write(s)" "${mirrorPath}"
(c) Same operation as a PowerShell here-string (verified; safest for multi-line
    scripts — a path with spaces is fine as the quoted argument). The opening
    @' may be indented, but the closing '@ MUST start at column 0: PowerShell
    5.1 rejects it otherwise ("White space is not allowed before the string
    terminator").
@'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = re.sub(r'(\\[\\[CTX_TURN 7 [^\\]]*\\]\\]).*?(?=\\n\\[\\[CTX_TURN|\\Z)', '', s, flags=re.S)
open(p, 'w', encoding='utf-8', newline='').write(s)
'@ | python - "${mirrorPath}"

RULES
* Do NOT \`cat\`/\`read\` the whole mirror file — its text is already in your
  context. Locate text with code (a python one-liner, \`rg\`/\`grep\`); never
  retype text you have already seen.
* Batch compaction: one big edit beats many small ones.
* Mind what is below your edit — everything after it is re-read next turn.
* Be generous in summaries, and keep useful tails (the newest turns, live state,
  anything you still need verbatim).
* Replacement-note contract: when you replace text, COPY forward the facts you
  are dropping — every RULED OUT candidate with its reason and the words
  "do not retry"; the exact queries/commands already tried; exact values marked
  VERIFIED or UNVERIFIED; and a NEXT line.

BUDGET
* Your context budget is ${budget} tokens; the gate is \`${gate}\`
  (${gate === "shrink" ? "an edit must SHRINK context" : "an edit must FIT the budget"}).
* Every tool result ends with a line showing your current size, and a standing
  meter message at the end of each request shows
  \`[context: ~{tokens}/${budget} tokens] · mirror: ${mirrorPath}\`.
* After you edit, look for the \`LIVE_CTX:\` receipt line in that meter:
  \`applied\`, \`applied but it GREW\`, \`applied but still over\`, \`NO change\`, or
  \`REJECTED\`. A REJECTED edit was NOT applied — you duplicated or appended
  instead of replacing; replace stale text with a SHORTER summary.
[CLM_DOCTRINE v1]`;
}

/* ============================================================================
 * 11. Adapter helpers — shared plumbing
 * ==========================================================================*/

export interface Runtime {
    states: Map<string, SessionState>;
    defaultDirectory?: string;
    dirBySession: Map<string, string>;
    configCache?: { mtimeMs: number; config: ClmConfig };
}

export function createRuntime(defaultDirectory?: string): Runtime {
    return {
        states: new Map(),
        defaultDirectory,
        dirBySession: new Map(),
    };
}

export function stateFor(runtime: Runtime, sessionID: string): SessionState {
    let state = runtime.states.get(sessionID);
    if (!state) {
        state = createSessionState();
        runtime.states.set(sessionID, state);
    }
    return state;
}

export function directoryFor(runtime: Runtime, sessionID?: string, hint?: string): string {
    if (hint) {
        runtime.defaultDirectory = runtime.defaultDirectory ?? hint;
        if (sessionID) runtime.dirBySession.set(sessionID, hint);
        return hint;
    }
    if (sessionID) {
        const cached = runtime.dirBySession.get(sessionID);
        if (cached) return cached;
    }
    const fallback = runtime.defaultDirectory ?? process.cwd();
    if (sessionID) runtime.dirBySession.set(sessionID, fallback);
    return fallback;
}

export function rememberDirectory(runtime: Runtime, sessionID: string | undefined, directory: string | undefined): void {
    if (!directory) return;
    runtime.defaultDirectory = runtime.defaultDirectory ?? directory;
    if (sessionID) runtime.dirBySession.set(sessionID, directory);
}

/** Load clm.jsonc, re-reading only when its mtime changes (misses cost one stat). */
export function currentConfig(runtime: Runtime): ClmConfig {
    try {
        const mtime = safeMtime(CLM_CONFIG_PATH);
        if (runtime.configCache && runtime.configCache.mtimeMs === mtime) {
            return runtime.configCache.config;
        }
        const config = loadConfig(CLM_CONFIG_PATH);
        runtime.configCache = { mtimeMs: mtime, config };
        return config;
    } catch {
        return { budget: DEFAULT_BUDGET, gate: DEFAULT_GATE };
    }
}

function safeMtime(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return -1;
    }
}

/* ============================================================================
 * 12. Adapter — V2 (native LLM.Message { id?, role, content[] })
 * ==========================================================================*/

export interface NativeMessage {
    id?: string;
    role: string;
    content?: unknown[];
    [k: string]: unknown;
}

function resultText(result: any): string {
    if (result === null || result === undefined) return "";
    const type = result.type;
    if (type === "text" || type === "error") return typeof result.value === "string" ? result.value : String(result.value ?? "");
    if (type === "json") {
        try {
            return JSON.stringify(result.value);
        } catch {
            return String(result.value);
        }
    }
    if (type === "content" && Array.isArray(result.value)) {
        return result.value
            .map((entry: any) => (entry && entry.type === "text" ? String(entry.text ?? "") : ""))
            .filter((s: string) => s !== "")
            .join("\n");
    }
    return "";
}

export function nativeToCore(messages: NativeMessage[]): ClmMessage[] {
    const results = new Map<string, any>();
    for (const message of messages) {
        if (!Array.isArray(message?.content)) continue;
        for (const part of message.content as any[]) {
            if (part && part.type === "tool-result" && part.id) results.set(part.id, part);
        }
    }
    const consumed = new Set<string>();

    return messages.map((message) => {
        const parts: ClmPart[] = [];
        const content = Array.isArray(message?.content) ? (message.content as any[]) : [];
        for (const part of content) {
            if (!part || typeof part !== "object") continue;
            switch (part.type) {
                case "text":
                    if (typeof part.text === "string" && part.text !== "") parts.push({ type: "text", text: part.text });
                    break;
                case "reasoning":
                    if (typeof part.text === "string" && part.text !== "")
                        parts.push({ type: "reasoning", text: part.text });
                    break;
                case "tool-call": {
                    const id = String(part.id ?? "");
                    const paired = id ? results.get(id) : undefined;
                    if (id) consumed.add(id);
                    parts.push({
                        type: "tool",
                        name: String(part.name ?? "tool"),
                        args: joinArgs(part.input),
                        output: paired ? resultText(paired.result) : "",
                        callId: id || undefined,
                    });
                    break;
                }
                case "tool-result": {
                    const id = String(part.id ?? "");
                    if (id && consumed.has(id)) break;
                    const text = resultText(part.result);
                    if (text !== "") parts.push({ type: "text", text });
                    break;
                }
                case "media":
                    parts.push({
                        type: "misc",
                        text: `[media ${String((part as any).mediaType ?? (part as any).media?.mediaType ?? "unknown")}]`,
                    });
                    break;
                case "compaction":
                case "effort":
                    break;
                default:
                    break;
            }
        }
        const seed =
            message.id ??
            `${message.role}|${parts.map((p) => (p.type === "text" || p.type === "reasoning" || p.type === "misc" ? p.text : `${p.name}(${p.args})${p.output}`)).join("\u0000")}`;
        return {
            role: String(message.role ?? "user"),
            parts,
            key: String(seed),
            original: message,
        } satisfies ClmMessage;
    });
}

export function coreToNative(messages: ClmMessage[]): NativeMessage[] {
    return messages.map((message) => {
        if (message.original !== undefined && message.synthetic !== true) {
            return message.original as NativeMessage;
        }
        return { role: message.role, content: [{ type: "text", text: messageText(message) }] };
    });
}

/** Build the standing meter message in native shape. */
export function nativeMeterMessage(sessionID: string, text: string): NativeMessage {
    return { id: meterId(sessionID), role: "user", content: [{ type: "text", text }] };
}

export function stripNativeMeter(messages: NativeMessage[]): NativeMessage[] {
    const id = meterId("");
    return messages.filter((message) => {
        if (message.id && typeof message.id === "string" && message.id.startsWith(METER_ID_PREFIX)) return false;
        if (message.id === id) return false;
        const content = message.content;
        if (Array.isArray(content) && content.length === 1) {
            const part = content[0] as any;
            if (part && part.type === "text" && typeof part.text === "string" && part.text.startsWith(METER_TEXT_MARKER)) {
                return false;
            }
        }
        return true;
    });
}

/* ============================================================================
 * 13. Adapter — V1 ({info, parts})
 * ==========================================================================*/

export interface V1Message {
    info: any;
    parts: any[];
}

export function v1ToCore(messages: V1Message[]): ClmMessage[] {
    return messages.map((message) => {
        const parts: ClmPart[] = [];
        for (const part of message.parts ?? []) {
            if (!part || typeof part !== "object") continue;
            switch (part.type) {
                case "text":
                    if (typeof part.text === "string" && part.text !== "") parts.push({ type: "text", text: part.text });
                    break;
                case "reasoning":
                    if (typeof part.text === "string" && part.text !== "")
                        parts.push({ type: "reasoning", text: part.text });
                    break;
                case "tool": {
                    const state = part.state ?? {};
                    const output =
                        state.status === "completed" && typeof state.output === "string"
                            ? state.output
                            : state.status === "error" && typeof state.error === "string"
                              ? state.error
                              : "";
                    parts.push({
                        type: "tool",
                        name: String(part.tool ?? "tool"),
                        args: joinArgs(state.input),
                        output,
                        callId: part.callID ? String(part.callID) : undefined,
                    });
                    break;
                }
                case "file":
                    parts.push({ type: "misc", text: `[file ${String(part.mime ?? "unknown")}]` });
                    break;
                case "step-start":
                case "step-finish":
                case "snapshot":
                case "retry":
                case "compaction":
                case "patch":
                case "agent":
                case "subtask":
                    break;
                default:
                    break;
            }
        }
        const id = message.info?.id;
        const seed =
            typeof id === "string" && id !== ""
                ? id
                : `${message.info?.role}|${parts.map((p) => (p.type === "tool" ? `${p.name}(${p.args})${p.output}` : p.type === "misc" ? p.text : p.text)).join("\u0000")}`;
        return {
            role: String(message.info?.role ?? "user"),
            parts,
            key: seed,
            original: message,
        } satisfies ClmMessage;
    });
}

function syntheticV1Info(base: any, role: string, id: string, sessionID: string): any {
    const now = Date.now();
    const common = {
        id,
        sessionID: sessionID ?? String(base?.sessionID ?? ""),
        role,
        time: { created: now },
        agent: String(base?.agent ?? "build"),
    };
    if (role === "user") {
        return {
            ...common,
            model: {
                providerID: String(base?.model?.providerID ?? "unknown"),
                modelID: String(base?.model?.modelID ?? "unknown"),
            },
        };
    }
    return {
        ...common,
        parentID: String(base?.id ?? ""),
        modelID: String(base?.modelID ?? base?.model?.modelID ?? "unknown"),
        providerID: String(base?.providerID ?? base?.model?.providerID ?? "unknown"),
        mode: String(base?.mode ?? "build"),
        path: base?.path ?? { cwd: "", root: "" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
}

export function coreToV1(messages: ClmMessage[], sessionID: string): V1Message[] {
    const base = messages.find((m) => m.original !== undefined)?.original as V1Message | undefined;
    const infoBase = base?.info;
    return messages.map((message, index) => {
        if (message.original !== undefined && message.synthetic !== true) {
            return message.original as V1Message;
        }
        const role = message.role === "assistant" ? "assistant" : "user";
        const id = message.key && message.key.startsWith("msg_") ? message.key : `${message.key}_${index}`;
        return {
            info: syntheticV1Info(infoBase, role, id, sessionID),
            parts: [
                {
                    id: `${id}_p0`,
                    sessionID: sessionID ?? String(infoBase?.sessionID ?? ""),
                    messageID: id,
                    type: "text",
                    text: messageText(message),
                },
            ],
        };
    });
}

export function v1MeterMessage(sessionID: string, base: any, text: string): V1Message {
    const id = meterId(sessionID);
    return {
        info: syntheticV1Info(base, "user", id, sessionID),
        parts: [
            {
                id: `${id}_p0`,
                sessionID,
                messageID: id,
                type: "text",
                text,
            },
        ],
    };
}

export function stripV1Meter(messages: V1Message[]): V1Message[] {
    return messages.filter((message) => {
        const id = message?.info?.id;
        if (typeof id === "string" && id.startsWith(METER_ID_PREFIX)) return false;
        const text = (message?.parts ?? []).find((p: any) => p?.type === "text")?.text;
        if (typeof text === "string" && text.startsWith(METER_TEXT_MARKER)) return false;
        return true;
    });
}

export function isV1Meter(message: V1Message): boolean {
    const id = message?.info?.id;
    return typeof id === "string" && id.startsWith(METER_ID_PREFIX);
}

/* ============================================================================
 * 14. Adapter — V1 plugin (server() → Hooks)
 * ==========================================================================*/

export interface V1HookInput {
    directory: string;
    worktree?: string;
}

interface V1HookSet {
    dispose?: () => Promise<void>;
    config?: (input: any) => Promise<void>;
    "experimental.chat.messages.transform"?: (input: any, output: any) => Promise<void>;
    "experimental.chat.system.transform"?: (input: any, output: any) => Promise<void>;
    "tool.execute.after"?: (input: any, output: any) => Promise<void>;
    "permission.ask"?: (input: any, output: any) => Promise<void>;
}

export function createV1Hooks(input: V1HookInput): V1HookSet {
    const runtime = createRuntime(input.directory);

    return {
        "experimental.chat.messages.transform": async (_v1input: any, output: any) => {
            try {
                const raw: V1Message[] = Array.isArray(output?.messages) ? output.messages : [];
                const stripped = stripV1Meter(raw);
                if (stripped.length === 0) return;
                const sessionID = String(stripped[0]?.info?.sessionID ?? "");
                if (!sessionID) return;
                const directory = directoryFor(runtime, sessionID, stripped[0]?.info?.path?.cwd ?? undefined);
                const core = v1ToCore(stripped);
                const result = runClm({
                    sessionID,
                    directory,
                    messages: core,
                    config: currentConfig(runtime),
                    state: stateFor(runtime, sessionID),
                });
                const rebuilt = coreToV1(result.messages, sessionID);
                const meterInfo = syntheticV1Info(stripped[0]?.info, "user", meterId(sessionID), sessionID);
                rebuilt.push({
                    info: meterInfo,
                    parts: [
                        {
                            id: `${meterId(sessionID)}_p0`,
                            sessionID,
                            messageID: meterId(sessionID),
                            type: "text",
                            text: result.meterBody,
                        },
                    ],
                });
                output.messages = rebuilt;
            } catch (error) {
                console.error("[clm-context] V1 messages.transform failed:", error);
            }
        },

        "experimental.chat.system.transform": async (v1input: any, output: any) => {
            try {
                const sessionID = String(v1input?.sessionID ?? "unknown");
                const directory = directoryFor(runtime, sessionID);
                const config = currentConfig(runtime);
                const text = doctrineText({ mirrorPath: mirrorPathFor(directory, sessionID), budget: config.budget, gate: config.gate });
                if (!Array.isArray(output.system)) output.system = [];
                if (output.system.some((entry: any) => typeof entry === "string" && entry.includes(DOCTRINE_MARKER))) return;
                output.system.push(text);
            } catch (error) {
                console.error("[clm-context] V1 system.transform failed:", error);
            }
        },

        "tool.execute.after": async (v1input: any, output: any) => {
            try {
                const sessionID = String(v1input?.sessionID ?? "");
                const state = runtime.states.get(sessionID);
                if (!state) return;
                if (typeof output?.output !== "string") return;
                output.output = appendBudgetLine(output.output, state.tokens, currentConfig(runtime).budget);
            } catch (error) {
                console.error("[clm-context] V1 tool.execute.after failed:", error);
            }
        },

        "permission.ask": async (v1input: any, output: any) => {
            try {
                const sessionID = String(v1input?.sessionID ?? "");
                const directory = directoryFor(runtime, sessionID);
                const patterns = Array.isArray(v1input?.pattern)
                    ? v1input.pattern
                    : typeof v1input?.pattern === "string"
                      ? [v1input.pattern]
                      : [];
                const resourceish = [v1input?.title, ...patterns]
                    .filter((entry): entry is string => typeof entry === "string")
                    .map((entry) => normalize(entry));
                if (resourceish.length === 0) return;
                if (resourceish.every((entry) => insideClmDir(entry, directory))) {
                    output.status = "allow";
                }
            } catch (error) {
                console.error("[clm-context] V1 permission.ask failed:", error);
            }
        },
    };
}

/* ============================================================================
 * 15. Adapter — V2 plugin (setup(ctx))
 * ==========================================================================*/

interface V2SystemEntry {
    type: string;
    text: string;
    [k: string]: unknown;
}

interface V2ContextEvent {
    sessionID?: string;
    agent?: string;
    model?: { providerID?: string; id?: string; limit?: { context?: number } };
    system?: V2SystemEntry[];
    messages?: NativeMessage[];
    tools?: Record<string, unknown>;
    options?: Record<string, unknown>;
}

interface V2PluginContext {
    location?: { directory?: string; worktree?: string };
    session?: {
        hook?: (kind: string, callback: (event: any) => unknown) => unknown;
        context?: (input: { sessionID: string }) => Promise<unknown>;
        get?: (input: { sessionID: string }) => Promise<any>;
    };
    tool?: {
        transform?: (callback: (editor: any) => unknown) => unknown;
        hook?: (kind: string, callback: (event: any) => unknown) => unknown;
    };
    permission?: {
        hook?: (kind: string, callback: (event: any) => unknown) => unknown;
    };
    agent?: { get?: (input: { agentID: string }) => Promise<any> };
}

export function createV2Setup(ctx: V2PluginContext): () => void {
    const directory = ctx?.location?.directory ?? process.cwd();
    const runtime = createRuntime(directory);

    const contextHook = (event: V2ContextEvent) => {
        try {
            const sessionID = String(event?.sessionID ?? "");
            if (!sessionID) return;
            const eventDirectory = directoryFor(runtime, sessionID, directory);
            const raw = Array.isArray(event?.messages) ? event.messages : [];
            const stripped = stripNativeMeter(raw);
            if (stripped.length === 0) return;

            const core = nativeToCore(stripped);
            const result = runClm({
                sessionID,
                directory: eventDirectory,
                messages: core,
                config: currentConfig(runtime),
                state: stateFor(runtime, sessionID),
            });
            const rebuilt = coreToNative(result.messages);
            rebuilt.push(nativeMeterMessage(sessionID, result.meterBody));

            // Mutate in place (host may hold the array reference) and reassign.
            const target = event.messages as NativeMessage[];
            target.length = 0;
            for (const message of rebuilt) target.push(message);
            (event as any).messages = target;

            // System doctrine: APPEND only.
            const config = currentConfig(runtime);
            const text = doctrineText({ mirrorPath: result.mirrorPath, budget: config.budget, gate: config.gate });
            if (Array.isArray(event.system)) {
                if (!event.system.some((entry) => typeof entry?.text === "string" && entry.text.includes(DOCTRINE_MARKER))) {
                    event.system.push({ type: "text", text });
                }
            }
        } catch (error) {
            console.error("[clm-context] V2 session.context hook failed:", error);
        }
    };

    try {
        ctx?.session?.hook?.("context", contextHook);
    } catch (error) {
        console.error("[clm-context] failed to register context hook:", error);
    }

    // Tool result budget line (V2 equivalent of tool.execute.after).
    try {
        ctx?.tool?.hook?.("execute.after", (toolEvent: any) => {
            try {
                if (!toolEvent || toolEvent.status !== "completed") return;
                const result = toolEvent.result;
                if (!result || typeof result.output !== "string") return;
                const sessionID = String(toolEvent.sessionID ?? "");
                const state = runtime.states.get(sessionID);
                if (!state) return;
                result.output = appendBudgetLine(result.output, state.tokens, currentConfig(runtime).budget);
            } catch (error) {
                console.error("[clm-context] V2 tool.execute.after failed:", error);
            }
        });
    } catch (error) {
        console.error("[clm-context] failed to register tool.execute.after:", error);
    }

    // Permission passthrough: allow anything inside the session's .clm dir.
    try {
        ctx?.permission?.hook?.("evaluate", (permission: any) => {
            try {
                if (!permission || permission.effect === "allow") return;
                const sessionID = typeof permission.sessionID === "string" ? permission.sessionID : undefined;
                const directoryNow = directoryFor(runtime, sessionID);
                const resources: string[] = Array.isArray(permission.resources)
                    ? permission.resources
                    : typeof permission.resource === "string"
                      ? [permission.resource]
                      : [];
                if (resources.length === 0) return;
                if (resources.every((resource) => insideClmDir(String(resource), directoryNow))) {
                    permission.effect = "allow";
                    permission.message = "CLM mirror file";
                }
            } catch (error) {
                console.error("[clm-context] V2 permission.evaluate failed:", error);
            }
        });
    } catch (error) {
        console.error("[clm-context] failed to register permission hook:", error);
    }

    // ctx.tool.transform — read-only status tool (also proves the transform path).
    try {
        ctx?.tool?.transform?.((editor: any) => {
            editor.add({
                name: "clm_status",
                description:
                    "Report this session's Context-Language-Model mirror: mirror file path, current context size " +
                    "in tokens, the token budget, the gate mode, and any pending LIVE_CTX receipt. Read-only; " +
                    "does not modify the mirror. Use instead of reading the mirror file.",
                input: { type: "object", properties: {}, additionalProperties: false },
                execute: async (_args: unknown, toolContext: { sessionID?: string }) => {
                    const sessionID = String(toolContext?.sessionID ?? "unknown");
                    const config = currentConfig(runtime);
                    const state = runtime.states.get(sessionID);
                    const dir = directoryFor(runtime, sessionID);
                    const tokens = state?.tokens ?? 0;
                    // Same return convention as DCP's V2 transform tools: { content: string }.
                    return {
                        content:
                            `mirror: ${mirrorPathFor(dir, sessionID)}\n` +
                            `context: ~${tokens}/${config.budget} tokens (${config.budget > 0 ? Math.round((tokens / config.budget) * 100) : 0}%)\n` +
                            `gate: ${config.gate}\n` +
                            `view-authoritative: ${state?.viewAuthoritative ? "yes (mirror is your context)" : "no (mirror not edited yet)"}`,
                    };
                },
            });
        });
    } catch (error) {
        console.error("[clm-context] failed to register tool transform:", error);
    }

    return () => {
        runtime.states.clear();
        runtime.dirBySession.clear();
    };
}

/* ============================================================================
 * 16. Plugin module (both shapes)
 * ==========================================================================*/

const plugin = {
    id: PLUGIN_ID,
    server: async (input: V1HookInput) => createV1Hooks(input),
    setup: (ctx: V2PluginContext) => createV2Setup(ctx),
};

export default plugin;
