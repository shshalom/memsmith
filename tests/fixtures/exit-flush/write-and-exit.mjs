const [size, mode, helper] = process.argv.slice(2);
const { exitAfterFlush } = await import(helper);
process.stdout.write('x'.repeat(Number(size)));
if (mode === 'plain') process.exit(0);
await exitAfterFlush(0);
