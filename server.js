require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const crypto = require('crypto');
const NodeCache = require('node-cache');

// ---------------------------------------------------------------------------
// Startup validation — fail fast instead of silently returning 500s later
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['GROQ_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Groq's lineup shifts often (they retired llama-3.3-70b-versatile and
// llama-3.1-8b-instant in favor of the gpt-oss models) — check
// https://console.groq.com/docs/models before depending on a specific one.
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
// Vision-capable model, used automatically when an image is attached.
// qwen/qwen3.6-27b is currently Groq's multimodal model but is a *preview*
// model — verify it's still production-supported before relying on it long-term.
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const ALLOWED_MODELS = [TEXT_MODEL, VISION_MODEL];

const GROQ_KEY = process.env.GROQ_API_KEY.trim();
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GOOGLE_FC_KEY = process.env.GOOGLE_API_KEY;

// In-memory response cache, keyed by a hash of the submitted content.
// Swap this for Redis when you move to multiple instances (see notes at bottom).
const cache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 600 }); // 6h TTL

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json({ limit: '15mb' }));

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser requests (no Origin header) and anything explicitly whitelisted.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please try again in a few minutes.' } },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hashInput(text, base64Image, model) {
  const h = crypto.createHash('sha256');
  h.update(text || '');
  if (base64Image) h.update(base64Image.slice(0, 5000)); // prefix is enough to key the cache
  h.update(model);
  return h.digest('hex');
}

function buildQuery(text) {
  if (!text) return 'breaking news fact check';
  const q = text.trim().split(/\s+/).slice(0, 6).join(' ');
  return q || 'breaking news fact check';
}

async function fetchNewsContext(query) {
  if (!NEWS_API_KEY || NEWS_API_KEY === 'your_newsapi_key_here') return '';
  try {
    const { data } = await axios.get('https://newsapi.org/v2/everything', {
      params: { q: query, pageSize: 3, apiKey: NEWS_API_KEY },
      timeout: 8000,
    });
    if (!data?.articles?.length) return '';
    return data.articles.map((a) => `- [${a.source?.name || 'unknown'}] ${a.title}: ${a.description || ''}`).join('\n');
  } catch (err) {
    console.error('NewsAPI error:', err?.response?.data || err.message);
    return '';
  }
}

async function fetchFactCheckContext(query) {
  if (!GOOGLE_FC_KEY || GOOGLE_FC_KEY === 'your_google_api_key_here') return '';
  try {
    const { data } = await axios.get('https://factchecktools.googleapis.com/v1alpha1/claims:search', {
      params: { query, key: GOOGLE_FC_KEY },
      timeout: 8000,
    });
    if (!data?.claims?.length) return '';
    return data.claims
      .map((c) => {
        const review = c.claimReview?.[0];
        return `- Claim by ${c.claimant || 'unknown'}: ${c.text}\n  Rating: ${review?.textualRating || 'unrated'} by ${
          review?.publisher?.name || 'unknown'
        }`;
      })
      .join('\n');
  } catch (err) {
    console.error('Google Fact Check error:', err?.response?.data || err.message);
    return '';
  }
}

function buildSystemPrompt() {
  return `You are TruthLens, an expert fact-checker and misinformation analyst.
You are given a user request alongside fetched context from NewsAPI and Google Fact Check Tools.
Analyze all data in a comprehensive "multi-source check". Assign a final Confidence score for misinformation risk (0-100).

You MUST respond with ONLY a JSON object, no other text, in exactly this format:
{"score":NUMBER_0_TO_100,"level":"high"|"medium"|"low","badge":"string","issues":[{"name":"string","s":"flagged"|"warn"|"ok","d":"string"}],"explain":"string","tip":"string","fc":[{"src":"string","claim":"string","v":"string","c":"red"|"amber"|"green"}]}

Rules:
score = misinformation risk 0-100 (100 = definitely fake/scam, 0 = entirely verified).
level = high (>65), medium (35-65), low (<35).
issues = Provide up to 5 specific evaluation tags evaluating emotional tone, sources, and plausibility.
explain = Combine the user content and the provided context API data to write a plain language explanation summarizing the multi-source check. You MUST conclude this explanation with a capitalized "DISCLAIMER:" summarizing the final verdict.
fc = Fill this section using the FACT_CHECK_CONTEXT provided to you if applicable, otherwise suggest 2 ways to verify.`;
}

