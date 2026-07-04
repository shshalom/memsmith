-- SPDX-License-Identifier: Apache-2.0
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS embedding_vec public.vector(384);
CREATE INDEX IF NOT EXISTS idx_observations_embedding_vec
  ON observations USING hnsw (embedding_vec public.vector_cosine_ops);
