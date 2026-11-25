// =====================================================================
// Wayfinder — find running routes, cafés and restaurants near any place.
//
// Free data sources (no account or API key needed):
//   Nominatim → turns text like "Kyoto" or a hotel name into coordinates
//   Overpass  → asks OpenStreetMap for cafés, restaurants, parks nearby
//   OSRM      → plans walking/running routes along real paths
// =====================================================================

// ---------- 1. App state: everything the app currently "knows" ----------
const state = {
  center: null,          // { lat, lon, name } — the point we search around
  radius: 1000,          // metres
  activeTab: 'cafes',
  data: {},              // cached results per tab, e.g. data.cafes = [...]
  loop: null,            // last generated running loop
  loopAngle: 0,          // direction the loop heads off in
};

// ---------- 2. The map ----------
const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);

const placesLayer = L.layerGroup().addTo(map);  // café/restaurant/park pins
const loopLayer = L.layerGroup().addTo(map);    // the running loop line
let centerMarker = null;
let radiusCircle = null;
const markersById = {};

const ICONS = { cafes: '☕', restaurants: '🍽️', running: '🌳', home: '📍' };
function pinIcon(emoji, extraClass = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${extraClass}">${emoji}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// ---------- 3. Small helpers ----------
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Distance in metres between two points on Earth (the "haversine" formula)
function distanceM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDist(m) {
  const walkMin = Math.max(1, Math.round(m / 80)); // ~80 m per minute walking
  const d = m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  return `${d} · ${walkMin} min walk`;
}

function formatDuration(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

function directionsUrl(from, to) {
  return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${to.lat},${to.lon}&travelmode=walking`;
}

// ---------- 4. Talking to the free map services ----------

// Search text → list of matching places
async function geocode(query) {
  const lang = encodeURIComponent(navigator.language || 'en');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=${lang}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  return res.json();
}

// Coordinates → a readable name (used when you click the map)
async function reverseGeocode(lat, lon) {
  const lang = encodeURIComponent(navigator.language || 'en');
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=${lang}&lat=${lat}&lon=${lon}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.display_name || null;
}

// Ask OpenStreetMap (via Overpass) for things near a point.
// These are free community servers and are sometimes busy, so we give each
// one a time limit and move on to the next if it doesn't answer.
const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const SERVER_TIME_LIMIT_MS = 12000;
let preferredServer = 0;  // remember whichever server answered last time

async function overpass(query, onRetry) {
  let lastError;
  for (let i = 0; i < OVERPASS_SERVERS.length; i++) {
    const idx = (preferredServer + i) % OVERPASS_SERVERS.length;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SERVER_TIME_LIMIT_MS);
    try {
      if (i > 0 && onRetry) onRetry(i);
      const res = await fetch(OVERPASS_SERVERS[idx], {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      preferredServer = idx;
      return json.elements || [];
    } catch (err) {
      lastError = err.name === 'AbortError' ? new Error('timed out') : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Couldn't load places (${lastError.message}). The free map servers are busy — try again in a minute.`);
}

// Plan B when Overpass is busy: ask the search service (Nominatim) for
// "cafe" / "restaurant" / "park" inside a box around the pin.
// Fewer details and max 40 results per word, but it's quick and reliable.
const FALLBACK_SEARCH = {
  cafes: [{ q: 'cafe', keep: (r) => r.type === 'cafe' }],
  restaurants: [{ q: 'restaurant', keep: (r) => r.type === 'restaurant' }],
  running: [
    { q: 'park', keep: (r) => r.category === 'leisure' },
    { q: 'running track', keep: (r) => r.category === 'leisure' },
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatimNearby(tab, { lat, lon }, r) {
  const dLat = r / 111320, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  const box = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((n) => n.toFixed(5)).join(',');
  const lang = encodeURIComponent(navigator.language || 'en');
  const elements = [];
  for (const [i, { q, keep }] of FALLBACK_SEARCH[tab].entries()) {
    if (i > 0) await sleep(1100);  // Nominatim's rule: max 1 request per second
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&bounded=1&limit=40&extratags=1&namedetails=1` +
      `&accept-language=${lang}&viewbox=${box}&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const p of await res.json()) {
      if (!keep(p)) continue;
      // Reshape it to look like an Overpass element, so the rest of the app doesn't care where it came from
      const nd = p.namedetails || {};
      elements.push({
        type: p.osm_type, id: p.osm_id, lat: +p.lat, lon: +p.lon,
        tags: { ...(p.extratags || {}), name: nd.name || p.name || undefined, 'name:en': nd['name:en'], [p.category]: p.type },
      });
    }
  }
  return elements;
}

// What to ask Overpass for on each tab
function buildQuery(tab, { lat, lon }, r) {
  const around = `(around:${r},${lat},${lon})`;
  const parts = {
    cafes: `nwr["amenity"="cafe"]${around};`,
    restaurants: `nwr["amenity"="restaurant"]${around};`,
    running: `
      nwr["leisure"="park"]["name"]${around};
      nwr["leisure"="track"]${around};
      nwr["leisure"="nature_reserve"]["name"]${around};
      nwr["route"~"^(running|fitness_trail)$"]${around};
      nwr["natural"="beach"]["name"]${around};`,
  };
  return `[out:json][timeout:25];(${parts[tab]});out center tags 400;`;
}

// Turn a raw OpenStreetMap element into a tidy "place" object
function toPlace(el, tab) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const englishName = t['name:en'];
  const localName = t.name;
  const fallback = { cafes: 'Unnamed café', restaurants: 'Unnamed restaurant', running: 'Running track' }[tab];
  const kind =
    t.leisure === 'track' ? 'Running track' :
    t.leisure === 'park' ? 'Park' :
    t.leisure === 'nature_reserve' ? 'Nature reserve' :
    t.natural === 'beach' ? 'Beach' :
    t.route ? 'Marked running route' : null;

  return {
    id: `${el.type}/${el.id}`,
    lat, lon,
    name: englishName || localName || fallback,
    localName: englishName && localName && englishName !== localName ? localName : null,
    cuisine: t.cuisine ? t.cuisine.split(';').map((c) => c.trim().replace(/_/g, ' ')) : [],
    hours: t.opening_hours || null,
    website: t.website || t['contact:website'] || null,
    kind,
    dist: distanceM(state.center, { lat, lon }),
  };
}

// Running loop: pick 3 points on a circle that passes through the start,
// then ask OSRM for a walking route start → A → B → C → start.
async function routeLoop(center, targetKm, angle) {
  const ROAD_FACTOR = 1.3;           // real paths wiggle more than a perfect circle
  let radiusKm = targetKm / (2 * Math.PI * ROAD_FACTOR);
  let best = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const pts = loopWaypoints(center, radiusKm, angle);
    const coords = [center, ...pts, center].map((p) => `${p.lon},${p.lat}`).join(';');
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Route service error (HTTP ${res.status})`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No walkable route found here — try moving your pin.');

    const route = data.routes[0];
    const km = route.distance / 1000;
    if (!best || Math.abs(km - targetKm) < Math.abs(best.km - targetKm)) {
      best = { km, coords: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]) };
    }
    if (Math.abs(km - targetKm) / targetKm < 0.1) break;  // within 10% — good enough
    radiusKm *= targetKm / km;                              // too long/short: rescale and retry
  }
  return best;
}

function loopWaypoints(center, radiusKm, angle) {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((center.lat * Math.PI) / 180);
  // Middle of the circle sits radiusKm away from the start, in direction `angle`
  const cx = radiusKm * Math.cos(angle), cy = radiusKm * Math.sin(angle);
  const startAngle = angle + Math.PI; // the start is on the opposite side of the circle
  return [1, 2, 3].map((i) => {
    const a = startAngle + (i * Math.PI) / 2;
    const x = cx + radiusKm * Math.cos(a), y = cy + radiusKm * Math.sin(a);
    return { lat: center.lat + y / kmPerDegLat, lon: center.lon + x / kmPerDegLon };
  });
}

// ---------- 5. Choosing where to explore ----------

function setCenter(lat, lon, name) {
  state.center = { lat, lon, name };
  state.data = {};          // forget old results — new place
  clearLoop();

  if (centerMarker) centerMarker.remove();
  if (radiusCircle) radiusCircle.remove();
  centerMarker = L.marker([lat, lon], { icon: pinIcon(ICONS.home, 'home'), zIndexOffset: 1000 }).addTo(map);
  radiusCircle = L.circle([lat, lon], {
    radius: state.radius, color: '#1f7a5a', weight: 1, fillOpacity: 0.06,
  }).addTo(map);
  map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] });

  $('current').hidden = false;
  $('current-name').textContent = name;
  try { localStorage.setItem('wayfinder:last', JSON.stringify(state.center)); } catch {}

  loadTab(state.activeTab);

  // If you asked for a run ("5k loop near…"), plan it as soon as we know where
  if (state.pending?.loop) {
    state.pending.loop = false;
    makeLoop(false);
  }
}

function onSearch(e) {
  e.preventDefault();
  const text = $('search-input').value.trim();
  if (text) handleRequest(text);
}

// Look up a place, jump to the best match, and list the other matches
// underneath in case the first guess was wrong.
async function searchPlace(q) {
  const list = $('search-results');
  list.hidden = false;
  list.innerHTML = '<li class="type">Searching…</li>';
  try {
    const results = await geocode(q);
    if (!results.length) {
      list.innerHTML = `<li class="type">Couldn't find “${escapeHtml(q)}”. Try adding the city or country.</li>`;
      return;
    }
    pickSearchResult(results[0]);
    if (results.length > 1) {
      list.hidden = false;
      // Collapsed by default so it doesn't push the results off screen
      const others = results.slice(1);
      list.innerHTML = '';
      const toggle = document.createElement('li');
      toggle.className = 'other-label';
      toggle.textContent = `Wrong place? See ${others.length} other match${others.length > 1 ? 'es' : ''} ▾`;
      toggle.onclick = () => {
        toggle.textContent = 'Wrong place? Pick one:';
        toggle.onclick = null;
        others.forEach((r) => {
          const li = document.createElement('li');
          li.innerHTML = `${escapeHtml(r.display_name)}<div class="type">${escapeHtml((r.type || '').replace(/_/g, ' '))}</div>`;
          li.onclick = () => pickSearchResult(r);
          list.appendChild(li);
        });
      };
      list.appendChild(toggle);
    }
  } catch (err) {
    list.innerHTML = `<li class="type">${escapeHtml(err.message)}</li>`;
  }
}

