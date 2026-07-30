// SPDX-License-Identifier: Apache-2.0
//
// The shipped default for MEMSMITH_QUEUE_ENGINE was 'sqlite' — the RETIRED
// runtime. Follow it through buildQueueManager:
//
//   if (config.engine !== 'bullmq') return new DisabledServerQueueManager(...)
//
// 'sqlite' is a VALID enum value that resolves to a DISABLED queue. Every fresh
// install writes it to settings.json, so if that value ever reached the code,
// generation would silently stop entirely — no error, no warning, jobs simply
// queue forever.
//
// It never bit because of a double accident: local-runtime.ts only forces
// 'inline' when process.env is empty, and settings.json is never loaded into
// process.env on that path. Change either half and generation dies silently.
// That is luck, not design — exactly the class of bug this default belongs to.
//
// The default is now 'inline': the actual local engine, matching what
// local-runtime forces anyway, so the config and the behaviour finally agree.
import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('MEMSMITH_QUEUE_ENGINE default', () => {
  it('is inline, not the retired sqlite engine', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.MEMSMITH_QUEUE_ENGINE).toBe('inline');
  });

  it('is never sqlite — that value disables the queue entirely', () => {
    // buildQueueManager: anything that is not 'inline' or 'bullmq' becomes
    // DisabledServerQueueManager, which means no observations are ever produced.
    expect(SettingsDefaultsManager.getAllDefaults().MEMSMITH_QUEUE_ENGINE).not.toBe('sqlite');
  });

  it('is a value buildQueueManager actually activates', () => {
    // Guards the real invariant rather than a literal: whatever the default is,
    // it must be an engine that produces a working queue.
    const engine = SettingsDefaultsManager.getAllDefaults().MEMSMITH_QUEUE_ENGINE;
    expect(['inline', 'bullmq']).toContain(engine);
  });
});
