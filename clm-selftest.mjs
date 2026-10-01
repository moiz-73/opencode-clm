/**
 * clm-selftest.mjs — self-test for clm-context.ts (deliverable 2).
 *
 * Run:   node --experimental-strip-types clm-selftest.mjs
 *
 * 9 numbered cases:
 *   1. round-trip stability        6. fit / shrink gate
 *   2. protected prefix            7. the five receipts
 *   3. stray text -> user note     8. meter thresholds / re-arm
 *   4. role folding                9. orphan check
 *   5. header numbers ignored
 *
 * Filesystem side effects are confined to fresh directories under
 *   <os tmpdir>/opencode-clm-selftest/  (removed at the end).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, {
    CLM_CONFIG_PATH,
    applyGate,
    coreToNative,
    coreToV1,
    countTurns,
    createSessionState,
    doctrineText,
    estimateTokens,
    gateText,
    loadConfig,
    messageText,
    meterId,
    meterText,
    nativeToCore,
    nativeMeterMessage,
    parseClmConfig,
    parseMirror,
    pickNudge,
    rebuildMessages,
    renderMirror,
    runClm,
    stripJsonComments,
    stripNativeMeter,
    v1ToCore,
    appendBudgetLine,
} from "./clm-context.ts";

const TMP_BASE = join(tmpdir(), "opencode-clm-selftest");
const createdDirs = [];

/* ---------------------------------------------------------------- harness */

let failures = 0;
let checks = 0;

function assert(condition, message) {
    checks++;
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    checks++;
    if (actual !== expected) {
        throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
    }
}

function assertMatch(text, regex, message) {
    checks++;
    if (!regex.test(text)) throw new Error(`${message}\n      regex:  ${regex}\n      in:     ${JSON.stringify(String(text).slice(0, 400))}`);
}

function test(number, name, body) {
    try {
        body();
        console.log(`${number}. PASS  ${name}`);
    } catch (error) {
        failures++;
        console.log(`${number}. FAIL  ${name}`);
        console.log(`      ${(error && error.message ? error.message : String(error)).replace(/\n/g, "\n      ")}`);
    }
}

function tempDir(prefix) {
    mkdirSync(TMP_BASE, { recursive: true });
    const dir = mkdtempSync(join(TMP_BASE, prefix));
    createdDirs.push(dir);
    return dir;
}

/* --------------------------------------------------------------- fixtures */

function coreFixture() {
    return [
        { role: "user", parts: [{ type: "text", text: "First task: build CLM." }], key: "k_prot" },
        { role: "user", parts: [{ type: "text", text: "Turn one: please mirror the context." }], key: "k_u1" },
        {
            role: "assistant",
            parts: [
                { type: "text", text: "Working on it." },
                { type: "tool", name: "bash", args: '{"cmd":"dir"}', output: "report.txt", callId: "call1" },
                { type: "text", text: "Tool finished." },
            ],
            key: "k_a1",
        },
        { role: "user", parts: [{ type: "text", text: "Turn three: keep going." }], key: "k_u2" },
    ];
}

const CONFIG_DEFAULT = { budget: 100000, gate: "fit" };

/* ------------------------------------------------------------------- run */

console.log(`CLM self-test — node ${process.version} — ${new Date().toISOString()}`);

