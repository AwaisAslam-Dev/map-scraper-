/**
 * background.js — Service Worker
 *
 * Key fixes:
 * - START_SCRAPE: first pings content script; if no response, injects it fresh
 *   (fixes "Could not establish connection" after extension reload / tab reload)
 * - downloadCSV returns CSV text to popup — popup does the actual download
 *   (Blob/URL.createObjectURL not available in service workers)
 */

const KEY_RESULTS   = 'scrape_results';
const KEY_SEEN_URLS = 'scrape_seen_urls';
const KEY_STATE     = 'scrape_state';

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'SAVE_BATCH': {
      saveBatch(msg.items).then(r => sendResponse(r));
      return true;
    }

    case 'GET_STATS': {
      getStats().then(s => sendResponse(s));
      return true;
    }

    case 'DOWNLOAD_CSV': {
      buildCSV(msg.onlyNoWebsite).then(res => sendResponse({ ok: true, csv: res.csv, count: res.count }));
      return true;
    }

    case 'RESET': {
      resetAll().then(() => sendResponse({ ok: true }));
      return true;
    }

    // START: ping tab first; if content script not there, inject it then start
    case 'START_SCRAPE': {
      startScrapeOnTab().then(result => sendResponse(result));
      return true;
    }

    case 'STOP_SCRAPE': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_SCRAPE' }, () => {
            chrome.runtime.lastError; // suppress error if content script gone
          });
        }
      });
      updateState({ isRunning: false });
      sendResponse({ ok: true });
      return true;
    }

    case 'SCRAPE_DONE': {
      updateState({ isRunning: false });
      sendResponse({ ok: true });
      return true;
    }

    case 'UPDATE_BADGE': {
      chrome.action.setBadgeText({ text: String(msg.count) });
      chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
      break;
    }

    default: break;
  }
});

// ── startScrapeOnTab ──────────────────────────────────────────────────────────
// Ensures content script is alive before sending START_SCRAPE.
// If the tab was opened before the extension was loaded/reloaded, the content
// script won't be there — we inject it programmatically.
async function startScrapeOnTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) return { ok: false, error: 'No active tab' };

  const tabId = tabs[0].id;

  // 1. Ping content script
  const alive = await pingContentScript(tabId);

  if (!alive) {
    // 2. Inject content script fresh
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['content.js'],
      });
      // Give it a moment to register its listener
      await sleep(300);
    } catch (err) {
      console.error('[MapsLead] Could not inject content script:', err);
      return { ok: false, error: err.message };
    }
  }

  // 3. Send START_SCRAPE to content script
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'START_SCRAPE' });
  } catch (err) {
    return { ok: false, error: 'Failed to start: ' + err.message };
  }

  await updateState({ isRunning: true });
  return { ok: true };
}

// Ping content script — returns true if it responds, false if not
function pingContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (_) {
      resolve(false);
    }
  });
}

// ── saveBatch ─────────────────────────────────────────────────────────────────
async function saveBatch(items) {
  const data = await chrome.storage.local.get([KEY_RESULTS, KEY_SEEN_URLS, KEY_STATE]);

  const results = data[KEY_RESULTS]   || [];
  const seenSet = new Set(data[KEY_SEEN_URLS] || []);
  const state   = data[KEY_STATE]     || { isRunning: true, total: 0, batchCount: 0 };

  let added = 0, dups = 0;

  for (const item of items) {
    // Primary key: profileUrl (most unique); fallback: name only
    // Never use name alone as key if profileUrl exists — avoids dropping
    // two businesses that share a name but are at different locations
    const key = item.profileUrl
      ? item.profileUrl.toLowerCase()
      : (item.name || '').toLowerCase().trim();
    if (!key) continue;
    if (seenSet.has(key)) { dups++; continue; }

    seenSet.add(key);
    results.push({
      name:       item.name       || '',
      phone:      item.phone      || '',
      link:       item.link       || null,
      profileUrl: item.profileUrl || null,
    });
    added++;
  }

  state.total      = results.length;
  state.batchCount = (state.batchCount || 0) + 1;

  await chrome.storage.local.set({
    [KEY_RESULTS]:   results,
    [KEY_SEEN_URLS]: Array.from(seenSet),
    [KEY_STATE]:     state,
  });

  console.log(`[MapsLead] +${added} new, ${dups} dupes. Total: ${results.length}`);
  return { added, duplicates: dups, total: results.length };
}

// ── getStats ──────────────────────────────────────────────────────────────────
async function getStats() {
  const data  = await chrome.storage.local.get([KEY_RESULTS, KEY_STATE]);
  const state = data[KEY_STATE] || { isRunning: false, total: 0, batchCount: 0 };
  return {
    total:      (data[KEY_RESULTS] || []).length,
    isRunning:  state.isRunning  || false,
    batchCount: state.batchCount || 0,
  };
}

// ── updateState ───────────────────────────────────────────────────────────────
async function updateState(patch) {
  const data  = await chrome.storage.local.get(KEY_STATE);
  const state = data[KEY_STATE] || {};
  await chrome.storage.local.set({ [KEY_STATE]: { ...state, ...patch } });
}

// ── buildCSV — returns CSV string (popup does the actual download) ─────────
async function buildCSV(onlyNoWebsite = false) {
  const data    = await chrome.storage.local.get([KEY_RESULTS, 'onlyNoWebsite']);
  let results   = data[KEY_RESULTS] || [];
  const filterActive = onlyNoWebsite !== undefined ? onlyNoWebsite : !!data['onlyNoWebsite'];

  if (filterActive) {
    results = results.filter(r => !r.link || r.link.trim() === '');
  }

  if (results.length === 0) return { csv: '', count: 0 };

  const header = 'Business Name,Phone,Website,Google Profile URL';
  const rows   = results.map(r => [
    csvEscape(r.name),
    csvEscape(r.phone),
    csvEscape(r.link),
    csvEscape(r.profileUrl),
  ].join(','));

  return { csv: [header, ...rows].join('\n'), count: results.length };
}

function csvEscape(val) {
  if (val === null || val === undefined || val === 'null' || val === '') return '';
  const s = String(val).trim();
  if (s === 'null') return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── resetAll ──────────────────────────────────────────────────────────────────
async function resetAll() {
  await chrome.storage.local.remove([KEY_RESULTS, KEY_SEEN_URLS, KEY_STATE]);
  try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
  console.log('[MapsLead] Reset done.');
}

// ── Utility ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
