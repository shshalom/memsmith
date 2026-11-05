# Start at login: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MemSmith starts when the user logs in, on macOS, Linux, and Windows, so memory is available after a reboot before any Claude Code session opens.

**Architecture:** A `memsmith autostart enable|disable|status` command registers a one-shot login entry that runs `<bun> <server-service.cjs> start`. That command starts embedded Postgres and the server as a daemon, then exits, so the login entry is never supervised and never restarts anything. One pure module builds each platform's entry; a small OS adapter writes files and runs `launchctl`, `systemctl`, or `reg`. The installer offers it, `memsmith update` offers it once, and `memsmith uninstall` removes it.

**Tech Stack:** TypeScript, Bun tests, `@clack/prompts`, launchd, systemd user units, the Windows `HKCU\...\Run` registry key.

**Spec:** The Design section below. Decided in session on 2026-11-05: the user skipped the design questions; the platform choices below are the controller's calls.

## Design

1. Command: `memsmith autostart enable | disable | status`. `enable` is idempotent and overwrites an existing entry. `disable` succeeds when nothing is registered. `status` prints whether an entry exists, the command it runs, and whether that command's script still exists.
2. The entry runs `<bun> <script> start` with absolute paths: Bun from `resolveWorkerRuntimePath()`, never `getBunPath()`, which can return a bare `bun`; the script is `join(marketplaceDirectory(), 'plugin', 'scripts', 'server-service.cjs')`. It sets `PATH` to include Bun's directory.
3. macOS: `~/Library/LaunchAgents/com.memsmith.start.plist`, `RunAtLoad` true, no `KeepAlive`, log to `~/.memsmith/logs/launchd-start.log`. Enable runs `launchctl bootout gui/<uid>/com.memsmith.start` (ignore failure), then `launchctl bootstrap gui/<uid> <plist>`. Disable boots it out and deletes the file. The label matches the hand-made agent already on the maintainer's machine, so `enable` replaces it.
4. Linux: `~/.config/systemd/user/memsmith.service`, `Type=oneshot`, `RemainAfterExit=yes`, `WantedBy=default.target`. Enable runs `systemctl --user daemon-reload` and `systemctl --user enable memsmith.service`. Without a working `systemctl --user` (no systemd, WSL), `enable` exits 1 with a message saying to run `memsmith start` from the shell profile instead; it writes nothing.
5. Windows: a `MemSmith` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` holding the quoted command. A Run key needs no administrator rights, unlike a Task Scheduler logon task. Known limitation, documented: a console window can flash at login.
6. Installer: after the server starts, ask `Start MemSmith when you log in?` with Yes preselected. Ask only when interactive, not in CI, and not on the `server` runtime. New flags for non-interactive installs: `--start-at-login` and `--no-start-at-login`; without either, a non-interactive install registers nothing. The existing `--no-auto-start` (skip starting the server now) is unrelated and unchanged.
7. Update: in an interactive `memsmith update` on the local runtime, when no entry is registered and `MEMSMITH_LOGIN_AUTOSTART_OFFERED` is unset, ask the same question once; either answer writes `MEMSMITH_LOGIN_AUTOSTART_OFFERED=1`. Non-interactive updates never prompt and print nothing about it.
8. Uninstall: remove the entry before the marketplace directory is deleted.
9. A failure to register never fails install or update: report it as a warning and continue.

## Global constraints

- Label and names, verbatim: `com.memsmith.start`, `memsmith.service`, Run value name `MemSmith`.
- Prompt text, verbatim: `Start MemSmith when you log in?`
- Flags, verbatim: `--start-at-login`, `--no-start-at-login`.
- Settings key, verbatim: `MEMSMITH_LOGIN_AUTOSTART_OFFERED`.
- Comments only where the code cannot say it. No narration comments.
- User-facing text follows the Google developer documentation style.
- Tests never call real `launchctl`, `systemctl`, or `reg`, and never write outside a temp directory.
- Never use `git stash`; use `git worktree add` for baselines.

## Review focus

1. A path with spaces (a Windows user name such as `C:\Users\Ana Silva\...`, a macOS home with spaces): the generated command must stay one correctly quoted argument list on every platform. Test in Task 1.
2. Re-running `enable` (or re-running the installer) must not stack duplicate entries or fail because one exists. Test in Task 2.
3. The marketplace script moves or is deleted (plugin reinstalled to the cache path): `status` must report the entry as broken rather than healthy. Test in Task 2.
4. Linux without systemd: `enable` must fail clearly and write no unit file. Test in Task 2.
5. A failing registration during install or update must not abort it. Test in Task 3.

---

### Task 1: Pure entry builders

**Files:**
- Create: `src/npx-cli/autostart/login-entry.ts`
- Test: `tests/npx-cli/login-entry.test.ts`

**Interfaces:**
- Produces:
```ts
export type LoginPlatform = 'darwin' | 'linux' | 'win32';
export interface LoginCommand { bunPath: string; scriptPath: string; logPath: string }
export function buildLaunchAgentPlist(cmd: LoginCommand): string;
export function buildSystemdUnit(cmd: LoginCommand): string;
export function buildWindowsRunValue(cmd: LoginCommand): string;
export function loginEntryPath(platform: LoginPlatform, home: string): string | null; // null for win32 (registry)
```

- [ ] **Step 1: Write failing tests:** `plist runs bun with the script and start as separate arguments, RunAtLoad true, no KeepAlive, label com.memsmith.start`; `plist escapes XML special characters in paths`; `systemd unit is oneshot with RemainAfterExit and WantedBy=default.target, and quotes a path with spaces`; `Windows Run value quotes both paths: "C:\Users\Ana Silva\.bun\bin\bun.exe" "C:\...\server-service.cjs" start`; `loginEntryPath returns the LaunchAgents plist on darwin, the systemd user unit on linux, null on win32`.
- [ ] **Step 2: Run** `bun test tests/npx-cli/login-entry.test.ts`. Expected: fails (module missing).
- [ ] **Step 3: Implement.** Build the plist with a fixed template and XML escaping; set `EnvironmentVariables.PATH` to Bun's directory plus `/usr/bin:/bin:/usr/sbin:/sbin` and Homebrew's `/opt/homebrew/bin:/usr/local/bin`.
- [ ] **Step 4: Run** the test file. Expected: all pass.
- [ ] **Step 5: Commit** `feat(autostart): build login entries for macOS, Linux, and Windows`.

### Task 2: `memsmith autostart` command

**Files:**
- Create: `src/npx-cli/commands/autostart.ts`
- Modify: `src/npx-cli/index.ts` (new `case 'autostart'` following the `telemetry` pattern; a help line under "Server Commands")
- Test: `tests/npx-cli/autostart-command.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
```ts
export interface AutostartDeps {
  platform: LoginPlatform; home: string; uid: number;
  resolveCommand(): LoginCommand | null;   // null when Bun or the script can't be found
  writeFile(path: string, body: string): void; removeFile(path: string): void; exists(path: string): boolean; readFile(path: string): string | null;
  run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string };
  out(line: string): void; err(line: string): void;
}
export function enableLoginAutostart(d: AutostartDeps): { ok: boolean; message: string };
export function disableLoginAutostart(d: AutostartDeps): { ok: boolean; message: string };
export function loginAutostartStatus(d: AutostartDeps): { registered: boolean; healthy: boolean; command?: string };
export function runAutostartCommand(argv: string[], d?: AutostartDeps): Promise<number>;
export function defaultAutostartDeps(): AutostartDeps;
```

