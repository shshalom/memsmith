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

export function resolveDashboardUrl(): string {
  return `http://127.0.0.1:${resolveDashboardPort()}`;
}
