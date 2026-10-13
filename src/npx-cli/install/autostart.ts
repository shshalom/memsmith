export function buildAutoStartCommand(input: { runtimePath: string; scriptPath: string; useSetsid: boolean }): { execPath: string; args: string[] } {
  const command = [input.scriptPath, 'start', '--daemon'];
  return input.useSetsid
    ? { execPath: '/usr/bin/setsid', args: [input.runtimePath, ...command] }
    : { execPath: input.runtimePath, args: command };
}