function buildUserPrompt(text, newsContext, factCheckContext) {
  return `USER CONTENT TO ANALYZE:
"${text || '[Image attached without text]'}"

--- MULTI-SOURCE CHECK DATA ---

NEWS_API_CONTEXT:
${newsContext || 'No relevant recent news found for the query.'}

FACT_CHECK_CONTEXT:
${factCheckContext || 'No official fact-checks found in Google Fact Check database.'}
`;
}

function validateResultShape(result) {
  if (typeof result !== 'object' || result === null) return false;
  if (typeof result.score !== 'number' || result.score < 0 || result.score > 100) return false;
  if (!['high', 'medium', 'low'].includes(result.level)) return false;
  if (!Array.isArray(result.issues)) return false;
  if (typeof result.explain !== 'string') return false;
  if (!Array.isArray(result.fc)) return false;
  return true;
}

async function callGroqWithRetry(userContent, model, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await axios.post(
        GROQ_URL,
        {
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: userContent },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        },
        {
          headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      return response.data;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      // Don't burn retries on client errors (bad key, bad request) — only on timeouts/5xx/429.
      if (status && status < 500 && status !== 429) break;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { text, base64Image, mimeType, modelSetting } = req.body || {};

    if (!text && !base64Image) {
      return res.status(400).json({ error: { message: 'Provide text or an image to analyze.' } });
    }
    if (text && typeof text !== 'string') {
      return res.status(400).json({ error: { message: 'text must be a string.' } });
    }
    if (text && text.length > 20000) {
      return res.status(400).json({ error: { message: 'text is too long (max 20,000 characters).' } });
    }
    if (base64Image && (!mimeType || !/^image\//.test(mimeType))) {
      return res.status(400).json({ error: { message: 'A valid image mimeType is required with base64Image.' } });
    }

    // Image analysis needs the vision model regardless of what the client asked
    // for — text-only models on Groq will reject an image_url content block.
    const requestedModel = ALLOWED_MODELS.includes(modelSetting) ? modelSetting : TEXT_MODEL;
    const model = base64Image ? VISION_MODEL : requestedModel;

    const cacheKey = hashInput(text, base64Image, model);
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const query = buildQuery(text);
    const [newsContext, factCheckContext] = await Promise.all([fetchNewsContext(query), fetchFactCheckContext(query)]);

    const promptText = buildUserPrompt(text, newsContext, factCheckContext);

    // Groq's chat-completions API is OpenAI-compatible: plain string content
    // for text-only, or an array of content parts when an image is attached.
    let userContent = promptText;
    if (base64Image && mimeType) {
      userContent = [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ];
    }

    const data = await callGroqWithRetry(userContent, model);
    if (data.error) throw new Error(data.error.message);

    const raw = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch {
      return res.status(502).json({ error: { message: 'Analysis model returned an unparseable response. Please retry.' } });
    }

    if (!validateResultShape(result)) {
      return res.status(502).json({ error: { message: 'Analysis model returned an unexpected response shape. Please retry.' } });
    }

    cache.set(cacheKey, result);
    return res.json(result);
  } catch (error) {
    console.error('Backend error:', error?.response?.data || error.message);
    const status = error?.response?.status && error.response.status < 500 ? error.response.status : 500;
    res.status(status).json({
      error: {
        message: status === 500 ? 'Failed to process analysis. Please try again.' : error.message || 'Request failed.',
      },
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found.' } });
});

// Central error handler (also catches CORS rejections thrown above)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.message === 'Not allowed by CORS' ? 403 : 500).json({ error: { message: err.message } });
});

const server = app.listen(PORT, () => {
  console.log(`TruthLens API server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = app; // exported for testing
