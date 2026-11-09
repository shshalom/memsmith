import { exitAfterFlush } from '../../../src/npx-cli/utils/exit.ts';

const size = Number(process.argv[2]);
const mode = process.argv[3];
process.stdout.write('x'.repeat(size));
if (mode === 'plain') process.exit(0);
await exitAfterFlush(0);
