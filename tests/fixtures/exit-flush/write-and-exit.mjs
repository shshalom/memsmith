const [size, mode, helper] = process.argv.slice(2);
const { exitAfterFlush, ignoreClosedPipes } = await import(helper);
if (mode !== 'plain') ignoreClosedPipes();
process.stdout.write('x'.repeat(Number(size)));
// Real commands keep working (closing pools) after their output is written.
await new Promise((resolve) => setTimeout(resolve, 200));
if (mode === 'plain') process.exit(0);
await exitAfterFlush(0);
