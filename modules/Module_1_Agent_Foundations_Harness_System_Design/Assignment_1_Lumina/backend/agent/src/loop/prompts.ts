/**
 * Prompt text. One file because this is the cacheable prefix: byte-identical across
 * requests. Anything per-request belongs in `messages`, never here.
 */
import type { CitedSource } from '../evidence/merge.js';
import type { Gear } from './gear.js';

/**
 * Phase 1: retrieval. Tools on, no prose kept.
 *
 * The flow it describes assumes a search has ALREADY run — `retrieve.ts` fires one
 * eagerly before the first turn, the same reasoning §5.4 gives for eager recall_memory:
 * it is a thing we always want, and paying an LLM round trip to be told to do it cost a
 * measured 1.8s of the TTFT budget.
 *
 * The model keeps the judgement that mattered — rewriting a question into search terms —
 * but only spends a turn on it when the first results are actually off-target.
 */
export function retrieveSystemPrompt(gear: Gear): string {
  return [
    'You are the retrieval stage of a research assistant. Your only job is to gather',
    'source material. You are NOT writing the answer — another stage does that, and',
    'anything you write here is discarded.',
    '',
    'A web search has already been run on the raw question, and you are shown its results.',
    '',
    'Earlier turns of this conversation may appear before the question. They are there for',
    'ONE purpose: working out what the question refers to when it uses a pronoun or leaves',
    'its subject implicit. Resolve the reference, then search for the resolved question. If',
    'the question stands on its own, ignore them — an earlier topic is not part of it.',
    '',
    'How to work:',
    '1. Look at the results you were given. If they are on-target, go straight to step 2.',
    '   If they are clearly off-target — wrong topic, wrong sense of an ambiguous word —',
    '   call web_search ONCE more with better keywords. Do not refine more than once.',
    '2. Call fetch_page on the 3-4 most promising URLs — emit all of those calls in a',
    '   SINGLE turn so the pages are read in parallel. Never fetch them one at a time.',
    '3. Stop. If you have read enough pages, reply with the single word DONE.',
    '',
    'Rules:',
    '- Search results are links. Their teaser text is not a source and may never be quoted.',
    '  Only a successful fetch_page produces text the answer may cite.',
    '- If a fetch fails, that is normal. Continue with the pages you did get, or fetch one',
    '  replacement. Never retry the same URL.',
    '- If nothing usable can be found, stop and reply DONE. Reporting that nothing was',
    '  found is a correct outcome; inventing a source is not.',
    // Measured, not theoretical: "What is the capital of Portugal?" retrieved NOTHING —
    // the model read the search results, decided it already knew the answer, and replied
    // DONE on turn 1 with zero fetches. The answer that came back was "I have no sources
    // and cannot answer", because Phase 2 is shown only fetched text and is forbidden to
    // use its own knowledge. The model cannot see that consequence from inside Phase 1, so
    // the prompt has to state it. It is also not a hypothetical corner: this is the exact
    // question bench.mjs asks in its memory phase.
    '- A question you are confident you already know the answer to STILL gets pages fetched.',
    '  You are not the stage that answers. The stage that does is shown ONLY the text you',
    '  fetch and may not use its own knowledge, so skipping the fetch does not produce a',
    '  short correct answer — it produces "I have no sources and cannot answer".',
    '- Never reply DONE before at least one fetch_page has succeeded. The only exceptions',
    '  are that every fetch failed, or the search returned nothing to fetch.',
    '',
    // Retrieval is the only stage that holds tools, so the one durable WRITE the product
    // has is exercised from here or not at all. It is kept off the numbered flow and put
    // last on purpose: it applies to a small minority of requests, and an instruction
    // sitting in the main path invites a save on every turn.
    'One thing here is not retrieval. If the user states a standing preference or a lasting',
    'fact about themselves — how they want answers written, what they work in, who they are',
    '— call save_memory with it, as one self-contained sentence. Only for things that will',
    'still be true and still useful in an unrelated conversation next month; never for the',
    'subject of this question, and never for something you just read on a page. Saving is in',
    'addition to the work above, not instead of it: a question that also carries a preference',
    'still gets its pages fetched.',
    '',
    'The single exception to the fetch rule: a request that asks ONLY to remember something',
    'and contains no question. Save it, reply DONE, fetch nothing.',
    '',
    `Budget: at most ${gear.maxToolCalls} tool calls and ${gear.wallClockSec} seconds.`,
    'The fast path is one turn: fetch three or four pages together, and you are finished.'
  ].join('\n');
}

/**
 * The opening user message: the question, the recalled memories, and the eager search
 * results, each presented as what it is. Not faked into an assistant tool_use block — the
 * transcript should say the system ran these, because the system did.
 *
 * Memories go FIRST, above the search results. They are the frame the question is read in
 * ("show me code, not prose" changes which pages are worth fetching), and burying them
 * under six search hits is how a standing instruction gets skimmed past.
 *
 * Both blocks are per-request and therefore belong here rather than in the system prompt,
 * which is the cacheable prefix. A per-user memory block spliced into the system prompt
 * would mint a fresh cache entry per user and quietly cost more than it saves.
 */
export function openingUserMessage(query: string, eagerSearch: string | null, memories: string | null): string {
  return [
    ...(memories ? [memories, ''] : []),
    `Question: ${query}`,
    ...(eagerSearch ? ['', 'A web search has already been run on this question. Its results:', '', eagerSearch] : [])
  ].join('\n');
}

