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

Call `observation_search` to get a ranked list of matching observations:

```
observation_search(query="authentication token expiry", limit=20)
```

Parameters:

- `query` (string, required): The search terms.
- `limit` (number, optional): Maximum results. The default is 20 and the maximum is 100.
- `projectId` (string, optional): The project to search. Defaults to the current project from settings.
- `platformSource` (string, optional): Restricts results to one agent's memory, such as `claude`, `codex`, or `cursor`.

Read the titles and snippets, and decide which results are relevant. Discard the rest.

### Step 2: Get context for the results that matter

Call `observation_context` with a query narrowed to the relevant results, such as a title or a distinctive phrase from step 1:

```
observation_context(query="JWT refresh token expiry fix", limit=5)
```

It returns the top matching observations and a packed context string that is ready to use in your answer.

Parameters:

- `query` (string, required): The focused query.
- `limit` (number, optional): Maximum observations. The default is 10 and the maximum is 50. Keep it small.
- `projectId` and `platformSource` (optional): Same as `observation_search`.

### Step 3: Answer

Answer from the retrieved observations, and say which ones you relied on. If memory has nothing relevant, say so before you fall back to reading code.

## Record a user-directed note

When the user asks you to remember, record, note, or save something, call `note_add`:

```
note_add(content="Deploys to staging need the VPN; production deploys run from CI only.")
```

Write the note so it makes sense on its own in a future session. Don't use `observation_add` for user requests: it doesn't mark the row as a user note.

## Why search first

A search result costs far fewer tokens than full context. Searching broadly, then requesting context for only a few results, keeps the answer grounded without filling the context window.
