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

`waymark people --json` prints `[{ name, total, aliases: [{ alias, bySource: { <sourceId>: count } }] }]`. Names ending in `[bot]` are listed last under a `bots` heading. They are excluded from expertise later.
