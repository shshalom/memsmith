# Security Policy

## Supported Versions

Only the latest released version of `memsmith` receives security updates. Please upgrade to the latest version before reporting a vulnerability.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a vulnerability

If you discover a security vulnerability in MemSmith, report it privately:

1. Don't open a public GitHub issue, pull request, or discussion.
2. Open a private advisory with GitHub private vulnerability reporting: https://github.com/shshalom/memsmith/security/advisories/new
3. Include steps to reproduce, the impact, the affected versions, and a suggested fix if you have one.

**Scope:** This policy covers the `memsmith` npm package and Claude Code plugin: the hooks, the MemSmith server (local and team runtimes), the embedded Postgres manager, the MCP server, the viewer UI, and the bundled skills. Report issues in upstream dependencies to those projects directly; you can also flag them to us.

We acknowledge valid reports within 48 hours and aim to ship a fix in the next release.

## Security Measures

### Command Injection Prevention

MemSmith executes system commands for git operations and process management. We have implemented comprehensive protections against command injection:

#### Safe Command Execution
- **Array-based Arguments:** All commands use array-based arguments to prevent shell interpretation
- **No Shell Execution:** `shell: false` is explicitly set for all spawn operations involving user input
- **Input Validation:** All user-controlled parameters are validated before use

#### Example Safe Pattern
```typescript
// ✅ SAFE: Array-based arguments with validation
if (!isValidBranchName(userInput)) {
  throw new Error('Invalid input');
}
spawnSync('git', ['checkout', userInput], { shell: false });

// ❌ UNSAFE: Never do this
execSync(`git checkout ${userInput}`);
```

### Input Validation

All user-controlled inputs are validated using whitelists and strict patterns:

- **Branch Names:** Must match `/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/` and not contain `..`
- **Port Numbers:** Must be numeric and within range 1024-65535
- **File Paths:** All paths are joined using `path.join()` to prevent traversal

### Process management

- **PID file protection:** The server stores process IDs in your data directory (`~/.memsmith/`).
- **Port validation:** The server validates its port before binding.
- **Health checks:** Hooks and the CLI check server health before they send requests.

### Privacy Controls

MemSmith includes dual-tag system for content privacy:

- `<private>content</private>` - User-level privacy (prevents storage)
- `<memsmith-context>content</memsmith-context>` - System-level tag (prevents recursive storage)

Hooks strip these tags before data reaches the server or the database.

## Security Audit History

### 2025-12-16: Command Injection Vulnerability (Issue #354)
- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Affected Versions:** All versions prior to fix
- **Fixed In:** Current version
- **Vulnerabilities Found:** 3
- **Vulnerabilities Fixed:** 3

**Summary of Fixes:**
1. Replaced string interpolation with array-based arguments in `BranchManager.ts`
2. Added `isValidBranchName()` validation function
3. Removed unnecessary shell usage in `bun-path.ts`
4. Created comprehensive security test suite

## Security Best Practices for Contributors

### When Adding Command Execution

1. **NEVER use shell with user input:**
   ```typescript
   // ❌ NEVER
   execSync(`command ${userInput}`);
   spawn('command', [...], { shell: true });

   // ✅ ALWAYS
   spawnSync('command', [userInput], { shell: false });
   ```

2. **ALWAYS validate user input:**
   ```typescript
   if (!isValidInput(userInput)) {
     throw new Error('Invalid input');
   }
   ```

3. **Use array-based arguments:**
   ```typescript
   // ❌ NEVER
   execSync(`git ${command} ${arg}`);

   // ✅ ALWAYS
   spawnSync('git', [command, arg], { shell: false });
   ```

4. **Explicitly set shell: false:**
   ```typescript
   spawnSync('command', args, { shell: false });
   ```

### When Adding User Input

1. **Whitelist validation** over blacklist
2. **Strict regex patterns** for format validation
3. **Type checking** for expected data types
4. **Range validation** for numeric inputs
5. **Length limits** for string inputs

### Code Review Checklist

Before submitting a PR with command execution or user input handling:

- [ ] No `execSync` with string interpolation or template literals
- [ ] No `shell: true` when user input is involved
- [ ] All spawn/spawnSync calls use array arguments
- [ ] Input validation is present for all user-controlled parameters
- [ ] Security tests are added for new attack vectors
- [ ] Code follows the safe patterns described above

## Dependencies

We regularly audit dependencies for vulnerabilities:

- **npm audit:** Run before each release
- **Dependabot:** Enabled for automatic security updates
- **Manual Review:** Critical dependencies reviewed quarterly

## Data storage

Where MemSmith stores observations depends on the runtime:

- **Local runtime (default):** An embedded Postgres with pgvector, with its data directory at `~/.memsmith/pgdata` and downloaded binaries at `~/.memsmith/pg-binaries`. Nothing leaves your machine except calls to the generation provider you configure.
- **Team runtime:** Observations are stored in the team's remote Postgres, reached through the team's MemSmith server. Anyone with access to that server or database can read the team's memory.

In both runtimes, MemSmith keeps its own state in `~/.memsmith/`:

- **Logs:** `~/.memsmith/logs/`
- **Settings:** `~/.memsmith/settings.json`, written with owner-only permissions because it can hold API keys

MemSmith sends no usage telemetry unless you configure your own telemetry key. For details, see `docs/public/telemetry.mdx`.

By design, MemSmith calls model providers and optional integrations, so observation, transcript, and prompt content can leave your machine through these channels:

- **Claude Agent SDK** (default generation provider): sends prompts and transcript context to Anthropic's API.
- **Alternate providers** (`gemini`, `openrouter`, `ollama`): when configured, receive the same context instead. Ollama runs locally.
- **OAuth and keychain reads:** MemSmith reads the Claude Code OAuth token from the platform credential store when it starts a generation process. It passes the token to that process and doesn't transmit it anywhere else.
- **npm registry:** version checks and self-update fetch metadata from the public registry.

Review your provider configuration in `~/.memsmith/settings.json` before you send sensitive content. To keep specific content out of memory, wrap it in `<private>...</private>` tags.

## Permissions

MemSmith requires the following:

- **File system:** Read and write access to `~/.memsmith/` and `~/.claude/plugins/`.
- **Network:** An HTTP server on `127.0.0.1`. The default port is derived from your user ID (`38877 + uid % 100`) so that accounts on a shared machine don't collide. The local runtime's embedded Postgres listens on `127.0.0.1:55433`.
- **Process management:** Starts and stops the server and embedded Postgres processes and manages their PID files.

MemSmith doesn't need elevated (root or administrator) privileges.

## Secure defaults

- **Server host:** Binds to `127.0.0.1` (localhost only).
- **Server port:** UID-derived by default; configurable, and validated to the range 1024-65535.
- **Log level:** INFO by default, with no sensitive data in logs.
- **Privacy tags:** Hooks strip private content before storage.

## Updates

Security patches are released as soon as possible after discovery. Users should:

1. Keep memsmith updated to the latest version
2. Monitor GitHub releases for security announcements
3. Review [CHANGELOG.md](./CHANGELOG.md) for security-related changes

## Questions

For security questions that aren't vulnerabilities:

1. Review the code comments in security-critical files.
2. Open a GitHub Discussion (not an issue) for general security questions.
3. For sensitive questions, open a private advisory at https://github.com/shshalom/memsmith/security/advisories/new.

---

**Last Updated:** 2026-05-03
**Last Audit:** 2025-12-16 (Issue #354)
**Next Scheduled Audit:** 2026-09-16