- [ ] **Step 1: Write failing tests** with a recording fake `AutostartDeps`: `enable on darwin writes the plist and runs bootout then bootstrap gui/<uid>`; `enable twice leaves one plist and succeeds`; `disable on darwin boots out and deletes; disable with nothing registered succeeds`; `enable on linux writes the unit and runs daemon-reload then enable`; `enable on linux without systemd (systemctl --user fails) exits 1 and writes no unit`; `enable on win32 runs reg add HKCU\...\Run /v MemSmith /d <quoted command> /f`; `status reports broken when the registered script path no longer exists`; `enable fails clearly when resolveCommand returns null`; `runAutostartCommand with an unknown action prints usage and returns 1`.
- [ ] **Step 2: Run** the test file. Expected: fails.
- [ ] **Step 3: Implement**, including `defaultAutostartDeps` with `resolveWorkerRuntimePath()`, `marketplaceDirectory()`, `os.homedir()`, `process.getuid?.()`, and `spawnSync` for `run`.
- [ ] **Step 4: Run** `bun test tests/npx-cli/`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(autostart): add memsmith autostart enable, disable, and status`.

### Task 3: Installer, update, and uninstall integration

**Files:**
- Modify: `src/npx-cli/index.ts` (`--start-at-login`, `--no-start-at-login` in `parseInstallOptions`; help text)
- Modify: `src/npx-cli/commands/install.ts` (the prompt after the start step, ~1458, gated like `promptTelemetryOptIn`)
- Modify: `src/npx-cli/commands/update.ts` (one-time offer, same deps pattern as the Haiku switch offer)
- Modify: `src/npx-cli/commands/uninstall.ts` (disable step before the marketplace directory is removed)
- Test: `tests/npx-cli/install-start-at-login.test.ts`, `tests/npx-cli/update.test.ts`, `tests/npx-cli/uninstall-autostart.test.ts`

**Interfaces:**
- Consumes: `enableLoginAutostart`, `disableLoginAutostart`, `loginAutostartStatus` (Task 2).
- Produces: `export function startAtLoginDecision(input: { interactive: boolean; ci: boolean; runtime: 'local' | 'server'; flag?: boolean }): 'ask' | 'enable' | 'skip'` in `src/npx-cli/install/start-at-login.ts`.

- [ ] **Step 1: Write failing tests:** `startAtLoginDecision asks when interactive on local runtime without a flag`; `--start-at-login enables without asking, even non-interactive`; `--no-start-at-login skips`; `non-interactive without a flag skips`; `server runtime skips`; `CI skips unless --start-at-login`; `a failing enable during install becomes a warning and the install still succeeds`; `update offers once when nothing is registered, writes the marker on either answer, never offers again`; `update never prompts when non-interactive`; `uninstall disables login autostart before removing the marketplace directory` (assert call order).
- [ ] **Step 2: Run** the new and changed test files. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test tests/npx-cli/`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(install): offer to start MemSmith at login`.

### Task 4: Docs, changelog, build, and live check

**Files:**
- Modify: `docs/public/installation.mdx` (a "Start at login" section; flag rows for `--start-at-login` and `--no-start-at-login`; a removal line under Uninstall), `docs/public/configuration.mdx:~133` (one line for `memsmith autostart`), `CHANGELOG.md` (`## [Unreleased]` → Added)

- [ ] **Step 1:** Update docs and changelog. Document the Windows console-window limitation and the Linux-without-systemd fallback.
- [ ] **Step 2: Run** `bun test` and `npx tsc --noEmit`, then `npm run build`.
- [ ] **Step 3: Live check (controller, macOS only):** `memsmith autostart status` on the maintainer's machine reports the existing hand-made agent; `memsmith autostart enable` replaces it with the generated plist; `memsmith stop --all`, then `launchctl kickstart gui/<uid>/com.memsmith.start`, brings the server and Postgres back; `status` reports healthy.
- [ ] **Step 4: Commit** `docs: start at login`.
