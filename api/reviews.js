// Vercel serverless function: fetches Google reviews server-side so the API key stays secret.
// Requires two environment variables set in Vercel project settings:
//   GOOGLE_PLACES_API_KEY  - API key with "Places API (New)" enabled
//   GOOGLE_PLACE_ID        - the Place ID for Crest Wash Co

export default async function handler(req, res) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!key || !placeId) {
    return res.status(500).json({ error: 'Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID env var' });
  }

  try {
    const url = `https://places.googleapis.com/v1/places/${placeId}`;
    const r = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'rating,userRatingCount,reviews,googleMapsUri',
      },
    });

    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: 'Places API error', detail: body });
    }

    const data = await r.json();

    const payload = {
      rating: data.rating ?? null,
      count: data.userRatingCount ?? 0,
      mapsUrl: data.googleMapsUri ?? null,
      reviews: (data.reviews || [])
        .filter((rv) => (rv.rating ?? 0) >= 4) // only feature 4★+ reviews on the site
        .map((rv) => ({
        author: rv.authorAttribution?.displayName ?? 'Google user',
        photo: rv.authorAttribution?.photoUri ?? null,
        rating: rv.rating ?? 5,
        text: rv.text?.text ?? rv.originalText?.text ?? '',
        time: rv.relativePublishTimeDescription ?? '',
      })),
    };

    // Cache at the edge for 24h; serve stale for a day while revalidating.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch reviews', detail: String(err) });
  }
}
