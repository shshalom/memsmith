---
name: ms-dashboard
description: Open the MemSmith dashboard (memory viewer, metrics, and cost panel) in the browser. Use when the user asks to open/see/view the MemSmith dashboard, viewer, or memory UI.
---

# MemSmith Dashboard

Open the local MemSmith dashboard for this machine.

## Resolve the URL

The dashboard is served by the local MemSmith server on a UID-derived port:

- If `MEMSMITH_SERVER_PORT` is set to a positive integer, the port is that value.
- Otherwise the port is `38877 + (uid % 100)`, where `uid` is the current user's numeric id (`id -u`).

Compute the URL as `http://127.0.0.1:<port>`. For example:

```bash
PORT="${MEMSMITH_SERVER_PORT:-$((38877 + $(id -u) % 100))}"
echo "http://127.0.0.1:$PORT"
```

## Open it

- On macOS: `open "http://127.0.0.1:$PORT"`.
- On Linux: `xdg-open "http://127.0.0.1:$PORT"` (or just print the URL).
- Otherwise: print the URL as a clickable link for the user.

If the page does not load, the local MemSmith server may not be running — starting a new Claude Code session in a MemSmith-tracked project boots it.