function pickSearchResult(r) {
  $('search-results').hidden = true;
  const lat = +r.lat, lon = +r.lon;
  const [s, n, w, e] = (r.boundingbox || []).map(Number);
  const sizeKm = r.boundingbox ? distanceM({ lat: s, lon: w }, { lat: n, lon: e }) / 1000 : 0;

  // A country or big city is too large to search "around" — zoom there and let the user pick a spot
  if (sizeKm > 25) {
    map.fitBounds([[s, w], [n, e]]);
    $('current').hidden = false;
    $('current-name').textContent = r.display_name;
    state.center = null;
    clearPlaces();
    const msg = `That's a big area. Zoom in and click the exact spot you want (e.g. near your hotel), or search a neighbourhood or hotel name.`;
    ['cafes', 'restaurants', 'running'].forEach((t) => setStatus($(`${t}-status`), msg));
    return;
  }
  setCenter(lat, lon, r.display_name);
}

async function onMapClick(e) {
  const { lat, lng } = e.latlng;
  setCenter(lat, lng, 'Dropped pin');
  const name = await reverseGeocode(lat, lng).catch(() => null);
  if (name && state.center && state.center.lat === lat) {
    state.center.name = name;
    $('current-name').textContent = name;
  }
}

function onLocate() {
  if (!navigator.geolocation) return alert('Your browser can’t share location.');
  $('locate-btn').textContent = '📍 Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('locate-btn').textContent = '📍 Use my location';
      setCenter(pos.coords.latitude, pos.coords.longitude, 'My location');
    },
    () => {
      $('locate-btn').textContent = '📍 Use my location';
      alert('Couldn’t get your location. Check location permissions, or search instead.');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ---------- 5b. Understanding requests ("ramen near Kyoto Station") ----------
//
// Works the same whether you type or speak. Picks out:
//   what   → cafés / food / running   (from words like "coffee", "dinner", "5k run")
//   cuisine→ sushi, ramen, pizza…      (filters the Food tab)
//   km     → loop distance             ("5k", "10 km", "3 miles", "half marathon")
//   radius → search radius             ("within 2 km")
//   where  → the text after "near / around / in / at", or "me" for your location

const CUISINES = {
  sushi: 'sushi', ramen: 'ramen', udon: 'udon', soba: 'soba', tempura: 'tempura', yakiniku: 'yakiniku',
  pizza: 'pizza', pizzeria: 'pizza', italian: 'italian', japanese: 'japanese', chinese: 'chinese',
  indian: 'indian', thai: 'thai', mexican: 'mexican', korean: 'korean', vietnamese: 'vietnamese',
  french: 'french', spanish: 'spanish', tapas: 'tapas', greek: 'greek', turkish: 'turkish', kebab: 'kebab',
  burger: 'burger', burgers: 'burger', steak: 'steak house', steakhouse: 'steak house', seafood: 'seafood',
  vegetarian: 'vegetarian', vegan: 'vegan', curry: 'curry', noodle: 'noodle', noodles: 'noodle',
  bbq: 'barbecue', barbecue: 'barbecue', chicken: 'chicken', asian: 'asian', american: 'american',
  mediterranean: 'mediterranean', filipino: 'filipino',
};
const RUN_WORDS = ['run', 'runs', 'running', 'jog', 'jogs', 'jogging', 'loop', 'loops', 'route', 'routes'];
const CAFE_WORDS = ['cafe', 'cafes', 'café', 'cafés', 'coffee', 'espresso', 'latte', 'cappuccino'];
const FOOD_WORDS = ['restaurant', 'restaurants', 'food', 'eat', 'eating', 'dinner', 'lunch', 'breakfast',
  'brunch', 'dine', 'dining', 'hungry', 'meal'];
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const UNIT_WORDS = ['k', 'km', 'kms', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'mi', 'mile', 'miles',
  'm', 'meter', 'meters', 'metre', 'metres', 'half', 'marathon'];
const FILLER_WORDS = ['find', 'show', 'give', 'get', 'me', 'i', "i'm", 'im', 'want', 'need', 'would', 'like',
  'looking', 'look', 'for', 'to', 'a', 'an', 'the', 'some', 'any', 'good', 'best', 'nice', 'great', 'cheap',
  'place', 'places', 'spot', 'spots', 'please', 'where', 'can', 'could', 'you', 'is', 'are', 'there', 'go',
  "let's", 'lets', 'plan', 'make', 'do', 'of', 'with', 'within', 'nearby', 'near', 'around', 'in', 'at',
  'and', 'shop', 'shops', 'morning', 'evening', 'tonight', 'today'];
const STOP_WORDS = new Set([...RUN_WORDS, ...CAFE_WORDS, ...FOOD_WORDS, ...Object.keys(CUISINES),
  ...Object.keys(NUMBER_WORDS), ...UNIT_WORDS, ...FILLER_WORDS]);
const ME_WORDS = /^(me|here|us|my location|my current location|where i am|where we are)$/i;
const MY_BASE = /^(my|our|the) (hotel|airbnb|apartment|place|room|accommodation)$/i;

function parseRequest(text) {
  const raw = text.trim().replace(/[?.!,]+$/, '');
  // Speech sometimes writes numbers as words: "five k" → "5 k"
  const lower = raw.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b(?=\s*(k|km|kilomet|mi|mile))/g,
    (w) => NUMBER_WORDS[w]);
  const req = { text: raw, tab: null, cuisine: null, km: null, radius: null, loop: false, nearMe: false, useCurrent: false, place: null };

  // "within 2 km" → search radius (snapped to the nearest option in the dropdown)
  let rest = lower;
  const within = lower.match(/\bwithin\s+(\d+(?:[.,]\d+)?)\s*(meters?|metres?|m|km|k|kilomet\w*|miles?|mi)\b/);
  if (within) {
    const n = parseFloat(within[1].replace(',', '.')), u = within[2];
    const metres = /^mi/.test(u) ? n * 1609 : /^m/.test(u) ? n : n * 1000;
    req.radius = [500, 1000, 2000, 5000].reduce((a, b) => (Math.abs(b - metres) < Math.abs(a - metres) ? b : a));
    rest = lower.replace(within[0], ' ');
  }

  // "5k", "10 km", "3 miles", "half marathon" → loop distance
  const dist = rest.match(/(\d+(?:[.,]\d+)?)\s*(km|k|kilomet(?:er|re)s?|miles?|mi)\b/);
  if (dist) {
    const n = parseFloat(dist[1].replace(',', '.'));
    req.km = /^mi/.test(dist[2]) ? n * 1.609 : n;
  }
  if (/half[\s-]?marathon/.test(rest)) req.km = 21.1;
  else if (/\bmarathon\b/.test(rest)) req.km = 42.2;

  // Where? Text after "near / around / close to / next to" wins; then "within … of"; then "in / at"
  let intentText = lower;
  for (const re of [
    /\b(?:near|around|close to|next to)\s+(.+)$/i,
    /\bwithin\s+[\d.,]+\s*\w+\s+of\s+(.+)$/i,
    /\b(?:in|at)\s+(.+)$/i,
  ]) {
    const m = raw.match(re);
    if (m) {
      req.place = m[1].trim().replace(/\s+please$/i, '');
      intentText = lower.slice(0, m.index);
      break;
    }
  }

  // What?
  const words = intentText.split(/[^a-z0-9à-ÿ']+/).filter(Boolean);
  const hasAny = (list) => words.some((w) => list.includes(w));
  const cuisineWord = words.find((w) => CUISINES[w]);
  if (cuisineWord) req.cuisine = CUISINES[cuisineWord];
  if (hasAny(RUN_WORDS) || req.km) { req.tab = 'running'; req.loop = true; }
  else if (hasAny(CAFE_WORDS)) req.tab = 'cafes';
  else if (hasAny(FOOD_WORDS) || req.cuisine) req.tab = 'restaurants';

  const understoodSomething = req.tab || req.radius;
  if (!req.place) {
    if (!understoodSomething) {
      req.place = raw;   // no keywords at all → treat it as a plain place search, like before
    } else {
      // e.g. "coffee Shibuya" → whatever's left after removing the keywords is the place
      const leftover = words.filter((w) => !STOP_WORDS.has(w) && !/^\d+([.,]\d+)?(k|km|mi|m)?$/.test(w)).join(' ');
      if (leftover.length > 1) req.place = leftover;
      else if (!state.center) req.nearMe = true;   // "coffee" with no pin yet → use your location
    }
  }

  // "near me" → your GPS location; "near my hotel" → the pin that's already on the map
  if (req.place && ME_WORDS.test(req.place)) { req.place = null; req.nearMe = true; }
  if (req.place && MY_BASE.test(req.place)) {
    req.place = null;
    if (state.center) req.useCurrent = true; else req.nearMe = true;
  }
  if (!req.place && !req.nearMe && state.center) req.useCurrent = true;
  return req;
}

async function handleRequest(text, viaVoice = false) {
  const req = parseRequest(text);
  state.pending = { cuisine: req.cuisine, loop: req.loop };
  showUnderstood(req, viaVoice);

  if (req.km) setLoopDistance(req.km);
  if (req.radius) { state.radius = req.radius; $('radius').value = String(req.radius); }
  if (req.tab) showTab(req.tab);

  if (req.nearMe) return onLocate();
  if (req.place) return searchPlace(req.place);
  if (!state.center) {
    showUnderstoodError('Where should I look? Add a place, e.g. “… near Shibuya Station”, or tap the map.');
    return;
  }
  // No new place → use the pin that's already on the map
  if (req.radius) return setCenter(state.center.lat, state.center.lon, state.center.name);
  switchTab(state.activeTab);
  if (state.pending.loop) { state.pending.loop = false; makeLoop(false); }
}

function setLoopDistance(km) {
  km = Math.min(50, Math.max(1, Math.round(km * 10) / 10));
  const sel = $('loop-distance');
  if (![...sel.options].some((o) => +o.value === km)) {
    const opt = new Option(`${km} km`, String(km));
    const after = [...sel.options].find((o) => +o.value > km);
    sel.add(opt, after || null);
  }
  sel.value = String(km);
}

// Little chips under the search box: "Food · ramen · near Kyoto Station"
function showUnderstood(req, viaVoice) {
  const box = $('understood');
  const chips = [];
  const tabLabel = { cafes: '☕ Cafés', restaurants: '🍽️ Food', running: '🏃 Running' }[req.tab];
  if (tabLabel) chips.push(tabLabel);
  if (req.cuisine) chips.push(req.cuisine);
  if (req.km) chips.push(`${Math.round(req.km * 10) / 10} km loop`);
  if (req.radius) chips.push(`within ${req.radius >= 1000 ? req.radius / 1000 + ' km' : req.radius + ' m'}`);
  if (req.nearMe) chips.push('📍 near you');
  else if (req.place && (tabLabel || req.radius)) chips.push(`📍 ${req.place}`);
  else if (req.useCurrent && state.center) chips.push('📍 current pin');

  box.classList.remove('error');
  if (!viaVoice && !tabLabel && !req.radius) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = (viaVoice ? `<div class="heard">🎙 “${escapeHtml(req.text)}”</div>` : '') +
    chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
}

function showUnderstoodError(msg) {
  const box = $('understood');
  box.hidden = false;
  box.classList.add('error');
  box.textContent = msg;
}

// ---------- 5c. Voice input (dictation) ----------
// Uses the browser's built-in speech recognition (Chrome, Edge, Safari).
// Chrome sends the audio to Google to transcribe it; Safari uses Apple's service.

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('mic-btn');
  const input = $('search-input');
  const defaultPlaceholder = input.placeholder;

  if (!SpeechRecognition) {
    btn.onclick = () => showUnderstoodError('Voice input isn’t available in this browser. Try Chrome or Safari.');
    return;
  }

  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }   // tap again to stop early

    rec = new SpeechRecognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;          // show words as you speak
    rec.maxAlternatives = 1;
    let heard = '';
    let failed = false;

    rec.onstart = () => {
      btn.classList.add('listening');
      btn.setAttribute('aria-label', 'Stop listening');
      input.value = '';
      input.placeholder = 'Listening… e.g. “ramen near Kyoto Station”';
    };
    rec.onresult = (e) => {
      heard = [...e.results].map((r) => r[0].transcript).join('');
      input.value = heard;
    };
    rec.onerror = (e) => {
      failed = true;
      const messages = {
        'not-allowed': 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.',
        'service-not-allowed': 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.',
        'no-speech': 'Didn’t hear anything — tap the mic and try again.',
        'audio-capture': 'No microphone found.',
        'network': 'Voice needs an internet connection.',
        'aborted': '',
      };
      const msg = messages[e.error] ?? `Voice input stopped (${e.error}).`;
      if (msg) showUnderstoodError(msg);
    };
    rec.onend = () => {
      btn.classList.remove('listening');
      btn.setAttribute('aria-label', 'Speak your request');
      input.placeholder = defaultPlaceholder;
      rec = null;
      if (!failed && heard.trim()) handleRequest(heard.trim(), true);
    };
    rec.start();
  };
}

