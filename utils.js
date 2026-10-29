/**
 * utils.js — Maps Lead Scraper Shared Utilities & Centralized Deduplication Engine
 *
 * Implements strict, platform-aware deduplication and business identity resolution:
 * 1. Google Maps Place ID (highest priority)
 * 2. Verified Google Maps entity ID or CID
 * 3. Normalized canonical Google Maps business profile URL
 * 4. Normalized combination of business name, phone number, and address (fallback)
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
   * Normalize phone number to pure digits with leading + if international.
   * Strips all non-digit formatting characters. Rejects time ranges, ratings, coordinates.
   */
  function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const s = phone.trim();

    // Filter out non-phone strings: times ("10:00 - 18:00"), coordinates ("40.71, -74.00"), ratings ("4.8 ★")
    if (s.includes(':') || s.includes('@') || s.includes('★')) return '';
    if (/^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$/.test(s)) return '';
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s) || /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(s)) return '';
    if (s.includes('$') || s.includes('€') || s.includes('£')) return '';

    const digitsWithPlus = s.replace(/[^\d+]/g, '');
    const pureDigits = digitsWithPlus.replace(/\D/g, '');

    // Standard ITU E.164 phone numbers have 7 to 15 digits
    if (pureDigits.length < 7 || pureDigits.length > 15) return '';
    // Reject repeating dummy digits like 0000000 or 9999999999
    if (/^(\d)\1+$/.test(pureDigits)) return '';

    return digitsWithPlus.startsWith('+') ? `+${pureDigits}` : pureDigits;
  }

  /**
   * Check if a raw string is a valid phone candidate.
   */
  function isValidPhone(str) {
    return normalizePhone(str).length >= 7;
  }

  /**
   * Format phone number nicely for display/export while preserving original digits.
   */
  function formatPhone(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') return '';
    const trimmed = rawPhone.trim();
    const norm = normalizePhone(trimmed);
    if (!norm) return trimmed;

    // If already has readable human formatting (spaces, parentheses, or dashes), preserve cleaned spacing
    if (/[ \-()]/.test(trimmed)) {
      return trimmed.replace(/\s+/g, ' ').replace(/-+/g, '-').trim();
    }

    const digits = norm.replace(/\D/g, '');
    const startsWithPlus = norm.startsWith('+');

    if (digits.length === 10 && !startsWithPlus) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }

    return startsWithPlus ? `+${digits}` : digits;
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

      // Normalize coordinate precision in path (round to 3 decimals ~100m) to avoid zoom level splits (e.g. 15z vs 17z)
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
   * Priority:
   * 1. 0x...:0x... hex CID pair
   * 2. ChIJ Place ID
   */
  function extractPlaceId(url) {
    if (!url || typeof url !== 'string') return '';

    // Standard Google Maps data entity parameter: !1s...
    const s1Match = url.match(/!1s([^!/?&#]+)/);
    if (s1Match) return s1Match[1];

    // Google Hex CID feature pair (e.g. 0x3e5f4345c6480299:0x55194ec5a1ae072e)
    const hexPair = url.match(/(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
    if (hexPair) return hexPair[1].toLowerCase();

    // ChIJ Place ID
    const chij = url.match(/[?&]query_place_id=(ChIJ[A-Za-z0-9_-]{10,})/i) ||
                 url.match(/place_id:(ChIJ[A-Za-z0-9_-]{10,})/i);
    if (chij) return chij[1];

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

    const url = biz.profileUrl || biz.url || '';

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
    const cleanName = (biz.name || '').trim().toLowerCase();
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

  /**
   * Determine whether two business records represent the exact same entity.
   */
  function areBusinessesSame(bizA, bizB) {
    if (!bizA || !bizB) return false;

    // 1. Compare Place IDs if both have one
    const placeIdA = bizA.placeId || extractPlaceId(bizA.profileUrl);
    const placeIdB = bizB.placeId || extractPlaceId(bizB.profileUrl);
    if (placeIdA && placeIdB) {
      return placeIdA.toLowerCase() === placeIdB.toLowerCase();
    }

    // 2. Compare CIDs if both have one
    const cidA = bizA.cid || extractCid(bizA.profileUrl);
    const cidB = bizB.cid || extractCid(bizB.profileUrl);
    if (cidA && cidB) {
      return cidA.toLowerCase() === cidB.toLowerCase();
    }

    // 3. Compare normalized Google Maps profile URLs
    const urlA = normalizeGoogleMapsUrl(bizA.profileUrl);
    const urlB = normalizeGoogleMapsUrl(bizB.profileUrl);
    if (urlA && urlB && urlA.toLowerCase() === urlB.toLowerCase()) {
      return true;
    }

    // 4. Compare Normalized Name + Phone
    const phoneA = normalizePhone(bizA.phone || bizA.rawPhone);
    const phoneB = normalizePhone(bizB.phone || bizB.rawPhone);
    const nameA = (bizA.name || '').trim().toLowerCase();
    const nameB = (bizB.name || '').trim().toLowerCase();

    if (phoneA && phoneB && phoneA === phoneB && phoneA.length >= 7) {
      if (nameA === nameB || nameA.startsWith(nameB.slice(0, 8)) || nameB.startsWith(nameA.slice(0, 8))) {
        return true;
      }
    }

    // 5. Compare Normalized Name + Address
    const addrA = (bizA.address || '').trim().toLowerCase();
    const addrB = (bizB.address || '').trim().toLowerCase();
    if (nameA && nameB && nameA === nameB && addrA && addrB && addrA === addrB && addrA.length > 5) {
      return true;
    }

    return false;
  }

  /**
   * Merge newly extracted fields into an existing business record.
   * Preserves existing valid values and never overwrites with empty or failed values.
   */
  function mergeBusinessRecords(target, source) {
    if (!target || !source) return target;

    // Name: pick the longer or more complete display name
    if (!target.name || target.name.trim() === '') {
      target.name = (source.name || '').trim();
    } else if (source.name && source.name.trim().length > target.name.trim().length) {
      target.name = source.name.trim();
    }

    // Phone: update if target missing phone and source has one
    const targetPhoneNorm = normalizePhone(target.phone || target.rawPhone);
    const sourcePhoneNorm = normalizePhone(source.phone || source.rawPhone);

    if (!targetPhoneNorm && sourcePhoneNorm) {
      target.phone = formatPhone(source.phone || source.rawPhone);
      target.rawPhone = source.rawPhone || source.phone;
    }

    // Website: update if target missing website
    if ((!target.link || target.link.trim() === '') && source.link && source.link.trim() !== '') {
      target.link = source.link.trim();
    }

    // Google Maps Profile URL: update if missing or if source has canonical Place ID
    const targetHasPlaceId = !!(target.placeId || extractPlaceId(target.profileUrl));
    const sourceHasPlaceId = !!(source.placeId || extractPlaceId(source.profileUrl));

    if (!target.profileUrl || target.profileUrl.trim() === '') {
      if (source.profileUrl && source.profileUrl.trim() !== '') {
        target.profileUrl = normalizeGoogleMapsUrl(source.profileUrl);
      }
    } else if (!targetHasPlaceId && sourceHasPlaceId && source.profileUrl) {
      target.profileUrl = normalizeGoogleMapsUrl(source.profileUrl);
    }

    // Place ID
    if (!target.placeId && source.placeId) {
      target.placeId = source.placeId;
    }

    // Address
    if ((!target.address || target.address.trim() === '') && source.address && source.address.trim() !== '') {
      target.address = source.address.trim();
    }

    return target;
  }

  // Alias for backward compatibility
  const enrichProfile = mergeBusinessRecords;

  /**
   * Centralized deduplication pass for a dataset of records.
   * Ensures exactly one row per unique business by merging duplicates.
   */
  function deduplicateAndMergeDataset(records) {
    if (!Array.isArray(records) || records.length === 0) return [];

    const deduped = [];

    for (const rawItem of records) {
      if (!rawItem || (!rawItem.name && !rawItem.profileUrl)) continue;

      const normUrl = normalizeGoogleMapsUrl(rawItem.profileUrl) || null;
      const placeId = (rawItem.placeId || extractPlaceId(normUrl || rawItem.profileUrl)) || null;

      const item = {
        name:       (rawItem.name || '').trim(),
        phone:      formatPhone(rawItem.phone || rawItem.rawPhone) || (rawItem.phone || '').trim(),
        rawPhone:   (rawItem.rawPhone || rawItem.phone || '').trim(),
        link:       (rawItem.link || '').trim() || null,
        profileUrl: normUrl,
        address:    (rawItem.address || '').trim() || null,
        placeId:    placeId,
      };

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
   * Check if link is an external website (not Google internal/map utility).
   */
  function isExternalLink(href) {
    if (!href || typeof href !== 'string') return false;
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
    mergeBusinessRecords,
    enrichProfile,
    deduplicateAndMergeDataset,
    isLinktreeOrBioLink,
    isExternalLink,
    extractContactFromHtml,
  };
});
