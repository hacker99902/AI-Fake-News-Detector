# TruthLens

**AI-assisted misinformation risk analyzer.** TruthLens takes a piece of text, a URL, or an image and returns a structured, explainable risk assessment — combining an LLM's analysis with live context from news and fact-checking APIs, rather than relying on the model's judgment alone.

> ⚠️ **Project status:** actively hardened from an original hackathon prototype toward production readiness. Core security and reliability issues have been addressed (see [Security](#security) and [Known Limitations](#known-limitations)), but it does not yet have persistent storage, authentication, or automated tests — see [Roadmap](#roadmap) before deploying publicly.

---

## Table of Contents

- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Getting API keys](#getting-api-keys)
- [Running the app](#running-the-app)
- [API reference](#api-reference)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)

---

## How it works

1. The user submits text, a URL, or an image via the frontend.
2. The backend extracts a short query from the content and, in parallel:
   - Fetches related recent articles from **NewsAPI**
   - Searches **Google Fact Check Tools** for matching fact-checked claims
3. That context, plus the original content, is sent to a **Groq-hosted LLM** with a strict system prompt requiring a structured JSON verdict.
4. The model returns a misinformation risk score (0–100), a risk level, specific flagged issues, a plain-language explanation, and any matched fact-checks.
5. Identical requests are served from an in-memory cache instead of re-querying the APIs.

This is a **multi-source verification pipeline**, not a black-box classifier — every score comes with a rationale and citable context rather than a bare percentage.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express 5 |
| AI inference | [Groq API](https://console.groq.com) (OpenAI-compatible chat completions) |
| Context sources | NewsAPI, Google Fact Check Tools API |
| Security | Helmet, CORS allowlist, express-rate-limit |
| Caching | node-cache (in-memory, TTL-based) |
| Frontend | Vanilla HTML/CSS/JS (no build step), multi-language UI |

## Project structure

```
truthlens/
├── server.js          # Express API — validation, caching, rate limiting, Groq/NewsAPI/FactCheck integration
├── index.html          # Frontend UI (analyze content, learning hub, history, settings)
├── script.js            # Frontend logic — API calls, i18n, rendering, local history
├── styles.css            # Styling
├── package.json
├── .env.example         # Template for required/optional environment variables
└── .gitignore
```

## Getting started

### Prerequisites
- [Node.js](https://nodejs.org) v18 or later
- A [Groq API key](https://console.groq.com) (required)
- A [NewsAPI key](https://newsapi.org) (optional, adds live news context)
- A [Google Fact Check Tools API key](https://console.cloud.google.com) (optional, adds fact-check matches)

### Installation

```bash
git clone <your-repo-url>
cd truthlens
npm install
cp .env.example .env
```

Then fill in `.env` with your real keys (see [Environment Variables](#environment-variables)).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ Yes | — | Your Groq API key. The server refuses to start without it. |
| `PORT` | No | `3000` | Port the backend listens on. |
| `GROQ_TEXT_MODEL` | No | `openai/gpt-oss-120b` | Model used for text-only analysis. |
| `GROQ_VISION_MODEL` | No | `qwen/qwen3.6-27b` | Model auto-selected when an image is submitted. |
| `NEWS_API_KEY` | No | — | Enables live news context. App works without it, with reduced accuracy. |
| `GOOGLE_API_KEY` | No | — | Enables Google Fact Check Tools context. |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173,http://localhost:3000` | Comma-separated list of origins allowed to call the API (CORS). |
| `RATE_LIMIT_MAX` | No | `30` | Max requests per IP per 15-minute window on `/api/analyze`. |

> Groq's model lineup changes fairly often. Check [console.groq.com/docs/models](https://console.groq.com/docs/models) before relying on a specific model long-term, and adjust `GROQ_TEXT_MODEL` / `GROQ_VISION_MODEL` if a model you're using is deprecated.

## Getting API keys

**Groq** — [console.groq.com](https://console.groq.com) → sign up → API Keys → Create Key.

**NewsAPI** — [newsapi.org/register](https://newsapi.org/register) → free tier gives 100 requests/day. Note: the free tier is restricted to non-commercial/localhost use; a live production deployment needs a paid plan or an alternative provider (e.g. GNews, NewsData.io).

**Google Fact Check Tools API**:
1. [console.cloud.google.com](https://console.cloud.google.com) → create/select a project
2. **APIs & Services → Library** → search **"Fact Check Tools API"** → Enable
3. **APIs & Services → Credentials → Create Credentials → API Key**
4. Click into the key → **API restrictions** → restrict it to only the Fact Check Tools API

## Running the app

The backend and frontend run as two separate processes.

**Terminal 1 — backend:**
```bash
npm start
```
Confirm it's up:
```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":...}
```

**Terminal 2 — frontend:**
```bash
npx serve . -l 5173
```
Open **http://localhost:5173** in your browser.

> If you serve the frontend on a different port, add it to `ALLOWED_ORIGINS` in `.env` and restart the backend — env vars only load on startup.

For development with auto-restart on file changes:
```bash
npm run dev
```

## API reference

### `POST /api/analyze`

Analyzes text and/or an image for misinformation risk.

**Request body:**
```json
{
  "text": "string, optional if base64Image is provided",
  "base64Image": "string, optional — base64-encoded image data",
  "mimeType": "string, required if base64Image is provided, e.g. image/png",
  "modelSetting": "string, optional — must match an allowed model, ignored if base64Image is present"
}
```

**Response (200):**
```json
{
  "score": 72,
  "level": "high",
  "badge": "string",
  "issues": [
    { "name": "string", "s": "flagged | warn | ok", "d": "string" }
  ],
  "explain": "string, ends with a DISCLAIMER summarizing the verdict",
  "tip": "string",
  "fc": [
    { "src": "string", "claim": "string", "v": "string", "c": "red | amber | green" }
  ]
}
```

**Error responses:** `400` (invalid input), `403` (CORS rejected), `429` (rate limited), `502` (model returned an invalid response), `500` (unexpected failure).

### `GET /health`

Returns `{ "status": "ok", "uptime": <seconds> }`. Use for uptime/load-balancer checks.

## Security

The following hardening has already been applied relative to the original prototype:

- **API keys are server-side only** — never accepted from or exposed to the client
- **CORS allowlist** — only explicitly configured origins can call the API
- **Rate limiting** on `/api/analyze` (default 30 req / 15 min / IP)
- **Helmet** for standard security headers
- **Model whitelisting** — the client cannot force an arbitrary/unsupported model name through to Groq
- **Input validation** — text length limits, image MIME-type checks
- **Response shape validation** — a malformed model response returns a clean `502` instead of crashing or leaking a raw error

**Before deploying:** rotate any API keys that were ever committed to source control or shared outside your own machine, and never commit `.env` (it's already in `.gitignore`).

## Known limitations

- **No database** — analysis history is stored client-side only (browser `localStorage`) and is lost on a new device or cleared cache.
- **In-memory cache** — works for a single instance; move to Redis before running multiple backend replicas.
- **No authentication** — the API is open to anyone who can reach it, gated only by CORS and rate limiting.
- **"Show confidence intervals" setting is not yet functional** — the toggle exists in the UI but the backend does not currently return an uncertainty range alongside the score.
- **NewsAPI free tier is non-commercial only** — production deployments need a paid NewsAPI plan or an alternative provider.
- **`qwen/qwen3.6-27b` (vision model) is a Groq preview model**, not GA — verify its status before depending on it long-term.

## Roadmap

- [ ] Persistent storage (PostgreSQL/MongoDB) for analysis history and audit trail
- [ ] Redis-backed cache for multi-instance deployments
- [ ] API authentication / per-user rate limiting
- [ ] Automated tests (unit + integration) and CI
- [ ] Structured logging and error monitoring (e.g. Pino + Sentry)
- [ ] Docker + deployment pipeline
- [ ] Wire up or remove the confidence-interval toggle
- [ ] Full translation pass for non-English UI strings

## Troubleshooting

**`Analysis Failed: Failed to fetch`**
Almost always CORS or the backend not running. Open browser DevTools → Console for the real error:
- `net::ERR_CONNECTION_REFUSED` → backend isn't running (`npm start`)
- `CORS policy: No 'Access-Control-Allow-Origin'` → your frontend's port isn't in `ALLOWED_ORIGINS` in `.env`; add it and restart the backend

**Frontend keeps opening on a random port**
`npx serve .` without `-l` falls back to a random port if its default is taken. Always run `npx serve . -l 5173`, or use `npm run frontend` if that script is defined in `package.json`.

**Server exits immediately on `npm start`**
Check the console output — it fails fast with `Missing required environment variables: GROQ_API_KEY` if `.env` isn't set up correctly.

**404 model errors from Groq**
Groq deprecates/renames models periodically. Check [console.groq.com/docs/models](https://console.groq.com/docs/models) and update `GROQ_TEXT_MODEL` / `GROQ_VISION_MODEL` in `.env` accordingly.

---

## License

ISC
