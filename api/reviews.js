// Vercel serverless function: fetches Google reviews server-side so the API key stays secret.
// Environment variables (set in Vercel project settings):
//   GOOGLE_PLACES_API_KEY  - required. API key with "Places API (New)" enabled.
//   GOOGLE_PLACE_ID        - optional. If set, used directly.
//   GOOGLE_PLACE_QUERY     - optional. Search text used to auto-find the listing
//                            when GOOGLE_PLACE_ID is not set. Defaults below.

const DEFAULT_QUERY = 'Crest Wash Co pressure washing Winder GA';

export default async function handler(req, res) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Missing GOOGLE_PLACES_API_KEY env var' });
  }

  try {
    let placeId = process.env.GOOGLE_PLACE_ID || null;
    let matchedName = null;

    // No Place ID configured? Find the listing by text search.
    if (!placeId) {
      const q = process.env.GOOGLE_PLACE_QUERY || DEFAULT_QUERY;
      const sr = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.userRatingCount',
        },
        body: JSON.stringify({ textQuery: q }),
      });
      if (!sr.ok) {
        const body = await sr.text();
        return res.status(sr.status).json({ error: 'Place search error', detail: body });
      }
      const sdata = await sr.json();
      const places = sdata.places || [];
      if (!places.length) {
        return res.status(404).json({ error: 'No place found for query', query: q });
      }
      // Prefer the listing that actually has reviews.
      places.sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));
      placeId = places[0].id;
      matchedName = places[0].displayName?.text || null;
    }

    const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'displayName,rating,userRatingCount,reviews,googleMapsUri',
      },
    });

    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: 'Places API error', detail: body });
    }

    const data = await r.json();

    const payload = {
      place: data.displayName?.text || matchedName,
      placeId,
      rating: data.rating ?? null,
      count: data.userRatingCount ?? 0,
      mapsUrl: data.googleMapsUri ?? null,
      reviews: (data.reviews || [])
        .filter((rv) => (rv.rating ?? 0) >= 4) // only feature 4-star-plus reviews on the site
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
