/**
 * test-engine.js — Regression Test Suite for Maps Lead Scraper
 *
 * Explicitly tests all 10 regression requirements:
 * 1. The same business appears 10 times in the DOM.
 * 2. The same business appears during multiple scrolling events.
 * 3. The same business has multiple Google Maps URL variants.
 * 4. The same business is scraped twice concurrently.
 * 5. The same business is encountered in separate scraping sessions.
 * 6. An existing record has a phone number and a later record has a website.
 * 7. Two different branches share the same business name but have different Place IDs.
 * 8. Two businesses have the same name but different locations.
 * 9. The phone number is missing from one extraction but available in another.
 * 10. The final export contains repeated raw records.
 */

const assert = require('assert');
const utils = require('./utils.js');

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
  isLinktreeOrBioLink,
  isExternalLink,
  cleanExternalUrl,
  extractContactFromHtml,
  isCloseBusinessName,
  convertArabicIndicDigits,
  extractBusinessPhoneNumber,
  extractBusinessLinks,
  extractPhoneNumber,
  extractBusinessWebsite,
  extractBusinessSocialLinks,
  validateBusinessRecord,
} = utils;

console.log('====================================================');
console.log('   GOOGLE MAPS LEAD SCRAPER REGRESSION TEST SUITE');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(`       Error: ${err.message}\n`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(`       Error: ${err.message}\n`);
  }
}

// ── Mock Storage & Pipeline Simulation ───────────────────────────────────────
class MockChromeStorage {
  constructor() {
    this.store = {};
  }
  async get(keys) {
    if (typeof keys === 'string') {
      return { [keys]: this.store[keys] };
    }
    const result = {};
    for (const k of keys) {
      if (this.store[k] !== undefined) result[k] = this.store[k];
    }
    return result;
  }
  async set(items) {
    for (const [k, v] of Object.entries(items)) {
      this.store[k] = JSON.parse(JSON.stringify(v));
    }
  }
}

