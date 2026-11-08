import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { undoMergeSql } from '../../src/services/projects/copy-project.js';

// The restore steps are run by hand against real data, so they are pinned to
// the code that defines what a merge wrote.
const doc = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'public', 'usage', 'projects.mdx'), 'utf-8');
const restore = doc.slice(doc.indexOf('## Restore from a backup'), doc.indexOf('## Find stray markers'));

describe('projects.mdx restore steps', () => {
  it('create a database with a valid createdb invocation', () => {
    expect(restore).not.toContain('createdb" --dbname=');
    expect(restore).toContain('createdb" --maintenance-db="$PGURL/postgres"');
  });

  it('do not assume the account database is postgres', () => {
    expect(restore).toContain('accountDatabase');
    expect(restore).toContain('msp_');
  });

  it('undo a merge with exactly the SQL that deletes the recorded rows', () => {
    const documented = restore.split('\n').map((line) => line.trim());
    const statements = undoMergeSql('<source-project-id>').split('\n');
    const first = documented.indexOf(statements[0]);
    expect(first).toBeGreaterThan(-1);
    expect(documented.slice(first, first + statements.length)).toEqual(statements);
    expect(restore).not.toContain("id = ANY('{<source ids>}')");
  });

  it('say what undoing a merge leaves behind and what it cannot undo', () => {
    expect(restore).toContain('generated from moved jobs');
    expect(restore).toContain('after the merge routed');
    expect(restore).toContain('merged into a third project');
  });

  it('do not claim the server picks up moved jobs only at startup', () => {
    expect(doc).not.toContain('picks up those jobs only when it starts');
  });
});