/**
 * Phase 2: synthesis. Tools are off — not by instruction, but because `LlmProvider.stream()`
 * has no `tools` parameter at all (§5.1). By the time this prompt runs, the citable
 * universe is closed and already on the wire.
 *
 * Takes no arguments, on purpose. It is the cacheable prefix, and the things that change
 * per request — how many sources there are, the exact legal range, whether retrieval was
 * cut short — go in the user message below. Parameterising this string by source count
 * would mint a new cache entry per shape of run to say something the structural guard in
 * `citations.ts` enforces anyway.
 */
export function synthesizeSystemPrompt(): string {
  return [
    'You are the synthesis stage of a research assistant. You are given a question and a',
    'numbered set of sources that were just retrieved for it. Write the answer.',
    '',
    'Grounding:',
    '- Use ONLY the sources you are given. Where they do not cover something, say that',
    '  plainly. Never fill a gap from your own knowledge.',
    '- Cite with a bracketed number, like [1], at the end of the sentence it supports.',
    '  Every substantive claim carries one.',
    '- Cite ONLY numbers from the range you are given. A citation to a number outside it is',
    '  worse than no citation: it is stripped before the reader sees it, leaving the',
    '  sentence looking unsupported.',
    '- Never invent a source, a URL, a title, or a statistic.',
    '- Where sources disagree, say so and cite both.',
    '- Earlier turns of the conversation may appear before the question. They exist so you',
    '  can tell what a pronoun refers to, and they are NOT sources. Their citation numbers',
    '  belonged to a different request and have been stripped; a claim that appears only',
    '  there cannot be carried into this answer.',
    '- Remembered preferences about the reader may also appear. They govern HOW you write —',
    '  language, length, whether to lead with code. They are NOT sources either: never cite',
    '  one, and never present one as something this request retrieved. A preference cannot',
    '  license a claim the sources do not support.',
    '',
    'Shape:',
    '- LENGTH IS A HARD CONSTRAINT: aim for 150 words and never exceed 200. Every word is',
    '  streamed to a waiting reader, so an answer that runs long is a slow answer, not a',
    '  thorough one. Two paragraphs is usually right; three is the maximum.',
    '- Answer the question in the first sentence. Supporting detail after it. Cut anything',
    '  that is background rather than an answer — an adjacent comparison the question did',
    '  not ask for is the most common way to overrun.',
    '- Plain prose. No headings, no preamble, and no talking about "the sources provided".',
    '- A markdown link is not a citation. Use [n].'
  ].join('\n');
}

/**
 * The per-request half of the synthesis prompt: the question, the legal citation range,
 * and the page text each number stands for.
 *
 * The text handed over is `sentText` — the same truncated window Phase 1 budgeted — and
 * not `fullText`. The snippet the chip shows was selected from `sentText`, so the model
 * reads exactly the text its citations are checked against (§6.4).
 */
export type SynthesizeUserMessageArgs = {
  query: string;
  cited: CitedSource[];
  terminated: 'done' | 'cap';
  /** The same block Phase 1 saw, or null. Repeated here because THIS is the stage that writes. */
  memories: string | null;
  /** True when the model called `save_memory` successfully during retrieval. */
  savedMemory: boolean;
};

export function synthesizeUserMessage(args: SynthesizeUserMessageArgs): string {
  const { query, cited, terminated, memories, savedMemory } = args;
  // Memories lead, for the same reason they lead in Phase 1: an instruction about how to
  // write has to be read before the thing it governs.
  const head = [...(memories ? [memories, ''] : []), `Question: ${query}`, ''];

  if (!cited.length) {
    // "Remember that I write TypeScript" is a complete, successful request that retrieves
    // nothing. Falling through to the empty-retrieval wording below would answer it with
    // "I have no sources and cannot answer" — which is technically true about a question
    // nobody asked, and reads as a broken product. The run really did do what was wanted,
    // so the answer says so.
    if (savedMemory) {
      return [
        ...head,
        'You saved what the user asked you to remember. Nothing was retrieved, because',
        'nothing needed to be.',
        '',
        'In one or two sentences, confirm what you will remember and that it will apply to',
        'future conversations. Mention that they can view or delete it in their memory',
        'settings. Do not answer a research question, and cite nothing.'
      ].join('\n');
    }
    // Empty retrieval is `done`, not an error (§5.3) — the run worked, it just found
    // nothing. Saying so is the correct answer; inventing one is the failure.
    //
    // Empty AND capped is a different sentence, and the distinction is the whole reason
    // `terminated` has three values: "we looked and there is nothing" and "we ran out of
    // budget before we could look properly" send the reader to different next steps.
    return [
      ...head,
      terminated === 'cap'
        ? 'Retrieval ran out of budget before it produced a single usable source.'
        : 'Retrieval finished and produced no usable sources for this question.',
      '',
      'In one or two sentences, say that you have no sources and therefore cannot answer,',
      terminated === 'cap'
        ? 'and that the search was cut short before it finished.'
        : 'and that the search ran to completion but turned up nothing usable.',
      'Do not answer from your own knowledge, and cite nothing.'
    ].join('\n');
  }

  const range = cited.length === 1 ? 'only [1]' : `[1] through [${cited.length}]`;
  const partial =
    terminated === 'cap'
      ? [
          'Retrieval hit its budget before it finished, so this evidence may be incomplete.',
          'End with one sentence saying the answer is partial and what is missing.',
          ''
        ]
      : [];

  const blocks = cited.map(({ source, item }) =>
    [
      `SOURCE [${source.n}] ${source.title}`,
      ...(source.url ? [source.url] : []),
      '"""',
      item.sentText,
      '"""'
    ].join('\n')
  );

  return [
    ...head,
    `You may cite ${range}. No other number exists, and any other number will be stripped.`,
    '',
    ...partial,
    blocks.join('\n\n')
  ].join('\n');
}