// ---------- 6. Loading & showing nearby places ----------

async function loadTab(tab) {
  const status = $(`${tab}-status`);
  if (!state.center) return;
  if (state.data[tab]) return renderTab(tab);   // already loaded for this place

  const centerAtStart = state.center;
  setStatus(status, 'Looking around…');
  $(`${tab}-list`).innerHTML = '';
  if (tab === state.activeTab) clearPlaces();

  try {
    let elements;
    try {
      elements = await overpass(buildQuery(tab, state.center, state.radius), () => {
        if (state.center === centerAtStart) setStatus(status, 'Map server is busy — trying a backup…');
      });
      state.usedFallback = false;
    } catch {
      if (state.center !== centerAtStart) return;
      setStatus(status, 'Map servers are busy — using quick search instead…');
      elements = await nominatimNearby(tab, state.center, state.radius);
      state.usedFallback = true;
    }
    if (state.center !== centerAtStart) return;  // user moved on while we waited
    const seen = new Set();
    state.data[tab] = elements
      .map((el) => toPlace(el, tab))
      .filter((p) => p.lat != null && p.dist <= state.radius * 1.05)
      .filter((p) => !seen.has(p.id) && seen.add(p.id))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 80);
    renderTab(tab);
  } catch (err) {
    if (state.center === centerAtStart) setStatus(status, err.message, true);
  }
}

