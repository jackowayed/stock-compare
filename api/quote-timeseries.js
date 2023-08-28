export default async function handler(request, response) {
  const { symbol } = req.query;
  const API_KEY = process.env.ALPHA_VANTAGE_KEY;
  try {
    const response = await fetch(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${API_KEY}`);
    const responseData = await response.json();
    response.status(200).json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred' });
  }
}