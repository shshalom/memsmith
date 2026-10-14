---
name: ms-mem-search
description: Search MemSmith's persistent cross-session memory. Use when the user asks "did we already solve this?", "how did we do X last time?", or needs decisions and work from previous sessions. Also use to record a note when the user asks you to remember something.
---

# Memory search

Search past work across sessions with the MemSmith MCP tools. Search first, then pull full context only for the few results that matter.

## When to use

Use this skill when the user asks about earlier sessions, not the current conversation:

- "Did we already fix this?"
- "How did we solve X last time?"
- "Why did we choose this approach?"

## Workflow

### Step 1: Search

Call `observation_search` to get a ranked index of matching observations:

```
observation_search(query="authentication token expiry")
```

Each result is one entry: id, date, type, title, and a snippet of about 200 characters.

Parameters:

- `query` (string, required): The search terms.
- `limit` (number, optional): Maximum results. The default is 10 and the maximum is 25.
- `projectId` (string, optional): The project to search. Defaults to the current project from settings.
- `platformSource` (string, optional): Restricts results to one agent's memory, such as `claude`, `codex`, or `cursor`.

Read the titles and snippets, and decide which results are relevant. Discard the rest. If nothing is relevant, search again with different terms before you conclude that memory has no record.

### Step 2: Fetch the records that matter

Call `observation_get` with the ids of the relevant results:

```
observation_get(ids=["<id>", "<id>"])
```

It returns each full record: the body, why it was done, the files involved, and any rejected alternatives. You can pass up to 10 ids per call.

To get the full bodies of the top few matches in one call without choosing, use `observation_context(query="...", limit=5)`. The default is 5 and the maximum is 10.

### Step 3: Answer

Answer from the retrieved observations, and say which ones you relied on. If memory has nothing relevant, say so before you fall back to reading code. Verify load-bearing claims against the current code.

## Record a user-directed note

When the user asks you to remember, record, note, or save something, call `note_add`:

```
note_add(content="Deploys to staging need the VPN; production deploys run from CI only.")
```

Write the note so it makes sense on its own in a future session. Don't use `observation_add` for user requests: it doesn't mark the row as a user note.

## Why search first

An index entry costs far fewer tokens than a full record. Searching broadly, then fetching only the few records that matter, keeps the answer grounded without filling the context window.