async function simulateSaveBatch(mockStorage, items) {
  const data = await mockStorage.get(['scrape_results', 'scrape_seen_urls', 'scrape_state']);
  let results = data.scrape_results || [];
  const seenSet = new Set(data.scrape_seen_urls || []);

  let added = 0;
  let enriched = 0;
  let dups = 0;

  for (const rawItem of items) {
    const normUrl = normalizeGoogleMapsUrl(rawItem.profileUrl) || null;
    const placeId = (rawItem.placeId || extractPlaceId(normUrl || rawItem.profileUrl)) || null;
    const cid     = (rawItem.cid || extractCid(normUrl || rawItem.profileUrl)) || null;

    const item = {
      name:       (rawItem.name || '').trim(),
      phone:      formatPhone(rawItem.phone || rawItem.rawPhone) || (rawItem.phone || '').trim(),
      rawPhone:   (rawItem.rawPhone || rawItem.phone || '').trim(),
      link:       (rawItem.link || '').trim() || null,
      profileUrl: normUrl,
      address:    (rawItem.address || '').trim() || null,
      placeId:    placeId,
      cid:        cid,
    };

    let matchedIdx = -1;
    for (let i = 0; i < results.length; i++) {
      if (areBusinessesSame(results[i], item)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      const existing = results[matchedIdx];
      const prevPhone = existing.phone;
      const prevLink = existing.link;
      const prevUrl = existing.profileUrl;

      mergeBusinessRecords(existing, item);

      const wasEnriched = (existing.phone !== prevPhone) || (existing.link !== prevLink) || (existing.profileUrl !== prevUrl);
      if (wasEnriched) enriched++;
      else dups++;
    } else {
      results.push(item);
      added++;
    }
  }

  // Ensure full deduplication pass
  results = deduplicateAndMergeDataset(results);

  results.forEach(r => {
    const k = getBusinessUniqueKey(r);
    if (k) seenSet.add(k);
    if (r.placeId) seenSet.add(`place:${r.placeId}`);
    if (r.profileUrl) seenSet.add(`url:${r.profileUrl.toLowerCase()}`);
    const normPh = normalizePhone(r.phone || r.rawPhone);
    if (r.name && normPh) seenSet.add(`name_phone:${r.name.trim().toLowerCase()}|${normPh}`);
  });

  await mockStorage.set({
    scrape_results: results,
    scrape_seen_urls: Array.from(seenSet),
  });

  return { added, enriched, duplicates: dups, total: results.length };
}

async function simulateBuildCSV(mockStorage, onlyNoWebsite = false) {
  const data = await mockStorage.get(['scrape_results']);
  const rawResults = data.scrape_results || [];

  const beforeCount = rawResults.length;
  const dedupedResults = deduplicateAndMergeDataset(rawResults);
  const afterCount = dedupedResults.length;

  // Save back deduplicated dataset
  await mockStorage.set({ scrape_results: dedupedResults });

  let exportList = dedupedResults;
  if (onlyNoWebsite) {
    exportList = exportList.filter(r => !r.link || r.link.trim() === '');
  }

  const header = 'Business Name,Phone,Website,Google Profile URL';
  const rows = exportList.map(r => [
    r.name,
    r.phone,
    r.link || '',
    r.profileUrl || '',
  ].join(','));

  return {
    csv: [header, ...rows].join('\n'),
    beforeCount,
    afterCount,
    exportedRowCount: exportList.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function main() {

  // Test 1: The same business appears 10 times in the DOM
  runTest('Regression 1: The same business appears 10 times in DOM -> Exactly 1 unique business', () => {
    const rawCards = [];
    for (let i = 0; i < 10; i++) {
      rawCards.push({
        name: 'Arum Beauty Salon',
        phone: '+971 4 123 4567',
        link: 'https://arumbeauty.com',
        profileUrl: 'https://www.google.com/maps/place/Arum+Beauty+Salon/@25.276987,55.296249,15z/data=!4m6!3m5!1s0x3e5f4345:0x55194ec',
      });
    }

    const deduped = deduplicateAndMergeDataset(rawCards);
    assert.strictEqual(deduped.length, 1, `Expected exactly 1 record, but got ${deduped.length}`);
    assert.strictEqual(deduped[0].name, 'Arum Beauty Salon');
    assert.strictEqual(deduped[0].phone, '+971 4 123 4567');
  });

  // Test 2: The same business appears during multiple scrolling events
  await runAsyncTest('Regression 2: The same business appears during multiple scrolling events -> No duplicates', async () => {
    const storage = new MockChromeStorage();

    // Scroll 1
    await simulateSaveBatch(storage, [
      { name: 'THE BEAUTY LOUNGE', phone: '+971 4 999 0001', profileUrl: 'https://www.google.com/maps/place/THE+BEAUTY+LOUNGE/@25.2048,55.2708,15z/data=!1s0x1:0x1' },
      { name: 'Salon Oasis', phone: '+971 4 999 0002', profileUrl: 'https://www.google.com/maps/place/Salon+Oasis/@25.2048,55.2708,15z/data=!1s0x2:0x2' },
    ]);

    // Scroll 2 (virtualized DOM renders THE BEAUTY LOUNGE again)
    await simulateSaveBatch(storage, [
      { name: 'THE BEAUTY LOUNGE', phone: '+971 4 999 0001', profileUrl: 'https://www.google.com/maps/place/THE+BEAUTY+LOUNGE/@25.2048,55.2708,15z/data=!1s0x1:0x1' },
      { name: 'Dubai Spa', phone: '+971 4 999 0003', profileUrl: 'https://www.google.com/maps/place/Dubai+Spa/@25.2048,55.2708,15z/data=!1s0x3:0x3' },
    ]);

    // Scroll 3 (re-renders THE BEAUTY LOUNGE and Salon Oasis)
    await simulateSaveBatch(storage, [
      { name: 'THE BEAUTY LOUNGE', phone: '+971 4 999 0001', profileUrl: 'https://www.google.com/maps/place/THE+BEAUTY+LOUNGE/@25.2048,55.2708,15z/data=!1s0x1:0x1' },
      { name: 'Salon Oasis', phone: '+971 4 999 0002', profileUrl: 'https://www.google.com/maps/place/Salon+Oasis/@25.2048,55.2708,15z/data=!1s0x2:0x2' },
    ]);

    const data = await storage.get('scrape_results');
    assert.strictEqual(data.scrape_results.length, 3, `Expected exactly 3 unique businesses across scrolls, got ${data.scrape_results.length}`);
  });

  // Test 3: The same business has multiple Google Maps URL variants
  runTest('Regression 3: The same business has multiple Google Maps URL variants (tracking params, zoom levels, trailing slashes)', () => {
    const variants = [
      { name: 'Arum Beauty Salon', phone: '+971 4 123 4567', profileUrl: 'https://www.google.com/maps/place/Arum+Beauty+Salon/@25.276987,55.296249,15z/data=!4m6!3m5!1s0x3e5f43:0x1234?entry=ttu' },
      { name: 'Arum Beauty Salon', phone: '+971 4 123 4567', profileUrl: 'https://www.google.com/maps/place/Arum+Beauty+Salon/@25.276987,55.296249,17z/data=!4m6!3m5!1s0x3e5f43:0x1234/' },
      { name: 'Arum Beauty Salon', phone: '+971 4 123 4567', profileUrl: 'https://maps.google.com/maps/place/Arum+Beauty+Salon/@25.276987,55.296249,15z?hl=ar&authuser=0' },
      { name: 'Arum Beauty Salon', phone: '+971 4 123 4567', profileUrl: '/maps/place/Arum+Beauty+Salon/@25.276987,55.296249,15z/data=!4m6!3m5!1s0x3e5f43:0x1234' },
    ];

    const deduped = deduplicateAndMergeDataset(variants);
    assert.strictEqual(deduped.length, 1, `All URL variants must collapse into 1 row, got ${deduped.length}`);
    assert.strictEqual(deduped[0].placeId, '0x3e5f43:0x1234');
  });

  // Test 4: The same business is scraped twice concurrently
  await runAsyncTest('Regression 4: The same business is scraped twice concurrently -> Mutex queue prevents race duplicate', async () => {
    const storage = new MockChromeStorage();

    let queue = Promise.resolve();
    function queuedBatch(items) {
      queue = queue.then(() => simulateSaveBatch(storage, items));
      return queue;
    }

    const batch1 = [
      { name: 'Concurrent Salon', phone: '+971 4 555 1111', profileUrl: 'https://www.google.com/maps/place/Concurrent+Salon/@25.20,55.27/data=!1s0x99:0x99' }
    ];
    const batch2 = [
      { name: 'Concurrent Salon', phone: '+971 4 555 1111', profileUrl: 'https://www.google.com/maps/place/Concurrent+Salon/@25.20,55.27/data=!1s0x99:0x99' }
    ];

    await Promise.all([queuedBatch(batch1), queuedBatch(batch2)]);

    const data = await storage.get('scrape_results');
    assert.strictEqual(data.scrape_results.length, 1, `Concurrent writes must result in exactly 1 record, got ${data.scrape_results.length}`);
  });

  // Test 5: The same business is encountered in separate scraping sessions
  await runAsyncTest('Regression 5: The same business encountered in separate scraping sessions -> Persisted deduplication', async () => {
    const storage = new MockChromeStorage();

    // Session 1
    await simulateSaveBatch(storage, [
      { name: 'Session One Barber', phone: '+971 4 333 4444', profileUrl: 'https://www.google.com/maps/place/Session+One+Barber/@25.20,55.27/data=!1s0x77:0x77' }
    ]);

    // Session 2 starts hours later (user clicks Start again)
    await simulateSaveBatch(storage, [
      { name: 'Session One Barber', phone: '+971 4 333 4444', profileUrl: 'https://www.google.com/maps/place/Session+One+Barber/@25.20,55.27/data=!1s0x77:0x77' },
      { name: 'Session Two Barber', phone: '+971 4 333 5555', profileUrl: 'https://www.google.com/maps/place/Session+Two+Barber/@25.20,55.27/data=!1s0x88:0x88' }
    ]);

    const data = await storage.get('scrape_results');
    assert.strictEqual(data.scrape_results.length, 2, `Session 2 must not duplicate Session 1 business, got ${data.scrape_results.length}`);
  });

  // Test 6: An existing record has a phone number and a later record has a website
  runTest('Regression 6: An existing record has a phone number and a later record has a website -> Merged into 1 row', () => {
    const records = [
      { name: 'Glow Spa', phone: '+971 4 777 8888', link: '', profileUrl: 'https://www.google.com/maps/place/Glow+Spa/@25.20,55.27/data=!1s0xaa:0xaa' },
      { name: 'Glow Spa', phone: '', link: 'https://glowspadubai.com', profileUrl: 'https://www.google.com/maps/place/Glow+Spa/@25.20,55.27/data=!1s0xaa:0xaa' },
    ];

    const deduped = deduplicateAndMergeDataset(records);
    assert.strictEqual(deduped.length, 1, `Must merge into 1 record, got ${deduped.length}`);
    assert.strictEqual(deduped[0].phone, '+971 4 777 8888', 'Phone from first record must be preserved');
    assert.strictEqual(deduped[0].link, 'https://glowspadubai.com', 'Website from second record must be merged');
  });

  // Test 7: Two different branches share the same business name but have different Place IDs
  runTest('Regression 7: Two different branches share the same name but have different Place IDs -> Kept separate', () => {
    const records = [
      { name: 'Tips and Toes', phone: '+971 4 111 0001', profileUrl: 'https://www.google.com/maps/place/Tips+and+Toes/@25.07,55.13/data=!1s0xbranch1:0x1' },
      { name: 'Tips and Toes', phone: '+971 4 222 0002', profileUrl: 'https://www.google.com/maps/place/Tips+and+Toes/@25.20,55.27/data=!1s0xbranch2:0x2' },
    ];

    const deduped = deduplicateAndMergeDataset(records);
    assert.strictEqual(deduped.length, 2, `Branches with different Place IDs must NOT be merged, got ${deduped.length}`);
    assert.strictEqual(deduped[0].placeId, '0xbranch1:0x1');
    assert.strictEqual(deduped[1].placeId, '0xbranch2:0x2');
  });

  // Test 8: Two businesses have the same name but different locations
  runTest('Regression 8: Two businesses have the same name but different locations/addresses -> Kept separate', () => {
    const records = [
      { name: 'Elegance Salon', address: 'Jumeirah Beach Road, Dubai', phone: '+971 4 345 6789' },
      { name: 'Elegance Salon', address: 'Al Barsha 1, Dubai', phone: '+971 4 987 6543' },
    ];

    const deduped = deduplicateAndMergeDataset(records);
    assert.strictEqual(deduped.length, 2, `Businesses at different locations with different phones must NOT be merged, got ${deduped.length}`);
  });

  // Test 9: The phone number is missing from one extraction but available in another
  runTest('Regression 9: Phone number missing from one extraction but available in another -> In-place enrichment', () => {
    const target = { name: 'Al Maha Beauty', phone: '', link: 'https://almaha.com', profileUrl: 'https://www.google.com/maps/place/Al+Maha/@25.2,55.2/data=!1s0x5:0x5' };
    const source = { name: 'Al Maha Beauty', phone: '+971 4 888 9999', link: '', profileUrl: 'https://www.google.com/maps/place/Al+Maha/@25.2,55.2/data=!1s0x5:0x5' };

    mergeBusinessRecords(target, source);
    assert.strictEqual(target.phone, '+971 4 888 9999', 'Phone number must be enriched');
    assert.strictEqual(target.link, 'https://almaha.com', 'Existing link must not be overwritten with empty string');
  });

  // Test 10: The final export contains repeated raw records
  await runAsyncTest('Regression 10: Final export stage deduplicates raw dataset guaranteeing 1 business = 1 row', async () => {
    const storage = new MockChromeStorage();

    // Store polluted dataset with duplicates
    const rawPollutedData = [
      { name: 'Arum Beauty Salon', phone: '+971 4 123 4567', link: 'https://arum.com', profileUrl: 'https://www.google.com/maps/place/Arum/@25.2,55.2/data=!1s0x100:0x100' },
      { name: 'Arum Beauty Salon', phone: '+971 4 123 4567', link: 'https://arum.com', profileUrl: 'https://www.google.com/maps/place/Arum/@25.2,55.2/data=!1s0x100:0x100' },
      { name: 'THE BEAUTY LOUNGE', phone: '+971 4 999 1111', link: 'https://beautylounge.ae', profileUrl: 'https://www.google.com/maps/place/TBL/@25.2,55.2/data=!1s0x200:0x200' },
      { name: 'THE BEAUTY LOUNGE', phone: '+971 4 999 1111', link: 'https://beautylounge.ae', profileUrl: 'https://www.google.com/maps/place/TBL/@25.2,55.2/data=!1s0x200:0x200' },
      { name: 'صالون سيدة الجمال', phone: '+971 4 888 2222', link: '', profileUrl: 'https://www.google.com/maps/place/ArabicSalon/@25.2,55.2/data=!1s0x300:0x300' },
      { name: 'صالون سيدة الجمال', phone: '+971 4 888 2222', link: '', profileUrl: 'https://www.google.com/maps/place/ArabicSalon/@25.2,55.2/data=!1s0x300:0x300' },
      { name: 'صالون سيدة الجمال', phone: '+971 4 888 2222', link: '', profileUrl: 'https://www.google.com/maps/place/ArabicSalon/@25.2,55.2/data=!1s0x300:0x300' },
    ];

    await storage.set({ scrape_results: rawPollutedData });

    const exportResult = await simulateBuildCSV(storage, false);
    assert.strictEqual(exportResult.beforeCount, 7, 'Raw records before export was 7');
    assert.strictEqual(exportResult.afterCount, 3, 'After export deduplication must be exactly 3 unique businesses');
    assert.strictEqual(exportResult.exportedRowCount, 3, 'Exported CSV must contain exactly 3 rows');

    // Verify storage was cleaned
    const cleaned = await storage.get('scrape_results');
    assert.strictEqual(cleaned.scrape_results.length, 3, 'Underlying storage must be cleaned to 3 records');
  });

  // Arabic Business Name & International Formatting Test
  runTest('Arabic & International: Exact phone and Arabic unicode name deduplication', () => {
    const raw = [
      { name: 'صالون الأناقة للتجميل', phone: '+971-4-321-7654', profileUrl: 'https://www.google.com/maps/place/%D8%B5%D8%A7%D9%84%D9%88%D9%86/@25.2,55.2/data=!1s0x9:0x9' },
      { name: 'صالون الأناقة للتجميل', phone: '04 321 7654', profileUrl: 'https://www.google.com/maps/place/%D8%B5%D8%A7%D9%84%D9%88%D9%86/@25.2,55.2/data=!1s0x9:0x9' },
    ];
    const deduped = deduplicateAndMergeDataset(raw);
    assert.strictEqual(deduped.length, 1, 'Arabic listing with variant phone formatting must merge into 1');
  });

  // Phone Validation Test: Rejection of times, coordinates, ratings
  runTest('Validation: Rejects times, coordinates, ratings, and invalid strings from being phone numbers', () => {
    assert.strictEqual(isValidPhone('10:00 - 18:00'), false, 'Time interval must be rejected');
    assert.strictEqual(isValidPhone('40.7128, -74.0060'), false, 'Coordinates must be rejected');
    assert.strictEqual(isValidPhone('4.8 ★ (1,234)'), false, 'Ratings must be rejected');
    assert.strictEqual(isValidPhone('2024-10-15'), false, 'Dates must be rejected');
    assert.strictEqual(isValidPhone('0000000'), false, 'Repeating digits must be rejected');
    assert.strictEqual(isValidPhone('+971 4 123 4567'), true, 'Valid international number accepted');
    assert.strictEqual(isValidPhone('(212) 555-0199'), true, 'Valid US number accepted');
  });

  // tel: Links & Linktree extraction
  runTest('Extraction: Extracts tel: links, WhatsApp links, and JSON-LD structured data', () => {
    const htmlWithTel = '<a href="tel:%2B971%204%20123%204567">Call Now</a>';
    const res1 = extractContactFromHtml(htmlWithTel, 'https://example.com');
    assert.strictEqual(res1.source, 'tel_link');
    assert.strictEqual(res1.phone, '+971 4 123 4567');

    const htmlWithJsonLd = `
      <script type="application/ld+json">
        { "@context": "https://schema.org", "@type": "LocalBusiness", "telephone": "+1-800-555-0199" }
      </script>
      <a href="https://wa.me/18005550199">WhatsApp</a>
    `;
    const res2 = extractContactFromHtml(htmlWithJsonLd, 'https://linktr.ee/coolbiz');
    assert.strictEqual(normalizePhone(res2.phone), '+18005550199');
  });

  // Relative URLs
  runTest('URL Normalization: Relative URLs correctly resolved to absolute Google Maps URLs', () => {
    const rel = '/maps/place/Dubai+Mall/@25.1972,55.2744,15z/data=!1s0x3e5f43:0x123';
    const norm = normalizeGoogleMapsUrl(rel);
    assert.strictEqual(norm, 'https://www.google.com/maps/place/Dubai+Mall/@25.197,55.274/data=!1s0x3e5f43:0x123');
  });

  // User Exact Screenshot Regression: Stale Detail Panel Deduplication
  runTest('User Regression: AD Salon & Spa (5 duplicate rows) & Beauty and Rose (6 duplicate rows)', () => {
    const userContaminatedRows = [
      { name: 'AD Salon & Spa', phone: '+966538811708', link: '', profileUrl: 'https://www.google.com/maps/place/AD+Salon/@24.8,46.5/data=!1s0x101:0x101' },
      { name: 'AD Salon & Spa', phone: '+966538811708', link: '', profileUrl: 'https://www.google.com/maps/place/AD+Salon/@24.8,46.5/data=!1s0x102:0x102' },
      { name: 'AD Salon & Spa', phone: '+966538811708', link: '', profileUrl: 'https://www.google.com/maps/place/AD+Salon/@24.8,46.5/data=!1s0x103:0x103' },
      { name: 'AD Salon & Spa', phone: '+966538811708', link: '', profileUrl: 'https://www.google.com/maps/place/AD+Salon/@24.8,46.5/data=!1s0x104:0x104' },
      { name: 'AD Salon & Spa', phone: '+966538811708', link: '', profileUrl: 'https://www.google.com/maps/place/AD+Salon/@24.8,46.5/data=!1s0x105:0x105' },
      { name: 'Beauty and Rose', phone: '+966580396652', link: 'https://instagram.com/beauty_rose', profileUrl: 'https://www.google.com/maps/place/Beauty/@24.8,46.5/data=!1s0x201:0x201' },
      { name: 'يونيك صالون و سبا', phone: '', link: '', profileUrl: 'https://www.google.com/maps/place/Unique/@24.8,46.5/data=!1s0x301:0x301' },
      { name: 'Beauty and Rose', phone: '+966580396652', link: 'https://instagram.com/beauty_rose', profileUrl: 'https://www.google.com/maps/place/Beauty/@24.8,46.5/data=!1s0x202:0x202' },
      { name: 'BELLEZZA LOUNGE', phone: '', link: '', profileUrl: 'https://www.google.com/maps/place/Bellezza/@24.8,46.5/data=!1s0x401:0x401' },
      { name: 'Beauty and Rose', phone: '+966580396652', link: 'https://instagram.com/beauty_rose', profileUrl: 'https://www.google.com/maps/place/Beauty/@24.8,46.5/data=!1s0x203:0x203' },
      { name: 'Beauty and Rose', phone: '+966580396652', link: 'https://instagram.com/beauty_rose', profileUrl: 'https://www.google.com/maps/place/Beauty/@24.8,46.5/data=!1s0x204:0x204' },
      { name: 'Beauty and Rose', phone: '+966580396652', link: 'https://instagram.com/beauty_rose', profileUrl: 'https://www.google.com/maps/place/Beauty/@24.8,46.5/data=!1s0x205:0x205' },
      { name: 'Beauty and Rose', phone: '+966580396652', link: 'https://instagram.com/beauty_rose', profileUrl: 'https://www.google.com/maps/place/Beauty/@24.8,46.5/data=!1s0x206:0x206' },
    ];

    const cleaned = deduplicateAndMergeDataset(userContaminatedRows);
    assert.strictEqual(cleaned.length, 4, '13 contaminated rows must resolve to exactly 4 unique businesses');

    const adSalon = cleaned.find(b => b.name === 'AD Salon & Spa');
    assert.ok(adSalon, 'AD Salon & Spa must exist');
    assert.strictEqual(normalizePhone(adSalon.phone), '+966538811708');

    const beautyRose = cleaned.find(b => b.name === 'Beauty and Rose');
    assert.ok(beautyRose, 'Beauty and Rose must exist');
    assert.strictEqual(normalizePhone(beautyRose.phone), '+966580396652');
    assert.strictEqual(beautyRose.link, 'https://instagram.com/beauty_rose');

    const uniqueSalon = cleaned.find(b => b.name === 'يونيك صالون و سبا');
    assert.ok(uniqueSalon, 'يونيك صالون و سبا must exist');

    const bellezza = cleaned.find(b => b.name === 'BELLEZZA LOUNGE');
    assert.ok(bellezza, 'BELLEZZA LOUNGE must exist');
  });

  // Business Name Distinctiveness Test
  runTest('isCloseBusinessName: Accurately differentiates distinct salons while handling truncations', () => {
    // Distinct businesses must NOT match even if they share "salon" / "spa" / "beauty"
    assert.strictEqual(isCloseBusinessName('AD Salon & Spa', 'Beauty and Rose'), false, 'AD Salon & Spa != Beauty and Rose');
    assert.strictEqual(isCloseBusinessName('AD Salon & Spa', 'Al Maha Beauty Salon'), false, 'AD Salon & Spa != Al Maha Beauty Salon');
    assert.strictEqual(isCloseBusinessName('Beauty and Rose', 'BELLEZZA LOUNGE'), false, 'Beauty and Rose != BELLEZZA LOUNGE');

    // Truncated / bilingual variations of the same business must match
    assert.strictEqual(isCloseBusinessName('Arum Beauty Sa...', 'Arum Beauty Salon'), true, 'Arum Beauty Sa... == Arum Beauty Salon');
    assert.strictEqual(isCloseBusinessName('Beauty and Rose', 'Beauty and Rose / بيوتي اند روز'), true, 'English == Bilingual name');

    // Arabic business name with district/neighborhood appended in feed card
    assert.strictEqual(
      isCloseBusinessName('صالون كلمات الجمال النسائي حي حطين', 'صالون كلمات الجمال النسائي'),
      true,
      'Arabic name with district preposition (حي حطين) matches base business name'
    );
  });

  // External URL & Google Redirect Unwrapping Test
  runTest('URL Unwrapping: Unwraps Google redirect URLs for Instagram, Snapchat, websites', () => {
    const wrappedInstagram = 'https://www.google.com/url?q=https%3A%2F%2Fwww.instagram.com%2Fbeauty_rose%2F&sa=D&sntz=1&usg=AOvVaw2...';
    assert.strictEqual(cleanExternalUrl(wrappedInstagram), 'https://www.instagram.com/beauty_rose/');
    assert.strictEqual(isExternalLink(wrappedInstagram), true);

    const wrappedSnapchat = 'https://www.google.com/url?q=https%3A%2F%2Fwww.snapchat.com%2Fadd%2Fad_salon&sa=D';
    assert.strictEqual(cleanExternalUrl(wrappedSnapchat), 'https://www.snapchat.com/add/ad_salon');

    const bareDomain = 'beauty-center.sa';
    assert.strictEqual(cleanExternalUrl(bareDomain), 'https://beauty-center.sa');

    const googleInternal = 'https://www.google.com/maps/place/SomePlace/@24.8,46.5';
    assert.strictEqual(cleanExternalUrl(googleInternal), null);
    assert.strictEqual(isExternalLink(googleInternal), false);
  });

  // Arabic-Indic Digits & Saudi Phone Canonicalization Test
  runTest('Arabic-Indic Digits & Saudi Phone Canonicalization', () => {
    const arabicIndic = '٠٥٣٨٨١١٧٠٨';
    assert.strictEqual(convertArabicIndicDigits(arabicIndic), '0538811708');
    assert.strictEqual(normalizePhone(arabicIndic), '+966538811708');

    const persian = '۰۵۳۸۸۱۱۷۰۸';
    assert.strictEqual(convertArabicIndicDigits(persian), '0538811708');
    assert.strictEqual(normalizePhone(persian), '+966538811708');

    const saudiLocal = '0538811708';
    assert.strictEqual(normalizePhone(saudiLocal), '+966538811708');

    const saudiIntl = '+966538811708';
    assert.strictEqual(normalizePhone(saudiIntl), '+966538811708');

    const saudiLandline = '0112345678';
    assert.strictEqual(normalizePhone(saudiLandline), '+966112345678');
  });

  // Container DOM Phone and Links Extractor Test
  runTest('extractBusinessPhoneNumber & extractBusinessLinks: Mock DOM Containers', () => {
    // Mock container with aria-label in Arabic
    const mockContainer = {
      querySelectorAll: (sel) => {
        if (sel.includes('aria-label*="هاتف"') || sel.includes('aria-label*="الهاتف"')) {
          return [{
            getAttribute: (attr) => attr === 'aria-label' ? 'الهاتف: ٠٥٣٨٨١١٧٠٨' : null,
            textContent: '٠٥٣٨٨١١٧٠٨'
          }];
        }
        if (sel.includes('data-item-id="authority"')) {
          return [{
            getAttribute: (attr) => attr === 'data-url' ? 'https://www.google.com/url?q=https%3A%2F%2Fwww.ad-salon.sa%2F' : null,
            href: 'https://www.google.com/url?q=https%3A%2F%2Fwww.ad-salon.sa%2F'
          }];
        }
        if (sel.includes('instagram.com')) {
          return [{
            getAttribute: (attr) => null,
            href: 'https://www.instagram.com/ad_salon_spa/'
          }];
        }
        return [];
      }
    };

    const phoneRes = extractBusinessPhoneNumber(mockContainer);
    assert.ok(phoneRes, 'Phone must be extracted from Arabic aria-label with Arabic-Indic digits');
    assert.strictEqual(phoneRes.normPhone, '+966538811708');

    const linksRes = extractBusinessLinks(mockContainer);
    assert.ok(linksRes, 'Links must be extracted');
    assert.strictEqual(linksRes.website, 'https://www.ad-salon.sa');
    assert.strictEqual(linksRes.socialLinks.length, 1);
    assert.strictEqual(linksRes.socialLinks[0], 'https://www.instagram.com/ad_salon_spa/');
  });

  // Strict Phone Extraction: Card with listing text must NEVER populate phone field
  runTest('Strict Phone Extraction: Card with listing text, rating, address, hours -> Empty Phone', () => {
    // Exact representative mock of user's reproduced bug
    const mockCard = {
      querySelectorAll: (sel) => {
        if (sel.includes('div.W4Efsd > span') || sel.includes('div.UsdlK')) {
          return [
            { children: [], textContent: 'Spa' },
            { children: [], textContent: '8260 سعيد بن زيد، الدرعية الجديدة، الدرعية' },
            { children: [], textContent: 'Open · Closes 10 PM' },
          ];
        }
        return [];
      }
    };

    const ph = extractPhoneNumber(mockCard);
    assert.strictEqual(ph.phone, '', 'Phone must be empty when card only has category, address, hours');
    assert.strictEqual(ph.normPhone, '');

    // Even if entire listing text is checked, normalizePhone must reject it
    const contaminatedText = 'And Spa Beauty Salon4.1(815)Spa · 8260 سعيد بن زيد، الدرعية الجديدة، الدرعيةOpen · Closes 10 PM';
    assert.strictEqual(normalizePhone(contaminatedText), '', 'Contaminated listing text must return empty phone');
    assert.strictEqual(formatPhone(contaminatedText), '', 'formatPhone on listing text must return empty');
  });

  // Strict Phone Extraction: Card with valid phone number in leaf span
  runTest('Strict Phone Extraction: Card with valid phone number in leaf span', () => {
    const mockCard = {
      querySelectorAll: (sel) => {
        if (sel.includes('div.W4Efsd > span') || sel.includes('div.UsdlK')) {
          return [
            { children: [], textContent: 'Beauty salon' },
            { children: [], textContent: '055 123 4567' },
            { children: [], textContent: 'Open · Closes 10 PM' },
          ];
        }
        return [];
      }
    };

    const ph = extractPhoneNumber(mockCard);
    assert.strictEqual(ph.normPhone, '+966551234567', 'Valid phone span must be recognized and normalized');
    assert.strictEqual(ph.phone, '+966 55 123 4567');
  });

  // Strict Website Extraction: Isolates official website from social media links
  runTest('Strict Website Extraction: Isolates official website from social media links', () => {
    const mockPanelOnlyInstagram = {
      querySelectorAll: (sel) => {
        if (sel.includes('instagram.com')) {
          return [{
            getAttribute: () => null,
            href: 'https://instagram.com/beauty_salon'
          }];
        }
        return [];
      }
    };

    const web = extractBusinessWebsite(mockPanelOnlyInstagram);
    assert.strictEqual(web, '', 'Official website must be empty when only Instagram exists');

    const social = extractBusinessSocialLinks(mockPanelOnlyInstagram);
    assert.strictEqual(social.length, 1);
    assert.strictEqual(social[0], 'https://instagram.com/beauty_salon');

    const mockPanelWithOfficialSite = {
      querySelectorAll: (sel) => {
        if (sel.includes('data-item-id="authority"')) {
          return [{
            getAttribute: () => 'https://www.google.com/url?q=https%3A%2F%2Fwww.baseandboon.com%2F',
            href: 'https://www.google.com/url?q=https%3A%2F%2Fwww.baseandboon.com%2F'
          }];
        }
        return [];
      }
    };

    const officialWeb = extractBusinessWebsite(mockPanelWithOfficialSite);
    assert.strictEqual(officialWeb, 'https://www.baseandboon.com', 'Official website must be extracted');
  });

  // Google Maps profile URL must NEVER be treated as official website
  runTest('URL Separation: Google Maps profile URLs are never treated as official websites', () => {
    const mapsUrl = 'https://www.google.com/maps/place/Base+%26+Boon/@24.8,46.5/data=!1s0x1:0x1';
    assert.strictEqual(cleanExternalUrl(mapsUrl), null, 'Maps place URL must be rejected as external link');
    assert.strictEqual(isExternalLink(mapsUrl), false);
  });

  // Data Validation Layer: Sanitizes contaminated records
  runTest('Data Validation Layer: Sanitizes contaminated records without losing business name or address', () => {
    const badRecord = {
      name: 'And Spa Beauty Salon',
      phone: 'And Spa Beauty Salon4.1(815)Spa · 8260 سعيد بن زيد، الدرعية الجديدة، الدرعيةOpen · Closes 10 PM',
      link: 'https://www.google.com/maps/place/And+Spa/@24.8,46.5',
      address: '8260 سعيد بن زيد، الدرعية الجديدة، الدرعية',
      rating: '4.1',
      profileUrl: 'https://www.google.com/maps/place/And+Spa/@24.8,46.5/data=!1s0x123:0x456'
    };

    const validated = validateBusinessRecord(badRecord);
    assert.strictEqual(validated.name, 'And Spa Beauty Salon');
    assert.strictEqual(validated.phone, '', 'Contaminated phone must be reset to empty string');
    assert.strictEqual(validated.website, '', 'Internal Google Maps URL in link must be reset to empty website');
    assert.strictEqual(validated.address, '8260 سعيد بن زيد، الدرعية الجديدة، الدرعية');
    assert.strictEqual(validated.rating, 4.1);
    assert.ok(validated.googleProfileUrl.includes('0x123:0x456'));
  });

  // Final CSV Export column order and header
  runTest('CSV Export: Strict column order, expected headers, and clean values', () => {
    const sampleRecord = {
      name: 'Base & Boon - Diriyah',
      phone: '+966 55 123 4567',
      website: 'https://baseandboon.com',
      googleProfileUrl: 'https://www.google.com/maps/place/Base+Boon/@24.8,46.5/data=!1s0x9:0x9',
      address: 'Abdulaziz Ibn Mohammad Ibn Saud Rd',
      rating: 4.1,
      socialLinks: ['https://instagram.com/baseandboon']
    };

    const deduped = deduplicateAndMergeDataset([sampleRecord]);
    assert.strictEqual(deduped.length, 1);

    const r = deduped[0];
    assert.strictEqual(r.name, 'Base & Boon - Diriyah');
    assert.strictEqual(r.phone, '+966 55 123 4567');
    assert.strictEqual(r.website, 'https://baseandboon.com');
    assert.strictEqual(r.address, 'Abdulaziz Ibn Mohammad Ibn Saud Rd');
    assert.strictEqual(r.rating, 4.1);
  });

  // End-to-end Detail Panel Contact Extraction & Enrichment Pipeline
  runTest('Detail Panel Pipeline: Enriches empty card record with Phone, Website, and Social Links', () => {
    // Stage 1: Bare feed card record (only Name, Rating, and Maps Profile URL available on search card)
    const initialFeedItem = {
      name: 'AD Salon & Spa',
      businessName: 'AD Salon & Spa',
      phone: '',
      rawPhone: '',
      website: '',
      link: null,
      socialLinks: [],
      profileUrl: 'https://www.google.com/maps/place/AD+Salon+Spa/@24.71,46.67/data=!4m2!3m1!1s0x3e2f03890d:0xabcdef',
      googleProfileUrl: 'https://www.google.com/maps/place/AD+Salon+Spa/@24.71,46.67/data=!4m2!3m1!1s0x3e2f03890d:0xabcdef',
      address: null,
      rating: 4.8,
      placeId: 'ChIJ7e2f03890d',
      cid: '0xabcdef'
    };

    // Stage 2: Mock Google Maps in-page detail panel container with live localized DOM
    const mockDetailPanel = {
      querySelectorAll: (sel) => {
        // Dedicated phone buttons with Arabic aria-label and Saudi phone format
        if (sel.includes('button[data-item-id^="phone:tel:"]') || sel.includes('[data-item-id*="phone"] button') || sel.includes('button[aria-label*="الهاتف" i]')) {
          return [{
            getAttribute: (attr) => attr === 'data-item-id' ? 'phone:tel:0538811708' : (attr === 'aria-label' ? 'الهاتف: 053 881 1708' : null),
            textContent: '053 881 1708'
          }];
        }
        // Dedicated authority button with official website
        if (sel.includes('a[data-item-id="authority"]') || sel.includes('a[aria-label*="الموقع الإلكتروني" i]')) {
          return [{
            href: 'https://www.ad-salon.sa',
            getAttribute: (attr) => attr === 'href' ? 'https://www.ad-salon.sa' : null
          }];
        }
        // Social media links
        if (sel.includes('social') || sel.includes('instagram.com')) {
          return [{
            href: 'https://www.instagram.com/ad_salon_spa/',
            getAttribute: (attr) => attr === 'href' ? 'https://www.instagram.com/ad_salon_spa/' : null
          }];
        }
        return [];
      },
      querySelector: (sel) => {
        if (sel.includes('button[data-item-id="address"]')) {
          return {
            getAttribute: () => 'العنوان: طريق الملك فهد، الرياض 12345',
            querySelector: () => ({ textContent: 'طريق الملك فهد، الرياض 12345' })
          };
        }
        if (sel.includes('h1.DUwDvf') || sel.includes('h1')) {
          return { textContent: 'AD Salon & Spa' };
        }
        return null;
      }
    };

    // Extract contact information from panel
    const phoneRes = extractPhoneNumber(mockDetailPanel);
    const webRes   = extractBusinessWebsite(mockDetailPanel);
    const socRes   = extractBusinessSocialLinks(mockDetailPanel);

    assert.strictEqual(phoneRes.phone, '+966 53 881 1708');
    assert.strictEqual(webRes, 'https://www.ad-salon.sa');
    assert.strictEqual(socRes.length, 1);
    assert.strictEqual(socRes[0], 'https://www.instagram.com/ad_salon_spa/');

    // Enrich the record in-place
    const enrichedRecord = {
      ...initialFeedItem,
      phone: phoneRes.phone,
      rawPhone: phoneRes.rawPhone,
      website: webRes,
      link: webRes,
      socialLinks: socRes,
      address: 'طريق الملك فهد، الرياض 12345'
    };

    const validated = validateBusinessRecord(enrichedRecord);
    assert.strictEqual(validated.name, 'AD Salon & Spa');
    assert.strictEqual(validated.phone, '+966 53 881 1708');
    assert.strictEqual(validated.website, 'https://www.ad-salon.sa');
    assert.strictEqual(validated.address, 'طريق الملك فهد، الرياض 12345');
    assert.strictEqual(validated.socialLinks.length, 1);
    assert.strictEqual(validated.rating, 4.8);
  });

  // Regression 27: Standalone Single Place Profile Extraction (AD Salon & Spa from user screenshot)
  runTest('Single Profile Extraction: AD Salon & Spa extracts phone +966 53 881 1708, rating 4.8, address, and saves immediately', () => {
    // Representative DOM fixture matching user's exact screenshot of AD Salon & Spa
    const mockDocument = {
      querySelectorAll: (sel) => {
        if (sel.includes('phone') || sel.includes('tel')) {
          return [{
            getAttribute: (a) => a === 'data-item-id' ? 'phone:tel:0538811708' : (a === 'aria-label' ? 'الهاتف: 053 881 1708' : null),
            textContent: '053 881 1708'
          }];
        }
        if (sel.includes('authority') || sel.includes('website')) {
          return []; // AD Salon & Spa has no official website
        }
        if (sel.includes('social') || sel.includes('instagram')) {
          return [];
        }
        return [];
      },
      querySelector: (sel) => {
        if (sel.includes('h1.DUwDvf') || sel.includes('h1')) {
          return { textContent: 'AD Salon & Spa' };
        }
        if (sel.includes('span.ceNzKf') || sel.includes('stars') || sel.includes('F7nice')) {
          return { getAttribute: () => '4.8 stars', textContent: '4.8' };
        }
        if (sel.includes('address')) {
          return {
            getAttribute: () => 'Address: Al Khalidiyah, Diriyah 13713, Saudi Arabia',
            querySelector: () => ({ textContent: 'Al Khalidiyah, Diriyah 13713, Saudi Arabia' })
          };
        }
        return null;
      }
    };

    // Extract fields
    const phoneRes = extractPhoneNumber(mockDocument);
    const webRes   = extractBusinessWebsite(mockDocument);
    const socRes   = extractBusinessSocialLinks(mockDocument);

    assert.strictEqual(phoneRes.phone, '+966 53 881 1708', 'Phone must be extracted as formatted Saudi mobile');
    assert.strictEqual(webRes, '', 'Website must be empty when none provided');
    assert.strictEqual(socRes.length, 0);

    const placeRecord = {
      name: 'AD Salon & Spa',
      businessName: 'AD Salon & Spa',
      phone: phoneRes.phone,
      rawPhone: phoneRes.rawPhone,
      website: webRes,
      link: null,
      socialLinks: socRes,
      address: 'Al Khalidiyah, Diriyah 13713, Saudi Arabia',
      rating: 4.8,
      profileUrl: 'https://www.google.com/maps/place/AD+Salon+%26+Spa/@24.7136,46.6753,15z',
      googleProfileUrl: 'https://www.google.com/maps/place/AD+Salon+%26+Spa/@24.7136,46.6753,15z',
      placeId: 'ChIJAD_SALON_DIRIYAH'
    };

    const validated = validateBusinessRecord(placeRecord);
    assert.strictEqual(validated.name, 'AD Salon & Spa');
    assert.strictEqual(validated.phone, '+966 53 881 1708');
    assert.strictEqual(validated.address, 'Al Khalidiyah, Diriyah 13713, Saudi Arabia');
    assert.strictEqual(validated.rating, 4.8);
    assert.strictEqual(validated.website, '');
  });

  // Regression 28: State Machine & Bulk Progression Counter Simulation
  await runAsyncTest('State Machine & Counter Progression: Counters advance from 0 to N without deadlocks', async () => {
    const mockStorage = new MockChromeStorage();

    // Initial state: 0 items
    let stats = { total: 0, isRunning: true, batchCount: 0, status: 'running' };
    await mockStorage.set({ scrape_state: stats, scrape_results: [] });

    // Item 1 extracted (e.g. AD Salon & Spa)
    const item1 = {
      name: 'AD Salon & Spa',
      phone: '+966 53 881 1708',
      website: '',
      profileUrl: 'https://www.google.com/maps/place/AD+Salon/@24.7,46.6/data=!1s0x1:0x1'
    };
    await simulateSaveBatch(mockStorage, [item1]);
    let currentData = await mockStorage.get(['scrape_results']);
    assert.strictEqual(currentData.scrape_results.length, 1, 'Total must advance to 1 after first item');

    // Item 2 extracted (e.g. Base & Boon)
    const item2 = {
      name: 'Base & Boon - Diriyah',
      phone: '+966 55 123 4567',
      website: 'https://baseandboon.com',
      profileUrl: 'https://www.google.com/maps/place/Base+Boon/@24.7,46.6/data=!1s0x2:0x2'
    };
    await simulateSaveBatch(mockStorage, [item2]);
    currentData = await mockStorage.get(['scrape_results']);
    assert.strictEqual(currentData.scrape_results.length, 2, 'Total must advance to 2 without getting stuck');

    // Final CSV export verification
    const csvRes = await simulateBuildCSV(mockStorage);
    assert.strictEqual(csvRes.afterCount, 2);
    assert.ok(csvRes.csv.includes('AD Salon & Spa'));
    assert.ok(csvRes.csv.includes('+966 53 881 1708'));
    assert.ok(csvRes.csv.includes('Base & Boon - Diriyah'));
  });

  console.log('\n====================================================');
  console.log(`TEST SUITE RESULTS: ${passedTests}/${totalTests} Passed`);
  console.log('====================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
