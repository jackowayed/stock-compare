# Stock Compare

A small single-page app for comparing how securities move over time.

- **Normalize** one or more symbols to a common start of 100, so you can
  compare performance regardless of share price (`AAPL, MSFT, SPY`).
- **Ratios** — type `NUM/DEN` (e.g. `SPY/QQQ`) to chart one security against
  another.
- **Adjustable time window** — 1W / 1M / 3M / 6M / 1Y / 5Y / Max, plus a
  draggable zoom slider.
- Optional **log scale**, **dark mode**, per-series summary cards, and
  **shareable links** (state lives in the URL).
- Works on phones and desktops.

## Stack

No build step — plain HTML/CSS/JS served statically, with
[ECharts](https://echarts.apache.org/) (from a CDN) for the chart.

- `index.html` — markup + CDN/script links
- `styles.css` — responsive, theme-aware styles
- `app.js` — data fetching, normalization, charting, URL sync
- `api/quote-timeseries.js` — serverless proxy to Yahoo Finance's v8 chart
  endpoint (normalizes the response, maps errors to real HTTP statuses, sets CDN
  cache headers, and sends a browser-like User-Agent so Yahoo doesn't 403)

## Data source

Prices come from Yahoo Finance's `v8/finance/chart` endpoint via the serverless
proxy, using daily **adjusted close** — adjusted for both splits and dividends,
so the chart reflects **total return**, not just price return. No API key is
required.

> **Why Yahoo?** It needs no key and has no meaningful per-day request budget
> (Alpha Vantage's free tier was 25 requests/day, and its adjusted-close
> endpoint was paywalled). The proxy requests `range=max`, so "Max" is decades
> of history rather than a few months. Responses are cached per-symbol for the
> day in the browser (localStorage) and for 6h at the CDN edge.
>
> The chart endpoint is unofficial and could change; keeping it behind the
> serverless proxy means a future swap to another provider (e.g. Tiingo) only
> touches `api/quote-timeseries.js`, which already normalizes the response to
> `{ symbol, currency, series: [["YYYY-MM-DD", value], ...] }`.

## Local development

The static files can be served by any static server, but the `/api` function
needs a runtime that understands Vercel serverless functions:

```sh
npm i -g vercel
vercel dev
```

Then open the printed local URL. No API key or environment variables are
needed — the proxy talks to Yahoo Finance directly.

Prices are shown for information only — not investment advice.
