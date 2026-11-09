import type { Writable } from 'node:stream';

function drained(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) return resolve();
    // A reader that closes early (`| head`) makes the write fail with EPIPE;
    // that is a normal end, not a crash.
    stream.once('error', () => resolve());
    stream.write('', () => resolve());
  });
}

/**
 * process.exit drops whatever a pipe hasn't accepted yet, so piped output
 * stops at the 64 KiB pipe buffer. Wait for both streams first.
 */
export async function exitAfterFlush(
  code: number,
  streams: { stdout: Writable; stderr: Writable; exit: (code: number) => never } = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (c) => process.exit(c),
  },
): Promise<never> {
  await Promise.all([drained(streams.stdout), drained(streams.stderr)]);
  return streams.exit(code);
}

/**
 * A reader that stops early (`| head`) closes the pipe while a command may
 * still be working. Drop the rest of the output instead of crashing, and let
 * the command finish: a merge or prune must not stop halfway because its
 * output went unread.
 */
export function ignoreClosedPipes(streams: Writable[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
    });
  }
}
