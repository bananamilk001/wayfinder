# Wayfinder

Find cafés, restaurants, parks and running loops near any place: a country, a city, or the street your hotel is on.

## Run it

Open Terminal and run:

```bash
cd ~/Documents/"Claude Code"/wayfinder && python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser. Press `Ctrl+C` in Terminal to stop.

## How to use it

1. Search for a place: "Japan", "Shibuya", "Hotel Granvia Kyoto", an address…
   - For a large area (a country or a big city), the map zooms there, and you click the exact spot you want.
2. Pick a radius (500 m to 5 km).
3. Switch tabs:
   - **☕ Cafés** and **🍽️ Food**: nearest first, with walking time, opening hours and directions. Food has a cuisine filter.
   - **🏃 Running**: parks and tracks nearby, plus **Make a loop**, which plans a round-trip run of your chosen distance on real streets. **Another direction** gives you a different loop, and **GPX for watch** downloads it for Garmin, Strava, Apple Watch apps and so on.
4. Click the map anywhere to move your pin.

### Live GPS while you run 📡

Tap the round **◎** button at the bottom-right of the map:

- A **blue dot** shows where you are, and the pale circle around it shows how accurate the GPS is. The map keeps you centered.
- Drag the map to look around. Tap ◎ again to re-center on yourself.
- If a running loop is on the map, the card shows **km to go** and **km done**, warns you when you're **off the route**, and says 🎉 when you finish.
- The screen stays awake while tracking, where the browser supports it.
- Tap **Stop** on the card to turn tracking off.

On a phone, GPS only works on an `https://` website, so the app has to be online first. Tracking also pauses if you lock the phone or switch apps, because browsers stop sharing location in the background.

### Ask in plain words, typed or spoken 🎙

Tap the microphone and speak, or type a request in the search box:

- "ramen near Kyoto Station": opens Food, filtered to ramen
- "find me a 5k run around Central Park": opens Running and plans a 5 km loop
- "cafés within 2 km of the Eiffel Tower": opens Cafés with a 2 km radius
- "coffee near me": uses your GPS location
- "half marathon route near my hotel": uses the pin already on the map

Voice works in Chrome, Edge and Safari, on phones too. It needs microphone permission and an internet connection, because Chrome sends the audio to Google to turn it into text and Safari uses Apple's service. The page has to be opened from `localhost` or an `https://` address. A file opened by double-clicking won't work.

## How the code is organized

| File | What it does |
|---|---|
| `index.html` | The page's **structure**: search box, tabs, lists, map area |
| `style.css` | The **look**: colors (light and dark mode), layout, phone layout |
| `app.js` | The **behavior**: everything that happens when you click or search |

`app.js` is split into numbered sections. Read them in order:

1. **App state**: what the app currently knows (your pin, radius, results)
2. **The map**: sets up Leaflet, the map library
3. **Helpers**: distance math, formatting
4. **Map services**: talks to the free online services (below)
5. **Choosing where to explore**: search, map clicks, "use my location"
   - **5b. Understanding requests**: turns "sushi near Shibuya" into tab, cuisine and place
   - **5c. Voice input**: the microphone button
6. **Loading and showing places**: lists and map pins
7. **Running loops**: route planning and the GPX download
   - **7b. Live GPS**: the blue dot, following you, and progress along the loop
8. **Tabs**
9. **Wiring up**: connects buttons to the functions above

## Free services used (no API keys)

- **Nominatim**: text → coordinates ("Kyoto" → 35.0, 135.7)
- **Overpass**: "every café within 1 km of this point" from OpenStreetMap. When it's busy, the app falls back to Nominatim's quick search, which returns fewer details.
- **OSRM (foot profile)**: plans walking or running routes on real paths

These are community-run servers, so please use them gently. They can be slow at busy times.
