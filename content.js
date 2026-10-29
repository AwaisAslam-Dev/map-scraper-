/**
 * content.js — Google Maps Lead Scraper
 *
 * Implements end-to-end deduplication across infinite scrolling, dynamic DOM updates,
 * panel synchronization, and background batch persistence:
 * - Centralized business identity resolution via MapsScraperUtils.
 * - Deduplication at result discovery, card extraction, panel opening, and batch aggregation.
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
  const normalizeGoogleMapsUrl  = utils.normalizeGoogleMapsUrl || utils.normalizeProfileUrl || (u => u ? u.split('?')[0] : '');
  const extractPlaceId          = utils.extractPlaceId          || (() => '');
  const extractCid              = utils.extractCid              || (() => '');
  const getBusinessUniqueKey    = utils.getBusinessUniqueKey    || utils.generateProfileKey || (p => p.profileUrl || p.name);
  const normalizePhone          = utils.normalizePhone          || (p => p ? p.replace(/[^\d+]/g, '') : '');
  const formatPhone             = utils.formatPhone             || (p => p || '');
  const isValidPhone            = utils.isValidPhone            || (() => true);
  const areBusinessesSame       = utils.areBusinessesSame       || (() => false);
  const mergeBusinessRecords    = utils.mergeBusinessRecords    || utils.enrichProfile      || ((t, s) => Object.assign(t, s));
  const isExternalLink          = utils.isExternalLink          || (h => !!h && !h.includes('google.com'));

  // ── State ───────────────────────────────────────────────────────────────────
  let isRunning          = false;
  let isScrolling        = false;
  let scraped            = [];          // items awaiting sendBatch
  let inMemoryRegistry   = [];          // all unique items processed in this tab session
  let processedKeySet    = new Set();   // lookup set of all registered unique keys
  let lastPanelName      = '';
  let lastPanelUrl       = '';

  const SAVE_EVERY     = 5;     // save to background every N items
  const MAX_PANEL_WAIT = 5000;  // max ms to wait for detail panel to change to new business
  const PHONE_WAIT     = 3000;  // extra ms to wait for phone number to appear in panel
  const SCROLL_WAIT    = 1500;  // ms after scrolling feed
  const MAX_NO_NEW     = 8;     // max consecutive no-new-cards scrolls before stopping

  // ── Message listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_SCRAPE') {
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

  // ── Main scraper loop ───────────────────────────────────────────────────────
  async function startScraping() {
    isRunning = true;
    window.__mapsLeadRunning = true;

    lastPanelName    = '';
    lastPanelUrl     = '';
    scraped          = [];
    inMemoryRegistry = [];
    processedKeySet  = new Set();

    log('Scraper started with centralized deduplication.');

    await loadSeenUrls();

    let totalThis  = 0;
    let noNewCount = 0;

    while (isRunning) {
      const cards = getResultCards();
      log(`Discovered ${cards.length} candidate cards in feed.`);

      if (cards.length === 0) {
        log('No cards found — make sure you are on a Google Maps search results page.');
        break;
      }

      let processedThisRound = 0;

      for (let i = 0; i < cards.length && isRunning; i++) {
        const { card, profileUrl, cardData, dedupKey, placeId, cid } = cards[i];

        // 1. Stage 1 Deduplication: Check if card is already known before clicking
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

        // Register candidate key temporarily to prevent parallel duplicate extraction
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

        // 2. Scroll card into view
        scrollCardIntoView(card);
        await wait(250);

        // 3. Click title/card
        const clickable = getClickableElement(card);
        if (clickable) {
          try { clickable.click(); } catch (_) { card.click(); }
        } else {
          card.click();
        }

        // 4. Synchronize: Wait until detail panel updates
        const panelUpdated = await waitForPanelUpdate(cardData.name, lastPanelName);

        let item = null;
        if (panelUpdated) {
          item = await extractData(profileUrl, cardData);
          if (item && item.name) {
            lastPanelName = item.name;
          }
        } else {
          logWarning(`Panel update timed out for "${cardData.name}". Using feed card data.`);
          if (cardData.name && !isGenericHeader(cardData.name)) {
            item = {
              name:       cardData.name,
              phone:      cardData.phone || '',
              rawPhone:   cardData.phone || '',
              link:       cardData.link || null,
              profileUrl: profileUrl || null,
              address:    cardData.address || null,
              placeId:    placeId || null,
              cid:        cid || null,
            };
          }
        }

        if (item && item.name && !isGenericHeader(item.name)) {
          // If phone is still missing and we have a website, try external contact inspection
          if (!item.phone && item.link && isExternalLink(item.link)) {
            const extPhone = await tryFetchExternalPhone(item.link, item.name);
            if (extPhone) {
              item.phone = extPhone.formatted;
              item.rawPhone = extPhone.raw;
            }
          }

          // 5. Stage 2 Deduplication: Check if extracted item matches any previously processed item
          let matchedInMemoryIdx = -1;
          for (let j = 0; j < inMemoryRegistry.length; j++) {
            if (areBusinessesSame(inMemoryRegistry[j], item)) {
              matchedInMemoryIdx = j;
              break;
            }
          }

          if (matchedInMemoryIdx !== -1) {
            // Duplicate detected in memory — merge newly discovered fields
            log(`[DEDUP] Duplicate business detected: ${getBusinessUniqueKey(item) || item.name}`);
            log(`[DEDUP] Merging newly discovered fields into ${inMemoryRegistry[matchedInMemoryIdx].name}`);
            mergeBusinessRecords(inMemoryRegistry[matchedInMemoryIdx], item);
            registerIdentifiers(inMemoryRegistry[matchedInMemoryIdx]);
          } else {
            // New unique business discovered
            log(`[SCRAPER] Business discovered: ${item.name} (${getBusinessUniqueKey(item)})`);
            inMemoryRegistry.push(item);
            registerIdentifiers(item);

            // Check No Website Filter setting
            let onlyNoWebsite = false;
            try {
              const filterData = await chrome.storage.local.get('onlyNoWebsite');
              onlyNoWebsite = !!filterData.onlyNoWebsite;
            } catch (_) {}

            if (onlyNoWebsite && item.link && item.link.trim() !== '') {
              log(`[Filtered Out] "${item.name}" skipped (has website: ${item.link})`);
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

        await wait(450);
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

  // ── Detail panel synchronization ───────────────────────────────────────────
  async function waitForPanelUpdate(expectedCardName, previousPanelName) {
    const startTime = Date.now();
    while (Date.now() - startTime < MAX_PANEL_WAIT) {
      const currentName = extractName();
      const currentUrl  = window.location.href;
      const isPlaceUrl  = currentUrl.includes('/maps/place/') || currentUrl.includes('/place/');

      if (currentName && !isGenericHeader(currentName)) {
        if (lastPanelUrl && currentUrl !== lastPanelUrl && isPlaceUrl) {
          lastPanelUrl = currentUrl;
          return true;
        }
        if (previousPanelName === '' || currentName !== previousPanelName) {
          if (isPlaceUrl) lastPanelUrl = currentUrl;
          return true;
        }
        if (
          expectedCardName &&
          currentName.toLowerCase().includes(expectedCardName.toLowerCase().slice(0, 15))
        ) {
          if (isPlaceUrl) lastPanelUrl = currentUrl;
          return true;
        }
      }
      await wait(180);
    }
    return false;
  }

  // ── Wait until phone appears in the detail panel (up to PHONE_WAIT ms) ────────
  async function waitForPhone() {
    const start = Date.now();
    while (Date.now() - start < PHONE_WAIT) {
      const phone = extractPhone();
      if (phone) return phone;
      await wait(250);
    }
    return extractPhone();
  }

  // ── Get unique result cards from feed ───────────────────────────────────────
  function getResultCards() {
    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div[aria-label*="Results"]') ||
                 document.querySelector('div.m6QErb[aria-label]');

    let rawElements = [];

    if (feed) {
      rawElements = Array.from(feed.querySelectorAll('div.Nv2pk, div[role="article"], div.THOPZb'));
      if (rawElements.length === 0) {
        const links = Array.from(feed.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"]'));
        const containerSet = new Set();
        links.forEach(a => {
          const parent = a.closest('div.Nv2pk') || a.closest('div[role="article"]') || a.closest('div[jsaction]') || a.parentElement;
          if (parent) containerSet.add(parent);
        });
        rawElements = Array.from(containerSet);
      }
    } else {
      const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"]'));
      const containerSet = new Set();
      links.forEach(a => {
        const parent = a.closest('div.Nv2pk') || a.closest('div[role="article"]') || a.parentElement;
        if (parent) containerSet.add(parent);
      });
      rawElements = Array.from(containerSet);
    }

    const uniqueMap = new Map();
    for (const card of rawElements) {
      const cardData   = extractFromCard(card);
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

  function getClickableElement(card) {
    return card.querySelector('a.hfA8B') ||
           card.querySelector('a[href*="/maps/place/"]') ||
           card.querySelector('a[href*="/place/"]') ||
           card.querySelector('div.qBF1Pd') ||
           card;
  }

  // ── Extract pre-click information directly from Card element ────────────────
  function extractFromCard(card) {
    let name    = '';
    let link    = '';
    let phone   = '';
    let address = '';

    // Card Name
    const nameEl = card.querySelector('div.qBF1Pd, div.fontHeadlineSmall, [class*="headlineSmall"]');
    if (nameEl?.textContent?.trim()) {
      name = nameEl.textContent.trim();
    } else {
      const linkEl = card.querySelector('a.hfA8B, a[href*="/maps/place/"], a[href*="/place/"]');
      if (linkEl) {
        const aria = linkEl.getAttribute('aria-label');
        if (aria) name = aria.trim();
      }
    }

    // Card direct website link
    const cardWebBtn = card.querySelector('a[data-value="Website"], a[aria-label*="website" i]');
    if (cardWebBtn?.href && isExternalLink(cardWebBtn.href)) {
      link = cardWebBtn.href;
    }

    // Card phone link or visible phone text
    const telEl = card.querySelector('a[href^="tel:"]');
    if (telEl) {
      const raw = telEl.href.replace(/^tel:/i, '').trim();
      const norm = normalizePhone(raw);
      if (norm) phone = formatPhone(raw);
    }

    // Scan card text spans for phone and address info
    const textSpans = card.querySelectorAll('div.W4Efsd span, div.UsdlK');
    textSpans.forEach(span => {
      const txt = span.textContent?.trim() || '';
      if (!phone && isValidPhone(txt)) {
        phone = formatPhone(txt);
      }
      if (!address && txt.length > 5 && !isValidPhone(txt) && !txt.includes('★') && !txt.includes('Open') && !txt.includes('Closed')) {
        address = txt;
      }
    });

    return { name, link, phone, address };
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

  // ── Extract full data from detail panel ─────────────────────────────────────
  async function extractData(profileUrl, cardData) {
    let name = extractName();
    if (!name || isGenericHeader(name)) {
      name = cardData.name;
    }

    if (!name || isGenericHeader(name)) {
      return null;
    }

    const link = extractLink() || cardData.link || null;

    // Wait for phone to appear in panel (panel loads async)
    let phone = await waitForPhone();
    let rawPhone = phone;

    if (!phone && cardData.phone) {
      phone = cardData.phone;
      rawPhone = cardData.phone;
    }

    // Profile URL extraction:
    let canonicalProfileUrl = profileUrl;

    if (!canonicalProfileUrl || !canonicalProfileUrl.includes('/maps/place/')) {
      const startPoll = Date.now();
      while (Date.now() - startPoll < 1000) {
        if (window.location.href.includes('/maps/place/') || window.location.href.includes('/place/')) {
          canonicalProfileUrl = normalizeGoogleMapsUrl(window.location.href, window.location.origin);
          break;
        }
        await wait(150);
      }
    }

    // Canonical tag in DOM
    if (!canonicalProfileUrl) {
      const canonTag = document.querySelector('link[rel="canonical"]');
      if (canonTag?.href && (canonTag.href.includes('/maps/place/') || canonTag.href.includes('/place/'))) {
        canonicalProfileUrl = normalizeGoogleMapsUrl(canonTag.href, window.location.origin);
      }
    }

    // Share button in detail panel
    if (!canonicalProfileUrl) {
      const shareBtn = document.querySelector('button[data-item-id="share"], button[aria-label*="Share" i]');
      if (shareBtn) {
        const shareDataUrl = shareBtn.getAttribute('data-url') || shareBtn.getAttribute('data-href');
        if (shareDataUrl) {
          canonicalProfileUrl = normalizeGoogleMapsUrl(shareDataUrl, window.location.origin);
        }
      }
    }

    const placeId = canonicalProfileUrl ? extractPlaceId(canonicalProfileUrl) : (cardData.placeId || null);
    const cid     = canonicalProfileUrl ? extractCid(canonicalProfileUrl) : (cardData.cid || null);

    return {
      name,
      phone:      phone ? formatPhone(phone) : null,
      rawPhone:   rawPhone || null,
      link,
      profileUrl: canonicalProfileUrl || null,
      address:    cardData.address || null,
      placeId,
      cid,
    };
  }

  // ── Extract phone from detail panel ─────────────────────────────────────────
  function extractPhone() {
    // 1. Check data-item-id buttons
    const itemIdButtons = document.querySelectorAll('button[data-item-id^="phone:tel:"], button[data-item-id^="phone:"]');
    for (const btn of itemIdButtons) {
      const raw = btn.getAttribute('data-item-id').replace(/^phone:tel:/i, '').replace(/^phone:/i, '').trim();
      const norm = normalizePhone(raw);
      if (norm) return formatPhone(raw);
    }

    // 2. Check aria-label buttons
    const phoneButtons = document.querySelectorAll(
      'button[aria-label*="phone" i], button[aria-label*="teléfono" i], button[aria-label*="téléphone" i], button[aria-label*="telefon" i], button[aria-label*="call" i]'
    );
    for (const btn of phoneButtons) {
      const aria = btn.getAttribute('aria-label') || '';
      const cleaned = aria.replace(/^(?:Phone|Teléfono|Téléphone|Telefon|Call):\s*/i, '').trim();
      const norm = normalizePhone(cleaned);
      if (norm) return formatPhone(cleaned);
    }

    // 3. Check tel: links
    const telLinks = document.querySelectorAll('a[href^="tel:"]');
    for (const a of telLinks) {
      const raw = decodeURIComponent(a.href.replace(/^tel:/i, '')).trim();
      const norm = normalizePhone(raw);
      if (norm) return formatPhone(raw);
    }

    // 4. Check Google Maps phone container classes
    const phoneContainers = document.querySelectorAll(
      '[data-item-id*="phone"] .Io6YTe, [data-item-id*="phone"] div.fontBodyMedium'
    );
    for (const el of phoneContainers) {
      const txt = el.textContent?.trim() || '';
      const norm = normalizePhone(txt);
      if (norm) return formatPhone(txt);
    }

    // 5. Scan info sections in detail panel
    const panel = document.querySelector('div[role="main"]') || document.body;
    const infoSections = panel.querySelectorAll('div.rogA2c, div.LBgpqf, div[class*="section"]');
    for (const sec of infoSections) {
      const txt = sec.textContent || '';
      const match = txt.match(/(\+?[0-9][0-9\s\-().]{6,20}[0-9])/);
      if (match) {
        const norm = normalizePhone(match[1]);
        if (norm) return formatPhone(match[1]);
      }
    }

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
        log(`[External Contact Success] Discovered phone for "${name}": ${resp.phone} (source: ${resp.source || 'external'})`);
        return { formatted: formatPhone(resp.phone), raw: resp.rawPhone || resp.phone };
      }
    } catch (err) {
      logWarning(`[External Contact Exception] ${err.message}`);
    }
    return null;
  }

  function isGenericHeader(name) {
    if (!name) return true;
    const lower = name.toLowerCase().trim();
    return (
      lower === 'results' ||
      lower === 'search results' ||
      lower.startsWith('results for') ||
      lower === 'google maps'
    );
  }

  function extractName() {
    const selectors = [
      'h1.DUwDvf',
      'h1.fontHeadlineLarge',
      'h1[class*="DUwDvf"]',
      'div[role="main"] h1',
      'div.m6QErb h1',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const txt = el.textContent?.trim();
        if (txt && !isGenericHeader(txt)) {
          return txt;
        }
      }
    }
    return null;
  }

  function extractLink() {
    const websiteSelectors = [
      'a[data-item-id="authority"]',
      'a[aria-label*="website" i]',
      'a[data-tooltip*="website" i]',
      'a[data-value="Website"]',
      'a[jsaction*="authority"]',
      'button[data-item-id="authority"]',
      'div[data-item-id="authority"] a',
    ];

    for (const sel of websiteSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const href = el.href || el.getAttribute('data-url') || el.getAttribute('data-href') || '';
      if (href && isExternalLink(href)) return href;
    }

    const mainPanel = document.querySelector('div[role="main"]');
    if (mainPanel) {
      const links = mainPanel.querySelectorAll('a[href^="http"], a[href^="https"]');
      for (const a of links) {
        if (isExternalLink(a.href)) return a.href;
      }
    }

    return findSocialLink();
  }

  function findSocialLink() {
    const social = [
      'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
      'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com',
      'whatsapp.com', 'wa.me', 'linktr.ee', 'bio.link', 'beacons.ai',
    ];
    const all = document.querySelectorAll('a[href^="http"]');
    for (const a of all) {
      if (social.some(d => a.href.includes(d))) return a.href;
    }
    return null;
  }

  // ── Scroll results feed ────────────────────────────────────────────────────
  async function scrollFeedDown() {
    if (isScrolling) return;
    isScrolling = true;

    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div.m6QErb[aria-label]') ||
                 document.querySelector('div[aria-label*="Results"]');

    if (feed) {
      feed.scrollBy({ top: 900, behavior: 'smooth' });
      await wait(400);

      const cards = feed.querySelectorAll('div.Nv2pk, div[role="article"], a[href*="/maps/place/"], a[href*="/place/"]');
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

  function scrollCardIntoView(card) {
    try {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (_) {}
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

      // Also register all identifiers of existing saved results
      const results = data['scrape_results'] || [];
      results.forEach(r => {
        inMemoryRegistry.push(r);
        registerIdentifiers(r);
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
    console.warn(`%c[MapsLead Warning] ${msg}`, 'color:#f59e0b;font-weight:bold');
  }

  function notifyBadge(count) {
    try { chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count }); } catch (_) {}
  }

})();
