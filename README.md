# Maps Lead Scraper — Chrome Extension

A Chrome extension that scrapes business leads from Google Maps search results — name, phone number, website, and Maps profile URL — and exports them to CSV.

---

## ⚠️ Important: No npm / Node.js required

This is a **plain browser extension**. There is no build step, no `package.json`, and no `npm run dev`.  
If you cloned this repo and ran `npm run dev`, you will get an error — that command does not apply here.

---

## Installation (Chrome / Edge / Brave)

1. Clone or download this repository:
   ```
   git clone https://github.com/YOUR_USERNAME/maps-scraper.git
   ```

2. Open Chrome and go to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **"Load unpacked"**.

5. Select the cloned/downloaded folder (`maps-scraper`).

6. The extension icon will appear in your toolbar. Pin it for easy access.

That's it — no terminal commands needed.

---

## How to Use

1. Go to [Google Maps](https://www.google.com/maps) and search for businesses  
   (e.g. `plumbers in New York`, `restaurants in Dubai`).

2. Click the extension icon in the toolbar.

3. Click **Start Scraping**.

4. The extension will automatically scroll through results and extract:
   - Business Name
   - Phone Number
   - Website URL
   - Google Maps Profile URL

5. When done (or whenever you want), click **Download CSV** to export the data.

6. Click **Reset** to clear all data and start fresh.

---

## Features

- Sequential 1-by-1 scraping — no skipped or duplicated leads
- Waits for phone numbers to load before moving on
- Deduplicates by Maps profile URL
- Filter: "No Website only" — export only businesses without a website
- CSV export with UTF-8 BOM (opens correctly in Excel)
- Works with Chrome, Edge, and Brave

---

## File Structure

```
maps-scraper/
├── manifest.json       # Extension config (Manifest V3)
├── background.js       # Service worker — data storage, CSV export
├── content.js          # Scraping logic — runs on Google Maps tab
├── popup.html          # Extension popup UI
├── popup.js            # Popup interaction logic
├── styles.css          # Popup styles
└── icons/              # Extension icons (16, 48, 128px)
```

---

## Permissions Used

| Permission | Reason |
|---|---|
| `activeTab` | Access the current Google Maps tab |
| `scripting` | Inject content script if not already present |
| `storage` | Save scraped results locally |
| `downloads` | (declared but download handled via popup) |

---

## Troubleshooting

**Extension not scraping anything**  
→ Make sure you are on a Google Maps *search results* page (not a single business page).

**Phone numbers missing in CSV**  
→ Some listings don't have a phone number on Google Maps. The extension waits up to 3 seconds per listing for the phone to load.

**Duplicate entries**  
→ Click **Reset** before starting a new search to clear the previous session's data.

**`npm run dev` error / ENOENT / package.json not found**  
→ This project has no npm setup. Do not run any npm/node commands. Just load the folder directly in Chrome as described above.