function renderTab(tab) {
  let places = state.data[tab] || [];
  const status = $(`${tab}-status`);
  const list = $(`${tab}-list`);

  if (tab === 'restaurants') {
    fillCuisineFilter(places);
    const want = $('cuisine-filter').value;
    if (want) places = places.filter((p) => p.cuisine.includes(want));
  }

  const label = { cafes: 'cafés', restaurants: 'restaurants', running: 'parks & tracks' }[tab];
  setStatus(status, places.length
    ? `${places.length} ${label} within ${state.radius >= 1000 ? state.radius / 1000 + ' km' : state.radius + ' m'}, nearest first.`
    : `No ${label} found nearby. Try a bigger radius.`);
  if (state.usedFallback && places.length) status.textContent += ' (Quick mode: main map servers were busy, so some places may be missing.)';
  if (tab === 'restaurants' && state.cuisineNote) {
    status.textContent = `${state.cuisineNote} ${status.textContent}`;
    state.cuisineNote = null;
  }

  list.innerHTML = '';
  places.forEach((p) => list.appendChild(placeItem(p, tab)));
  if (tab === state.activeTab) drawPlaces(places, tab);
}

function placeItem(p, tab) {
  const li = document.createElement('li');
  li.dataset.id = p.id;
  const sub = [
    p.kind,
    p.localName,
    p.cuisine.length ? p.cuisine.join(', ') : null,
    p.hours ? `🕒 ${p.hours}` : null,
  ].filter(Boolean).map(escapeHtml).join(' · ');

  li.innerHTML = `
    <div class="place-top">
      <span class="place-name">${escapeHtml(p.name)}</span>
      <span class="place-dist">${formatDist(p.dist)}</span>
    </div>
    ${sub ? `<div class="place-sub">${sub}</div>` : ''}
    <div class="place-links">
      <a href="${directionsUrl(state.center, p)}" target="_blank" rel="noopener">Directions ↗</a>
      ${p.website ? `<a href="${escapeHtml(p.website)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
    </div>`;
  li.onclick = (e) => {
    if (e.target.tagName === 'A') return;
    const m = markersById[p.id];
    if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 16)); m.openPopup(); }
    highlight(p.id);
  };
  return li;
}

function drawPlaces(places, tab) {
  clearPlaces();
  places.forEach((p) => {
    const emoji = tab === 'running' && p.kind === 'Running track' ? '🏃' : ICONS[tab];
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(emoji) })
      .bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${formatDist(p.dist)}<br>
        <a href="${directionsUrl(state.center, p)}" target="_blank" rel="noopener">Directions ↗</a>`)
      .on('click', () => highlight(p.id))
      .addTo(placesLayer);
    markersById[p.id] = m;
  });
}

