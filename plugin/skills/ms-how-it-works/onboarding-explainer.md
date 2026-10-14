# How memsmith works

## What it does

Every Read, Edit, and Bash that Claude makes turns into a compressed observation. Observations get summarized at session end. Relevant ones get auto-injected into future prompts so the next session starts with context from the last one — no re-explaining the codebase, no re-discovering decisions.

## When it kicks in

Memory injection starts on your second session in a project.

The first session in a fresh project seeds memory; subsequent sessions receive auto-injected context for relevant past work.

## Where data lives

In local mode (the default), everything stays in ~/.memsmith on this machine. The database, embeddings, logs, and settings all live under that directory, and `npx memsmith uninstall` removes them. Nothing leaves your machine except calls to the generation provider you configured (Claude, Gemini, OpenRouter, or Ollama).

In team mode, observations are stored on your team's MemSmith server, where teammates with access can search them. Your settings and logs still live in ~/.memsmith.
