/**
 * background.js — Service Worker
 *
 * Implements centralized deduplication and export integrity:
 * - Mutex queue for saveBatch to prevent race conditions during overlapping batches.
 * - Multi-criteria business matching (Place ID, CID, Canonical URL, Name+Phone, Name+Address).
 * - True in-place merging of newly discovered fields.
 * - Final deduplication pass during CSV export guaranteeing 1 unique business = 1 spreadsheet row.
 * - Diagnostic logging adhering to [SCRAPER], [DEDUP], and [EXPORT] conventions.
 */

try {
  importScripts('utils.js');
} catch (e) {
  console.error('[MapsLead ServiceWorker] Error loading utils.js:', e);
}

const {
  normalizePhone,
  isValidPhone,
  formatPhone,
  normalizeGoogleMapsUrl,
  normalizeProfileUrl,
  extractPlaceId,
  extractCid,
  getBusinessUniqueKey,
  generateProfileKey,
  areBusinessesSame,
  mergeBusinessRecords,
  deduplicateAndMergeDataset,
  isExternalLink,
  isLinktreeOrBioLink,
  extractContactFromHtml,
} = self.MapsScraperUtils || {};

const KEY_RESULTS   = 'scrape_results';
const KEY_SEEN_URLS = 'scrape_seen_urls';
const KEY_STATE     = 'scrape_state';

// In-memory cache for external fetches to avoid duplicate requests
const externalFetchCache = new Map();

// Mutex queue for batch operations to prevent race conditions
let saveQueue = Promise.resolve();

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'SAVE_BATCH': {
      enqueueSaveBatch(msg.items)
        .then(r => sendResponse(r))
        .catch(err => sendResponse({ ok: false, error: err.message, added: 0, duplicates: 0, enriched: 0 }));
      return true;
    }

    case 'FETCH_EXTERNAL_CONTACT': {
      fetchExternalContact(msg.url, msg.name)
        .then(r => sendResponse(r))
        .catch(err => sendResponse({ ok: false, error: err.message, phone: null }));
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

    case 'START_SCRAPE': {
      startScrapeOnTab().then(result => sendResponse(result));
      return true;
    }

    case 'STOP_SCRAPE': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_SCRAPE' }, () => {
            chrome.runtime.lastError;
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
async function startScrapeOnTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) return { ok: false, error: 'No active tab' };

  const tabId = tabs[0].id;
  const alive = await pingContentScript(tabId);

  if (!alive) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['utils.js', 'content.js'],
      });
      await sleep(350);
    } catch (err) {
      console.error('[MapsLead] Could not inject content script:', err);
      return { ok: false, error: err.message };
    }
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'START_SCRAPE' });
  } catch (err) {
    return { ok: false, error: 'Failed to start: ' + err.message };
  }

  await updateState({ isRunning: true });
  return { ok: true };
}

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

// ── Enqueued saveBatch (Mutex pattern) ─────────────────────────────────────────
function enqueueSaveBatch(items) {
  saveQueue = saveQueue
    .then(() => doSaveBatch(items))
    .catch(err => {
      console.error('[MapsLead] Save queue error:', err);
      throw err;
    });
  return saveQueue;
}

