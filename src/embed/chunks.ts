const SIZE = 1200;
const OVERLAP = 200;
// ponytail: long transcripts only get their start embedded; raise the cap if recall suffers
const MAX_CHUNKS = 8;

export interface Chunk {
  n: number;
  start: number; // offset in the body
  text: string;
}

/** Chunk 0 is the title plus the start of the body; then overlapping body windows. */
export function chunkDoc(title: string, body: string): Chunk[] {
  const chunks: Chunk[] = [{ n: 0, start: 0, text: `${title}\n\n${body.slice(0, SIZE)}` }];
  for (let start = SIZE - OVERLAP; start < body.length && chunks.length < MAX_CHUNKS; ) {
    chunks.push({ n: chunks.length, start, text: body.slice(start, start + SIZE) });
    start += SIZE - OVERLAP;
  }
  return chunks;
}
