# Stock Compare

A small single-page app for comparing how securities move over time.

- **Normalize** one or more symbols to a common start of 100, so you can
  compare performance regardless of share price (`AAPL, MSFT, SPY`).
- **Ratios** — type `NUM/DEN` (e.g. `SPY/QQQ`) to chart one security against
  another.
- **Adjustable time window** — 1W / 1M / 3M / Max, plus a draggable zoom slider.
- Optional **log scale**, **dark mode**, per-series summary cards, and
  **shareable links** (state lives in the URL).
- Works on phones and desktops.

## Stack

No build step — plain HTML/CSS/JS served statically, with
[ECharts](https://echarts.apache.org/) (from a CDN) for the chart.

- `index.html` — markup + CDN/script links
- `styles.css` — responsive, theme-aware styles
- `app.js` — data fetching, normalization, charting, URL sync
- `api/quote-timeseries.js` — serverless proxy to Alpha Vantage (keeps the API
  key server-side; maps Alpha Vantage's in-body errors to real HTTP statuses;
  sets CDN cache headers to stretch the free-tier request budget)

## Data source

Prices come from Alpha Vantage's `TIME_SERIES_DAILY` endpoint via the
serverless proxy. Set `ALPHA_VANTAGE_KEY` in the environment (e.g. a Vercel
project env var).

> **Free-tier note:** the proxy uses `outputsize=compact`, which returns the
> latest ~100 trading days (~5 months). `full` history is gated behind Alpha
> Vantage's premium plan for this key, which is why the time-window options top
> out at that range. Responses are cached per-symbol for the day in the browser
> (localStorage) and at the CDN edge to stay under the daily request limit.

## Local development

The static files can be served by any static server, but the `/api` function
needs a runtime that understands Vercel serverless functions:

```sh
npm i -g vercel
vercel dev
```

Then open the printed local URL. You'll need `ALPHA_VANTAGE_KEY` set (e.g. in a
`.env` / Vercel project settings).

Prices are shown for information only — not investment advice.
