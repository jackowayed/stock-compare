// Serverless proxy for Yahoo Finance's v8 chart endpoint.
//
// Returns daily *adjusted* close (`adjclose`) — adjusted for both splits and
// dividends (CRSP-style), so charts reflect total return, not just price
// return. Yahoo needs no API key and has no per-day request budget to ration,
// which is why this replaced the Alpha Vantage proxy (25 requests/day, and its
// adjusted endpoint paywalled).
//
// Notes:
//   - We ask for the full period1=0..now window at interval=1d, so "Max" is now
//     decades of daily history rather than the ~5 months Alpha Vantage's free
//     tier allowed.
//   - The chart endpoint is unofficial. It doesn't need the cookie/crumb dance
//     that quoteSummary does, but it does reject requests without a browser-ish
//     User-Agent, so we send one. Keeping it server-side also hides this from
//     the browser and lets us cache at the edge.
//   - Response shape is normalized to { symbol, currency, series: [[date, v]] }
//     with `date` as an America/New_York 'YYYY-MM-DD' string, ascending.

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;

// en-CA renders as 'YYYY-MM-DD'; pin to the market's timezone so a bar lands on
// its trading date regardless of where the function runs.
const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export default async function handler(request, response) {
  const symbol = (request.query.symbol || '').trim().toUpperCase();

  if (!symbol) {
    return response.status(400).json({ error: 'Missing "symbol" query parameter.', kind: 'bad_request' });
  }
  if (!SYMBOL_RE.test(symbol)) {
    return response.status(400).json({ error: `Invalid symbol: "${symbol}".`, kind: 'bad_request' });
  }

  // Ask for the full history at daily granularity. NB: `range=max` makes Yahoo
  // downsample to ~quarterly bars — an explicit period1=0..now window is what
  // actually returns daily rows.
  const now = Math.floor(Date.now() / 1000);
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    `?period1=0&period2=${now}&interval=1d`;

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: {
        // Yahoo 403s requests without a real-looking User-Agent.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
  } catch (error) {
    console.error('Upstream fetch failed:', error);
    return response.status(502).json({ error: 'Could not reach the data provider.', kind: 'upstream' });
  }

  if (upstream.status === 429) {
    return response.status(429).json({
      error: 'The data provider is rate limiting requests right now. Try again shortly.',
      kind: 'rate_limit',
    });
  }

  const text = await upstream.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return response.status(502).json({ error: 'Unexpected response from the data provider.', kind: 'upstream' });
  }

  const chart = data && data.chart;

  // Yahoo reports unknown/delisted symbols as an error object in the body.
  if (chart && chart.error) {
    const desc = chart.error.description || chart.error.code || 'symbol not found';
    return response.status(404).json({ error: `No data for "${symbol}". ${desc}`, kind: 'not_found' });
  }

  const result = chart && Array.isArray(chart.result) && chart.result[0];
  const timestamps = result && result.timestamp;
  const adjclose =
    result &&
    result.indicators &&
    result.indicators.adjclose &&
    result.indicators.adjclose[0] &&
    result.indicators.adjclose[0].adjclose;
  // Some rows (indices, very new listings) carry no adjusted series; fall back
  // to raw close so the symbol still charts.
  const rawClose =
    result &&
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0] &&
    result.indicators.quote[0].close;
  const closes = adjclose || rawClose;

  if (!Array.isArray(timestamps) || !Array.isArray(closes) || !timestamps.length) {
    return response.status(502).json({ error: 'Unexpected response from the data provider.', kind: 'upstream' });
  }

  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const v = closes[i];
    // Yahoo pads gaps (halts, the still-open current bar) with nulls.
    if (typeof t !== 'number' || v == null || !Number.isFinite(v)) continue;
    series.push([DATE_FMT.format(new Date(t * 1000)), v]);
  }

  if (!series.length) {
    return response.status(502).json({ error: 'Unexpected response from the data provider.', kind: 'upstream' });
  }

  // Good payload — cache at the edge for 6h, serve stale for a day while
  // revalidating. Daily bars don't move intraday, so this is generous headroom.
  response.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  return response.status(200).json({
    symbol,
    currency: (result.meta && result.meta.currency) || null,
    series,
  });
}