function clearPlaces() {
  placesLayer.clearLayers();
  for (const k in markersById) delete markersById[k];
}

function highlight(id) {
  document.querySelectorAll('.results li').forEach((li) => {
    const on = li.dataset.id === id;
    li.classList.toggle('selected', on);
    if (on) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function fillCuisineFilter(places) {
  const sel = $('cuisine-filter');
  const current = sel.value;
  const counts = {};
  places.forEach((p) => p.cuisine.forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
  const options = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  sel.innerHTML = '<option value="">All cuisines</option>' +
    options.map(([c, n]) => `<option value="${escapeHtml(c)}">${escapeHtml(c[0].toUpperCase() + c.slice(1))} (${n})</option>`).join('');
  let pick = counts[current] ? current : '';

  // A cuisine you asked for ("sushi near…") gets selected automatically
  const wanted = state.pending?.cuisine;
  if (wanted) {
    state.pending.cuisine = null;
    const match = Object.keys(counts).find((c) => c === wanted) || Object.keys(counts).find((c) => c.includes(wanted));
    if (match) pick = match;
    else state.cuisineNote = `No places tagged “${wanted}” here, so showing all restaurants.`;
  }
  sel.value = pick;
  sel.hidden = options.length === 0;
}

// ---------- 7. Running loops ----------

async function makeLoop(newDirection) {
  const status = $('loop-status');
  if (!state.center) return setStatus(status, 'First pick a place — search above or click the map.', true);
  if (newDirection) state.loopAngle += (Math.PI * 2) / 5 + Math.random() * 0.6;  // turn to a fresh direction

  const targetKm = +$('loop-distance').value;
  $('loop-btn').disabled = $('loop-again').disabled = true;
  setStatus(status, `Planning a ${targetKm} km loop…`);
  try {
    const loop = await routeLoop(state.center, targetKm, state.loopAngle);
    state.loop = loop;
    loopLayer.clearLayers();
    const line = L.polyline(loop.coords, { color: '#e4572e', weight: 5, opacity: 0.85 }).addTo(loopLayer);
    if (!isFollowing()) map.fitBounds(line.getBounds(), { padding: [30, 30] });
    live.progressM = 0;   // new loop → start counting progress from zero
    renderLiveCard();
    showLoopStats();
    $('loop-result').hidden = false;
    setStatus(status, '');
  } catch (err) {
    setStatus(status, err.message, true);
  } finally {
    $('loop-btn').disabled = $('loop-again').disabled = false;
  }
}

function showLoopStats() {
  if (!state.loop) return;
  const pace = +$('loop-pace').value;
  $('loop-km').textContent = state.loop.km.toFixed(1);
  $('loop-time').textContent = formatDuration(state.loop.km * pace);
}

function clearLoop() {
  state.loop = null;
  loopLayer.clearLayers();
  $('loop-result').hidden = true;
  renderLiveCard();
}

// ---------- 7b. Live GPS: see where you are while you run ----------
//
// Tap the ◎ button on the map:
//   1st tap → start live tracking and keep the map centred on you
//   drag the map → stops centring (so you can look around); tap ◎ to re-centre
//   "Stop" on the live card → turn tracking off
// If a loop is on the map, the card shows km to go and warns if you're off route.

const live = {
  watchId: null,     // id from the browser's GPS watcher (null = off)
  following: true,   // keep the map centred on you?
  firstFix: true,
  last: null,        // latest { lat, lon, accuracy }
  dot: null,         // blue dot
  ring: null,        // pale circle showing GPS accuracy
  progressM: 0,      // how far along the loop you are, in metres
  wakeLock: null,    // keeps the screen on while tracking
};

function isFollowing() {
  return live.watchId !== null && live.following;
}

// The round ◎ button (bottom-right of the map)
const LiveButton = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'live-btn');
    btn.type = 'button';
    btn.title = 'Show my live location';
    btn.setAttribute('aria-label', 'Show my live location');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2h-2.06ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"/></svg>';
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener('click', onLiveButton);
    return btn;
  },
});
// The info card (bottom-left of the map)
const LiveCard = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const card = L.DomUtil.create('div', 'live-card');
    card.hidden = true;
    L.DomEvent.disableClickPropagation(card);
    return card;
  },
});
const liveBtn = new LiveButton().addTo(map).getContainer();
const liveCard = new LiveCard().addTo(map).getContainer();

