// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue, PostgresQueryable } from './utils.js';
import {
  assertProjectOwnership,
  assertSessionOwnership,
  canonicalJson,
  deterministicKey,
  newId,
  queryOne,
  toEpoch,
  toJsonObject
} from './utils.js';
import { normalizePlatformSourceOrNull } from '../../shared/platform-source.js';
import { combineRanks } from '../../server/retrieval/rrf.js';
import { expandQuery } from '../../server/retrieval/query-expansion.js';
import { embed } from '../../server/generation/embedder.js';

export type ObservationSourceType = 'agent_event' | 'session_summary' | 'observation_reindex' | 'manual';

export interface PostgresObservation {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  generationKey: string | null;
  metadata: JsonObject;
  embedding: JsonValue | null;
  createdByJobId: string | null;
  obsType: string | null;
  lifecycleState: string;
  supersedes: string | null;
  quality: number | null;
  embeddingVec: number[] | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
  /** Response-only: set by the supersession-chain read path; never stored. */
  supersededBy?: string | null;
}

export interface PostgresObservationSource {
  id: string;
  observationId: string;
  agentEventId: string | null;
  generationJobId: string | null;
  sourceType: ObservationSourceType;
  sourceId: string;
  metadata: JsonObject;
  createdAtEpoch: number;
}

export interface ObservationRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  kind: string;
  content: string;
  generation_key: string | null;
  metadata: unknown;
  embedding: unknown | null;
  created_by_job_id: string | null;
  obs_type: string | null;
  lifecycle_state: string;
  supersedes: string | null;
  quality: number | null;
  embedding_vec: number[] | string | null;
  created_at: Date;
  updated_at: Date;
}

interface ObservationSourceRow {
  id: string;
  observation_id: string;
  agent_event_id: string | null;
  generation_job_id: string | null;
  source_type: ObservationSourceType;
  source_id: string;
  metadata: unknown;
  created_at: Date;
}

