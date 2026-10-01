# opencode-clm

**Context Language Models for OpenCode** — let the model own and edit its own context instead of letting the harness silently compact it.

Implements the CLM mechanism from [*Context Language Models*](https://arxiv.org/abs/2609.37725) (arXiv 2609.37725) as a single-file OpenCode plugin. The model reads a **mirror file** of its own conversation, edits it to compact or reorganize, and gets a **receipt** for every edit. The harness's built-in auto-compaction stays on as a last-resort safety net.

- **One file, zero dependencies.** `clm-context.ts` is the whole plugin.
- **Drop-in install.** Copy one file into `~/.config/opencode/plugins/` and reload.
- **Doesn't fight your setup.** fly-team-bus, subagents, built-in compaction — all keep working.

---

## Install

### Windows (PowerShell)

```powershell
iwr https://raw.githubusercontent.com/f2025408135-cyber/opencode-clm/main/install.ps1 | iex
```

### macOS / Linux (bash)

```bash
curl -fsSL https://raw.githubusercontent.com/f2025408135-cyber/opencode-clm/main/install.sh | bash
```

### Manual (any platform)

```bash
# 1. copy the plugin into OpenCode's auto-discovered plugin dir
mkdir -p ~/.config/opencode/plugins
cp clm-context.ts ~/.config/opencode/plugins/

# 2. reload OpenCode (or restart the app)
opencode reload
```

That's it. The plugin is auto-discovered — **no config edits required.**

Verify it loaded:

```bash
# in your next session, ask: "run clm_status"
# or check the log for the plugin load line:
grep "clm-context" ~/.local/share/opencode/log/opencode.log | tail -5
```

### Optional: tune the budget

Create `~/.config/opencode/clm.jsonc`:

```jsonc
{
  // context budget in approximate tokens (~1 token per 4 characters)
  "budget": 100000,
  // "fit"   — reject an edit only if it would EXCEED the budget (default)
  // "shrink" — reject an edit unless it makes context SMALLER than before
  "gate": "fit"
}
```

### Uninstall

```bash
rm ~/.config/opencode/plugins/clm-context.ts   # (add .disabled on Windows if locked)
opencode reload
```

To also revert to DCP-style compression, re-add `"@tarquinen/opencode-dcp"` to the `plugins` array in `~/.config/opencode/opencode.json`.

---

## What it does

Every session gets a mirror file at `<project>/.clm/LIVE_CTX_<sessionID>.txt`:

```text
[[PROTECTED]]
<system prompt — never mirrored, re-pinned verbatim on every parse>

[[CTX_TURN 1 role=user]]
First task: build CLM.

[[CTX_TURN 2 role=assistant]]
Working on it — starting with the mirror renderer…
```

On every turn the plugin:

1. **Renders** the durable session history into the mirror (append-only; turn numbers are display-only — file order wins).
2. **Re-emits** the protected prefix byte-identically (the harness's system prompt is never rewritten) and the mirror as the model's quoted context.
3. **Injects a meter** on every tool result:
   `[context: ~50678/100000 tokens (51%)] · mirror: <path>`
4. **Applies the edit gate.** After you (the model) edit the mirror file, your edit is parsed back and either applied or rejected with a receipt.

### Receipts

Every mirror edit gets exactly one receipt on the next turn:

| Receipt | Meaning |
|---|---|
| `LIVE_CTX: applied` | Edit fits the budget and was applied |
| `LIVE_CTX: edit applied but it GREW context ~655->674 tokens` | Applied, but note the growth |
| `LIVE_CTX: NO change — your edit matched nothing` | Edit was a no-op (render-equal); protected block re-pinned |
| `LIVE_CTX: edit REJECTED — …` | Violated the gate; **your edit was not applied**, original context kept |
| `LIVE_CTX: still over …` | Applied but still above budget (only reachable with `shrink` off) |

### The doctrine

The plugin appends a short, append-only instruction block to the system prompt teaching the model the CLM loop — you own your own context, edit the mirror, copy facts forward, batch your edits, watch the meter. Nudges fire at 25 / 50 / 75 % of budget and re-arm after a shrink.

### The `clm_status` tool

Read-only status report: mirror path, current context size, budget, gate mode, and whether the mirror is authoritative. Use it instead of reading the mirror file.

---

## Design notes

- **Protected prefix** = system prompt + first message. Never mirrored, re-pinned verbatim on parse (paper's `_PROTECT = 2`). Tampering with it in the file is detected and reverted.
- **Role folding** (paper rule): every non-assistant header role folds to `user` on parse; `assistant` stays `assistant`.
- **Session history is never mutated.** Mirror edits only change the outgoing payload for the next model call — export your session before/after an edit and the durable history is identical.
- **Receipts are ephemeral.** They're consumed on the next turn; state is in-memory (a fresh process re-initializes from the durable history).
- **Built-in auto-compaction is untouched.** If the model never edits its mirror, OpenCode's own compactor still fires as the last resort — CLM *augments* the harness, it doesn't disable the safety net.
- **Coexists with other plugins.** Doctrine/meter/nudges are *appended* to system text, never replacing other plugins' pushes (verified with fly-team-bus).

### Known limitations

- `still-over` receipt is unreachable under the default `fit` gate (by design).
- Windows: if the plugin dir is a junction/symlink and a long-lived host fails its first import, `opencode reload` may not clear the poisoned resolve — install into `~/.config/opencode/plugins/` directly (which `install.ps1` does) to avoid it.
- V2 plugin API (`setup` shape) is the tested path; the V1 `server` adapter is implemented but untested against a real V1 host.

---

## Testing

```bash
node --experimental-strip-types clm-selftest.mjs
```

9 numbered cases, 116 assertions: round-trip stability, protected prefix, stray-text handling, role folding, header-number handling, fit/shrink gates, all five receipts, meter thresholds/re-arm, orphan checks. Writes only to a fresh temp dir and cleans up after itself.

Requires Node ≥ 22.6 (uses `--experimental-strip-types` to import the `.ts` directly).

---

## Credits

- Mechanism: [Context Language Models](https://arxiv.org/abs/2609.37725) (arXiv 2609.37725), announced by [Nathan Lambert](https://x.com/natolambert/status/2105284621638439271).
- Built for [OpenCode](https://opencode.ai) v2 plugin API.
- Replaces the active role of `@tarquinen/opencode-dcp` (compression) with model-driven editing — DCP stays installed as a one-line revert.

## License

[MIT](LICENSE)
