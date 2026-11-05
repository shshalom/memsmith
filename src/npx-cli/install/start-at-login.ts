export const START_AT_LOGIN_QUESTION = 'Start MemSmith when you log in?';

export type StartAtLoginDecision = 'ask' | 'enable' | 'skip';

export function startAtLoginDecision(input: {
  interactive: boolean;
  ci: boolean;
  runtime: 'local' | 'server';
  flag?: boolean;
}): StartAtLoginDecision {
  if (input.runtime === 'server' || input.flag === false) return 'skip';
  if (input.flag === true) return 'enable';
  return input.interactive && !input.ci ? 'ask' : 'skip';
}

export interface StartAtLoginIO {
  /** False when the user declines or cancels. */
  ask(): Promise<boolean>;
  enable(): { ok: boolean; message: string };
  info(line: string): void;
  warn(line: string): void;
}

export async function applyStartAtLogin(decision: StartAtLoginDecision, io: StartAtLoginIO): Promise<void> {
  if (decision === 'skip') return;
  if (decision === 'ask' && !(await io.ask())) return;
  try {
    const result = io.enable();
    if (result.ok) io.info(result.message);
    else io.warn(result.message);
  } catch (error) {
    io.warn(`Could not register start at login: ${error instanceof Error ? error.message : String(error)}`);
  }
}