export class PostgresObservationRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    kind?: string;
    content: string;
    generationKey?: string | null;
    metadata?: JsonObject;
    embedding?: JsonValue | null;
    createdByJobId?: string | null;
    obsType?: string | null;
    lifecycleState?: string;
    supersedes?: string | null;
    quality?: number | null;
    embeddingVec?: number[] | null;
  }): Promise<PostgresObservation> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
    if (input.createdByJobId) {
      await assertJobOwnership(this.client, input.createdByJobId, input.projectId, input.teamId);
    }

    const row = await queryOne<ObservationRow>(
      this.client,
      `
        INSERT INTO observations (
          id, project_id, team_id, server_session_id, kind, content,
          generation_key, metadata, embedding, created_by_job_id,
          obs_type, lifecycle_state, supersedes, quality, embedding_vec
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
                $11, COALESCE($12, 'open'), $13, $14, $15::public.vector)
        ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL DO UPDATE SET
          updated_at = observations.updated_at
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        input.serverSessionId ?? null,
        input.kind ?? 'observation',
        input.content,
        input.generationKey ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.embedding == null ? null : JSON.stringify(input.embedding),
        input.createdByJobId ?? null,
        input.obsType ?? (input.metadata?.type as string | undefined) ?? null,
        input.lifecycleState ?? null,
        input.supersedes ?? null,
        input.quality ?? null,
        input.embeddingVec == null ? null : '[' + input.embeddingVec.join(',') + ']'
      ]
    );
    return mapObservationRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservation | null> {
    const row = await queryOne<ObservationRow>(
      this.client,
      'SELECT * FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapObservationRow(row) : null;
  }

  async listByProject(input: {
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    limit?: number;
  }): Promise<PostgresObservation[]> {
    const result = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND ($3::text IS NULL OR server_session_id = $3)
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.serverSessionId ?? null, input.limit ?? 100]
    );
    return result.rows.map(mapObservationRow);
  }

  async search(input: {
    projectId: string;
    teamId: string;
    query: string;
    limit?: number;
    platformSource?: string | null;
    obsType?: string | null;
    lifecycleState?: string | null;
  }): Promise<PostgresObservation[]> {
    const platformSource = normalizePlatformSourceOrNull(input.platformSource);
    const result = await this.client.query<ObservationRow>(
      `
        SELECT observations.* FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE observations.project_id = $1
          AND observations.team_id = $2
          AND observations.content_search @@ websearch_to_tsquery('english', $3)
          AND (
            $5::text IS NULL
            OR server_sessions.platform_source = $5
            OR (
              observations.server_session_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM observation_sources
                INNER JOIN agent_events
                  ON agent_events.id = observation_sources.agent_event_id
                  AND agent_events.project_id = observations.project_id
                  AND agent_events.team_id = observations.team_id
                WHERE observation_sources.observation_id = observations.id
                  AND observation_sources.source_type = 'agent_event'
                  AND agent_events.platform_source = $5
              )
            )
          )
          AND ($6::text IS NULL OR observations.obs_type = $6)
          AND ($7::text IS NULL OR observations.lifecycle_state = $7)
        ORDER BY ts_rank(observations.content_search, websearch_to_tsquery('english', $3)) DESC, observations.updated_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.query, input.limit ?? 20, platformSource, input.obsType ?? null, input.lifecycleState ?? null]
    );
    return result.rows.map(mapObservationRow);
  }

  async vectorSearch(input: { projectId: string; teamId: string; query: string; limit?: number }): Promise<PostgresObservation[]> {
    const qvec = '[' + (await embed(input.query)).join(',') + ']';
    const result = await this.client.query<ObservationRow>(
      // Schema-qualify the cosine operator via OPERATOR(public.<=>) so vector
      // search resolves even when a connection pool sets a tenant-only
      // search_path that excludes `public` (where pgvector's operators live).
      `SELECT observations.* FROM observations
        WHERE project_id = $1 AND team_id = $2 AND embedding_vec IS NOT NULL
        ORDER BY embedding_vec OPERATOR(public.<=>) $3::public.vector
        LIMIT $4`,
      [input.projectId, input.teamId, qvec, input.limit ?? 20]
    );
    return result.rows.map(mapObservationRow);
  }

  // Run vectorSearch for each query variant and RRF-fuse the rankings into one
  // vector result list (ordered by fused score). With a single variant this is
  // just vectorSearch; with expansion it lets any variant that ranks the answer
  // high pull it up in the fused order.
  private async multiVectorSearch(
    projectId: string, teamId: string, variants: string[], limit: number,
  ): Promise<PostgresObservation[]> {
    if (variants.length <= 1) {
      return this.vectorSearch({ projectId, teamId, query: variants[0] ?? '', limit });
    }
    const perVariant = await Promise.all(
      variants.map(q => this.vectorSearch({ projectId, teamId, query: q, limit })),
    );
    const byId = new Map<string, PostgresObservation>();
    for (const list of perVariant) for (const o of list) byId.set(o.id, o);
    const rankings = perVariant.map(list => list.map((o, i) => ({ id: o.id, rank: i })));
    const fused = combineRanks(rankings);
    return fused.map(f => byId.get(f.id)).filter((o): o is PostgresObservation => o != null).slice(0, limit);
  }

  async hybridSearch(input: {
    projectId: string; teamId: string; query: string; limit?: number;
    obsType?: string | null; lifecycleState?: string | null;
    ftsWeight?: number; vecWeight?: number; rrfK?: number;
    expandQueries?: boolean; platformSource?: string | null;
  }): Promise<PostgresObservation[]> {
    const limit = input.limit ?? 5;
    const pool = 30; // retrieve deeper, fuse, then trim
    // Query expansion (opt-in): embed several de-framed variants of the query
    // and RRF-fuse their vector rankings, so an obliquely-phrased question that
    // buries the answer under one embedding can still surface it. Default off;
    // enable via MEMSMITH_QUERY_EXPANSION=1 or the expandQueries flag.
    const useExpansion = input.expandQueries ?? process.env.MEMSMITH_QUERY_EXPANSION === '1';
    // Per-arm RRF weights. On single-session / semantically-phrased questions
    // FTS often can't find the answer session (no lexical overlap), so equal
    // weighting lets FTS's irrelevant hits demote strong vector hits. Weighting
    // vector above FTS fixes that. Default FTS=0.3 was chosen empirically on the
    // full LongMemEval-S set: it lifts single-session-preference recall
    // 0.767 -> 0.800 and regresses no other question type (overall R@5
    // 0.936 -> 0.938). Override via MEMSMITH_FTS_WEIGHT / MEMSMITH_VEC_WEIGHT.
    const ftsWeight = input.ftsWeight ?? Number(process.env.MEMSMITH_FTS_WEIGHT ?? 0.3);
    const vecWeight = input.vecWeight ?? Number(process.env.MEMSMITH_VEC_WEIGHT ?? 1);
    const variants = useExpansion ? expandQuery(input.query) : [input.query];
    // The vector arm depends on the onnxruntime-backed embedder (embed()). If it
    // throws (embedder down, model load failure, OOM), degrade to FTS-only
    // ranking rather than failing the whole search — otherwise, with hybrid as
    // the default read path, a transient embedder hiccup would turn every
    // /v1/search and /v1/context into a 500 even for queries with good FTS hits.
    // An empty vector arm simply contributes nothing to the RRF fusion.
    const [fts, vec] = await Promise.all([
      this.search({ projectId: input.projectId, teamId: input.teamId, query: input.query, limit: pool, obsType: input.obsType, lifecycleState: input.lifecycleState, platformSource: input.platformSource }),
      this.multiVectorSearch(input.projectId, input.teamId, variants, pool).catch(() => [] as PostgresObservation[]),
    ]);
    const toRanked = (list: PostgresObservation[]) => list.map((o, i) => ({ id: o.id, rank: i }));
    const fused = combineRanks([toRanked(fts), toRanked(vec)], input.rrfK, [ftsWeight, vecWeight]);
    const byId = new Map<string, PostgresObservation>();
    for (const o of [...fts, ...vec]) byId.set(o.id, o);
    return fused
      .map(f => byId.get(f.id))
      .filter((o): o is PostgresObservation => o != null)
      .filter(o => (input.obsType == null || o.obsType === input.obsType))
      .filter(o => (input.lifecycleState == null || o.lifecycleState === input.lifecycleState))
      .slice(0, limit);
  }
}

