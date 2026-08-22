// SPDX-License-Identifier: Apache-2.0
//
// CopyDeps over HTTPS — the transport that lets convert reach a managed database.
//
// A private RDS is unreachable from a developer machine: PubliclyAccessible=false and the
// hostname resolves to a VPC-internal address, so the direct pool times out even on VPN.
// Measured with the same code path and only the destination changed:
//   127.0.0.1:55441 -> {"reachable":true,"authenticates":true}
//   the real RDS    -> {"error":"Connection terminated due to connection timeout"}
// Every other MemSmith operation already speaks HTTPS to the team server; convert was the
// last one holding a raw Postgres socket.
//
// This satisfies the SAME CopyDeps interface the direct transport does, so runCopy's
// control flow is untouched — the swap the joiner's transport already demonstrated.

import type { CopyDeps } from './copy-engine.js';
import { splitByByteBudget } from './import-batching.js';

export interface HttpsCopyInput {
  /** The team server's HTTPS endpoint. Never a postgres:// URL. */
  serverUrl: string;
  teamKey: string;
  projectId: string;
  /** Local reads stay local — only writes and remote counts cross the network. */
  readLocalRows: (table: string) => Promise<Array<Record<string, unknown>>>;
  countLocalRows: (table: string) => Promise<number>;
  fetchImpl?: typeof fetch;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function makeHttpsCopyDeps(input: HttpsCopyInput): CopyDeps {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = stripTrailingSlash(input.serverUrl);
  // Per-table offsets make a batch token stable across a retry of the SAME batch while
  // staying distinct between batches — the property the server's idempotency relies on.
  const sent: Record<string, number> = {};
  let remoteCounts: Record<string, number> | null = null;

  const postBatch = async (
    table: string,
    rows: Array<Record<string, unknown>>,
    offset: number,
  ): Promise<void> => {
    const batchToken = `${input.projectId}:${table}:${offset}:${rows.length}`;
    let response: Response;
    try {
      response = await fetchImpl(`${base}/v1/convert/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.teamKey}`,
        },
        // projectId is the SOURCE project, sent so the destination lands rows where
        // they belong instead of re-homing them under the key's project. The server
        // validates it against the key's entitlement rather than trusting it.
        body: JSON.stringify({ table, rows, batchToken, projectId: input.projectId }),
      });
    } catch {
      // Deliberately does NOT include the thrown message: a fetch error can echo the
      // request, and the request body carries the team key. Same reasoning as the join
      // transport.
      throw new Error(`cannot reach that server at ${base}`);
    }

    if (response.status === 413) {
      // The byte budget is an estimate; the server's limit is authoritative. Halve and
      // retry rather than failing the whole convert. Splitting also changes the token,
      // which is correct — these are different batches now.
      if (rows.length <= 1) {
        throw new Error(`a single row exceeds the server's request limit (table ${table})`);
      }
      const mid = Math.ceil(rows.length / 2);
      await postBatch(table, rows.slice(0, mid), offset);
      await postBatch(table, rows.slice(mid), offset + mid);
      return;
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(detail?.error ?? `import failed with HTTP ${response.status}`);
    }
  };

  return {
    readRows: (table) => input.readLocalRows(table),

    upsertRows: async (table, rows) => {
      const offset = sent[table] ?? 0;
      let cursor = offset;
      for (const chunk of splitByByteBudget(rows)) {
        await postBatch(table, chunk, cursor);
        cursor += chunk.length;
      }
      sent[table] = cursor;
      // The remote count changed, so the cache is stale.
      remoteCounts = null;
    },

    countRows: async (which, table) => {
      if (which === 'local') return input.countLocalRows(table);
      if (remoteCounts === null) {
        // One request answers every table, so verifyCopy's per-table loop does not turn
        // into seven round trips.
        let response: Response;
        try {
          response = await fetchImpl(
            // Same project the copy wrote, so verification counts what was actually
            // written rather than whatever the credential scopes to.
            `${base}/v1/convert/verify?projectId=${encodeURIComponent(input.projectId)}`,
            { headers: { authorization: `Bearer ${input.teamKey}` } },
          );
        } catch {
          throw new Error(`cannot reach that server at ${base}`);
        }
        if (!response.ok) throw new Error(`verify failed with HTTP ${response.status}`);
        const body = await response.json() as { counts?: Record<string, number> };
        remoteCounts = body.counts ?? {};
      }
      return remoteCounts[table] ?? 0;
    },
  };
}
