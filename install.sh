#!/usr/bin/env bash
# opencode-clm installer (macOS / Linux)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/f2025408135-cyber/opencode-clm/main/install.sh | bash
#   - or from a clone:  ./install.sh
set -euo pipefail

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
DEST_DIR="$CONF_DIR/plugins"
DEST="$DEST_DIR/clm-context.ts"
RAW_URL="https://raw.githubusercontent.com/f2025408135-cyber/opencode-clm/main/clm-context.ts"

mkdir -p "$DEST_DIR"

# Prefer the copy next to this script (clone); fall back to GitHub raw (| bash).
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE}")" && pwd)"
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/clm-context.ts" ]; then
  cp "$SCRIPT_DIR/clm-context.ts" "$DEST"
  echo "Using local clm-context.ts"
else
  echo "Downloading $RAW_URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$RAW_URL" -o "$DEST"
  else
    wget -qO "$DEST" "$RAW_URL"
  fi
fi
echo "Installed -> $DEST"

# Default config (only if the user has none yet)
CFG="$CONF_DIR/clm.jsonc"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<'EOF'
{
  // Context budget in approximate tokens (~1 token per 4 visible characters).
  "budget": 100000,
  // "fit" = reject an edit only if it would exceed the budget (default).
  // "shrink" = reject an edit unless it makes context smaller than before.
  "gate": "fit"
}
EOF
  echo "Wrote default config -> $CFG"
fi

echo ""
echo "Done. Now restart OpenCode (or run 'opencode reload')."
echo "Verify: ask the model to run clm_status, or check the log for 'clm-context'."
