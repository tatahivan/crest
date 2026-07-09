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

    // No Place ID configured? Find the listing by trying several searches.
    // Phone-number search is the most reliable way to match service-area
    // businesses that text search can't always find.
    if (!placeId) {
      const winderBias = {
        circle: { center: { latitude: 33.9926, longitude: -83.7202 }, radius: 40000 },
      };
      const candidates = [];
      if (process.env.GOOGLE_PLACE_QUERY) candidates.push({ textQuery: process.env.GOOGLE_PLACE_QUERY });
      candidates.push(
        { textQuery: '(470) 499-0552' },
        { textQuery: 'Crest Wash Co', locationBias: winderBias },
        { textQuery: DEFAULT_QUERY },
        { textQuery: 'Crest Wash Co Winder' },
      );

      let found = [];
      const tried = [];
      for (const body of candidates) {
        tried.push(body.textQuery);
        const sr = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.userRatingCount',
          },
          body: JSON.stringify(body),
        });
        if (!sr.ok) {
          const detail = await sr.text();
          return res.status(sr.status).json({ error: 'Place search error', detail, query: body.textQuery });
        }
        const sdata = await sr.json();
        const places = (sdata.places || []).filter((p) =>
          (p.displayName?.text || '').toLowerCase().includes('crest')
        );
        if (places.length) { found = places; break; }
      }

      if (!found.length) {
        return res.status(404).json({ error: 'No place found', tried });
      }
      // Prefer the listing that actually has reviews.
      found.sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));
      placeId = found[0].id;
      matchedName = found[0].displayName?.text || null;
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
