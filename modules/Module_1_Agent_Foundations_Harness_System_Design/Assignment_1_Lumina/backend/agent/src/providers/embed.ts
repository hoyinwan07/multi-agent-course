/**
 * Embeddings. OpenAI `text-embedding-3-small`, 1536 dims — named by the assignment and
 * enforced by `MemoryDoc.embedding` in the contract, which rejects any other length.
 *
 * Used by memory (save + recall) in Week 1 and by chunk indexing in Week 2. Anthropic
 * serves the answers; this is the one place OpenAI is called.
 */
import OpenAI from 'openai';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from '../env.js';
import { ProviderError, requireSecret } from '../lib/errors.js';

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireSecret('openai', secrets.openai, 'OPENAI_API_KEY'),
      maxRetries: 1
    });
  }
  return client;
}

export type Embedding = {
  vector: number[];
  /** Billable embedding tokens; feeds the embedding term of costUsd (§10.2). */
  tokens: number;
};

export async function embed(text: string): Promise<Embedding> {
  const [only] = await embedBatch([text]);
  if (!only) throw new ProviderError('openai', 'embedding response was empty');
  return only;
}

export async function embedBatch(texts: string[]): Promise<Embedding[]> {
  if (!texts.length) return [];
  let res: Awaited<ReturnType<OpenAI['embeddings']['create']>>;
  try {
    res = await openai().embeddings.create({
      model: env.embeddingModel,
      input: texts,
      dimensions: EMBEDDING_DIMS
    });
  } catch (e) {
    throw new ProviderError('openai', e instanceof Error ? e.message : String(e));
  }

  // The embedding API does not promise input order, but it does promise `index`.
  const byIndex = [...res.data].sort((a, b) => a.index - b.index);
  const totalTokens = res.usage?.total_tokens ?? 0;
  const perItem = Math.ceil(totalTokens / texts.length);

  return byIndex.map((d) => {
    if (d.embedding.length !== EMBEDDING_DIMS) {
      // Wrong dimensions here become an unusable vector index later, and the symptom is
      // "recall returns nothing" three steps away from the cause.
      throw new ProviderError(
        'openai',
        `expected ${EMBEDDING_DIMS} dims from ${env.embeddingModel}, got ${d.embedding.length}`
      );
    }
    return { vector: d.embedding, tokens: perItem };
  });
}
