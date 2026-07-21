// SPDX-License-Identifier: Apache-2.0
import { isIncognito, setIncognito } from '../incognito.js';

const MSG_ON = '🔒 Incognito ON — nothing from this session will be recorded.';
const MSG_OFF = 'Incognito OFF — recording resumed.';

export function handleIncognitoCommand(
  sessionId: string,
  arg: string | undefined,
): { on: boolean; message: string } {
  const normalized = (arg ?? '').trim().toLowerCase();
  let on: boolean;
  if (normalized === 'on') on = true;
  else if (normalized === 'off') on = false;
  else on = !isIncognito(sessionId); // '' or 'toggle'
  setIncognito(sessionId, on);
  return { on, message: on ? MSG_ON : MSG_OFF };
}