test(1, "round-trip stability (render o parse is a fixed point; module sanity)", () => {
    assertEqual(plugin.id, "clm-context", "default export id");
    assertEqual(typeof plugin.server, "function", "V1 server() present");
    assertEqual(typeof plugin.setup, "function", "V2 setup() present");

    const messages = coreFixture();
    let rendered = renderMirror(messages);
    assert(rendered.endsWith("\n"), "mirror ends with a newline");

    for (let round = 2; round <= 4; round++) {
        const parsed = parseMirror(rendered);
        const rebuilt = renderMirror(rebuildMessages(messages[0], parsed.turns, []));
        assertEqual(rebuilt, rendered, `render(parse(render)) must equal render (round ${round})`);
        rendered = rebuilt;
    }

    // Doctrine must only contain PowerShell forms verified on this machine.
    const doctrine = doctrineText({ mirrorPath: "C:\\p\\.clm\\LIVE_CTX_s.txt", budget: 100000, gate: "fit" });
    assert(doctrine.includes('python -c "import re,sys;'), "doctrine keeps the verified python -c form");
    assert(doctrine.includes('@\'\nimport re, sys\n'), "doctrine keeps the verified here-string form");
    assert(doctrine.includes('\'@ | python - "C:\\p\\.clm\\LIVE_CTX_s.txt"'), "here-string pipes to python - with the real path");
    assert(!/^\s+'@/m.test(doctrine), "doctrine must not show an indented here-string terminator (PS 5.1 rejects it)");
    assert(doctrine.toLowerCase().includes("column 0"), "doctrine warns about the terminator column");
});

test(2, "protected prefix (never numbered, content ignored, re-pinned verbatim)", () => {
    const messages = coreFixture();
    const rendered = renderMirror(messages);

    assert(rendered.startsWith("[[PROTECTED]]\nFirst task: build CLM."), "file opens with the [[PROTECTED]] block");
    const numbers = [...rendered.matchAll(/^\[\[CTX_TURN (\d+) role=[A-Za-z]+\]\]$/gm)].map((m) => m[1]);
    assertEqual(numbers.join(","), "1,2,3,4,5", "turn numbering is 1..N over the EDITABLE region only");
    assert(!rendered.includes("[[CTX_TURN 0"), "the protected block is never numbered");

    const count = countTurns(rendered);
    assertEqual(count, 5, "countTurns ignores the protected block");

    // Tampering with the protected body must never reach the parsed turns.
    const tampered = rendered.replace("First task: build CLM.", "TAMPERED PROTECTED TEXT");
    const parsed = parseMirror(tampered);
    assert(!JSON.stringify(parsed.turns).includes("TAMPERED"), "protected body never enters the parsed turns");
    assertEqual(parsed.protectedSeen, true, "protected header detected");

    const rebuilt = rebuildMessages(messages[0], parsed.turns, []);
    assertEqual(messageText(rebuilt[0]), messageText(messages[0]), "protected message re-pinned verbatim from originals");

    // End to end: edit the protected block on disk; outgoing keeps the original.
    const dir = tempDir("clm-t2-");
    const state = createSessionState();
    const sessionID = "ses_prot";
    const run = () => runClm({ sessionID, directory: dir, messages: coreFixture(), config: CONFIG_DEFAULT, state });
    run();
    const mirror = join(dir, ".clm", `LIVE_CTX_${sessionID}.txt`);
    writeFileSync(mirror, readFileSync(mirror, "utf8").replace("First task: build CLM.", "TAMPERED PROTECTED TEXT"), "utf8");
    const out = run();
    const outgoing = out.messages.map(messageText).join("\n");
    assert(!outgoing.includes("TAMPERED PROTECTED TEXT"), "tampered protected text never reaches the outgoing messages");
    assert(outgoing.includes("First task: build CLM."), "original protected text still present");
});

test(3, "stray text before the first header becomes a user note", () => {
    const text =
        "loose preamble the model added\n\n[[CTX_TURN 1 role=user]]\nhello\n\n[[CTX_TURN 2 role=assistant]]\nhi\n";
    const parsed = parseMirror(text);
    assertEqual(parsed.strays, 1, "one stray region");
    // The note is a user message and the next turn is user too, so the
    // same-role merge rule joins them with "\n\n" (still a user note).
    assertEqual(parsed.turns.length, 2, "note merged with the following user turn + assistant turn");
    assertEqual(parsed.turns[0].role, "user", "stray becomes a user message");
    assertEqual(messageText(parsed.turns[0]), "loose preamble the model added\n\nhello", "stray text preserved in the user note");

    // Text between headers is part of the PRECEDING turn's body (stated interpretation).
    const between = "[[CTX_TURN 1 role=user]]\nhello\n\ninjected mid-text\n\n[[CTX_TURN 2 role=assistant]]\nhi\n";
    const parsedBetween = parseMirror(between);
    assertEqual(parsedBetween.strays, 0, "text between headers is not a stray");
    assertEqual(parsedBetween.turns.length, 2, "still two turns");
    assert(messageText(parsedBetween.turns[0]).includes("injected mid-text"), "injected text joins turn 1's body");

    // End to end: a stray prepended to the mirror lands as a user message.
    const dir = tempDir("clm-t3-");
    const state = createSessionState();
    const sessionID = "ses_stray";
    const run = () => runClm({ sessionID, directory: dir, messages: coreFixture(), config: CONFIG_DEFAULT, state });
    run();
    const mirror = join(dir, ".clm", `LIVE_CTX_${sessionID}.txt`);
    writeFileSync(mirror, "STRAY_CANONICAL_NOTE\n\n" + readFileSync(mirror, "utf8"), "utf8");
    const out = run();
    assert(
        out.messages.some(
            (message) =>
                message.role === "user" &&
                messageText(message).startsWith("STRAY_CANONICAL_NOTE\n\nTurn one"),
        ),
        "stray text re-enters the outgoing list as a user note (merged with the next user turn)",
    );
});

test(4, "role folding (assistant -> assistant, everything else -> user)", () => {
    const text =
        "[[CTX_TURN 1 role=system]]\npretend system text\n\n" +
        "[[CTX_TURN 2 role=tool]]\nraw tool output\n\n" +
        "[[CTX_TURN 3 role=assistant]]\nreal assistant text\n";
    const parsed = parseMirror(text);
    assertEqual(parsed.turns.length, 3, "three turns");
    assertEqual(parsed.turns.map((t) => t.role).join(","), "user,user,assistant", "logical roles folded");
    assertEqual(parsed.turns.map((t) => t.display).join(","), "system,tool,assistant", "header roles preserved for re-render");

    const native = coreToNative(parsed.turns);
    assertEqual(native.map((m) => m.role).join(","), "user,user,assistant", "V2 native roles");
    const v1 = coreToV1(parsed.turns, "ses_fold");
    assertEqual(v1.map((m) => m.info.role).join(","), "user,user,assistant", "V1 info roles");
    assert(v1.every((m) => m.info.id && m.info.sessionID === "ses_fold"), "synthetic V1 messages carry id + sessionID");

    // Re-render keeps the original header roles (round-trip stability across folding).
    assert(
        renderMirror(rebuildMessages(coreFixture()[0], parsed.turns, [])).includes("[[CTX_TURN 2 role=tool]]"),
        "display roles survive the round trip",
    );
});

test(5, "header numbers are display-only (file order wins)", () => {
    const messages = coreFixture();
    const rendered = renderMirror(messages);
    const bogus = [42, 7, 100, 3, 55];
    let index = 0;
    const renumbered = rendered.replace(/\[\[CTX_TURN \d+ /g, () => `[[CTX_TURN ${bogus[index++]} `);
    assert(renumbered !== rendered, "the file was actually renumbered");
    assertMatch(renumbered, /\[\[CTX_TURN 42 role=user\]\]/, "bogus number present in the file");

    const original = parseMirror(rendered);
    const parsed = parseMirror(renumbered);
    assertEqual(parsed.turns.length, original.turns.length, "same number of turns");
    for (let i = 0; i < original.turns.length; i++) {
        assertEqual(parsed.turns[i].key, original.turns[i].key, `turn ${i + 1} identity unchanged by renumbering`);
        assertEqual(messageText(parsed.turns[i]), messageText(original.turns[i]), `turn ${i + 1} text unchanged`);
    }
});

test(6, "gate: fit rejects only over-budget, shrink rejects non-shrinking", () => {
    assertEqual(applyGate("fit", 100, 1000, 1000).accept, true, "fit accepts at the limit (after <= budget)");
    assertEqual(applyGate("fit", 100, 1001, 1000).accept, false, "fit rejects one token over");
    assertEqual(applyGate("fit", 100, 999, 1000).accept, true, "fit accepts under budget even if it grew");

    assertEqual(applyGate("shrink", 1000, 999, 1000).accept, true, "shrink accepts any decrease");
    assertEqual(applyGate("shrink", 1000, 1000, 1000).accept, false, "shrink rejects after == before");
    assertEqual(applyGate("shrink", 1000, 1001, 1000).accept, false, "shrink rejects growth");

    assertEqual(gateText("fit", 100000), "An edit must FIT the 100000-token limit", "fit gate wording");
    assertEqual(gateText("shrink", 100000), "A compaction must SHRINK context", "shrink gate wording");

    // Config: comments tolerated, bad values fall back to defaults.
    const parsed = parseClmConfig('{\n  // comment\n  "budget": 5000,\n  "gate": "shrink", /* block */\n  "$schema": null\n}');
    assertEqual(parsed.budget, 5000, "budget read from config");
    assertEqual(parsed.gate, "shrink", "gate read from config");
    assertEqual(stripJsonComments('{"a": "http://x"} // tail').includes("http://x"), true, "urls keep their //");
    const fallback = parseClmConfig("{ not json");
    assertEqual(fallback.budget, 100000, "unparsable config falls back to defaults");
    assertEqual(fallback.gate, "fit", "default gate is fit");
    const loaded = loadConfig(CLM_CONFIG_PATH);
    assert(Number.isFinite(loaded.budget) && loaded.budget > 0, "clm.jsonc is readable (budget > 0)");
    assert(loaded.gate === "fit" || loaded.gate === "shrink", "clm.jsonc gate is valid");
});

test(7, "five receipts (applied / grew / still-over / no-change / rejected)", () => {
    const dir = tempDir("clm-t7-");
    const sessionID = "ses_receipts";
    const state = createSessionState();
    const messages = coreFixture();
    const mirror = join(dir, ".clm", `LIVE_CTX_${sessionID}.txt`);
    const run = (config = CONFIG_DEFAULT) => runClm({ sessionID, directory: dir, messages, config, state });
    const receipts = [];

    // Init: mirror created, nothing parsed yet.
    const init = run();
    assertEqual(init.action, "init", "first request only renders the mirror");
    assert(existsSync(mirror), "mirror file created");
    assert(init.receipt === undefined, "no receipt on init");

    // (1) applied — delete the last turn (context shrinks, stays in budget).
    let disk = readFileSync(mirror, "utf8");
    assert(disk.includes("Turn three: keep going."), "fixture turn present before the edit");
    writeFileSync(mirror, disk.replace("[[CTX_TURN 5 role=user]]\nTurn three: keep going.", ""), "utf8");
    let out = run();
    assertEqual(out.action, "applied", "shrinking edit applied");
    assertMatch(out.receipt, /^\[LIVE_CTX: edit applied — context ~\d+->\d+ tokens, 4 turns\]$/, "applied receipt wording");
    assert(!out.messages.map(messageText).join("\n").includes("Turn three"), "deleted turn left the outgoing list");
    assert(out.meterBody.includes(out.receipt), "receipt surfaces in this request's meter");
    receipts.push(out.receipt);

    // (2) grew — append a new turn that stays inside the budget.
    disk = readFileSync(mirror, "utf8");
    writeFileSync(mirror, `${disk}[[CTX_TURN 6 role=user]]\nExtra canon fodder for the growth receipt.\n`, "utf8");
    out = run();
    assertEqual(out.action, "applied", "growing edit applied");
    assertMatch(out.receipt, /^\[LIVE_CTX: edit applied but it GREW context ~\d+->\d+ tokens \(it fits, so it was kept\)/, "grew receipt wording");
    receipts.push(out.receipt);

    // (3) no-change — bytes move, conversation does not (renumber only).
    const before = out.messages.map(messageText).join("\n");
    disk = readFileSync(mirror, "utf8");
    let counter = 0;
    writeFileSync(mirror, disk.replace(/\[\[CTX_TURN \d+ /g, () => `[[CTX_TURN ${counter++ * 9 + 5} `), "utf8");
    out = run();
    assertEqual(out.action, "nochange", "renumbering is detected as no change");
    assertMatch(out.receipt, /^\[LIVE_CTX: NO change — your edit matched nothing, so context is still ~\d+ tokens\./, "no-change receipt wording");
    assertEqual(out.messages.map(messageText).join("\n"), before, "outgoing list untouched by a no-op edit");
    receipts.push(out.receipt);

    // (4) rejected — fit gate with a tiny budget: growth beyond budget is refused.
    disk = readFileSync(mirror, "utf8");
    writeFileSync(mirror, `${disk}[[CTX_TURN 7 role=user]]\nCANARY_SHOULD_BE_REJECTED\n`, "utf8");
    out = run({ budget: 5, gate: "fit" });
    assertEqual(out.action, "rejected", "over-budget edit rejected under fit");
    assertMatch(out.receipt, /^\[LIVE_CTX: edit REJECTED — fit: your edit was NOT applied \(still ~\d+\)/, "rejected receipt wording");
    assert(!out.messages.map(messageText).join("\n").includes("CANARY"), "original outgoing messages kept (canary absent)");
    assert(!readFileSync(mirror, "utf8").includes("CANARY"), "mirror restored to the view actually sent");
    receipts.push(out.receipt);

    // (5) still-over — shrink gate accepts a decrease that stays above budget.
    disk = readFileSync(mirror, "utf8");
    writeFileSync(mirror, disk.replace("[[CTX_TURN 1 role=user]]\nTurn one: please mirror the context.", ""), "utf8");
    out = run({ budget: 5, gate: "shrink" });
    assertEqual(out.action, "applied", "shrink accepted the decrease");
    assertMatch(out.receipt, /^\[LIVE_CTX: edit applied — context ~\d+->\d+ tokens, but STILL OVER the ~5-token limit\./, "still-over receipt wording");
    assert(!out.messages.map(messageText).join("\n").includes("Turn one"), "the shrunk turn is gone");
    receipts.push(out.receipt);

    assertEqual(receipts.length, 5, "all five receipts observed end to end");
});

test(8, "meter thresholds re-arm; urgent nudge is standing; one meter message", () => {
    assertEqual(meterId("ses_x"), "msg_clm_meter_ses_x", "deterministic meter id");
    assertEqual(
        meterText({ tokens: 50000, budget: 100000, mirrorPath: "P" }),
        "[context: ~50000/100000 tokens (50%)] · mirror: P",
        "meter line format",
    );
    const withExtras = meterText({ tokens: 10, budget: 100, mirrorPath: "P", receipt: "R", nudge: "N" });
    assertEqual(withExtras, "[context: ~10/100 tokens (10%)] · mirror: P\nR\nN", "receipt + nudge appended below the meter");

    // One standing meter: stripping removes any previous copy by id and by shape.
    const meter = nativeMeterMessage("ses_x", "[context: ~1/100 tokens (1%)] · mirror: P");
    const conversation = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }, meter, meter];
    assertEqual(stripNativeMeter(conversation).length, 1, "old meter messages are stripped before each rewrite");

    assertEqual(estimateTokens([{ role: "user", parts: [{ type: "text", text: "a".repeat(400) }], key: "k" }]), 100, "~1 token per 4 chars");
    assertEqual(appendBudgetLine("out", 10, 100), "out\n[context: ~10/100 tokens]", "tool budget line format");
    assertEqual(appendBudgetLine("out\n[context: ~10/100 tokens]", 10, 100), "out\n[context: ~10/100 tokens]", "budget line added at most once");

    // Threshold sequence: fire once, re-arm below, fire again; urgent stands.
    const budget = 1000;
    let state = pickNudge(200, budget, { 25: false, 50: false, 75: false }).state;
    assertEqual(pickNudge(200, budget, state).text, "", "20%: silent");
    let step = pickNudge(250, budget, state);
    assertMatch(step.text, /~25% of your 1000-token budget \(250 tokens\)\. No action needed\./, "25% nudge text");
    state = step.state;
    assertEqual(pickNudge(300, budget, state).text, "", "25% nudge is one-shot");
    state = pickNudge(200, budget, state).state;
    step = pickNudge(300, budget, state);
    assertMatch(step.text, /~25% of your 1000-token budget/, "25% re-armed below the threshold and fired again");
    state = step.state;
    step = pickNudge(500, budget, state);
    assertMatch(step.text, /~50% of your 1000-token budget \(500 tokens\)\. Finish the unit of work in flight, then tidy ONCE\./, "50% nudge text");
    state = step.state;
    assertEqual(pickNudge(520, budget, state).text, "", "50% nudge is one-shot");
    step = pickNudge(1001, budget, state);
    assertMatch(step.text, /^CONTEXT BUDGET NUDGE \(URGENT\): You are at 1001\/1000 tokens — over your hard context limit\./, "urgent nudge over budget");
    state = step.state;
    step = pickNudge(1050, budget, state);
    assertMatch(step.text, /URGENT/, "urgent nudge is standing while over budget");
    state = step.state;
    assertEqual(pickNudge(900, budget, state).text, "", "back under budget: urgent stops, thresholds stay consumed");
    state = pickNudge(700, budget, state).state;
    step = pickNudge(760, budget, state);
    assertMatch(step.text, /~75% of your 1000-token budget \(760 tokens\) — close to the limit\./, "75% re-armed below and fired again");
});

test(9, "orphan check (folded region carries no tool parts; results never dangle)", () => {
    // (a) Rendered tool blocks fold back as plain text — nothing to orphan.
    const rendered = renderMirror(coreFixture());
    const parsed = parseMirror(rendered);
    for (const turn of parsed.turns) {
        for (const part of turn.parts) assertEqual(part.type, "text", "every folded part is plain text");
    }
    const rebuilt = rebuildMessages(coreFixture()[0], parsed.turns, []);
    assert(
        !JSON.stringify(rebuilt).includes('"type":"tool"'),
        "the rebuilt region contains no tool parts at all",
    );
    assert(
        rebuilt.map(messageText).join("\n").split("report.txt").length - 1 === 1,
        "the tool output text survives exactly once",
    );

    // (b) Same guarantee starting from the real V1 {info, parts} shape.
    const v1Messages = [
        {
            info: { id: "msg_u1", sessionID: "ses_o", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
            parts: [{ id: "p1", sessionID: "ses_o", messageID: "msg_u1", type: "text", text: "go" }],
        },
        {
            info: { id: "msg_a1", sessionID: "ses_o", role: "assistant", time: { created: 2 }, agent: "build", modelID: "m", providerID: "p", mode: "build", path: { cwd: "", root: "" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            parts: [
                { id: "p2", sessionID: "ses_o", messageID: "msg_a1", type: "tool", callID: "call9", tool: "read", state: { status: "completed", input: { filePath: "x" }, output: "file contents", title: "read", metadata: {}, time: {} } },
            ],
        },
    ];
    const fromV1 = parseMirror(renderMirror(v1ToCore(v1Messages)));
    assert(
        !JSON.stringify(fromV1.turns).includes('"type":"tool"'),
        "V1-shaped input also folds to plain text",
    );
    assert(fromV1.turns.some((t) => messageText(t) === "file contents"), "V1 tool output kept as text");

    // (c) Native pairing: a result is attached to its call exactly once; an
    //     unpaired result degrades to text instead of dangling.
    const native = [
        { id: "m1", role: "user", content: [{ type: "text", text: "go" }] },
        {
            id: "m2",
            role: "assistant",
            content: [
                { type: "text", text: "reading" },
                { type: "tool-call", id: "call1", name: "read", input: { filePath: "x" } },
            ],
        },
        { id: "m3", role: "user", content: [{ type: "tool-result", id: "call1", result: { type: "text", value: "file contents" } }] },
        { id: "m4", role: "user", content: [{ type: "tool-result", id: "callX", result: { type: "text", value: "orphan output" } }] },
    ];
    const core = nativeToCore(native);
    const callPart = core[1].parts.find((p) => p.type === "tool");
    assert(callPart !== undefined, "tool-call found");
    assertEqual(callPart.output, "file contents", "paired result attached to its call");
    assertEqual(core[2].parts.length, 0, "consumed result not duplicated into the user message");
    assertEqual(core[3].parts.map((p) => (p.type === "text" ? p.text : "?")).join(","), "orphan output", "unpaired result kept as text");
    assertEqual(core[0].key, "m1", "native ids become stable message keys");
});

/* --------------------------------------------------------------- summary */

for (const dir of createdDirs) {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

const total = 9;
console.log("");
if (failures === 0) {
    console.log(`RESULT: ${total}/${total} PASS (${checks} assertions)`);
    process.exit(0);
} else {
    console.log(`RESULT: ${total - failures}/${total} PASS, ${failures} FAIL (${checks} assertions)`);
    process.exit(1);
}
