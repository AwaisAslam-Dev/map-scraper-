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
  extractContactFromHtml,
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
