// SPDX-License-Identifier: Apache-2.0
//
// Two team-mode Settings gaps the user reported after converting a project.
//
// 1. GO TEAM stayed clickable on a converted project, re-offering work already
//    done. The gate (identity.runtime === 'team') exists and /v1/identity does
//    return 'team' — the button the user saw was a stale bundle. Guarded here so
//    an unconditional render cannot come back: it already regressed once.
//
// 2. Context settings silently apply to ONE MACHINE in team mode. They write
//    MEMSMITH_CONTEXT_* into ~/.memsmith/settings.json, while team overrides
//    (server_settings via PATCH /v1/settings) cover a DISJOINT set of keys —
//    provider, model, search weights, cost caps. Converting to team mode does
//    NOT make context settings shared, and nothing said so. A user reasonably
//    assumes everything under Settings follows the project into team mode.
//
//    The fix states the scope rather than rerouting. Silently writing per-machine
//    display preferences into a team-wide table would change behaviour for
//    teammates who never asked for it — and the team key set does not include
//    these keys, so there is nowhere correct to put them today.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const SETTINGS_VIEW = readFileSync(join(REPO, 'src/ui/viewer/views/SettingsView.tsx'), 'utf-8');

describe('GO TEAM is not offered on a converted project', () => {
  it('gates the Team Mode row on identity.runtime', () => {
    expect(SETTINGS_VIEW).toMatch(/identity\.runtime === 'team'/);
  });

  it('renders a state badge, not a button, once in team mode', () => {
    // A second button labelled anything invites a redo of completed work.
    expect(SETTINGS_VIEW).toContain('settings-badge--team');
    expect(SETTINGS_VIEW).toContain('This project is in Team mode');
  });

  it('still offers GO TEAM when the project is local', () => {
    expect(SETTINGS_VIEW).toContain('GO TEAM');
  });
});

describe('the base key stays recoverable to the owner', () => {
  it('Settings can reveal the plaintext, not only the mask', () => {
    // The wizard shows the key once. Without a reveal path the owner would have
    // to read ~/.memsmith/credentials.json by hand to onboard a teammate.
    expect(SETTINGS_VIEW).toMatch(/identity\.keyPlaintext/);
    expect(SETTINGS_VIEW).toMatch(/handleRevealToggle/);
  });

  it('masks by default, revealing only on explicit action', () => {
    // Plaintext must not be the resting state of the pane.
    expect(SETTINGS_VIEW).toMatch(/revealKey && identity\.keyPlaintext \? identity\.keyPlaintext : identity\.keyMasked/);
  });
});

describe('context settings state their scope in team mode', () => {
  it('ContextPane receives the runtime so it can say what applies where', () => {
    expect(SETTINGS_VIEW).toMatch(/runtime=\{identity\?\.runtime\}/);
  });

  it('warns that context settings are machine-local when in team mode', () => {
    expect(SETTINGS_VIEW).toMatch(/settings-note--scope/);
    expect(SETTINGS_VIEW).toMatch(/this machine only/i);
  });

  it('does NOT show the notice on a local project', () => {
    // On a local install there is no team to mislead anyone about, so the notice
    // would be noise. The condition must be runtime-gated, not unconditional.
    const noticeBlock = SETTINGS_VIEW.slice(
      SETTINGS_VIEW.indexOf('settings-pane--context'),
      SETTINGS_VIEW.indexOf('settings-pane--context') + 1400,
    );
    expect(noticeBlock).toMatch(/runtime === 'team' \?/);
  });

  it('the notice is styled, so it reads as a warning rather than body text', () => {
    const css = readFileSync(join(REPO, 'src/ui/viewer-template.html'), 'utf-8');
    expect(css).toContain('.settings-note--scope');
  });
});
