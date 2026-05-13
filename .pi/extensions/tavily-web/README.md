# Tavily web Pi extension

Project-local Pi extension that exposes Tavily web research tools to the agent.

## Requirements

Set one of these environment variables before starting Pi:

```bash
export TAVILY_API_KEY=tvly-...
# or, supported for this setup:
export TAVILY_API=tvly-...
```

After adding or editing the extension in a running Pi session, use `/reload`.

## Tools

- `web_search` — search the live web with ranked Tavily results and snippets.
- `web_extract` — extract markdown/text from selected URLs for source verification.
- `web_research` — run Tavily's deeper research agent with citations; polls by default.
- `web_research_status` — poll an existing Tavily research `request_id`.

Large outputs are truncated to Pi's standard 2000-line/50KB limit. When truncated, the full formatted output and raw Tavily JSON are saved under `.pi/tmp/tavily/`.

## Recommended workflow

1. Use `web_search` with short, focused queries and domain/date filters when possible.
2. Use `web_extract` on the best primary/authoritative URLs before trusting or citing important claims.
3. Use `web_research` for broad synthesis, then verify high-stakes claims with `web_extract`.
4. Prefer `searchDepth: "basic"` for normal searches; escalate to `"advanced"` when relevance matters more than cost/latency.

## Example tool inputs

```json
{
  "query": "Tavily API search extract research best practices",
  "searchDepth": "basic",
  "maxResults": 5,
  "includeDomains": ["docs.tavily.com"]
}
```

```json
{
  "urls": ["https://docs.tavily.com/documentation/api-reference/endpoint/search"],
  "query": "request parameters and best practices",
  "chunksPerSource": 3
}
```

```json
{
  "input": "Compare Tavily, Exa, Brave Search, and Firecrawl for AI-agent web research. Include citations.",
  "model": "mini",
  "timeoutSeconds": 180
}
```
