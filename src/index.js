// Cloudflare Worker for Stock Compare.
// Serves the static frontend (via the ASSETS binding) and proxies the
// Alpha Vantage API on /api/quote-timeseries, keeping the API key server-side
// and caching upstream responses to stay under the free-tier rate limit.

const CACHE_SECONDS = 60 * 60 * 12; // 12 hours; daily time series changes at most once a day.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/quote-timeseries') {
      return handleQuote(request, url, env, ctx);
    }

    // Everything else is a static asset (index.html, etc.).
    return env.ASSETS.fetch(request);
  },
};

async function handleQuote(request, url, env, ctx) {
  const symbol = (url.searchParams.get('symbol') || '').trim();
  if (!symbol) {
    return json({ error: 'Missing symbol' }, 400);
  }

  // Cache key normalized on the symbol so casing/whitespace don't fragment it.
  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.internal/quote?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    { method: 'GET' },
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  let body;
  try {
    const upstream = await fetch(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${encodeURIComponent(symbol)}&apikey=${env.ALPHA_VANTAGE_KEY}`,
    );
    body = await upstream.text();
  } catch (error) {
    console.error(error);
    return json({ error: 'An error occurred' }, 500);
  }

  // Alpha Vantage returns HTTP 200 even for rate-limit / error payloads
  // (a "Note"/"Information" object with no time series). Only cache real data.
  const isValidData = body.includes('Time Series (Daily)');

  const response = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': isValidData ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
    },
  });

  if (isValidData) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