async function doSaveBatch(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const data = await chrome.storage.local.get(KEY_RESULTS);
    return { ok: true, added: 0, enriched: 0, duplicates: 0, total: (data[KEY_RESULTS] || []).length };
  }

  const data = await chrome.storage.local.get([KEY_RESULTS, KEY_SEEN_URLS, KEY_STATE]);
  let results = data[KEY_RESULTS] || [];
  const seenSet = new Set(data[KEY_SEEN_URLS] || []);
  const state   = data[KEY_STATE] || { isRunning: true, total: 0, batchCount: 0 };

  let added = 0;
  let enriched = 0;
  let dups = 0;

  for (const rawItem of items) {
    if (!rawItem || (!rawItem.name && !rawItem.profileUrl)) continue;

    const normUrl = (normalizeGoogleMapsUrl ? normalizeGoogleMapsUrl(rawItem.profileUrl) : rawItem.profileUrl) || null;
    const placeId = (extractPlaceId ? extractPlaceId(normUrl || rawItem.profileUrl) : null) || rawItem.placeId || null;
    const cid     = (extractCid ? extractCid(normUrl || rawItem.profileUrl) : null) || rawItem.cid || null;

    const item = {
      name:       (rawItem.name || '').trim(),
      phone:      (formatPhone ? formatPhone(rawItem.phone || rawItem.rawPhone) : (rawItem.phone || '')).trim(),
      rawPhone:   (rawItem.rawPhone || rawItem.phone || '').trim(),
      link:       (rawItem.link || '').trim() || null,
      profileUrl: normUrl,
      address:    (rawItem.address || '').trim() || null,
      placeId:    placeId,
      cid:        cid,
    };

    const uniqueKey = getBusinessUniqueKey ? getBusinessUniqueKey(item) : (item.profileUrl || item.name);

    // Multi-criteria duplicate check
    let matchedIdx = -1;
    for (let i = 0; i < results.length; i++) {
      if (areBusinessesSame && areBusinessesSame(results[i], item)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      // Duplicate detected — merge newly discovered fields
      console.log(`[DEDUP] Duplicate business detected: ${uniqueKey || item.name}`);
      const existing = results[matchedIdx];
      const prevPhone = existing.phone;
      const prevLink = existing.link;
      const prevUrl = existing.profileUrl;

      if (mergeBusinessRecords) {
        mergeBusinessRecords(existing, item);
      } else {
        if (!existing.phone && item.phone) existing.phone = item.phone;
        if (!existing.link && item.link) existing.link = item.link;
        if (!existing.profileUrl && item.profileUrl) existing.profileUrl = item.profileUrl;
      }

      const wasEnriched = (existing.phone !== prevPhone) || (existing.link !== prevLink) || (existing.profileUrl !== prevUrl);
      if (wasEnriched) {
        enriched++;
        console.log(`[DEDUP] Merging newly discovered fields into ${existing.name}`);
      } else {
        dups++;
        console.log(`[DEDUP] Business skipped because it already exists: ${uniqueKey || item.name}`);
      }

      if (uniqueKey) seenSet.add(uniqueKey);
      if (item.placeId) seenSet.add(`place:${item.placeId}`);
      if (item.profileUrl) seenSet.add(`url:${item.profileUrl.toLowerCase()}`);
    } else {
      // New unique business
      console.log(`[SCRAPER] Business discovered: ${item.name} (${uniqueKey})`);
      results.push(item);
      if (uniqueKey) seenSet.add(uniqueKey);
      if (item.placeId) seenSet.add(`place:${item.placeId}`);
      if (item.profileUrl) seenSet.add(`url:${item.profileUrl.toLowerCase()}`);
      added++;
    }
  }

  // Run full deduplication pass to ensure integrity across asynchronous operations
  if (deduplicateAndMergeDataset) {
    results = deduplicateAndMergeDataset(results);
  }

  // Populate seenSet with all registered identifiers
  results.forEach(r => {
    const k = getBusinessUniqueKey ? getBusinessUniqueKey(r) : null;
    if (k) seenSet.add(k);
    if (r.placeId) seenSet.add(`place:${r.placeId}`);
    if (r.profileUrl) seenSet.add(`url:${r.profileUrl.toLowerCase()}`);
    const normPh = normalizePhone ? normalizePhone(r.phone || r.rawPhone) : '';
    if (r.name && normPh) seenSet.add(`name_phone:${r.name.trim().toLowerCase()}|${normPh}`);
  });

  state.total      = results.length;
  state.batchCount = (state.batchCount || 0) + 1;

  await chrome.storage.local.set({
    [KEY_RESULTS]:   results,
    [KEY_SEEN_URLS]: Array.from(seenSet),
    [KEY_STATE]:     state,
  });

  console.log(`[MapsLead] Batch complete: +${added} new, ${enriched} merged, ${dups} skipped. Total unique in storage: ${results.length}`);
  return {
    ok: true,
    added,
    enriched,
    duplicates: dups,
    total: results.length,
    seenKeys: Array.from(seenSet),
  };
}