function onLiveButton() {
  if (live.watchId === null) return startLive();
  live.following = true;                         // re-centre on you
  if (live.last) map.setView([live.last.lat, live.last.lon], Math.max(map.getZoom(), 16));
  updateLiveButton();
}

function startLive() {
  if (!navigator.geolocation) return showLiveMessage('Your browser can’t share location.', true);
  live.following = true;
  live.firstFix = true;
  showLiveMessage('Finding you… (go outside for the best GPS)');
  live.watchId = navigator.geolocation.watchPosition(onLivePosition, onLiveError, {
    enableHighAccuracy: true,   // use real GPS, not just Wi-Fi
    maximumAge: 1000,
    timeout: 30000,
  });
  keepScreenOn(true);
  updateLiveButton();
}

function stopLive() {
  if (live.watchId !== null) navigator.geolocation.clearWatch(live.watchId);
  live.watchId = null;
  live.last = null;
  if (live.dot) { live.dot.remove(); live.ring.remove(); live.dot = live.ring = null; }
  liveCard.hidden = true;
  keepScreenOn(false);
  updateLiveButton();
}

function onLivePosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  live.last = { lat, lon, accuracy };

  if (!live.dot) {
    live.ring = L.circle([lat, lon], { radius: accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    live.dot = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    live.dot.setLatLng([lat, lon]);
    live.ring.setLatLng([lat, lon]).setRadius(accuracy);
  }

  if (live.following) {
    if (live.firstFix) map.setView([lat, lon], Math.max(map.getZoom(), 16));
    else map.panTo([lat, lon], { animate: true, duration: 0.5 });
  }
  live.firstFix = false;
  renderLiveCard();
}

function onLiveError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    stopLive();
    showLiveMessage('Location is blocked. Allow it for this site in your browser settings, then tap ◎ again.', true);
  } else {
    showLiveMessage('Still looking for GPS… try moving to open sky.');
  }
}

