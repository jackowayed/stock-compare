export default async function handler(request, response) {
  const { symbol } = request.query;
  const API_KEY = process.env.ALPHA_VANTAGE_KEY;
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=full&symbol=${symbol}&apikey=${API_KEY}`);
    const rData = await r.text();
    response.send(rData);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'An error occurred' });
  }
}