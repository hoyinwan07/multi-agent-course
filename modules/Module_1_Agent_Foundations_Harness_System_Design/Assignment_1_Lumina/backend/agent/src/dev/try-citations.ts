/**
 * Dev harness for the citation guard (TECHSPEC §6.5). Not on any route.
 *
 *   npx tsx src/dev/try-citations.ts
 *
 * The guard is the one piece of the grounding path that a happy-path run never exercises:
 * when the prompt works, no marker is ever dropped, so the code that does the dropping is
 * never executed by a live ask. This runs it on purpose.
 *
 * The cases that matter are the SPLIT ones. A stream delivers `[12]` as whatever chunk
 * boundaries the provider felt like — `[1` then `2]`, or one character at a time — and a
 * filter that only works when a marker arrives whole is a filter that passes every test
 * you write by hand and fails in production.
 */
import { CitationFilter } from '../loop/citations.js';

type Case = {
  name: string;
  valid: number[];
  /** Fed in order. More than one element means the marker straddles a chunk boundary. */
  chunks: string[];
  expect: string;
  expectDropped: string[];
};

const CASES: Case[] = [
  {
    name: 'in-range marker survives',
    valid: [1, 2, 3],
    chunks: ['MCP is an open standard [2]. It connects tools [3].'],
    expect: 'MCP is an open standard [2]. It connects tools [3].',
    expectDropped: []
  },
  {
    name: 'out-of-range marker is dropped, prose is kept',
    valid: [1, 2, 3],
    chunks: ['It was released in 2024 [7]. That is documented [1].'],
    expect: 'It was released in 2024 . That is documented [1].',
    expectDropped: ['[7]']
  },
  {
    name: 'marker split across chunks',
    valid: [1, 2],
    chunks: ['claim one [', '2', '] and claim two [', '9', '] end.'],
    expect: 'claim one [2] and claim two  end.',
    expectDropped: ['[9]']
  },
  {
    name: 'one character at a time',
    valid: [12],
    chunks: 'a [12] b [3] c'.split(''),
    expect: 'a [12] b  c',
    expectDropped: ['[3]']
  },
  {
    name: 'bracketed prose is not a citation and is not touched',
    valid: [1],
    chunks: ['the spec [see §4] says [1] and [] stays'],
    expect: 'the spec [see §4] says [1] and [] stays',
    expectDropped: []
  },
  {
    name: 'four digits is not a citation shape — passed through, not dropped',
    valid: [1],
    chunks: ['the year [2024] and the source [1]'],
    expect: 'the year [2024] and the source [1]',
    expectDropped: []
  },
  {
    name: 'a second bracket releases the first',
    valid: [1],
    chunks: ['open [1 then [1] closes'],
    expect: 'open [1 then [1] closes',
    expectDropped: []
  },
  {
    name: 'stream ends mid-hold — the fragment is released, never eaten',
    valid: [1],
    chunks: ['cut off here ['],
    expect: 'cut off here [',
    expectDropped: []
  },
  {
    name: 'no sources: every marker is out of range',
    valid: [],
    chunks: ['nothing was retrieved [1].'],
    expect: 'nothing was retrieved .',
    expectDropped: ['[1]']
  }
];

let failed = 0;

for (const c of CASES) {
  const guard = new CitationFilter(c.valid);
  let got = '';
  for (const chunk of c.chunks) got += guard.push(chunk);
  got += guard.flush();

  const droppedOk = JSON.stringify(guard.dropped) === JSON.stringify(c.expectDropped);
  const textOk = got === c.expect;

  if (textOk && droppedOk) {
    console.log(`  ok   ${c.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${c.name}`);
    if (!textOk) console.log(`         want text: ${JSON.stringify(c.expect)}\n          got text: ${JSON.stringify(got)}`);
    if (!droppedOk) console.log(`      want dropped: ${JSON.stringify(c.expectDropped)}\n       got dropped: ${JSON.stringify(guard.dropped)}`);
  }
}

console.log(failed ? `\n${failed}/${CASES.length} failed` : `\nall ${CASES.length} passed`);
process.exit(failed ? 1 : 0);
