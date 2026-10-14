// A plugin update replaces the hooks and the MCP server, but the running server
// keeps its old code until it restarts. New tools then fail against old routes,
// as observation_get did against a 13.10.2 server.
const UNKNOWN_VERSIONS = new Set(['', '0.0.0-dev']);

export function serverVersionSkewNotice(serverVersion: string | undefined, pluginVersion: string): string | null {
  if (!serverVersion || UNKNOWN_VERSIONS.has(serverVersion) || UNKNOWN_VERSIONS.has(pluginVersion)) return null;
  if (serverVersion === pluginVersion) return null;
  return `MemSmith's server is running ${serverVersion}, but the plugin is ${pluginVersion}. ` +
    'Memory tools that changed between them can fail. To fix it, run: npx memsmith@latest update';
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

export interface ServerVersionCheck {
  projectRuntime: 'local' | 'server';
  serverBaseUrl: string | null;
  pluginVersion: string;
  probe?: (baseUrl: string) => Promise<string | undefined>;
}

// Only a local server is ours to restart; a team server is upgraded by its operator.
export async function checkServerVersion(check: ServerVersionCheck): Promise<string | null> {
  if (check.projectRuntime === 'server' || !check.serverBaseUrl) return null;
  const probe = check.probe ?? ((url: string) => probeServerVersion(url));
  return serverVersionSkewNotice(await probe(check.serverBaseUrl), check.pluginVersion);
}