// Where are you on the loop? Find the closest point on the route, preferring
// points just ahead of where you were (loops start and end at the same spot).
function loopProgress(pos) {
  const loop = state.loop;
  if (!loop) return null;
  if (!loop.cum) {   // distance from the start to each point on the route, worked out once
    loop.cum = [0];
    for (let i = 1; i < loop.coords.length; i++) {
      const [aLat, aLon] = loop.coords[i - 1], [bLat, bLon] = loop.coords[i];
      loop.cum.push(loop.cum[i - 1] + distanceM({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }));
    }
  }
  const nearest = (from, to) => {
    let best = { i: -1, d: Infinity };
    loop.coords.forEach(([la, lo], i) => {
      if (loop.cum[i] < from || loop.cum[i] > to) return;
      const d = distanceM(pos, { lat: la, lon: lo });
      if (d < best.d) best = { i, d };
    });
    return best;
  };
  const onRouteLimit = Math.max(35, pos.accuracy * 1.2);
  let hit = nearest(live.progressM - 150, live.progressM + 1000);   // just ahead of you
  if (hit.d > onRouteLimit) {
    const anywhere = nearest(0, Infinity);                          // maybe you joined mid-loop
    if (anywhere.d <= onRouteLimit) hit = anywhere;
  }
  const total = loop.cum[loop.cum.length - 1];
  const onRoute = hit.d <= onRouteLimit;
  if (onRoute) live.progressM = loop.cum[hit.i];
  return { onRoute, offBy: hit.d, done: live.progressM, left: Math.max(0, total - live.progressM), total };
}

