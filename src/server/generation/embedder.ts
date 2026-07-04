// SPDX-License-Identifier: Apache-2.0
// Local all-MiniLM-L6-v2 embedder (384-dim, no API key). Net-new in the TS
// package; mirrors the model worker mode uses via its Chroma subprocess.
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map(t => embed(t)));
}
