# Search

`waymark search` and the MCP `search` tool use the same ranking.

## Keyword search (default, no model needed)

- Query words become an SQLite FTS5 query (prefix match, OR). Common English and Portuguese function words ("why", "did", "we", "que", "para", ...) are dropped unless the query has nothing else.
- FTS5 `bm25` ranks the candidates (title weighs more than body).
- Candidates are fused with Reciprocal Rank Fusion (RRF, k = 60) and get a small recency boost: up to +20% for a document updated today, halving every year.

## Semantic search (optional)

Add an OpenAI-compatible embeddings endpoint to `config.json`:

```json
{
  "version": 1,
  "sources": [],
  "embeddings": { "url": "http://localhost:11434/v1", "model": "nomic-embed-text" }
}
```

- Ollama: `ollama pull nomic-embed-text`, then use `http://localhost:11434/v1` as above.
- OpenAI: `"url": "https://api.openai.com/v1"`, `"model": "text-embedding-3-small"`, and set `WAYMARK_EMBED_API_KEY` in the environment. Keys never go in `config.json`.
- Any other server with `POST /v1/embeddings` (LM Studio, vLLM, gateways) works the same way.
- Optional `batchSize` (default 32) controls how many texts go in one request.

Then run:

```bash
waymark embed
```

`waymark embed` embeds only documents that are new or changed since the last run (each document is split into up to 8 overlapping chunks). `waymark sync` runs it automatically after syncing when `embeddings` is configured; an embeddings error is logged and does not fail the sync. Changing `model` re-embeds everything.

With vectors present, search fuses the keyword list and the nearest-chunk list with RRF, so a document can be found without sharing any word with the query. If the endpoint is down, search logs a warning on stderr and falls back to keyword search.

**Privacy and cost:** `waymark embed` sends document text (already secret-redacted) to the configured endpoint. Use a local model (Ollama) to keep everything on your machine.

Vectors live in `db/waymark.db` (sqlite-vec) next to the keyword index. Like the rest of `db/`, they are a cache: deleting `db/` and running `waymark reindex` then `waymark embed` rebuilds them.