function renderLiveCard() {
  if (live.watchId === null || !live.last) return;
  const { accuracy } = live.last;
  let html = `<div class="live-row"><span class="live-dot"></span><strong>Live</strong>
    <span class="live-acc">GPS ±${Math.round(accuracy)} m</span>
    <button type="button" class="live-stop">Stop</button></div>`;

  const p = loopProgress(live.last);
  if (p) {
    const km = (m) => (m / 1000).toFixed(2);
    if (p.left < 60 && p.done > p.total * 0.8) {
      html += `<div class="live-big">🎉 Loop complete!</div>`;
    } else {
      html += `<div class="live-big">${km(p.left)} km to go</div><div class="live-sub">${km(p.done)} of ${km(p.total)} km done</div>`;
    }
    if (!p.onRoute) html += `<div class="live-warn">⚠️ ${Math.round(p.offBy)} m off the route</div>`;
  }
  liveCard.innerHTML = html;
  liveCard.hidden = false;
  liveCard.querySelector('.live-stop').onclick = stopLive;
}

function showLiveMessage(msg, isError = false) {
  liveCard.hidden = false;
  liveCard.innerHTML = `<div class="live-row ${isError ? 'live-error' : ''}">${escapeHtml(msg)}</div>` +
    (live.watchId !== null ? '<button type="button" class="live-stop">Stop</button>' : '');
  const stop = liveCard.querySelector('.live-stop');
  if (stop) stop.onclick = stopLive;
  if (isError) setTimeout(() => { if (live.watchId === null) liveCard.hidden = true; }, 6000);
}

function updateLiveButton() {
  liveBtn.classList.toggle('on', live.watchId !== null);
  liveBtn.classList.toggle('following', isFollowing());
  liveBtn.title = live.watchId === null ? 'Show my live location' : live.following ? 'Following you' : 'Re-centre on me';
}

// Dragging the map means you want to look around → stop auto-centring
map.on('dragstart', () => {
  if (isFollowing()) { live.following = false; updateLiveButton(); }
});

// Keep the phone screen awake while tracking (where the browser supports it)
async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator) live.wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && live.wakeLock) { await live.wakeLock.release(); live.wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && live.watchId !== null) keepScreenOn(true);
});

// Save the loop as a .gpx file (works with Garmin, Strava, Apple Watch apps…)
function downloadGpx() {
  if (!state.loop) return;
  const pts = state.loop.coords.map(([lat, lon]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n');
  const name = `Wayfinder ${state.loop.km.toFixed(1)} km loop`;
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wayfinder" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${escapeHtml(name)}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = `wayfinder-loop-${state.loop.km.toFixed(1)}km.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 8. Tabs ----------

// Just flips which tab is visible (no loading)
function showTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['cafes', 'restaurants', 'running'].forEach((t) => ($(`tab-${t}`).hidden = t !== tab));
  loopLayer.eachLayer((l) => l.setStyle({ opacity: tab === 'running' ? 0.85 : 0 }));
}

// Shows a tab and loads its places if we haven't yet
function switchTab(tab) {
  showTab(tab);
  clearPlaces();
  if (state.data[tab]) renderTab(tab); else loadTab(tab);
}

// ---------- 9. Wire up buttons & start ----------

$('search-form').addEventListener('submit', onSearch);
$('locate-btn').addEventListener('click', onLocate);
map.on('click', onMapClick);
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('radius').addEventListener('change', (e) => {
  state.radius = +e.target.value;
  if (state.center) setCenter(state.center.lat, state.center.lon, state.center.name);
});
$('cuisine-filter').addEventListener('change', () => renderTab('restaurants'));
$('loop-btn').addEventListener('click', () => makeLoop(false));
$('loop-again').addEventListener('click', () => makeLoop(true));
$('loop-gpx').addEventListener('click', downloadGpx);
$('loop-pace').addEventListener('change', showLoopStats);
setupVoice();

// Reopen where you left off last time
try {
  const last = JSON.parse(localStorage.getItem('wayfinder:last'));
  if (last && typeof last.lat === 'number') setCenter(last.lat, last.lon, last.name);
} catch {}
