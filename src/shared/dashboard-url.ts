// Single source of the local MemSmith dashboard/viewer URL. Mirrors the private
// getServerPort() in src/server/runtime/ServerService.ts so the SessionStart
// injection line and the ms-dashboard skill resolve the same URL without
// reaching into that private function or hardcoding a port. Pure + total:
// never throws (uid fallback 77), safe to call from the injection hot path.
const DEFAULT_SERVER_PORT = 38877;

export function resolveDashboardPort(): number {
  const parsed = Number.parseInt(process.env.MEMSMITH_SERVER_PORT ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_SERVER_PORT + ((process.getuid?.() ?? 77) % 100);
}

// One server serves every local project, so a bare link always lands on the
// project the SERVER booted from. Passing the session's own projectId scopes
// the dashboard — and the Go Team wizard, which acts on whatever the dashboard
// authenticates as — to the project the user is actually working in.
export function resolveDashboardUrl(projectId?: string): string {
  const base = `http://127.0.0.1:${resolveDashboardPort()}`;
  const id = projectId?.trim();
  return id ? `${base}?project=${encodeURIComponent(id)}` : base;
}
