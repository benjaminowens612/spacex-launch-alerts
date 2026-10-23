// Launch Library 2 (The Space Devs) client. Free tier: 15 requests/hour, no key.
// https://ll.thespacedevs.com/docs/

export const SPACEX_LSP_ID = 121;
const BASE = process.env.LL2_BASE || 'https://ll.thespacedevs.com/2.3.0';
const UA = 'spacex-launch-alerts (github.com; personal launch calendar)';

async function getJson(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429) throw new Error(`LL2 rate limit hit (429) for ${url}`);
      if (!res.ok) throw new Error(`LL2 HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      // Retrying a rate limit only burns more of the hourly quota.
      if (String(err.message).includes('429')) break;
    }
  }
  throw lastErr;
}

const isSpaceX = (l) =>
  l?.launch_service_provider?.id === SPACEX_LSP_ID || l?.launch_service_provider?.name === 'SpaceX';

/** Returns { upcoming, previous } raw LL2 launch objects (SpaceX only). */
export async function fetchLaunches() {
  const upcoming = await getJson(`${BASE}/launches/upcoming/?lsp__id=${SPACEX_LSP_ID}&limit=60&mode=detailed`);
  const previous = await getJson(`${BASE}/launches/previous/?lsp__id=${SPACEX_LSP_ID}&limit=15&mode=detailed`);

  const up = (upcoming.results || []).filter(isSpaceX);
  const prev = (previous.results || []).filter(isSpaceX);

  // If the API stops honouring the provider filter we'd silently get other
  // agencies' launches (filtered out above) and publish an empty calendar.
  // Fail loudly instead so the last good feed stays live.
  if ((upcoming.results || []).length > 0 && up.length === 0) {
    throw new Error('LL2 returned launches but none were SpaceX; provider filter may have changed');
  }
  return { upcoming: up, previous: prev };
}
