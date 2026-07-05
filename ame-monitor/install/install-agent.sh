#!/bin/bash
# Run this ON EACH MAC that runs Adobe Media Encoder.
# It installs the monitoring panel and lets AME load unsigned extensions.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_SRC="$SCRIPT_DIR/../agent"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.amemonitor.agent"

if [ ! -f "$AGENT_SRC/CSXS/manifest.xml" ]; then
  echo "Can't find the agent folder next to this script. Run it from the install/ folder."
  exit 1
fi

echo "→ Allowing unsigned CEP extensions (PlayerDebugMode)…"
for v in 9 10 11 12; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null || true
done
killall cfprefsd 2>/dev/null || true

echo "→ Installing panel to:"
echo "  $DEST"
mkdir -p "$DEST"
rsync -a --delete "$AGENT_SRC/" "$DEST/"

echo ""
echo "✓ Installed on $(hostname -s)."
echo "  1. Quit and reopen Adobe Media Encoder."
echo "  2. Open  Window ▸ Extensions ▸ AME Monitor  (only needed once)."
echo "  3. The panel will show:  Serving on  http://<this-mac-ip>:8642/status"
echo "  4. If macOS asks to allow incoming network connections, click Allow."
