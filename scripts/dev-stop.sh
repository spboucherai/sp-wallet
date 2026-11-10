#!/bin/bash
D=${SPW_DEV_DIR:-/tmp/spw-dev}; for f in "$D"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; true
