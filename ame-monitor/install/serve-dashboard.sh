#!/bin/bash
# Run this on ONE always-on Mac to host the dashboard as a web page.
# Then bookmark  http://<that-mac-ip>:9000/dashboard.html  on any machine.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../dashboard"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)
echo "Dashboard at:  http://$IP:9000/dashboard.html"
echo "(Ctrl-C to stop)"
python3 -m http.server 9000