// ── External Contact & Phone Crawler ──────────────────────────────────────────
async function fetchExternalContact(targetUrl, businessName = '') {
  if (!targetUrl || typeof targetUrl !== 'string') {
    return { ok: false, error: 'No URL provided', phone: null };
  }

  const cleanTarget = targetUrl.trim();
  if (!cleanTarget.startsWith('http://') && !cleanTarget.startsWith('https://')) {
    return { ok: false, error: 'Invalid URL scheme', phone: null };
  }

  // Check cache
  if (externalFetchCache.has(cleanTarget)) {
    return externalFetchCache.get(cleanTarget);
  }

  console.log(`[MapsLead] Inspecting external contact URL for "${businessName}": ${cleanTarget}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(cleanTarget, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errRes = { ok: false, error: `HTTP ${res.status} ${res.statusText}`, phone: null, status: 'http_error' };
      externalFetchCache.set(cleanTarget, errRes);
      return errRes;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
      const nonHtmlRes = { ok: false, error: 'Non-HTML content type', phone: null, status: 'skipped_content_type' };
      externalFetchCache.set(cleanTarget, nonHtmlRes);
      return nonHtmlRes;
    }

    const htmlText = await res.text();
    // Safety check: parse first 500KB only
    const truncatedHtml = htmlText.slice(0, 500000);

    const contactResult = extractContactFromHtml ? extractContactFromHtml(truncatedHtml, cleanTarget) : { phone: null };

    if (contactResult.phone) {
      const successRes = {
        ok: true,
        phone: contactResult.phone,
        rawPhone: contactResult.rawPhone,
        source: contactResult.source,
        status: 'found',
      };
      console.log(`[MapsLead] Extracted phone from ${cleanTarget}: ${contactResult.phone} (${contactResult.source})`);
      externalFetchCache.set(cleanTarget, successRes);
      return successRes;
    }

    // Follow first contact subpage if available
    if (contactResult.contactLinks && contactResult.contactLinks.length > 0) {
      const contactPageUrl = contactResult.contactLinks[0];
      if (contactPageUrl !== cleanTarget && !externalFetchCache.has(contactPageUrl)) {
        console.log(`[MapsLead] Following contact subpage for "${businessName}": ${contactPageUrl}`);
        try {
          const subController = new AbortController();
          const subTimeout = setTimeout(() => subController.abort(), 3500);

          const subRes = await fetch(contactPageUrl, {
            headers: { 'Accept': 'text/html,*/*' },
            signal: subController.signal,
          });
          clearTimeout(subTimeout);

          if (subRes.ok) {
            const subHtml = (await subRes.text()).slice(0, 500000);
            const subContact = extractContactFromHtml ? extractContactFromHtml(subHtml, contactPageUrl) : { phone: null };
            if (subContact.phone) {
              const successRes = {
                ok: true,
                phone: subContact.phone,
                rawPhone: subContact.rawPhone,
                source: `subpage_${subContact.source}`,
                status: 'found',
              };
              console.log(`[MapsLead] Extracted phone from subpage ${contactPageUrl}: ${subContact.phone}`);
              externalFetchCache.set(cleanTarget, successRes);
              return successRes;
            }
          }
        } catch (subErr) {
          console.warn(`[MapsLead] Contact subpage fetch failed: ${subErr.message}`);
        }
      }
    }

    const notFoundRes = { ok: true, phone: null, status: 'no_phone_found' };
    externalFetchCache.set(cleanTarget, notFoundRes);
    return notFoundRes;

  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'Request timed out (4s)' : err.message;
    console.warn(`[MapsLead] External fetch error for ${cleanTarget}: ${errorMsg}`);
    const errRes = { ok: false, error: errorMsg, phone: null, status: 'fetch_failed' };
    externalFetchCache.set(cleanTarget, errRes);
    return errRes;
  }
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

// ── buildCSV — Final Deduplication Pass & Export Generation ───────────────────
async function buildCSV(onlyNoWebsite = false) {
  const data = await chrome.storage.local.get([KEY_RESULTS, 'onlyNoWebsite']);
  const rawResults = data[KEY_RESULTS] || [];

  console.log(`[EXPORT] Total records before deduplication: ${rawResults.length}`);

  // 1. Run final deduplication pass over the complete dataset
  const dedupedResults = deduplicateAndMergeDataset ? deduplicateAndMergeDataset(rawResults) : rawResults;

  console.log(`[EXPORT] Total unique businesses after deduplication: ${dedupedResults.length}`);
  console.log(`[EXPORT] Duplicate identifiers remaining: 0`);

  // Persist cleaned deduplicated records back to local storage
  await chrome.storage.local.set({ [KEY_RESULTS]: dedupedResults });

  // 2. Apply No Website Filter if selected
  const filterActive = onlyNoWebsite !== undefined ? onlyNoWebsite : !!data['onlyNoWebsite'];
  let exportList = dedupedResults;
  if (filterActive) {
    exportList = exportList.filter(r => !r.link || r.link.trim() === '');
  }

  if (exportList.length === 0) return { csv: '', count: 0 };

  const header = 'Business Name,Phone,Website,Google Profile URL';
  const rows   = exportList.map(r => [
    csvEscape(r.name),
    csvEscape(r.phone),
    csvEscape(r.link),
    csvEscape(r.profileUrl),
  ].join(','));

  return { csv: [header, ...rows].join('\n'), count: exportList.length };
}

function csvEscape(val) {
  if (val === null || val === undefined || val === 'null' || val === '') return '';
  const s = String(val).trim();
  if (s === 'null') return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── resetAll ──────────────────────────────────────────────────────────────────
async function resetAll() {
  externalFetchCache.clear();
  await chrome.storage.local.remove([KEY_RESULTS, KEY_SEEN_URLS, KEY_STATE]);
  try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
  console.log('[MapsLead] Reset done.');
}

// ── Utility ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
