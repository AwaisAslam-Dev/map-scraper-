/**
 * utils.js — Maps Lead Scraper Shared Utilities & Centralized Deduplication Engine
 *
 * Implements strict, platform-aware deduplication and business identity resolution:
 * 1. Google Maps Place ID (highest priority)
 * 2. Verified Google Maps entity ID or CID
 * 3. Normalized canonical Google Maps business profile URL
 * 4. Normalized combination of business name, phone number, and address (fallback)
 *
 * Strict validation layer:
 * - Phone numbers: strictly validated digits and international formats (Saudi & global);
 *   listing texts, ratings, categories, addresses, and hours are never accepted as phone numbers.
 * - Websites: official external HTTP/HTTPS destination URLs only;
 *   social links (Instagram, Snapchat, etc.) are captured separately from primary websites;
 *   internal Google Maps URLs are never treated as business websites.
 *
 * Compatible with Node.js, Service Workers (importScripts), and Content Scripts.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MapsScraperUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Convert Arabic-Indic digits (٠-٩) and Eastern Arabic/Persian digits (۰-۹) to standard ASCII digits (0-9).
   * Also strips Unicode directional control marks (LTR/RTL marks).
   */
  function convertArabicIndicDigits(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ')
      .replace(/[٠۰]/g, '0')
      .replace(/[١۱]/g, '1')
      .replace(/[٢۲]/g, '2')
      .replace(/[٣۳]/g, '3')
      .replace(/[٤۴]/g, '4')
      .replace(/[٥۵]/g, '5')
      .replace(/[٦۶]/g, '6')
      .replace(/[٧۷]/g, '7')
      .replace(/[٨۸]/g, '8')
      .replace(/[٩۹]/g, '9');
  }

  /**
   * Strict phone normalization function:
   * - Converts Arabic-Indic and Persian digits to ASCII.
   * - Strips telephone label prefixes (e.g. "Phone:", "الهاتف:").
   * - Strictly REJECTS any string containing letters (Arabic or English), listing text,
   *   business names, addresses, ratings, categories, operating hours, currency, or symbols.
   * - Canonicalizes Saudi numbers:
   *   05XXXXXXXX (10 digits)   -> +9665XXXXXXXX
   *   9665XXXXXXXX (12 digits) -> +9665XXXXXXXX
   *   01XXXXXXXX (10 digits)   -> +9661XXXXXXXX
   *   9661XXXXXXXX (12 digits) -> +9661XXXXXXXX
   * - Validates standard E.164 pure digit lengths (7 to 15 digits).
   * - Returns normalized phone string (e.g. "+9665XXXXXXXX") or "" if invalid.
   */
  function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const cleanStr = convertArabicIndicDigits(phone).trim();
    if (!cleanStr) return '';

    // Strip known telephone label prefixes before validating
    const unlabelled = cleanStr
      .replace(/^(?:Phone|Teléfono|Téléphone|Telefon|Call|Tel|Mobile|الهاتف|اتصال|اتصل|رقم الهاتف|رقم الاتصال|جوال|هاتف):\s*/i, '')
      .trim();

    // 1. Length check: Phone number string is strictly between 7 and 30 characters
    if (unlabelled.length < 7 || unlabelled.length > 30) return '';

    // 2. Reject strings containing letters (English or Arabic)
    // Real phone numbers contain NO Latin or Arabic alphabetic characters
    if (/[\u0600-\u06FFa-zA-Z]/.test(unlabelled)) return '';

    // 3. Reject strings containing forbidden listing/address symbols
    // Symbols like rating stars, bullets, currency, coordinates, brackets
    if (/[·★✨@%$€£=_{}\[\]<>,;?!~`#^&*"']/.test(unlabelled)) return '';

    // 4. Reject strings containing time-like colons or date formats
    if (unlabelled.includes(':') || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(unlabelled)) return '';

    // 5. Structure check: Must consist strictly of an optional leading +, followed by digits and valid separators
    if (!/^\+?[\d\s\-()./]{7,30}$/.test(unlabelled)) return '';

    const digitsWithPlus = unlabelled.replace(/[^\d+]/g, '');
    const pureDigits = digitsWithPlus.replace(/\D/g, '');

    // Standard ITU E.164 phone numbers have 7 to 15 digits
    if (pureDigits.length < 7 || pureDigits.length > 15) return '';
    // Reject repeating dummy digits like 0000000 or 9999999999
    if (/^(\d)\1+$/.test(pureDigits)) return '';

    // Saudi Arabia phone canonicalization:
    // Saudi mobile 05XXXXXXXX (10 digits) -> +9665XXXXXXXX
    if (pureDigits.length === 10 && pureDigits.startsWith('05')) {
      return `+966${pureDigits.slice(1)}`;
    }
    // Saudi mobile 9665XXXXXXXX (12 digits) -> +9665XXXXXXXX
    if (pureDigits.length === 12 && pureDigits.startsWith('9665')) {
      return `+${pureDigits}`;
    }
    // Saudi landline 01XXXXXXXX (10 digits) -> +9661XXXXXXXX
    if (pureDigits.length === 10 && pureDigits.startsWith('01')) {
      return `+966${pureDigits.slice(1)}`;
    }
    // Saudi landline 9661XXXXXXXX (12 digits) -> +9661XXXXXXXX
    if (pureDigits.length === 12 && pureDigits.startsWith('9661')) {
      return `+${pureDigits}`;
    }

    return digitsWithPlus.startsWith('+') ? `+${pureDigits}` : pureDigits;
  }

  /**
   * Check if a raw string is a valid phone candidate.
   */
  function isValidPhone(str) {
    return normalizePhone(str).length >= 7;
  }

  /**
   * Format phone number nicely for display/export while preserving valid digits.
   * Formats Saudi mobile numbers as +966 5X XXX XXXX.
   * If the input is not a strictly valid phone number, returns empty string ("").
   */
  function formatPhone(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') return '';
    const norm = normalizePhone(rawPhone);
    // If not a strictly valid phone number according to normalizePhone, return empty string!
    if (!norm) return '';

    const digits = norm.replace(/\D/g, '');

    // Format Saudi mobile nicely: +966 5X XXX XXXX
    if (digits.length === 12 && digits.startsWith('9665')) {
      return `+966 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    }

    // Format Saudi landline nicely: +966 1X XXX XXXX
    if (digits.length === 12 && digits.startsWith('9661')) {
      return `+966 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    }

    // Preserve clean existing human spacing if present (e.g. "+971 4 123 4567")
    const cleanRaw = convertArabicIndicDigits(rawPhone).trim()
      .replace(/^(?:Phone|Teléfono|Téléphone|Telefon|Call|Tel|Mobile|الهاتف|اتصال|اتصل|رقم الهاتف|رقم الاتصال|جوال|هاتف):\s*/i, '')
      .trim();
    if (/[ \-()]/.test(cleanRaw)) {
      return cleanRaw.replace(/\s+/g, ' ').replace(/-+/g, '-').trim();
    }

    // Format US/North America nicely: (XXX) XXX-XXXX
    if (digits.length === 10 && !norm.startsWith('+')) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }

    return norm;
  }

  /**
   * Extract strictly verified business phone number from a container (card or detail panel).
   * Examines ONLY explicit phone attributes, tel: links, dedicated phone buttons,
   * or isolated leaf spans matching phone patterns.
   * NEVER returns arbitrary card text, names, ratings, or hours.
   */
  function extractPhoneNumber(container) {
    if (!container || !container.querySelectorAll) return { phone: '', rawPhone: '', normPhone: '' };

    function checkCandidate(str) {
      if (!str || typeof str !== 'string') return null;
      const clean = convertArabicIndicDigits(str).trim();
      const norm = normalizePhone(clean);
      if (norm) {
        return { phone: formatPhone(clean), rawPhone: clean, normPhone: norm };
      }
      return null;
    }

    // ── Step 1: data-item-id on ANY ancestor element (not just buttons) ───────
    // Google Maps sets data-item-id on a wrapping div/button, not always on the
    // element with the visible text. Check the element itself AND its children.
    const itemIdRoots = container.querySelectorAll(
      '[data-item-id^="phone:tel:"], [data-item-id^="phone:"], [data-item-id*="phone"]'
    );
    for (const root of itemIdRoots) {
      // Priority: extract number directly from data-item-id attribute
      const dataId = root.getAttribute('data-item-id') || '';
      const fromAttr = dataId
        .replace(/^phone:tel:/i, '')
        .replace(/^phone:/i, '')
        .trim();
      const res = checkCandidate(fromAttr);
      if (res) return res;

      // Fallback: visible text inside the element (div.Io6YTe, div.fontBodyMedium, or raw text)
      const textEls = root.querySelectorAll('.Io6YTe, div.fontBodyMedium, span.fontBodyMedium');
      for (const t of textEls) {
        const r = checkCandidate(t.textContent?.trim());
        if (r) return r;
      }
      const r2 = checkCandidate(root.textContent?.trim());
      if (r2) return r2;
    }

    // ── Step 2: tel: links (most reliable when present) ───────────────────────
    const telLinks = container.querySelectorAll('a[href^="tel:"]');
    for (const a of telLinks) {
      const raw = decodeURIComponent(a.getAttribute('href').replace(/^tel:/i, '')).trim();
      const res = checkCandidate(raw);
      if (res) return res;
    }

    // ── Step 3: aria-label / data-tooltip on buttons & links ─────────────────
    // Google Maps uses aria-label="Phone: +966XXXXXXXXX" or "اتصل بـ..."
    const ariaEls = container.querySelectorAll(
      'button[aria-label*="phone" i], button[aria-label*="call" i],' +
      'button[aria-label*="هاتف" i], button[aria-label*="اتصال" i],' +
      'button[aria-label*="اتصل" i], button[aria-label*="رقم" i],' +
      '[aria-label*="Phone:" i], [aria-label*="الهاتف:" i],' +
      'button[data-tooltip*="phone" i], button[data-tooltip*="هاتف" i],' +
      'button[data-tooltip*="اتصال" i]'
    );
    for (const el of ariaEls) {
      // Strip label prefix e.g. "Phone: " or "اتصل بـ "
      const ariaRaw = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '')
        .replace(/^(?:Phone|Call|Tel|Mobile|هاتف|اتصال|اتصل\s*بـ?|رقم(?:\s*الهاتف)?)[\s:：\-]+/i, '')
        .trim();
      const res = checkCandidate(ariaRaw);
      if (res) return res;

      // Also try visible child text
      const inner = el.querySelector('.Io6YTe, div.fontBodyMedium, span') || el;
      const r2 = checkCandidate(inner.textContent?.trim());
      if (r2) return r2;
    }

    // ── Step 4: .rogA2c rows in detail panel (Google Maps info rows) ──────────
    // Each info row in the detail panel is a div.rogA2c containing icon + text.
    // Phone rows have a phone/call icon; the sibling div holds the number text.
    const infoRows = container.querySelectorAll('div.rogA2c');
    for (const row of infoRows) {
      // Look for phone icon hint: aria on img, or svg title, or icon class
      const hasPhoneHint = (
        row.querySelector('[aria-label*="phone" i], [aria-label*="call" i], [aria-label*="هاتف" i], [aria-label*="اتصال" i]') ||
        row.querySelector('img[src*="phone"], img[src*="call"]') ||
        row.innerHTML.toLowerCase().includes('phone') ||
        row.innerHTML.includes('هاتف') ||
        row.innerHTML.includes('اتصال')
      );
      if (!hasPhoneHint) continue;

      // Extract text from .Io6YTe or fontBodyMedium inside this row
      const textEls = row.querySelectorAll('.Io6YTe, div.fontBodyMedium, span.fontBodyMedium');
      for (const t of textEls) {
        const r = checkCandidate(t.textContent?.trim());
        if (r) return r;
      }
      // Fallback: full row text
      const r = checkCandidate(row.textContent?.trim());
      if (r) return r;
    }

    // ── Step 5: Feed card leaf spans (div.W4Efsd / div.UsdlK) ────────────────
    // In search result cards, phone sometimes appears as a bare span.
    const cardSpans = container.querySelectorAll('div.W4Efsd > span, div.UsdlK');
    for (const sp of cardSpans) {
      if (sp.children.length > 0) continue;
      const txt = sp.textContent?.trim() || '';
      // Must be digits-only span: 7–25 chars, no letters
      if (txt.length >= 7 && txt.length <= 25 && !/[\u0600-\u06FFa-zA-Z]/.test(txt)) {
        const res = checkCandidate(txt);
        if (res) return res;
      }
    }

    // ── Step 6: Broad scan of all .Io6YTe and fontBodyMedium in panel ─────────
    // Last resort: scan every info-text element and validate strictly
    const allTextEls = container.querySelectorAll('.Io6YTe, div.fontBodyMedium, span.fontBodyMedium');
    for (const el of allTextEls) {
      if (el.children.length > 0) continue; // leaf only
      const txt = el.textContent?.trim() || '';
      if (txt.length >= 7 && txt.length <= 25 && !/[\u0600-\u06FFa-zA-Z]/.test(txt)) {
        const res = checkCandidate(txt);
        if (res) return res;
      }
    }

    return { phone: '', rawPhone: '', normPhone: '' };
  }

  // Alias for backward compatibility
  const extractBusinessPhoneNumber = extractPhoneNumber;

  /**
   * Check if a URL belongs to a social media network or bio page.
   */
  function isSocialPlatformUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return [
      'instagram.com', 'snapchat.com', 'tiktok.com', 'facebook.com', 'fb.me', 'fb.com',
      'twitter.com', 'x.com', 'wa.me', 'whatsapp.com', 'linktr.ee', 'bio.link',
      'beacons.ai', 'taplink.cc', 'solo.to', 'carrd.co', 'instabio.cc', 'snipfeed.co',
      'linkedin.com', 'youtube.com', 'pinterest.com', 't.me', 'telegram.me'
    ].some(domain => lower.includes(domain));
  }

  /**
   * Unwraps Google redirect URLs (google.com/url?q=...) and validates external links.
   * Rejects internal Google Maps search, navigation, directions, and utility links.
   * Ensures valid HTTP/HTTPS protocol.
   */
  function cleanExternalUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let s = rawUrl.trim();
    if (!s) return null;

    // Unwrap Google redirect URL if present
    try {
      if (s.includes('/url?') || s.includes('google.com/url?')) {
        const parsed = new URL(s, 'https://www.google.com');
        const qParam = parsed.searchParams.get('q') || parsed.searchParams.get('url');
        if (qParam) s = decodeURIComponent(qParam).trim();
      }
    } catch (_) {}

    // Verify protocol or prepend https:// if bare domain
    if (!s.startsWith('http://') && !s.startsWith('https://')) {
      if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(s)) {
        s = `https://${s}`;
      } else {
        return null;
      }
    }

    try {
      const finalUrl = new URL(s);
      const host = finalUrl.hostname.toLowerCase();
      // Exclude internal Google navigation, search, maps, services
      if (
        host === 'google.com' ||
        host.endsWith('.google.com') ||
        host.includes('gstatic.') ||
        host.includes('googleusercontent.') ||
        host === 'goo.gl' ||
        host === 'maps.app.goo.gl' ||
        host.includes('waze.com')
      ) {
        return null;
      }

      // Must be http or https
      if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') {
        return null;
      }

      let clean = finalUrl.href;
      if (finalUrl.pathname === '/' && !finalUrl.search && !finalUrl.hash) {
        clean = `${finalUrl.protocol}//${finalUrl.host}`;
      }
      return clean;
    } catch {
      return null;
    }
  }

  /**
   * Extract official business website URL from container (card or detail panel).
   * Excludes social media links and internal Google Maps links.
   * Returns valid external URL string or "" if no official website exists.
   */
  function extractBusinessWebsite(container) {
    if (!container || !container.querySelectorAll) return '';

    // Helper: try every possible URL source on an element and return first valid external non-social URL
    function tryGetWebsite(el) {
      // Priority order of URL sources on a Google Maps link element
      const candidates = [
        el.getAttribute('data-url'),
        el.getAttribute('data-href'),
        el.getAttribute('href'),
        el.href,                           // browser-resolved absolute URL
      ];
      for (const raw of candidates) {
        if (!raw || raw === 'javascript:void(0)' || raw === '#' || raw.trim() === '') continue;
        const cleaned = cleanExternalUrl(raw);
        if (cleaned && !isSocialPlatformUrl(cleaned)) return cleaned;
      }
      return null;
    }

    // ── Stage 1: Explicit website button selectors ─────────────────────────
    // Google Maps uses several patterns depending on UI version:
    //   - a[data-item-id="authority"]          (classic detail panel)
    //   - a[data-value="Website"]              (newer panel variant)
    //   - a[aria-label*="website"]             (aria-label based)
    //   - div[data-item-id="authority"] a      (wrapped version)
    //   - a[jsaction*="pane.place"] with website text (newer Maps)
    //   - a[href*="/url?q="] inside rogA2c rows (redirect-wrapped external links)
    const webBtnSelectors = [
      'a[data-item-id="authority"]',
      'a[data-value="Website"]',
      'a[data-value*="موقع"]',
      'a[aria-label*="website" i]',
      'a[aria-label*="الموقع الإلكتروني" i]',
      'a[aria-label*="موقع الويب" i]',
      'a[data-tooltip*="website" i]',
      'a[data-tooltip*="Open website" i]',
      'a[data-tooltip*="الموقع الإلكتروني" i]',
      'a[data-tooltip*="موقع الويب" i]',
      'button[data-item-id="authority"] a',
      'div[data-item-id="authority"] a',
      '[data-item-id="authority"]',
      'a[jsaction*="authority"]',
    ];

    for (const sel of webBtnSelectors) {
      const els = container.querySelectorAll(sel);
      for (const el of els) {
        const url = tryGetWebsite(el);
        if (url) return url;
      }
    }

    // ── Stage 2: Google redirect links inside info rows (div.rogA2c) ─────────
    // In the detail panel every info row is div.rogA2c. Website rows contain an
    // outbound <a> whose href is the Google redirect URL /url?q=ACTUAL_SITE.
    // We scan these rows first before doing a broad pass to avoid picking up
    // random links (maps embed, share, etc.) that appear elsewhere in the panel.
    const infoRows = container.querySelectorAll('div.rogA2c, div.LBgpqf, div.CsEnBe');
    for (const row of infoRows) {
      const links = row.querySelectorAll('a[href]');
      for (const a of links) {
        const url = tryGetWebsite(a);
        if (url && !isSocialPlatformUrl(url)) return url;
      }
    }

    // ── Stage 3: Any Google redirect link in container ────────────────────────
    // Covers: a[href*="/url?q="] and a[href*="google.com/url"]
    const redirectLinks = container.querySelectorAll(
      'a[href*="/url?q="], a[href*="google.com/url"]'
    );
    for (const a of redirectLinks) {
      const url = tryGetWebsite(a);
      if (url && !isSocialPlatformUrl(url)) return url;
    }

    // ── Stage 4: Broad scan of all outbound http links ────────────────────────
    // Last resort — skip Google-internal and social platform links
    const allLinks = container.querySelectorAll('a[href^="http"], a[href^="/"]');
    for (const a of allLinks) {
      const url = tryGetWebsite(a);
      if (url && !isSocialPlatformUrl(url)) return url;
    }

    return '';
  }

  /**
   * Extract social media profile links from container (Instagram, Snapchat, TikTok, Facebook, etc.).
   */
  function extractBusinessSocialLinks(container) {
    if (!container || !container.querySelectorAll) return [];

    const socialLinks = [];
    const seen = new Set();

    // Try all URL sources on an element, unwrap Google redirects, then check if social
    function addSocial(el) {
      const candidates = [
        el.getAttribute ? el.getAttribute('data-url') : null,
        el.getAttribute ? el.getAttribute('data-href') : null,
        el.getAttribute ? el.getAttribute('href') : null,
        el.href || null,
      ];
      for (const raw of candidates) {
        if (!raw || raw === 'javascript:void(0)' || raw === '#' || raw.trim() === '') continue;
        const cleaned = cleanExternalUrl(raw);
        if (cleaned && isSocialPlatformUrl(cleaned) && !seen.has(cleaned.toLowerCase())) {
          seen.add(cleaned.toLowerCase());
          socialLinks.push(cleaned);
          return; // one entry per element
        }
      }
    }

    // ── Stage 1: Explicit social platform direct href selectors ──────────────
    // Matches when Google hasn't wrapped the URL in a redirect
    const directSocialEls = container.querySelectorAll(
      'a[href*="instagram.com"], a[href*="snapchat.com"], a[href*="tiktok.com"],' +
      'a[href*="facebook.com"], a[href*="fb.me"], a[href*="x.com"],' +
      'a[href*="twitter.com"], a[href*="wa.me"], a[href*="whatsapp.com"],' +
      'a[href*="linktr.ee"], a[href*="bio.link"], a[href*="beacons.ai"],' +
      'a[href*="taplink.cc"], a[href*="t.me"], a[href*="telegram.me"],' +
      'a[href*="linkedin.com"], a[href*="youtube.com"], a[href*="pinterest.com"]'
    );
    for (const el of directSocialEls) addSocial(el);

    // ── Stage 2: Social section containers ────────────────────────────────────
    const socialContainerEls = container.querySelectorAll(
      'div[data-item-id*="social"] a, div[aria-label*="Social" i] a,' +
      'div[data-item-id*="instagram"] a, div[data-item-id*="facebook"] a,' +
      'div[data-item-id*="twitter"] a, div[data-item-id*="tiktok"] a,' +
      'div[data-item-id*="snapchat"] a, div[data-item-id*="whatsapp"] a,' +
      'div[data-item-id*="linkedin"] a, div[data-item-id*="youtube"] a'
    );
    for (const el of socialContainerEls) addSocial(el);

    // ── Stage 3: Google redirect links that wrap social URLs ──────────────────
    // e.g. href="/url?q=https%3A%2F%2Finstagram.com%2F..."
    // The selector matches by redirect pattern; cleanExternalUrl() unwraps and
    // isSocialPlatformUrl() confirms it's a social link.
    const redirectLinks = container.querySelectorAll(
      'a[href*="/url?q="], a[href*="google.com/url"]'
    );
    for (const a of redirectLinks) addSocial(a);

    // ── Stage 4: info rows scan (div.rogA2c) ─────────────────────────────────
    // Catches social links placed in detail panel info rows
    const infoRows = container.querySelectorAll('div.rogA2c, div.LBgpqf, div.CsEnBe');
    for (const row of infoRows) {
      const links = row.querySelectorAll('a[href]');
      for (const a of links) addSocial(a);
    }

    // ── Stage 5: Broad fallback — all http links ──────────────────────────────
    const allLinks = container.querySelectorAll('a[href^="http"], a[href^="/"]');
    for (const a of allLinks) addSocial(a);

    return socialLinks;
  }

  /**
   * Combined link extractor for backward compatibility.
   */
  function extractBusinessLinks(container) {
    const website = extractBusinessWebsite(container);
    const socialLinks = extractBusinessSocialLinks(container);
    return { website: website || null, socialLinks };
  }

  /**
   * Platform-aware Google Maps URL normalizer:
   * - Resolves relative URLs to absolute.
   * - Normalizes protocol to https: and host to www.google.com.
   * - Strips tracking, session, language, UI parameters (entry, hl, authuser, ved, ei, g_ep, sa, utm_*).
   * - Removes hashes and trailing slashes.
   * - Rejects generic search and directions URLs without place IDs.
   * - Canonicalizes path coordinates to 3 decimals to avoid zoom/pan level divergences.
   */
  function normalizeGoogleMapsUrl(rawUrl, baseOrigin = 'https://www.google.com') {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';

    try {
      const parsed = new URL(trimmed, baseOrigin);

      // Only normalize recognized Google Maps URLs
      const isGoogle = parsed.hostname === 'google.com' || parsed.hostname.endsWith('.google.com');
      if (!isGoogle) {
        return trimmed;
      }

      parsed.protocol = 'https:';
      if (parsed.hostname === 'maps.google.com' || parsed.hostname === 'google.com') {
        parsed.hostname = 'www.google.com';
      }

      parsed.hash = '';

      // Strip ephemeral tracking and UI query parameters
      const trackingParams = [
        'entry', 'hl', 'authuser', 'ved', 'ei', 'g_ep', 'sa', 'oq', 'gs_l',
        'sca_esv', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'ref'
      ];
      trackingParams.forEach(p => parsed.searchParams.delete(p));

      // Reject generic search/directions URLs without identity parameter
      const path = parsed.pathname;
      const isSearch = path.includes('/maps/search') || path.startsWith('/search');
      const isDirections = path.includes('/maps/dir') || path.startsWith('/dir');
      const isTimeline = path.includes('/maps/timeline') || path.includes('/maps/reserve');

      const hasPlaceIdQuery = parsed.searchParams.has('query_place_id') ||
                              parsed.searchParams.has('cid') ||
                              parsed.searchParams.has('ftid') ||
                              (parsed.searchParams.has('q') && parsed.searchParams.get('q').startsWith('place_id:'));

      if ((isSearch && !hasPlaceIdQuery) || isDirections || isTimeline) {
        return '';
      }

      // Remove trailing slashes
      let cleanPath = parsed.pathname.replace(/\/+$/, '');

      // Normalize coordinate precision in path (round to 3 decimals ~100m) to avoid zoom level splits
      cleanPath = cleanPath.replace(/@(-?\d+\.\d{3})\d*,(-?\d+\.\d{3})\d*(?:,[0-9.]+z)?/, '@$1,$2');

      parsed.pathname = cleanPath;

      // Keep only identity-defining query parameters
      const essentialParams = ['cid', 'ftid', 'ludocid', 'query_place_id'];
      const cleanSearch = new URLSearchParams();
      essentialParams.forEach(p => {
        if (parsed.searchParams.has(p)) {
          cleanSearch.set(p, parsed.searchParams.get(p));
        }
      });
      if (parsed.searchParams.has('q') && parsed.searchParams.get('q').startsWith('place_id:')) {
        cleanSearch.set('q', parsed.searchParams.get('q'));
      }

      const qStr = cleanSearch.toString();
      return `https://${parsed.hostname}${cleanPath}${qStr ? '?' + qStr : ''}`;
    } catch {
      return trimmed;
    }
  }

  // Alias for backward compatibility
  const normalizeProfileUrl = normalizeGoogleMapsUrl;

  /**
   * Extract Google Maps Place ID from URL or string.
   */
  function extractPlaceId(url) {
    if (!url || typeof url !== 'string') return '';

    // 1. Google Hex CID feature pair (e.g. 0x3e5f4345c6480299:0x55194ec5a1ae072e)
    const hexPair = url.match(/(0x[0-9a-zA-Z_-]+:0x[0-9a-zA-Z_-]+)/);
    if (hexPair) return hexPair[1].toLowerCase();

    // 2. ChIJ Place ID
    const chij = url.match(/[?&]query_place_id=(ChIJ[A-Za-z0-9_-]{10,})/i) ||
                 url.match(/place_id:(ChIJ[A-Za-z0-9_-]{10,})/i) ||
                 url.match(/(ChIJ[A-Za-z0-9_-]{20,})/);
    if (chij) return chij[1];

    // 3. Google Maps data entity parameter: !1s... (ignoring search queries containing '+' or spaces)
    const s1Match = url.match(/!1s([^!/?&#]+)/);
    if (s1Match) {
      const val = s1Match[1];
      if (!val.includes('+') && !val.includes(' ') && !val.includes('%20')) {
        return val;
      }
    }

    return '';
  }

  /**
   * Extract CID or FTID from URL.
   */
  function extractCid(url) {
    if (!url || typeof url !== 'string') return '';

    const cidMatch = url.match(/[?&]cid=(\d+)/i) || url.match(/[?&]ludocid=(\d+)/i);
    if (cidMatch) return cidMatch[1];

    const ftidMatch = url.match(/[?&]ftid=([^&]+)/i);
    if (ftidMatch) return decodeURIComponent(ftidMatch[1]);

    return '';
  }

  /**
   * Generate stable unique business key based on strict hierarchy:
   * 1. Google Maps Place ID (place:<id>)
   * 2. Verified Google Maps entity ID or CID (cid:<id>)
   * 3. Normalized canonical Google Maps business profile URL (url:<url>)
   * 4. Normalized combination of business name, phone, and address (fallback)
   */
  function getBusinessUniqueKey(biz) {
    if (!biz) return '';

    const url = biz.profileUrl || biz.googleProfileUrl || biz.url || '';

    // Priority 1: Google Maps Place ID
    const placeId = biz.placeId || extractPlaceId(url);
    if (placeId) {
      return `place:${placeId.toLowerCase()}`;
    }

    // Priority 2: Verified Google Maps CID or FTID
    const cid = biz.cid || extractCid(url);
    if (cid) {
      return `cid:${cid.toLowerCase()}`;
    }

    // Priority 3: Normalized canonical Google Maps business profile URL
    const normUrl = normalizeGoogleMapsUrl(url);
    if (normUrl) {
      return `url:${normUrl.toLowerCase()}`;
    }

    // Priority 4: Normalized combination of business name, phone number, and address
    const cleanName = (biz.name || biz.businessName || '').trim().toLowerCase();
    const cleanPhone = normalizePhone(biz.phone || biz.rawPhone);
    const cleanAddr = (biz.address || '').trim().toLowerCase();

    if (cleanName && cleanPhone && cleanAddr) {
      return `name_phone_addr:${cleanName}|${cleanPhone}|${cleanAddr}`;
    }

    if (cleanName && cleanPhone) {
      return `name_phone:${cleanName}|${cleanPhone}`;
    }

    if (cleanName && cleanAddr) {
      return `name_addr:${cleanName}|${cleanAddr}`;
    }

    if (cleanName) {
      return `name_unverified:${cleanName}`;
    }

    return '';
  }

  // Alias for backward compatibility
  const generateProfileKey = getBusinessUniqueKey;

  // Common stop words and generic category/location terms in English and Arabic
  const STOP_WORDS = new Set([
    'salon', 'spa', 'beauty', 'salons', 'spas', 'center', 'centre', 'lounge', 'bar',
    'shop', 'store', 'services', 'service', 'company', 'co', 'inc', 'ltd', 'llc',
    'the', 'and', '&', 'of', 'for', 'in', 'at', 'by', 'club', 'studio', 'boutique',
    'hair', 'nails', 'nail', 'skin', 'care', 'clinic', 'wellness', 'cosmetics',
    'cafe', 'coffee', 'restaurant', 'hotel', 'motel', 'suites', 'resort',
    // Arabic common category and district/location words
    'الصالون', 'صالون', 'سبا', 'مركز', 'مشغل', 'للتزيين', 'النسائي', 'النسائية',
    'الرجالي', 'والسبا', 'بوتيك', 'لاونج', 'استوديو', 'خياطة', 'تجميل', 'للتجميل',
    'كافيه', 'مقهى', 'مطعم', 'فندق', 'شقق', 'مؤسسة', 'شركة',
    'حي', 'شارع', 'طريق', 'فرع', 'منطقة', 'تقاطع', 'مخرج'
  ]);

  /**
   * Split business name into clean tokens for comparative analysis.
   */
  function cleanBusinessTokens(name) {
    if (!name || typeof name !== 'string') return [];
    const cleaned = name
      .replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ')
      .toLowerCase()
      .replace(/[.\-—_–:،,/\\&|()[\]{}'"!؟?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned
      .split(' ')
      .map(t => t.trim())
      .filter(t => t.length >= 2);
  }

  /**
   * Determine whether two business names refer to the same entity.
   */
  function isCloseBusinessName(nameA, nameB) {
    if (!nameA || !nameB) return false;
    const a = nameA.replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ').trim().toLowerCase().replace(/\.{2,}$/, '').trim();
    const b = nameB.replace(/[\u200E\u200F\u202A-\u202E\uFEFF\u00A0]/g, ' ').trim().toLowerCase().replace(/\.{2,}$/, '').trim();

    if (a === b) return true;
    if (a.length >= 5 && b.startsWith(a)) return true;
    if (b.length >= 5 && a.startsWith(b)) return true;

    const tokensA = cleanBusinessTokens(nameA);
    const tokensB = cleanBusinessTokens(nameB);

    const distA = tokensA.filter(t => !STOP_WORDS.has(t));
    const distB = tokensB.filter(t => !STOP_WORDS.has(t));

    if (distA.length > 0 && distB.length > 0) {
      const bSet = new Set(distB);
      const aInB = distA.every(t => bSet.has(t) || distB.some(bt => bt.startsWith(t) || t.startsWith(bt)));
      if (aInB) return true;

      const aSet = new Set(distA);
      const bInA = distB.every(t => aSet.has(t) || distA.some(at => at.startsWith(t) || t.startsWith(at)));
      if (bInA) return true;

      const intersection = distA.filter(t => bSet.has(t));
      const union = new Set([...distA, ...distB]);
      const sim = intersection.length / union.size;
      if (sim >= 0.5) return true;
    } else if (distA.length === 0 && distB.length === 0) {
      const bSet = new Set(tokensB);
      const matchCount = tokensA.filter(t => bSet.has(t)).length;
      if (matchCount === tokensA.length && tokensA.length === tokensB.length) return true;
    }

    return false;
  }

  /**
   * Determine whether two business records represent the exact same entity.
   */
  function areBusinessesSame(bizA, bizB) {
    if (!bizA || !bizB) return false;

    // 1. Phone + Name Match (conclusive proof of same business)
    const phoneA = normalizePhone(bizA.phone || bizA.rawPhone);
    const phoneB = normalizePhone(bizB.phone || bizB.rawPhone);
    const nameA  = (bizA.name || bizA.businessName || '').trim();
    const nameB  = (bizB.name || bizB.businessName || '').trim();

    if (phoneA && phoneB && phoneA === phoneB && phoneA.length >= 7) {
      if (nameA && nameB && isCloseBusinessName(nameA, nameB)) {
        return true;
      }
    }

    // 2. Compare Place IDs if both have one
    const placeIdA = bizA.placeId || extractPlaceId(bizA.profileUrl || bizA.googleProfileUrl);
    const placeIdB = bizB.placeId || extractPlaceId(bizB.profileUrl || bizB.googleProfileUrl);
    if (placeIdA && placeIdB) {
      if (placeIdA.toLowerCase() === placeIdB.toLowerCase()) {
        return true;
      }
      return false;
    }

    // 3. Compare CIDs if both have one
    const cidA = bizA.cid || extractCid(bizA.profileUrl || bizA.googleProfileUrl);
    const cidB = bizB.cid || extractCid(bizB.profileUrl || bizB.googleProfileUrl);
    if (cidA && cidB) {
      if (cidA.toLowerCase() === cidB.toLowerCase()) {
        return true;
      }
      return false;
    }

    // 4. Compare normalized Google Maps profile URLs
    const urlA = normalizeGoogleMapsUrl(bizA.profileUrl || bizA.googleProfileUrl);
    const urlB = normalizeGoogleMapsUrl(bizB.profileUrl || bizB.googleProfileUrl);
    if (urlA && urlB && urlA.toLowerCase() === urlB.toLowerCase()) {
      return true;
    }

    // 5. Compare Normalized Name + Address
    const addrA = (bizA.address || '').trim().toLowerCase();
    const addrB = (bizB.address || '').trim().toLowerCase();
    if (nameA && nameB && isCloseBusinessName(nameA, nameB) && addrA && addrB && addrA === addrB && addrA.length > 5) {
      return true;
    }

    return false;
  }

  /**
   * Data Validation Layer: Validates every field independently.
   * Cleans any contaminated values (e.g. listing text in phone field) without discarding the record.
   */
  function validateBusinessRecord(record) {
    if (!record || typeof record !== 'object') return null;

    // 1. Business Name
    let name = (record.name || record.businessName || '').trim();
    if (isGenericHeader(name)) name = '';

    // 2. Phone: strictly validated
    let phone = '';
    const rawPhoneCandidate = record.phone || record.rawPhone || '';
    if (typeof rawPhoneCandidate === 'string' && rawPhoneCandidate.trim()) {
      const validated = normalizePhone(rawPhoneCandidate);
      if (validated) {
        phone = formatPhone(rawPhoneCandidate);
      } else {
        // Log rejected phone candidate if not empty
        if (rawPhoneCandidate.trim().length > 0) {
          console.warn(`[VALIDATION] Rejected invalid phone candidate: "${rawPhoneCandidate.slice(0, 50)}..."`);
        }
      }
    }

    // 3. Website: strictly validated external HTTP/HTTPS URL
    let website = '';
    const rawWebCandidate = record.website || record.link || '';
    if (typeof rawWebCandidate === 'string' && rawWebCandidate.trim()) {
      const cleaned = cleanExternalUrl(rawWebCandidate);
      if (cleaned && !isSocialPlatformUrl(cleaned)) {
        website = cleaned;
      } else if (cleaned && isSocialPlatformUrl(cleaned)) {
        // Move social profile to socialLinks
        if (!Array.isArray(record.socialLinks)) record.socialLinks = [];
        if (!record.socialLinks.includes(cleaned)) record.socialLinks.push(cleaned);
      }
    }

    // 4. Social Links: array of cleaned valid URLs
    const socialLinks = [];
    const rawSocial = Array.isArray(record.socialLinks) ? record.socialLinks : [];
    for (const item of rawSocial) {
      const cleaned = cleanExternalUrl(item);
      if (cleaned && isSocialPlatformUrl(cleaned) && !socialLinks.includes(cleaned)) {
        socialLinks.push(cleaned);
      }
    }

    // 5. Google Maps Profile URL
    let profileUrl = '';
    const rawProfile = record.profileUrl || record.googleProfileUrl || '';
    if (typeof rawProfile === 'string' && rawProfile.trim()) {
      profileUrl = normalizeGoogleMapsUrl(rawProfile) || '';
    }

    // 6. Address: string, not containing phone or URL
    let address = (record.address || '').trim();
    if (address.includes('http://') || address.includes('https://') || isValidPhone(address)) {
      address = '';
    }

    // 7. Rating: parsed float or null
    let rating = null;
    if (record.rating !== undefined && record.rating !== null && record.rating !== '') {
      const parsedRating = parseFloat(record.rating);
      if (!isNaN(parsedRating) && parsedRating >= 1 && parsedRating <= 5) {
        rating = Math.round(parsedRating * 10) / 10;
      }
    }

    // 8. Place ID & CID
    const placeId = record.placeId || extractPlaceId(profileUrl) || null;
    const cid = record.cid || extractCid(profileUrl) || null;

    return {
      name,
      businessName: name,
      phone,
      rawPhone: phone ? (record.rawPhone || phone) : '',
      link: website || (socialLinks.length > 0 ? socialLinks[0] : null),
      website: website || '',
      socialLinks,
      profileUrl: profileUrl || null,
      googleProfileUrl: profileUrl || '',
      address: address || null,
      rating,
      placeId,
      cid,
    };
  }

  /**
   * Merge newly extracted fields into an existing business record.
   * Validates both records and preserves valid existing values.
   */
  function mergeBusinessRecords(target, source) {
    if (!target || !source) return target;

    const validSource = validateBusinessRecord(source) || source;

    // Name: pick the longer or more complete display name
    if (!target.name || target.name.trim() === '') {
      target.name = validSource.name;
    } else if (validSource.name && validSource.name.length > target.name.length) {
      target.name = validSource.name;
    }
    target.businessName = target.name;

    // Phone: update if target missing phone and source has a valid one
    if (!target.phone && validSource.phone) {
      target.phone = validSource.phone;
      target.rawPhone = validSource.rawPhone || validSource.phone;
    }

    // Website: update if target missing website and source has an official one
    if ((!target.website || target.website === '') && validSource.website) {
      target.website = validSource.website;
      target.link = validSource.website;
    } else if (!target.link && validSource.link) {
      target.link = validSource.link;
    }

    // Google Maps Profile URL
    if (!target.profileUrl && validSource.profileUrl) {
      target.profileUrl = validSource.profileUrl;
      target.googleProfileUrl = validSource.profileUrl;
    }

    // Place ID & CID
    if (!target.placeId && validSource.placeId) target.placeId = validSource.placeId;
    if (!target.cid && validSource.cid) target.cid = validSource.cid;

    // Address
    if (!target.address && validSource.address) target.address = validSource.address;

    // Rating
    if ((target.rating === null || target.rating === undefined) && validSource.rating !== null && validSource.rating !== undefined) {
      target.rating = validSource.rating;
    }

    // Social Links
    if (validSource.socialLinks && Array.isArray(validSource.socialLinks)) {
      const existing = target.socialLinks || [];
      target.socialLinks = Array.from(new Set([...existing, ...validSource.socialLinks]));
    }

    return target;
  }

  // Alias for backward compatibility
  const enrichProfile = mergeBusinessRecords;

  /**
   * Centralized deduplication pass for a dataset of records.
   * Validates every record, rejects contaminated phone/website fields,
   * merges duplicates, and ensures 1 unique business = 1 row.
   */
  function deduplicateAndMergeDataset(records) {
    if (!Array.isArray(records) || records.length === 0) return [];

    const deduped = [];

    for (const rawItem of records) {
      if (!rawItem) continue;

      const item = validateBusinessRecord(rawItem);
      if (!item || (!item.name && !item.profileUrl)) continue;

      // Match against existing deduped records
      let matchedIndex = -1;
      for (let i = 0; i < deduped.length; i++) {
        if (areBusinessesSame(deduped[i], item)) {
          matchedIndex = i;
          break;
        }
      }

      if (matchedIndex !== -1) {
        mergeBusinessRecords(deduped[matchedIndex], item);
      } else {
        deduped.push(item);
      }
    }

    return deduped;
  }

  /**
   * Detect Linktree or bio page URLs.
   */
  function isLinktreeOrBioLink(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return (
      lower.includes('linktr.ee') ||
      lower.includes('bio.link') ||
      lower.includes('beacons.ai') ||
      lower.includes('campsite.bio') ||
      lower.includes('taplink.cc') ||
      lower.includes('solo.to') ||
      lower.includes('snipfeed.co') ||
      lower.includes('carrd.co') ||
      lower.includes('instabio.cc')
    );
  }

  /**
   * Check if link is a valid external website or social profile.
   */
  function isExternalLink(href) {
    return !!cleanExternalUrl(href);
  }

  /**
   * Check if name is a generic header in Google Maps (Arabic and English).
   */
  function isGenericHeader(name) {
    if (!name) return true;
    const lower = name.toLowerCase().trim();
    return (
      lower === 'results' ||
      lower === 'search results' ||
      lower.startsWith('results for') ||
      lower === 'google maps' ||
      lower === 'نتائج' ||
      lower === 'نتائج البحث' ||
      lower.startsWith('نتائج البحث عن')
    );
  }

  /**
   * Extract phone number and contact links from HTML page content.
   */
  function extractContactFromHtml(html, pageUrl = '') {
    if (!html || typeof html !== 'string') {
      return { phone: null, rawPhone: null, source: null, contactLinks: [] };
    }

    // 1. tel: links
    const telRegex = /<a\s+[^>]*href=["']tel:([^"'>\s]+)["'][^>]*>/gi;
    let match;
    while ((match = telRegex.exec(html)) !== null) {
      const raw = decodeURIComponent(match[1]).trim();
      const norm = normalizePhone(raw);
      if (norm) {
        return { phone: formatPhone(raw), rawPhone: raw, source: 'tel_link', contactLinks: [] };
      }
    }

    // 2. WhatsApp links
    const waRegex = /href=["']https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)(\+?\d{7,15})[^"']*["']/gi;
    while ((match = waRegex.exec(html)) !== null) {
      const raw = match[1].trim();
      const norm = normalizePhone(raw);
      if (norm) {
        return { phone: formatPhone(raw), rawPhone: raw, source: 'whatsapp_link', contactLinks: [] };
      }
    }

    // 3. JSON-LD structured data
    const jsonLdRegex = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        const items = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
        for (const item of items) {
          const tel = item.telephone || item.contactPoint?.telephone || (Array.isArray(item.contactPoint) ? item.contactPoint[0]?.telephone : null);
          if (tel && typeof tel === 'string') {
            const norm = normalizePhone(tel);
            if (norm) {
              return { phone: formatPhone(tel), rawPhone: tel, source: 'json_ld', contactLinks: [] };
            }
          }
        }
      } catch (_) {}
    }

    // 4. Contact section keywords in HTML
    const cleanHtml = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');

    const contactKeywordRegex = /(?:call(?:\s+us)?|phone|tel|telephone|contact(?:\s+us)?|mobile)[:\s]+([^<>\n\r]{7,35})/gi;
    while ((match = contactKeywordRegex.exec(cleanHtml)) !== null) {
      const candidate = match[1].replace(/<[^>]+>/g, '').trim();
      const phoneCandidateMatch = candidate.match(/(\+?[0-9\s\-().]{7,25})/);
      if (phoneCandidateMatch) {
        const norm = normalizePhone(phoneCandidateMatch[1]);
        if (norm) {
          return { phone: formatPhone(phoneCandidateMatch[1]), rawPhone: phoneCandidateMatch[1].trim(), source: 'visible_contact_text', contactLinks: [] };
        }
      }
    }

    // 5. General phone regex in visible text
    const generalPhoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
    const visibleText = cleanHtml.replace(/<[^>]+>/g, ' ');
    let phoneMatch;
    while ((phoneMatch = generalPhoneRegex.exec(visibleText)) !== null) {
      const norm = normalizePhone(phoneMatch[0]);
      if (norm) {
        return { phone: formatPhone(phoneMatch[0]), rawPhone: phoneMatch[0].trim(), source: 'page_text', contactLinks: [] };
      }
    }

    // Discover contact subpages
    const contactLinks = [];
    if (pageUrl) {
      const contactLinkRegex = /<a\s+[^>]*href=["']([^"'>]+\/(?:contact|contact-us|about-us|reach-us)[^"'>]*)["'][^>]*>/gi;
      let linkMatch;
      while ((linkMatch = contactLinkRegex.exec(html)) !== null) {
        try {
          const resolved = new URL(linkMatch[1], pageUrl).href;
          if (resolved.startsWith('http') && !contactLinks.includes(resolved)) {
            contactLinks.push(resolved);
          }
        } catch (_) {}
      }
    }

    return { phone: null, rawPhone: null, source: null, contactLinks };
  }

  return {
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
    validateBusinessRecord,
    mergeBusinessRecords,
    enrichProfile,
    deduplicateAndMergeDataset,
    isLinktreeOrBioLink,
    isExternalLink,
    cleanExternalUrl,
    extractContactFromHtml,
    convertArabicIndicDigits,
    extractPhoneNumber,
    extractBusinessPhoneNumber,
    isSocialPlatformUrl,
    extractBusinessWebsite,
    extractBusinessSocialLinks,
    extractBusinessLinks,
    isCloseBusinessName,
    isGenericHeader,
    STOP_WORDS,
  };
});
