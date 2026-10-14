// A plugin update replaces the hooks and the MCP server, but the running server
// keeps its old code until it restarts. New tools then fail against old routes,
// as observation_get did against a 13.10.2 server.
export function serverVersionSkewNotice(serverVersion: string | undefined, pluginVersion: string): string | null {
  if (!serverVersion || !pluginVersion || serverVersion === pluginVersion) return null;
  return `MemSmith's server is running ${serverVersion}, but the plugin is ${pluginVersion}. ` +
    'Memory tools added since then fail until the server restarts. To fix it, run: memsmith restart';
}

export async function probeServerVersion(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}
