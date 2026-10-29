/**
 * content.js — Google Maps Lead Scraper
 *
 * Implements end-to-end bulk extraction and deduplication:
 * - Restores seamless multi-listing scraping across feed scrolling.
 * - In-page detail panel inspection without tab navigation.
 * - Strict field validation: phone numbers strictly validated; listing text never accepted.
 * - Official websites strictly isolated from social media links.
 * - Multi-stage deduplication: discovery, in-memory, batch persistence, and export.
 * - Diagnostic logging adhering to [SCRAPER], [DEDUP], and [EXPORT] conventions.
 */

(function () {
  'use strict';

  // ── Guard: prevent double-injection ────────────────────────────────────────
  if (window.__mapsLeadRunning === true) {
    return;
  }
  window.__mapsLeadRunning = false;

  // ── Utilities Fallback ──────────────────────────────────────────────────────
  const utils = window.MapsScraperUtils || {};
  const normalizeGoogleMapsUrl     = utils.normalizeGoogleMapsUrl || utils.normalizeProfileUrl || (u => u ? u.split('?')[0] : '');
  const extractPlaceId             = utils.extractPlaceId         || (() => '');
  const extractCid                 = utils.extractCid             || (() => '');
  const getBusinessUniqueKey       = utils.getBusinessUniqueKey   || utils.generateProfileKey || (p => p.profileUrl || p.name);
  const normalizePhone             = utils.normalizePhone         || (() => '');
  const formatPhone                = utils.formatPhone            || (() => '');
  const isValidPhone               = utils.isValidPhone           || (() => false);
  const areBusinessesSame          = utils.areBusinessesSame      || (() => false);
  const isCloseBusinessName        = utils.isCloseBusinessName    || ((a, b) => (a || '').toLowerCase() === (b || '').toLowerCase());
  const mergeBusinessRecords       = utils.mergeBusinessRecords   || utils.enrichProfile      || ((t, s) => Object.assign(t, s));
  const isExternalLink             = utils.isExternalLink         || (h => !!h && !h.includes('google.com'));
  const cleanExternalUrl           = utils.cleanExternalUrl       || (u => u || null);
  const convertArabicIndicDigits   = utils.convertArabicIndicDigits || (s => s || '');
  const extractPhoneNumber         = utils.extractPhoneNumber || utils.extractBusinessPhoneNumber || (() => ({ phone: '', rawPhone: '' }));
  const extractBusinessWebsite     = utils.extractBusinessWebsite || (() => '');
  const extractBusinessSocialLinks = utils.extractBusinessSocialLinks || (() => []);
  const validateBusinessRecord     = utils.validateBusinessRecord || (r => r);

  // ── State ───────────────────────────────────────────────────────────────────
  let isRunning          = false;
  let isScrolling        = false;
  let scraped            = [];          // items awaiting sendBatch
  let inMemoryRegistry   = [];          // all unique items processed in this tab session
  let processedKeySet    = new Set();   // lookup set of all registered unique keys
  let lastPanelName      = '';

  const SAVE_EVERY     = 5;     // save to background every N items
  const MAX_PANEL_WAIT = 2500;  // max ms to wait for detail panel to change to new business
  const SCROLL_WAIT    = 1200;  // ms after scrolling feed
  const MAX_NO_NEW     = 8;     // max consecutive no-new-cards scrolls before stopping

  // ── Message listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_SCRAPE' || msg.type === 'RESUME_SCRAPE') {
      if (!isRunning) {
        startScraping();
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'STOP_SCRAPE') {
      isRunning = false;
      window.__mapsLeadRunning = false;
      log('Stopped by user.');
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return true;
    }
  });

  // ── Main scraper entry point ────────────────────────────────────────────────
  async function startScraping() {
    isRunning = true;
    window.__mapsLeadRunning = true;

    lastPanelName    = '';
    scraped          = [];
    inMemoryRegistry = [];
    processedKeySet  = new Set();

    log('Scraper started with centralized deduplication, strict validation, and detail panel enrichment.');

    await loadSeenUrls();

    // Detect page type: single business profile vs. search results feed
    const pageType = detectPageType();
    log(`[SCRAPER] Page type detected: ${pageType}`);

    if (pageType === 'single_place') {
      await scrapeSinglePlaceProfile();
      return;
    }

    await scrapeSearchResultsFeed();
  }

  // ── Single Business Profile Page Scraper ────────────────────────────────────
  async function scrapeSinglePlaceProfile() {
    log('[SCRAPER] Single business profile page detected. Extracting profile details...');

    // Wait up to 3500ms for place content (title, phone, buttons) to render
    const placeData = await waitForSinglePlaceData(3500);

    if (!placeData || !placeData.name) {
      logWarning('[SCRAPER] Could not extract business profile name from page.');
      finishScraping(0);
      return;
    }

    log(`[SCRAPER] Discovered profile: "${placeData.name}"`);

    // Validate record
    let validated = validateBusinessRecord(placeData);

    // If phone is missing but external website exists, try external contact fetch
    if (!validated.phone && validated.website && isExternalLink(validated.website) && isRunning) {
      const extPhone = await tryFetchExternalPhone(validated.website, validated.name);
      if (extPhone && extPhone.formatted) {
        validated.phone = extPhone.formatted;
        validated.rawPhone = extPhone.raw || extPhone.formatted;
        validated = validateBusinessRecord(validated);
      }
    }

    // Save record
    scraped = [validated];
    await sendBatch();

    log(`[SCRAPER] Successfully saved business profile: "${validated.name}" - Phone: ${validated.phone || 'none'}, Website: ${validated.website || 'none'}`);
    notifyBadge(1);
    finishScraping(1);
  }

  // ── Search Results Feed Scraper ─────────────────────────────────────────────
  async function scrapeSearchResultsFeed() {
    let totalThis  = 0;
    let noNewCount = 0;

    // Initial wait if cards are still rendering
    let initialCards = getResultCards();
    if (initialCards.length === 0) {
      log('[SCRAPER] Waiting for search result cards to render...');
      initialCards = await waitForFeedCards(3500);
    }

    if (initialCards.length === 0) {
      // Re-check if this page is actually a single place profile
      if (detectPageType() === 'single_place') {
        await scrapeSinglePlaceProfile();
        return;
      }
      log('No cards found — make sure you are on a Google Maps search results page.');
      finishScraping(0);
      return;
    }

    while (isRunning) {
      const cards = getResultCards();
      log(`Discovered ${cards.length} candidate cards in feed.`);

      if (cards.length === 0) {
        log('No cards found in current view.');
        break;
      }

      let processedThisRound = 0;

      for (let i = 0; i < cards.length && isRunning; i++) {
        const { card, profileUrl, cardData, dedupKey, placeId, cid } = cards[i];

        // 1. Stage 1 Deduplication: Check if card is already known
        const isAlreadyKnown = isCandidateKnown({
          name:       cardData.name,
          phone:      cardData.phone,
          address:    cardData.address,
          profileUrl: profileUrl,
          placeId:    placeId,
          cid:        cid,
          key:        dedupKey,
        });

        if (isAlreadyKnown) {
          log(`[DEDUP] Business skipped because it already exists: ${dedupKey || cardData.name}`);
          continue;
        }

        // Register candidate key temporarily to prevent duplicate re-extraction
        registerIdentifiers({
          name:       cardData.name,
          phone:      cardData.phone,
          address:    cardData.address,
          profileUrl: profileUrl,
          placeId:    placeId,
          cid:        cid,
          key:        dedupKey,
        });

        processedThisRound++;

        // Base item from card data
        let rawItem = {
          name:             cardData.name,
          businessName:     cardData.name,
          phone:            cardData.phone || '',
          rawPhone:         cardData.rawPhone || '',
          website:          cardData.website || '',
          link:             cardData.website || null,
          socialLinks:      Array.isArray(cardData.socialLinks) ? cardData.socialLinks : [],
          profileUrl:       profileUrl || null,
          googleProfileUrl: profileUrl || '',
          address:          cardData.address || null,
          rating:           cardData.rating || null,
          placeId:          placeId || null,
          cid:              cid || null,
        };

        // Validate item through strict validation layer
        let item = validateBusinessRecord(rawItem);

        // 2. In-Page Detail Panel Enrichment (if phone or website is missing)
        const needsEnrichment = (!item.phone || !item.website);
        if (needsEnrichment && isRunning) {
          // Re-find target card in feed if reference disconnected
          const targetCard = (card && card.isConnected)
            ? card
            : findCardInFeed({ placeId, profileUrl, name: cardData.name });

          if (targetCard) {
            await enrichViaDetailPanel(item, targetCard, profileUrl, placeId);
            // Re-validate enriched item
            item = validateBusinessRecord(item);
          }
        }

        if (item && item.name && !isGenericHeader(item.name)) {
          // 3. External Website Contact Inspection (if phone missing and external site available)
          if (!item.phone && item.website && isExternalLink(item.website) && isRunning) {
            const extPhone = await tryFetchExternalPhone(item.website, item.name);
            if (extPhone && extPhone.formatted) {
              item.phone = extPhone.formatted;
              item.rawPhone = extPhone.raw || extPhone.formatted;
              item = validateBusinessRecord(item);
            }
          }

          // 4. Stage 2 Deduplication: Check if extracted item matches in-memory registry
          let matchedInMemoryIdx = -1;
          for (let j = 0; j < inMemoryRegistry.length; j++) {
            if (areBusinessesSame(inMemoryRegistry[j], item)) {
              matchedInMemoryIdx = j;
              break;
            }
          }

          if (matchedInMemoryIdx !== -1) {
            log(`[DEDUP] Duplicate business detected: ${getBusinessUniqueKey(item) || item.name}`);
            log(`[DEDUP] Merging newly discovered fields into ${inMemoryRegistry[matchedInMemoryIdx].name}`);
            mergeBusinessRecords(inMemoryRegistry[matchedInMemoryIdx], item);
            registerIdentifiers(inMemoryRegistry[matchedInMemoryIdx]);
          } else {
            log(`[SCRAPER] Business discovered: ${item.name} (${getBusinessUniqueKey(item)})`);
            inMemoryRegistry.push(item);
            registerIdentifiers(item);

            // Check No Website Filter setting
            let onlyNoWebsite = false;
            try {
              const filterData = await chrome.storage.local.get('onlyNoWebsite');
              onlyNoWebsite = !!filterData.onlyNoWebsite;
            } catch (_) {}

            if (onlyNoWebsite && item.website && item.website.trim() !== '') {
              log(`[Filtered Out] "${item.name}" skipped (has website: ${item.website})`);
            } else {
              scraped.push(item);
              totalThis++;
              notifyBadge(totalThis);
            }
          }
        }

        // Save batch periodically
        if (scraped.length >= SAVE_EVERY) {
          await sendBatch();
        }

        await wait(200);
      }

      if (processedThisRound === 0) {
        noNewCount++;
        log(`No new unprocessed cards in view (${noNewCount}/${MAX_NO_NEW}). Scrolling feed...`);
        if (noNewCount >= MAX_NO_NEW) {
          log('No more new results found. Scraping finished.');
          break;
        }
      } else {
        noNewCount = 0;
      }

      await scrollFeedDown();
      await wait(SCROLL_WAIT);
    }

    // Save remaining
    if (scraped.length > 0) await sendBatch();

    finishScraping(totalThis);
  }

  function finishScraping(totalThis) {
    isRunning = false;
    window.__mapsLeadRunning = false;
    log(`Scraping finished. Total unique leads collected this run: ${totalThis}`);

    try {
      chrome.runtime.sendMessage({ type: 'SCRAPE_DONE', total: totalThis });
    } catch (_) {}
  }

  // ── Deduplication Registry Helpers ──────────────────────────────────────────
  function isCandidateKnown(cand) {
    if (!cand) return false;

    // Direct key check
    if (cand.key && processedKeySet.has(cand.key)) return true;

    // Place ID check
    const placeId = cand.placeId || extractPlaceId(cand.profileUrl);
    if (placeId && processedKeySet.has(`place:${placeId.toLowerCase()}`)) return true;

    // CID check
    const cid = cand.cid || extractCid(cand.profileUrl);
    if (cid && processedKeySet.has(`cid:${cid.toLowerCase()}`)) return true;

    // Canonical URL check
    const normUrl = normalizeGoogleMapsUrl(cand.profileUrl);
    if (normUrl && processedKeySet.has(`url:${normUrl.toLowerCase()}`)) return true;

    // Normalized Name + Phone check
    const normPhone = normalizePhone(cand.phone || cand.rawPhone);
    const cleanName = (cand.name || '').trim().toLowerCase();
    if (cleanName && normPhone && normPhone.length >= 7) {
      if (processedKeySet.has(`name_phone:${cleanName}|${normPhone}`)) return true;
    }

    // Normalized Name + Address check
    const cleanAddr = (cand.address || '').trim().toLowerCase();
    if (cleanName && cleanAddr && cleanAddr.length > 5) {
      if (processedKeySet.has(`name_addr:${cleanName}|${cleanAddr}`)) return true;
    }

    // Compare against in-memory registry
    for (const existing of inMemoryRegistry) {
      if (areBusinessesSame(existing, cand)) return true;
    }

    return false;
  }

  function registerIdentifiers(item) {
    if (!item) return;

    const uKey = getBusinessUniqueKey(item);
    if (uKey) processedKeySet.add(uKey);

    const placeId = item.placeId || extractPlaceId(item.profileUrl);
    if (placeId) processedKeySet.add(`place:${placeId.toLowerCase()}`);

    const cid = item.cid || extractCid(item.profileUrl);
    if (cid) processedKeySet.add(`cid:${cid.toLowerCase()}`);

    const normUrl = normalizeGoogleMapsUrl(item.profileUrl);
    if (normUrl) processedKeySet.add(`url:${normUrl.toLowerCase()}`);

    const normPhone = normalizePhone(item.phone || item.rawPhone);
    const cleanName = (item.name || '').trim().toLowerCase();
    if (cleanName && normPhone && normPhone.length >= 7) {
      processedKeySet.add(`name_phone:${cleanName}|${normPhone}`);
    }

    const cleanAddr = (item.address || '').trim().toLowerCase();
    if (cleanName && cleanAddr && cleanAddr.length > 5) {
      processedKeySet.add(`name_addr:${cleanName}|${cleanAddr}`);
    }
  }

  // ── Page Type Detection ────────────────────────────────────────────────────
  function detectPageType() {
    const url = window.location.href;
    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div.m6QErb[aria-label*="Results" i]') ||
                 document.querySelector('div.m6QErb[aria-label*="نتائج" i]');

    // If search feed with cards is present, it's a search results page
    if (feed && feed.querySelectorAll('div.Nv2pk, div[role="article"]').length > 0) {
      return 'search_results';
    }

    // If URL contains place path and no feed cards
    if (url.includes('/maps/place/') || url.includes('/place/')) {
      return 'single_place';
    }

    // If h1.DUwDvf or place action buttons are present and no search feed
    const placeTitle = document.querySelector('h1.DUwDvf, h1.fontHeadlineLarge, div.TIHn2 h1');
    const placeActions = document.querySelector('button[data-item-id^="phone:"], a[data-item-id="authority"], button[data-item-id="address"]');
    if ((placeTitle || placeActions) && (!feed || feed.querySelectorAll('div.Nv2pk, div[role="article"]').length === 0)) {
      return 'single_place';
    }

    // If URL indicates search
    if (url.includes('/maps/search/') || url.includes('/search')) {
      return 'search_results';
    }

    return 'search_results';
  }

  // ── Wait for Feed Cards to Render on Search Page ────────────────────────────
  async function waitForFeedCards(timeout = 3500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return [];
      const cards = getResultCards();
      if (cards.length > 0) return cards;
      await wait(200);
    }
    return [];
  }

  // ── Single Place Extraction Helpers ─────────────────────────────────────────
  async function waitForSinglePlaceData(timeout = 3500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return null;

      const name = extractSinglePlaceName();
      if (name) {
        const phoneObj    = extractPhoneNumber(document);
        const website     = extractBusinessWebsite(document);
        const socialLinks = extractBusinessSocialLinks(document);
        const address     = extractSinglePlaceAddress();
        const rating      = extractSinglePlaceRating();
        const profileUrl  = extractSinglePlaceProfileUrl();
        const placeId     = extractPlaceId(profileUrl || window.location.href);
        const cid         = extractCid(profileUrl || window.location.href);

        return {
          name,
          businessName: name,
          phone: phoneObj.phone || '',
          rawPhone: phoneObj.rawPhone || '',
          website: website || '',
          link: website || (socialLinks.length > 0 ? socialLinks[0] : null),
          socialLinks: socialLinks || [],
          address: address || null,
          rating: rating,
          profileUrl: profileUrl || normalizeGoogleMapsUrl(window.location.href),
          googleProfileUrl: profileUrl || normalizeGoogleMapsUrl(window.location.href),
          placeId,
          cid
        };
      }
      await wait(150);
    }
    return null;
  }

  function extractSinglePlaceName() {
    const selectors = [
      'h1.DUwDvf',
      'h1.fontHeadlineLarge',
      'h1[class*="DUwDvf"]',
      'div[role="main"] h1',
      'div.TIHn2 h1',
      'h1'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        let txt = (el.textContent || '').replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt && !isGenericHeader(txt)) return txt;
      }
    }
    const docTitle = document.title || '';
    if (docTitle && !docTitle.toLowerCase().startsWith('google maps')) {
      const parts = docTitle.split(' - ');
      const firstPart = parts[0].trim();
      if (firstPart && !isGenericHeader(firstPart)) return firstPart;
    }
    return '';
  }

  function extractSinglePlaceRating() {
    const ratingEl = document.querySelector('span.ceNzKf, div.F7nice span[aria-hidden="true"], span[aria-label*="stars" i], span[aria-label*="نجوم" i]');
    if (ratingEl) {
      const txt = ratingEl.getAttribute('aria-label') || ratingEl.textContent || '';
      const m = txt.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        const val = parseFloat(m[1]);
        if (!isNaN(val) && val >= 1 && val <= 5) return val;
      }
    }
    return null;
  }

  function extractSinglePlaceAddress() {
    const addrBtn = document.querySelector('button[data-item-id="address"], button[aria-label*="Address" i], button[aria-label*="العنوان" i], [data-item-id="address"]');
    if (addrBtn) {
      const ioText = addrBtn.querySelector('.Io6YTe')?.textContent?.trim();
      const aria = addrBtn.getAttribute('aria-label') || '';
      const cleaned = (ioText || aria.replace(/^(?:Address|العنوان):\s*/i, '')).trim();
      if (cleaned && !isValidPhone(cleaned) && cleaned.length > 5) {
        return cleaned;
      }
    }
    return null;
  }

  function extractSinglePlaceProfileUrl() {
    const canonTag = document.querySelector('link[rel="canonical"]');
    if (canonTag?.href && (canonTag.href.includes('/maps/place/') || canonTag.href.includes('/place/'))) {
      return normalizeGoogleMapsUrl(canonTag.href);
    }
    const shareBtn = document.querySelector('button[data-item-id="share"], button[aria-label*="Share" i], button[aria-label*="مشاركة" i]');
    if (shareBtn) {
      const dataUrl = shareBtn.getAttribute('data-url') || shareBtn.getAttribute('data-href');
      if (dataUrl) return normalizeGoogleMapsUrl(dataUrl);
    }
    if (window.location.href.includes('/maps/place/') || window.location.href.includes('/place/')) {
      return normalizeGoogleMapsUrl(window.location.href);
    }
    return null;
  }

  // ── Trigger In-Page Detail Panel Open Safely ───────────────────────────────
  function triggerInPagePanelOpen(card) {
    if (!card) return;

    try {
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_) {}

    // Find the primary clickable anchor or card element
    const clickable = card.querySelector('a.hfA8B') ||
                      card.querySelector('a[href*="/maps/place/"]') ||
                      card.querySelector('a[href*="/place/"]') ||
                      card.querySelector('div.qBF1Pd') ||
                      card;

    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    try { clickable.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    try { clickable.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
    try { clickable.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
    try { clickable.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}

    try {
      if (typeof clickable.click === 'function') {
        clickable.click();
      } else {
        clickable.dispatchEvent(new MouseEvent('click', opts));
      }
    } catch (_) {
      try { clickable.dispatchEvent(new MouseEvent('click', opts)); } catch (_) {}
    }
  }

  // ── Detail Panel Synchronization ───────────────────────────────────────────
  async function waitForPanelUpdate(expectedName, expectedPlaceId, previousPanelName, timeout = 3500) {
    const startTime = Date.now();
    const cleanExpected = (expectedName || '').trim();

    while (Date.now() - startTime < timeout) {
      if (!isRunning) return { updated: false, panel: null };

      const currentUrl = window.location.href;
      const isPlaceUrl = currentUrl.includes('/maps/place/') || currentUrl.includes('/place/');

      const panel = document.querySelector('div[role="main"]') ||
                    document.querySelector('div.m6QErb.DFlfde') ||
                    document.querySelector('div.widget-pane-content');

      if (panel) {
        const currentName = extractPanelName(panel);

        // Ensure we are not looking at the stale previous business panel
        const isStillPrevious = previousPanelName && isCloseBusinessName(previousPanelName, currentName);

        if (!isStillPrevious && currentName && !isGenericHeader(currentName)) {
          // 1. Direct Place ID match in current URL
          if (expectedPlaceId && isPlaceUrl && currentUrl.toLowerCase().includes(expectedPlaceId.toLowerCase())) {
            await wait(200);
            return { updated: true, panel };
          }

          // 2. Direct or close name match
          if (cleanExpected && isCloseBusinessName(cleanExpected, currentName)) {
            await wait(200);
            return { updated: true, panel };
          }

          // 3. Substring match
          const cleanExpLow = cleanExpected.toLowerCase();
          const cleanCurrLow = currentName.toLowerCase();
          if (cleanCurrLow.includes(cleanExpLow.slice(0, 10)) || cleanExpLow.includes(cleanCurrLow.slice(0, 10))) {
            await wait(200);
            return { updated: true, panel };
          }
        }
      }

      await wait(120);
    }

    // Fallback: check one last time if panel is present with actions
    const finalPanel = document.querySelector('div[role="main"]') || document.querySelector('div.m6QErb.DFlfde');
    if (finalPanel) {
      const currentName = extractPanelName(finalPanel);
      if (currentName && !isGenericHeader(currentName)) {
        if (!previousPanelName || !isCloseBusinessName(previousPanelName, currentName)) {
          return { updated: true, panel: finalPanel };
        }
      }
    }

    return { updated: false, panel: null };
  }

  // ── Enrich via Detail Panel ────────────────────────────────────────────────
  async function enrichViaDetailPanel(item, card, profileUrl, placeId) {
    if (!card || !isRunning) return;

    // 1. Scroll card into view
    try {
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_) {}
    await wait(80);

    // 2. Trigger open
    triggerInPagePanelOpen(card);

    // 3. Wait for panel name to update (confirms correct business loaded)
    let panelResult = await waitForPanelUpdate(item.name, placeId, lastPanelName, 3500);

    // Retry once if first attempt did not open
    if ((!panelResult.updated || !panelResult.panel) && isRunning) {
      triggerInPagePanelOpen(card);
      panelResult = await waitForPanelUpdate(item.name, placeId, lastPanelName, 2500);
    }

    if (panelResult.updated && panelResult.panel) {
      const panel = panelResult.panel;

      // 4. Wait for phone button to appear in panel DOM — Google Maps loads it async
      //    after the name/title renders. Poll up to 4 seconds.
      if (!item.phone) {
        await waitForPanelPhone(panel, 4000);
      }

      // 5. Wait for website link to appear in panel DOM — also async loaded
      if (!item.website) {
        await waitForPanelWebsite(panel, 3000);
      }

      // 6. Now extract everything from the fully loaded panel
      enrichFromDetailPanel(item, panel, profileUrl);
      lastPanelName = item.name;
      log(`[ENRICH] Successfully enriched "${item.name}" -> Phone: ${item.phone || 'none'}, Website: ${item.website || 'none'}`);
    } else {
      logWarning(`[ENRICH] Detail panel timed out for "${item.name}". Preserving card-level data.`);
    }

    // 7. Ensure the search feed is visible before moving to next item
    await returnToFeedIfHidden();
  }

  // ── Poll panel until phone button appears ─────────────────────────────────
  async function waitForPanelPhone(panel, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return;
      // Check for any phone-related element appearing in panel
      const hasPhone = (
        panel.querySelector('button[data-item-id^="phone:"]') ||
        panel.querySelector('[data-item-id*="phone"]') ||
        panel.querySelector('a[href^="tel:"]') ||
        panel.querySelector('button[aria-label*="phone" i]') ||
        panel.querySelector('button[aria-label*="call" i]') ||
        panel.querySelector('button[aria-label*="هاتف" i]') ||
        panel.querySelector('button[aria-label*="اتصال" i]')
      );
      if (hasPhone) return;
      await wait(200);
    }
  }

  // ── Poll panel until website link appears ─────────────────────────────────
  async function waitForPanelWebsite(panel, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return;
      const hasWebsite = (
        panel.querySelector('a[data-item-id="authority"]') ||
        panel.querySelector('a[data-value="Website"]') ||
        panel.querySelector('a[aria-label*="website" i]') ||
        panel.querySelector('a[data-tooltip*="website" i]') ||
        // Google redirect format
        panel.querySelector('a[href*="google.com/url?q="]') ||
        panel.querySelector('a[href*="/url?q="]')
      );
      if (hasWebsite) return;
      await wait(200);
    }
  }

  // ── Feed Visibility and Return Helper ──────────────────────────────────────
  function isFeedVisible() {
    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div.m6QErb[aria-label*="Results" i]') ||
                 document.querySelector('div.m6QErb[aria-label*="نتائج" i]');
    if (!feed) return false;
    const rect = feed.getBoundingClientRect();
    return feed.offsetParent !== null && rect.width > 50 && rect.height > 50;
  }

  async function returnToFeedIfHidden() {
    if (isFeedVisible()) {
      return true;
    }

    // Only click the Google Maps Back button (←) to restore the search feed.
    // NEVER click close buttons (which clear the search query) and NEVER call window.history.back().
    const backBtn = document.querySelector('button[jsaction*="pane.back"], button.hYBOP, button[aria-label="Back" i], button[aria-label="الرجوع" i], button[aria-label*="Back to results" i], button[aria-label*="الرجوع إلى نتائج البحث" i]');

    if (backBtn && backBtn.offsetParent !== null) {
      try {
        backBtn.click();
      } catch (_) {}
    }

    // Wait up to 2000ms for feed to become visible
    const start = Date.now();
    while (Date.now() - start < 2000) {
      if (!isRunning) return false;
      if (isFeedVisible()) return true;
      await wait(100);
    }

    return isFeedVisible();
  }

  // ── Find Card in Feed by Place ID, Profile URL, or Name ──────────────────────
  function findCardInFeed(cand) {
    if (!cand) return null;
    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div.m6QErb[aria-label]') ||
                 document.body;

    const cards = Array.from(feed.querySelectorAll('div.Nv2pk, div[role="article"]'));
    const cleanCandName = (cand.name || '').trim().toLowerCase();

    for (const c of cards) {
      // 1. Match by placeId if known
      if (cand.placeId && c.innerHTML.includes(cand.placeId)) {
        return c;
      }
      // 2. Match by profile URL
      const a = c.querySelector('a.hfA8B, a[href*="/maps/place/"], a[href*="/place/"]');
      if (a && cand.profileUrl) {
        const normA = normalizeGoogleMapsUrl(a.href);
        const normCand = normalizeGoogleMapsUrl(cand.profileUrl);
        if (normA && normCand && normA === normCand) {
          return c;
        }
      }
      // 3. Match by business title
      const titleEl = c.querySelector('div.qBF1Pd, div.fontHeadlineSmall');
      if (titleEl && cleanCandName) {
        const titleTxt = (titleEl.textContent || '').trim().toLowerCase();
        if (titleTxt === cleanCandName || isCloseBusinessName(cleanCandName, titleTxt)) {
          return c;
        }
      }
    }
    return null;
  }

  // ── Enrich item from verified detail panel ──────────────────────────────────
  function enrichFromDetailPanel(item, panel, profileUrl) {
    if (!item || !panel) return;

    // 1. Authoritative untruncated name: upgrade if panel title provides fuller version
    const panelName = extractPanelName(panel);
    if (panelName && !isGenericHeader(panelName)) {
      if (!item.name || item.name.includes('...') || item.name.includes('…') || panelName.length > item.name.length) {
        item.name = panelName;
        item.businessName = panelName;
      }
    }

    // 2. Phone extraction from panel (strictly validated)
    if (!item.phone) {
      const phObj = extractPhoneNumber(panel);
      if (phObj && phObj.phone) {
        item.phone = phObj.phone;
        item.rawPhone = phObj.rawPhone;
      }
    }

    // 3. Official website extraction from panel
    if (!item.website) {
      const web = extractBusinessWebsite(panel);
      if (web) {
        item.website = web;
        item.link = web;
      }
    }

    // 4. Social links from panel
    const soc = extractBusinessSocialLinks(panel);
    if (soc && soc.length > 0) {
      const existing = item.socialLinks || [];
      item.socialLinks = Array.from(new Set([...existing, ...soc]));
    }

    // 5. Address from panel if missing
    if (!item.address) {
      const addrBtn = panel.querySelector('button[data-item-id="address"], button[aria-label*="Address" i], button[aria-label*="العنوان" i], [data-item-id="address"]');
      if (addrBtn) {
        const ioText = addrBtn.querySelector('.Io6YTe')?.textContent?.trim();
        const aria = addrBtn.getAttribute('aria-label') || '';
        const cleaned = (ioText || aria.replace(/^(?:Address|العنوان):\s*/i, '')).trim();
        if (cleaned && !isValidPhone(cleaned) && cleaned.length > 5) {
          item.address = cleaned;
        }
      }
    }

    // 6. Rating from panel
    if (item.rating === null) {
      const ratingEl = panel.querySelector('span.ceNzKf, div.F7nice span[aria-hidden="true"]');
      if (ratingEl) {
        const val = parseFloat(ratingEl.textContent?.trim());
        if (!isNaN(val) && val >= 1 && val <= 5) item.rating = val;
      }
    }

    // 7. Canonical profile URL & Place ID
    if (!item.profileUrl || !item.placeId) {
      const canonUrl = extractPanelProfileUrl(panel) || profileUrl;
      if (canonUrl) {
        item.profileUrl = normalizeGoogleMapsUrl(canonUrl);
        item.googleProfileUrl = item.profileUrl;
        if (!item.placeId) item.placeId = extractPlaceId(item.profileUrl);
        if (!item.cid) item.cid = extractCid(item.profileUrl);
      }
    }
  }

  function extractPanelName(panel) {
    const root = panel || document;
    const selectors = [
      'h1.DUwDvf',
      'h1.fontHeadlineLarge',
      'h1[class*="DUwDvf"]',
      'div[role="main"] h1',
      'h1',
    ];

    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) {
        let txt = el.textContent || '';
        txt = txt.replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt && !isGenericHeader(txt)) {
          return txt;
        }
      }
    }
    return '';
  }

  function extractPanelProfileUrl(panel) {
    const canonTag = document.querySelector('link[rel="canonical"]');
    if (canonTag?.href && (canonTag.href.includes('/maps/place/') || canonTag.href.includes('/place/'))) {
      return canonTag.href;
    }

    const shareBtn = (panel || document).querySelector('button[data-item-id="share"], button[aria-label*="Share" i], button[aria-label*="مشاركة" i]');
    if (shareBtn) {
      const dataUrl = shareBtn.getAttribute('data-url') || shareBtn.getAttribute('data-href');
      if (dataUrl) return dataUrl;
    }

    if (window.location.href.includes('/maps/place/') || window.location.href.includes('/place/')) {
      return window.location.href;
    }

    return null;
  }

  // ── Extract pre-click information directly from Card element ────────────────
  function extractFromCard(card) {
    let name        = '';
    let phone       = '';
    let rawPhone    = '';
    let website     = '';
    let socialLinks = [];
    let address     = '';
    let rating      = null;

    // 1. Business Name (preserve original Arabic / English text)
    const nameEl = card.querySelector('div.qBF1Pd, div.fontHeadlineSmall, [class*="headlineSmall"]');
    if (nameEl?.textContent?.trim()) {
      name = nameEl.textContent.replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      const linkEl = card.querySelector('a.hfA8B, a[href*="/maps/place/"], a[href*="/place/"]');
      if (linkEl) {
        const aria = linkEl.getAttribute('aria-label');
        if (aria) name = aria.replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }

    // 2. Rating from card
    const ratingEl = card.querySelector('span.MW4etd, span[aria-label*="stars" i], span[aria-label*="نجوم"]');
    if (ratingEl) {
      const ratingTxt = ratingEl.getAttribute('aria-label') || ratingEl.textContent || '';
      const rMatch = ratingTxt.match(/(\d+(?:\.\d+)?)/);
      if (rMatch) rating = parseFloat(rMatch[1]);
    }

    // 3. Address from card text spans (strictly rejecting phone, rating, hours)
    const textSpans = card.querySelectorAll('div.W4Efsd > span, div.UsdlK');
    for (const span of textSpans) {
      if (span.children.length > 0) continue;
      const txt = span.textContent?.trim() || '';
      if (
        !address &&
        txt.length > 5 &&
        !isValidPhone(txt) &&
        !txt.includes('★') &&
        !txt.includes('Open') &&
        !txt.includes('Closes') &&
        !txt.includes('Closed') &&
        !txt.includes('مفتوح') &&
        !txt.includes('مغلق')
      ) {
        address = txt;
      }
    }

    // 4. Strict Phone Number extraction from Card
    const phObj = extractPhoneNumber(card);
    if (phObj && phObj.phone) {
      phone = phObj.phone;
      rawPhone = phObj.rawPhone;
    }

    // 5. Official Website from Card
    website = extractBusinessWebsite(card);

    // 6. Social Links from Card
    socialLinks = extractBusinessSocialLinks(card);

    return { name, phone, rawPhone, website, socialLinks, address, rating };
  }

  // ── Get unique result cards from feed ───────────────────────────────────────
  function getResultCards() {
    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div.m6QErb[aria-label]') ||
                 document.querySelector('div[aria-label*="Results"]') ||
                 document.querySelector('div[aria-label*="نتائج"]') ||
                 document.body;

    let rawElements = Array.from(feed.querySelectorAll('div.Nv2pk, div[role="article"]'));

    if (rawElements.length === 0) {
      const links = Array.from(feed.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"]'));
      const containerSet = new Set();
      links.forEach(a => {
        const parent = a.closest('div.Nv2pk') || a.closest('div[role="article"]') || a.closest('div[jsaction]') || a.parentElement;
        if (parent) containerSet.add(parent);
      });
      rawElements = Array.from(containerSet);
    }

    const uniqueMap = new Map();
    for (const card of rawElements) {
      const cardData   = extractFromCard(card);
      if (!cardData.name || isGenericHeader(cardData.name)) continue;

      const profileUrl = getProfileUrl(card);
      const placeId    = profileUrl ? extractPlaceId(profileUrl) : '';
      const cid        = profileUrl ? extractCid(profileUrl) : '';

      const candObj = {
        name:       cardData.name,
        phone:      cardData.phone,
        address:    cardData.address,
        profileUrl: profileUrl,
        placeId:    placeId,
        cid:        cid,
      };

      const dedupKey = getBusinessUniqueKey(candObj);
      if (!dedupKey) continue;

      if (!uniqueMap.has(dedupKey)) {
        uniqueMap.set(dedupKey, { card, profileUrl, cardData, dedupKey, placeId, cid });
      }
    }

    return Array.from(uniqueMap.values());
  }

  // ── Get Profile URL from card ──────────────────────────────────────────────
  function getProfileUrl(card) {
    try {
      const selectors = [
        'a.hfA8B[href]',
        'a[href*="/maps/place/"]',
        'a[href*="/place/"]',
        'a[data-cid]',
        'a[href*="cid="]',
        'a[href*="place_id="]',
      ];

      if (card.tagName === 'A' && (card.href?.includes('/maps/place/') || card.href?.includes('/place/'))) {
        return normalizeGoogleMapsUrl(card.href, window.location.origin);
      }

      for (const sel of selectors) {
        const a = card.querySelector(sel);
        if (a) {
          const href = a.getAttribute('href') || a.href;
          if (href) {
            const norm = normalizeGoogleMapsUrl(href, window.location.origin);
            if (norm) return norm;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // ── Try fetching phone from external website or Linktree ────────────────────
  async function tryFetchExternalPhone(url, name) {
    if (!url || !isExternalLink(url)) return null;

    try {
      log(`Attempting external contact inspection for "${name}" at ${url}`);
      const resp = await chrome.runtime.sendMessage({
        type: 'FETCH_EXTERNAL_CONTACT',
        url:  url,
        name: name,
      });

      if (resp && resp.ok && resp.phone) {
        const validated = normalizePhone(resp.phone);
        if (validated) {
          log(`[External Contact Success] Discovered phone for "${name}": ${resp.phone} (source: ${resp.source || 'external'})`);
          return { formatted: formatPhone(validated), raw: resp.rawPhone || resp.phone };
        }
      }
    } catch (err) {
      logWarning(`[External Contact Exception] ${err.message}`);
    }
    return null;
  }

  function isGenericHeader(name) {
    return utils.isGenericHeader ? utils.isGenericHeader(name) : (
      !name ||
      name.toLowerCase().trim() === 'results' ||
      name.toLowerCase().trim() === 'search results' ||
      name.toLowerCase().trim().startsWith('results for') ||
      name.toLowerCase().trim() === 'google maps' ||
      name.includes('نتائج')
    );
  }

  // ── Scroll results feed ────────────────────────────────────────────────────
  async function scrollFeedDown() {
    if (isScrolling) return;
    isScrolling = true;

    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div.m6QErb[aria-label]') ||
                 document.querySelector('div[aria-label*="Results"]') ||
                 document.querySelector('div[aria-label*="نتائج"]');

    if (feed) {
      feed.scrollBy({ top: 900, behavior: 'smooth' });
      await wait(400);

      const cards = feed.querySelectorAll('div.Nv2pk, div[role="article"]');
      if (cards.length > 0) {
        try {
          cards[cards.length - 1].scrollIntoView({ block: 'end', behavior: 'smooth' });
        } catch (_) {}
      }
      await wait(600);
    } else {
      window.scrollBy({ top: 800, behavior: 'smooth' });
      await wait(600);
    }

    isScrolling = false;
  }

  // ── Send batch to background ────────────────────────────────────────────────
  async function sendBatch() {
    if (scraped.length === 0) return;
    const toSend = [...scraped];
    scraped = [];
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SAVE_BATCH', items: toSend });
      if (result && result.seenKeys) {
        result.seenKeys.forEach(k => processedKeySet.add(k));
      }
      log(`Saved batch: +${result.added} new, ${result.enriched || 0} merged, ${result.duplicates} skipped. Total unique in storage: ${result.total}`);
    } catch (err) {
      logWarning('Save error: ' + err.message);
      scraped = [...toSend, ...scraped];
    }
  }

  // ── Load seen URLs/keys from storage ────────────────────────────────────────
  async function loadSeenUrls() {
    try {
      const data = await chrome.storage.local.get(['scrape_seen_urls', 'scrape_results']);
      const arr  = data['scrape_seen_urls'] || [];
      arr.forEach(u => processedKeySet.add(u));

      // Also register all identifiers of existing saved results (after validating)
      const results = data['scrape_results'] || [];
      results.forEach(rawR => {
        const r = validateBusinessRecord(rawR);
        if (r) {
          inMemoryRegistry.push(r);
          registerIdentifiers(r);
        }
      });

      log(`Loaded ${processedKeySet.size} previously scraped keys into deduplication registry.`);

    } catch (_) {}
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function log(msg) {
    console.log(`%c[MapsLead] ${msg}`, 'color:#1a73e8;font-weight:bold');
  }

  function logWarning(msg) {
    console.log(`%c[MapsLead Warning] ${msg}`, 'color:#f59e0b;font-weight:bold');
  }

  function notifyBadge(count) {
    try { chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count }); } catch (_) {}
  }

})();
