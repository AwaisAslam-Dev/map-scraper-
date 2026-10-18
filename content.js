/**
 * content.js — Google Maps Lead Scraper
 *
 * Scrapes Google Maps search results with rich details sequentially:
 * - Ensures 1-by-1 exact crawling without skipping leads or duplicating stale panel info
 * - Verifies detail panel UI updates before extracting details
 * - Preserves unique place URLs for distinct locations
 */

(function () {
  'use strict';

  // ── Guard: prevent double-injection ────────────────────────────────────────
  // Allow re-injection but reset state cleanly so a fresh Start always works
  if (window.__mapsLeadRunning === true) {
    // Already actively running — do nothing
    return;
  }
  window.__mapsLeadRunning = false;

  // ── State ───────────────────────────────────────────────────────────────────
  let isRunning     = false;
  let scraped       = [];
  let processedSet  = new Set();   // tracks keys processed THIS session only
  let lastPanelName = '';
  let lastPanelUrl  = '';          // tracks last panel URL for stronger dedup

  const SAVE_EVERY     = 5;     // save to background every N items
  const MAX_PANEL_WAIT = 5000; // max ms to wait for detail panel to change to new business
  const PHONE_WAIT     = 3000; // extra ms to wait for phone number to appear in panel
  const SCROLL_WAIT    = 1500; // ms after scrolling feed
  const MAX_NO_NEW     = 8;    // max consecutive no-new-cards scrolls before stopping

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

    // Reset session state so a fresh Start always re-processes visible cards
    processedSet  = new Set();
    lastPanelName = '';
    lastPanelUrl  = '';
    scraped       = [];

    log('Scraper started (sequential 1-by-1 mode).');

    await loadSeenUrls();

    let totalThis  = 0;
    let noNewCount = 0;

    while (isRunning) {
      const cards = getResultCards();
      log(`Found ${cards.length} unique cards in feed.`);

      if (cards.length === 0) {
        log('No cards found — make sure you are on a Google Maps search results page.');
        break;
      }

      let processedThisRound = 0;

      for (let i = 0; i < cards.length && isRunning; i++) {
        const { card, profileUrl, cardData, dedupKey } = cards[i];

        if (processedSet.has(dedupKey)) continue;

        processedSet.add(dedupKey);
        processedThisRound++;

        // 1. Scroll card into view
        scrollCardIntoView(card);
        await wait(300);

        // 2. Click title/card
        const clickable = getClickableElement(card);
        if (clickable) {
          try { clickable.click(); } catch (_) { card.click(); }
        } else {
          card.click();
        }

        // 3. Synchronize: Wait until detail panel updates from last business
        const panelUpdated = await waitForPanelUpdate(cardData.name, lastPanelName);

        let item = null;
        if (panelUpdated) {
          // Panel updated! Extract full details (phone waits for async load)
          item = await extractData(profileUrl, cardData);
          if (item && item.name) {
            lastPanelName = item.name;
          }
        } else {
          // Detail panel did not update in time — fallback to feed card data to avoid duplicate stale info
          log(`Panel update timed out for "${cardData.name}". Using feed card data.`);
          if (cardData.name && !isGenericHeader(cardData.name)) {
            item = {
              name:       cardData.name,
              phone:      cardData.phone || null,
              link:       cardData.link || null,
              profileUrl: profileUrl || window.location.href,
            };
          }
        }

        if (item && item.name && !isGenericHeader(item.name)) {
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
            log(`[${totalThis}] ${item.name} | Phone: ${item.phone || 'N/A'} | Site: ${item.link || 'No website'} | Profile: ${item.profileUrl || 'N/A'}`);
            notifyBadge(totalThis);
          }
        }

        // Save periodically
        if (scraped.length >= SAVE_EVERY) {
          await sendBatch();
        }

        // Pace execution to allow UI stability
        await wait(600);
      }

      if (processedThisRound === 0) {
        noNewCount++;
        log(`No new cards processed in this view (${noNewCount}/${MAX_NO_NEW}). Scrolling feed...`);
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
    log(`Scraping finished. Total leads saved this run: ${totalThis}`);

    try {
      chrome.runtime.sendMessage({ type: 'SCRAPE_DONE', total: totalThis });
    } catch (_) {}
  }

  // ── Wait until phone appears in the detail panel (up to PHONE_WAIT ms) ────────
  async function waitForPhone() {
    const start = Date.now();
    while (Date.now() - start < PHONE_WAIT) {
      const phone = extractPhone();
      if (phone) return phone;
      await wait(250);
    }
    return extractPhone(); // final attempt
  }
  async function waitForPanelUpdate(expectedCardName, previousPanelName) {
    const startTime = Date.now();
    while (Date.now() - startTime < MAX_PANEL_WAIT) {
      const currentName = extractName();
      const currentUrl  = window.location.href;

      if (currentName && !isGenericHeader(currentName)) {
        // URL changed → definitely a new panel
        if (lastPanelUrl && currentUrl !== lastPanelUrl) {
          lastPanelUrl = currentUrl;
          return true;
        }
        // Name changed from previous panel → panel updated
        if (previousPanelName === '' || currentName !== previousPanelName) {
          lastPanelUrl = currentUrl;
          return true;
        }
        // Name matches what we clicked → correct panel loaded
        if (
          expectedCardName &&
          currentName.toLowerCase().includes(expectedCardName.toLowerCase().slice(0, 15))
        ) {
          lastPanelUrl = currentUrl;
          return true;
        }
      }
      await wait(200);
    }
    return false;
  }

  // ── Get unique result cards from feed ───────────────────────────────────────
  function getResultCards() {
    const feed = document.querySelector('div[role="feed"]') || document.querySelector('div[aria-label*="Results"]');
    let rawElements = [];

    if (feed) {
      rawElements = Array.from(feed.querySelectorAll('div.Nv2pk, div[role="article"]'));
      if (rawElements.length === 0) {
        const links = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
        const containerSet = new Set();
        links.forEach(a => {
          const parent = a.closest('div.Nv2pk') || a.closest('div[role="article"]') || a.closest('div[jsaction]') || a.parentElement;
          if (parent) containerSet.add(parent);
        });
        rawElements = Array.from(containerSet);
      }
    } else {
      const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      const containerSet = new Set();
      links.forEach(a => {
        const parent = a.closest('div.Nv2pk') || a.closest('div[role="article"]') || a.parentElement;
        if (parent) containerSet.add(parent);
      });
      rawElements = Array.from(containerSet);
    }

    // Deduplicate cards by unique key (profileUrl preferred; fallback to name+address combo)
    const uniqueMap = new Map();
    for (const card of rawElements) {
      const cardData   = extractFromCard(card);
      const profileUrl = getProfileUrl(card);

      // Use profileUrl as primary key — it contains coordinates so same-name
      // businesses at different locations get distinct keys
      let dedupKey;
      if (profileUrl) {
        dedupKey = profileUrl.toLowerCase();
      } else if (cardData.name) {
        // Fallback: combine name + any address text visible on card to avoid
        // collapsing two distinct businesses that share a name
        const addrEl = card.querySelector('div.W4Efsd span:nth-child(2), div.UsdlK');
        const addr   = addrEl?.textContent?.trim() || '';
        dedupKey     = (cardData.name + '|' + addr).toLowerCase();
      } else {
        continue; // no usable key — skip
      }

      if (!uniqueMap.has(dedupKey)) {
        uniqueMap.set(dedupKey, { card, profileUrl, cardData, dedupKey });
      }
    }

    return Array.from(uniqueMap.values());
  }

  function getClickableElement(card) {
    return card.querySelector('a.hfA8B') || 
           card.querySelector('a[href*="/maps/place/"]') || 
           card.querySelector('div.qBF1Pd') || 
           card;
  }

  // ── Extract pre-click information directly from Card element ────────────────
  function extractFromCard(card) {
    let name = '';
    let link = '';
    let phone = '';

    // Card Name
    const nameEl = card.querySelector('div.qBF1Pd, div.fontHeadlineSmall, [class*="headlineSmall"]');
    if (nameEl?.textContent?.trim()) {
      name = nameEl.textContent.trim();
    } else {
      const linkEl = card.querySelector('a[href*="/maps/place/"]');
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

    // Card phone link (if available)
    const telEl = card.querySelector('a[href^="tel:"]');
    if (telEl) {
      phone = telEl.href.replace('tel:', '').trim();
    }

    return { name, link, phone };
  }

  // ── Get Profile URL ────────────────────────────────────────────────────────
  function getProfileUrl(card) {
    try {
      if (card.tagName === 'A' && card.href?.includes('/maps/place/')) {
        return cleanUrl(card.href);
      }
      const a = card.querySelector('a[href*="/maps/place/"]');
      if (a?.href) return cleanUrl(a.href);
    } catch (_) {}
    return null;
  }

  function cleanUrl(href) {
    try {
      // Retain path + coordinates/place id to distinguish distinct locations
      const url = new URL(href);
      return url.origin + url.pathname;
    } catch (_) {
      return href.split('?')[0];
    }
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

    // Wait for phone to appear — panel loads it async
    const phone = await waitForPhone() || cardData.phone || null;

    // Current page URL if profileUrl not on card
    const currentUrl = window.location.href.includes('/maps/place/') ? cleanUrl(window.location.href) : profileUrl;

    return {
      name,
      phone,
      link,
      profileUrl: currentUrl || profileUrl,
    };
  }

  function extractPhone() {
    // All known selectors Google Maps uses for phone buttons/links
    const selectors = [
      'button[data-item-id^="phone:tel:"]',
      'button[data-item-id^="phone:"]',
      'button[data-item-id^="phone"]',
      'button[aria-label^="Phone:"]',
      'button[aria-label*="phone" i]',
      'button[data-tooltip*="Phone" i]',
      'a[href^="tel:"]',
      '[data-item-id*="phone"] .Io6YTe',
      '[data-item-id*="phone"] div.fontBodyMedium',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // Try aria-label first (most reliable)
        const aria = el.getAttribute('aria-label') || '';
        const ariaClean = aria.replace(/Phone:\s*/i, '').trim();
        if (ariaClean && isValidPhone(ariaClean)) return ariaClean;

        // Try href tel: link
        if (el.href && el.href.startsWith('tel:')) {
          const tel = decodeURIComponent(el.href.replace('tel:', '').trim());
          if (isValidPhone(tel)) return tel;
        }

        // Try visible text inside element
        const textEl = el.querySelector('div.Io6YTe, div.fontBodyMedium, span') || el;
        const txt = textEl.textContent?.trim() || '';
        const cleaned = txt.replace(/Phone:\s*/i, '').trim();
        if (cleaned && isValidPhone(cleaned)) return cleaned;
      }
    }

    // Broader fallback: scan the entire detail panel for a phone-like pattern
    const panel = document.querySelector('div[role="main"]') || document.body;
    // Look specifically inside info sections
    const infoSections = panel.querySelectorAll('div.rogA2c, div.LBgpqf, div[class*="section"]');
    for (const section of infoSections) {
      const text = section.textContent || '';
      const match = text.match(/(\+?[\d][\d\s\-\(\)\.]{6,20}[\d])/);
      if (match && isValidPhone(match[1])) return match[1].trim();
    }

    // Last resort: full panel text scan
    const fullText = panel.innerText || panel.textContent || '';
    const match = fullText.match(/(\+?[\d][\d\s\-\(\)\.]{6,20}[\d])/);
    if (match && isValidPhone(match[1])) return match[1].trim();

    return null;
  }

  // Validates a phone string: must have at least 7 digits
  function isValidPhone(str) {
    if (!str) return false;
    const digits = str.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
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

  function isExternalLink(href) {
    if (!href) return false;
    const lower = href.toLowerCase();
    return (
      lower.startsWith('http') &&
      !lower.includes('google.com') &&
      !lower.includes('googleusercontent') &&
      !lower.includes('maps.app') &&
      !lower.includes('goo.gl') &&
      !lower.includes('gstatic.com')
    );
  }

  function findSocialLink() {
    const social = [
      'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
      'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com',
      'whatsapp.com', 'wa.me',
    ];
    const all = document.querySelectorAll('a[href^="http"]');
    for (const a of all) {
      if (social.some(d => a.href.includes(d))) return a.href;
    }
    return null;
  }

  // ── Scroll results feed ────────────────────────────────────────────────────
  async function scrollFeedDown() {
    const feed = document.querySelector('div[role="feed"]') || 
                 document.querySelector('div.m6QErb[aria-label]') || 
                 document.querySelector('div[aria-label*="Results"]');

    if (feed) {
      feed.scrollBy({ top: 900, behavior: 'smooth' });
      await wait(400);

      const cards = feed.querySelectorAll('div.Nv2pk, div[role="article"], a[href*="/maps/place/"]');
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
      log(`Saved batch: +${result.added} new, ${result.duplicates} dupes. Total: ${result.total}`);
    } catch (err) {
      log('Save error: ' + err.message);
      scraped = [...toSend, ...scraped];
    }
  }

  // ── Load seen URLs/keys from storage ────────────────────────────────────────
  async function loadSeenUrls() {
    try {
      const data = await chrome.storage.local.get('scrape_seen_urls');
      const arr  = data['scrape_seen_urls'] || [];
      arr.forEach(u => processedSet.add(u));
      log(`Loaded ${arr.length} previously scraped items into seen set.`);
    } catch (_) {}
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function log(msg) {
    console.log(`%c[MapsLead] ${msg}`, 'color:#1a73e8;font-weight:bold');
  }

  function notifyBadge(count) {
    try { chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count }); } catch (_) {}
  }

})();
