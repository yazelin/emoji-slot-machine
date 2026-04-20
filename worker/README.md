# emoji-slot-gemini (Cloudflare Worker)

Proxy that adds a Vertex AI API key to requests from the static frontend.

## Deploy

```bash
cd worker
npx wrangler login                        # first time only, opens browser
npx wrangler secret put VERTEX_API_KEY    # paste the key, hits enter
npx wrangler deploy
```

Wrangler prints a URL like:
`https://emoji-slot-gemini.<your-subdomain>.workers.dev`

Put that URL into the frontend (via the on-page settings, or localStorage key
`slot-api-url`).

## Endpoints

- `POST /` — body: `{ imageBase64, mimeType, prompt?, model? }`
  → `{ mimeType, data, model }` on success.
- `GET  /` — health check.

## Environment

| Key | Type | Purpose |
|---|---|---|
| `VERTEX_API_KEY` | **Secret** | Vertex AI Express Mode API key |
| `DEFAULT_MODEL` | var (optional) | defaults to `gemini-3.1-flash-image-preview` |
