// Serverless proxy for Alpha Vantage TIME_SERIES_DAILY.
//
// Keeps the API key server-side and translates Alpha Vantage's quirky
// "always 200, error in the body" responses into real HTTP status codes so
// the frontend can react (rate limit, unknown symbol, upstream error).
//
// Free-tier notes:
//   - outputsize=compact returns the latest ~100 trading days. `full` is
//     gated behind Alpha Vantage's premium plan for this key, so we stay on
//     compact (~5 months of daily history).
//   - Free tier is rate limited (historically 25 requests/day), so we set
//     CDN cache headers on good responses to spread that budget across users.

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;

export default async function handler(request, response) {
  const symbol = (request.query.symbol || '').trim().toUpperCase();

  if (!symbol) {
    return response.status(400).json({ error: 'Missing "symbol" query parameter.', kind: 'bad_request' });
  }
  if (!SYMBOL_RE.test(symbol)) {
    return response.status(400).json({ error: `Invalid symbol: "${symbol}".`, kind: 'bad_request' });
  }

  const API_KEY = process.env.ALPHA_VANTAGE_KEY;
  if (!API_KEY) {
    return response.status(500).json({ error: 'Server is missing ALPHA_VANTAGE_KEY.', kind: 'config' });
  }

  const url =
    'https://www.alphavantage.co/query' +
    '?function=TIME_SERIES_DAILY' +
    '&outputsize=compact' +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&apikey=${API_KEY}`;

  let upstream;
  try {
    upstream = await fetch(url);
  } catch (error) {
    console.error('Upstream fetch failed:', error);
    return response.status(502).json({ error: 'Could not reach the data provider.', kind: 'upstream' });
  }

  const text = await upstream.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return response.status(502).json({ error: 'Unexpected response from the data provider.', kind: 'upstream' });
  }

  // Alpha Vantage signals problems inside a 200 body.
  if (data['Time Series (Daily)']) {
    // Good payload — cache at the edge for 6h, serve stale for a day while
    // revalidating. Keeps us well under the daily request budget.
    response.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return response.status(200).json(data);
  }

  if (data['Note'] || data['Information']) {
    // Rate limit reached, or the endpoint/outputsize now requires premium.
    return response.status(429).json({
      error: data['Note'] || data['Information'],
      kind: 'rate_limit',
    });
  }

  if (data['Error Message']) {
    return response.status(404).json({
      error: `No data for "${symbol}". ${data['Error Message']}`,
      kind: 'not_found',
    });
  }

  return response.status(502).json({ error: 'Unexpected response from the data provider.', kind: 'upstream' });
}