export class PostgresObservationSourcesRepository {
  constructor(private client: PostgresQueryable) {}

  async addSource(input: {
    id?: string;
    observationId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId?: string | null;
    generationJobId?: string | null;
    metadata?: JsonObject;
  }): Promise<PostgresObservationSource> {
    const observation = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.observationId, input.projectId, input.teamId]
    );
    if (!observation) {
      throw new Error('observation_id does not exist');
    }

    const agentEventId = input.sourceType === 'agent_event'
      ? input.agentEventId ?? input.sourceId
      : null;

    if (input.sourceType === 'agent_event') {
      if (agentEventId !== input.sourceId) {
        throw new Error('agent_event source_id must equal agent_event_id');
      }
      await assertAgentEventOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'session_summary' && !input.generationJobId) {
      await assertSessionOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'observation_reindex' && !input.generationJobId) {
      await assertObservationOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    }
    if (input.generationJobId) {
      await assertGenerationJobMatchesSource(this.client, {
        generationJobId: input.generationJobId,
        projectId: input.projectId,
        teamId: input.teamId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        agentEventId
      });
    }

    const row = await queryOne<ObservationSourceRow>(
      this.client,
      `
        INSERT INTO observation_sources (
          id, observation_id, agent_event_id, generation_job_id,
          source_type, source_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (observation_id, source_type, source_id) DO UPDATE SET
          metadata = observation_sources.metadata || excluded.metadata
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.observationId,
        agentEventId,
        input.generationJobId ?? null,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return mapObservationSourceRow(row!);
  }

  async listByObservationForScope(input: {
    observationId: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservationSource[]> {
    const result = await this.client.query<ObservationSourceRow>(
      `
        SELECT observation_sources.*
        FROM observation_sources
        INNER JOIN observations
          ON observations.id = observation_sources.observation_id
        WHERE observation_sources.observation_id = $1
          AND observations.project_id = $2
          AND observations.team_id = $3
        ORDER BY observation_sources.created_at ASC
      `,
      [input.observationId, input.projectId, input.teamId]
    );
    return result.rows.map(mapObservationSourceRow);
  }
}

export function buildObservationGenerationKey(input: {
  generationJobId: string;
  parsedObservationIndex: number;
  content: string;
}): string {
  return `generation:v1:${input.generationJobId}:${input.parsedObservationIndex}:${deterministicKey([
    canonicalJson(input.content.trim())
  ])}`;
}

async function assertJobOwnership(
  client: PostgresQueryable,
  generationJobId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observation_generation_jobs WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [generationJobId, projectId, teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
}

async function assertGenerationJobMatchesSource(
  client: PostgresQueryable,
  input: {
    generationJobId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId: string | null;
  }
): Promise<void> {
  if (input.sourceType === 'manual') {
    throw new Error('manual observation sources cannot be linked to a generation_job_id');
  }

  const row = await queryOne<{
    id: string;
    source_type: string;
    source_id: string;
    agent_event_id: string | null;
  }>(
    client,
    `
      SELECT id, source_type, source_id, agent_event_id
      FROM observation_generation_jobs
      WHERE id = $1 AND project_id = $2 AND team_id = $3
    `,
    [input.generationJobId, input.projectId, input.teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
  if (row.source_type !== input.sourceType || row.source_id !== input.sourceId) {
    throw new Error('generation_job_id source model must match observation source');
  }
  if (input.sourceType === 'agent_event' && row.agent_event_id !== input.agentEventId) {
    throw new Error('generation_job_id agent_event_id must match observation source');
  }
}

async function assertAgentEventOwnership(
  client: PostgresQueryable,
  agentEventId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [agentEventId, projectId, teamId]
  );
  if (!row) {
    throw new Error('agent_event_id must belong to project_id and team_id');
  }
}

async function assertObservationOwnership(
  client: PostgresQueryable,
  observationId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [observationId, projectId, teamId]
  );
  if (!row) {
    throw new Error('observation_reindex source_id must belong to project_id and team_id');
  }
}

function parseVector(v: number[] | string | null): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v) as number[]; } catch { return null; }
}

export function mapObservationRow(row: ObservationRow): PostgresObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    kind: row.kind,
    content: row.content,
    generationKey: row.generation_key,
    metadata: toJsonObject(row.metadata),
    embedding: row.embedding,
    createdByJobId: row.created_by_job_id,
    obsType: row.obs_type,
    lifecycleState: row.lifecycle_state,
    supersedes: row.supersedes,
    quality: row.quality,
    embeddingVec: parseVector(row.embedding_vec),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapObservationSourceRow(row: ObservationSourceRow): PostgresObservationSource {
  return {
    id: row.id,
    observationId: row.observation_id,
    agentEventId: row.agent_event_id,
    generationJobId: row.generation_job_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
