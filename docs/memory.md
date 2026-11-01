# Organisational memory

## People

The same person shows up under different names depending on the source: the git author name (`Alan Oliveira`), the GitHub login (`AlanEdward19`), a Linear or Discord display name. Features that count people ("who knows this path", "seen from 2 reviewers") would count one person twice, or merge two people with the same display name. The optional `people` section of `config.json` maps aliases to one canonical name:

```json
{
  "version": 1,
  "sources": [],
  "people": [{ "name": "Alan Oliveira", "aliases": ["AlanEdward19", "alan.oliveira", "Alan O."] }]
}
```

- `name`: 1-100 characters. `aliases`: 1-50 strings of 1-100 characters.
- Matching is case-insensitive after trimming and stripping one leading `@` (so `@AlanEdward19` matches `AlanEdward19`). A name that is not listed stays as stored, minus a leading `@`.
- An alias listed under two different names fails the config load.
- **No e-mail addresses.** Waymark stores display names and logins only. A name or alias shaped like an e-mail (`@` followed later by a `.`) fails the config load.

`waymark people` lists every person name found in the `authors` of indexed documents, grouped by canonical name, with document counts per source id. Use it to find the aliases to add:

```
Alan Oliveira  (41 docs)
  aliases seen: AlanEdward19 (waymark-git 40, waymark-gh 1)
bob  (3 docs)
  aliases seen: bob (waymark-gh 3)
```

`waymark people --json` prints `[{ name, total, aliases: [{ alias, bySource: { <sourceId>: count } }] }]`. Names ending in `[bot]` are listed last under a `bots` heading. Excluding bots from expertise and convention features is planned future work; today the command only lists them apart. Authors shaped like an e-mail address are never listed.

## LLM (optional)

Waymark works with zero API keys. Some features (phrasing convention candidates, chat bot answers) can use a text-generation model. They share one optional `llm` section in `config.json`, for any OpenAI-compatible chat completions endpoint, local or hosted. When it is absent those features fall back to their no-LLM behaviour.

Ollama (local):

```json
{ "llm": { "url": "http://localhost:11434/v1", "model": "llama3.1:8b" } }
```

OpenAI:

```json
{ "llm": { "url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "maxTokens": 800 } }
```

- `url` and `model` are required. `maxTokens` (1-8192, default 800) is sent as `max_tokens`, the one parameter every compatible server documents. `timeoutMs` (1000-300000, default 60000).
- `temperature` (0-2) is optional and has no default: it is left out of requests unless you set it, which is the portable choice across providers.
- The API key comes only from the `WAYMARK_LLM_API_KEY` environment variable (sent as `Authorization: Bearer <key>`). `apiKey` or `token` inside `llm` fails the config load.
- When `WAYMARK_LLM_API_KEY` is set, `url` must be `https:`; plain `http:` is allowed only for `localhost`, `127.0.0.1` and `[::1]`, so the key is never sent in cleartext. Unknown keys inside `llm` fail the config load. Responses over 1 MB and redirects are rejected.
- Requests retry on 429 and 503 (honouring `Retry-After`). Errors never include the key, the request or the response body.
- Check the setup with `waymark llm test`: it prints `LLM ok: <model> at <host> replied "..." in <ms> ms`.

**Text sent to the endpoint is document text (already secret-redacted); use a local model to keep everything on your machine.**
