export function buildAutoStartCommand(input: { runtimePath: string; scriptPath: string; useSetsid: boolean; projectCwd: string }): { execPath: string; args: string[]; env: Record<string, string> } {
  const command = [input.scriptPath, 'start', '--daemon'];
  const env = { MEMSMITH_PROJECT_CWD: input.projectCwd };
  return input.useSetsid
    ? { execPath: '/usr/bin/setsid', args: [input.runtimePath, ...command], env }
    : { execPath: input.runtimePath, args: command, env };
}
