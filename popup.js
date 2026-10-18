/**
 * popup.js — Popup UI logic
 *
 * - Polls background for stats every second
 * - Shows real-time progress
 * - Handles Start / Stop / Download / Reset buttons
 * - Shows preview of last scraped items
 * - Download: gets CSV text from background, triggers download via <a> tag in popup
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const totalCount     = document.getElementById('totalCount');
const batchCount     = document.getElementById('batchCount');
const batchProgress  = document.getElementById('batchProgress');
const progressWrap   = document.getElementById('progressWrap');
const progressFill   = document.getElementById('progressFill');
const progressLabel  = document.getElementById('progressLabel');
const infoBox        = document.getElementById('infoBox');
const previewSection = document.getElementById('previewSection');
const previewList    = document.getElementById('previewList');
const chkNoWebsite   = document.getElementById('chkNoWebsite');

const btnStart    = document.getElementById('btnStart');
const btnStop     = document.getElementById('btnStop');
const btnDownload = document.getElementById('btnDownload');
const btnReset    = document.getElementById('btnReset');

// ── Local tracking ────────────────────────────────────────────────────────────
let isRunning  = false;
let lastTotal  = 0;
let pollTimer  = null;
let batchStart = 0;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (chkNoWebsite) {
    const data = await chrome.storage.local.get('onlyNoWebsite');
    chkNoWebsite.checked = !!data.onlyNoWebsite;

    chkNoWebsite.addEventListener('change', async () => {
      await chrome.storage.local.set({ onlyNoWebsite: chkNoWebsite.checked });
      refreshPreview();
      refreshStats();
    });
  }
  refreshStats();
  startPolling();
});

// ── Button handlers ───────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  // Verify we're on Google Maps
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes('google.com/maps')) {
    setStatus('error', 'Please open Google Maps first!');
    return;
  }

  // Get current total to use as batchStart for progress bar
  const stats = await getStats();
  batchStart  = stats.total;

  // Send start command — background will inject content script if needed
  const startResp = await chrome.runtime.sendMessage({ type: 'START_SCRAPE' });

  if (startResp && startResp.ok === false) {
    setStatus('error', 'Could not start: ' + (startResp.error || 'unknown error'));
    return;
  }

  isRunning = true;
  setRunningUI(true);
  setStatus('running', 'Scraping in progress…');
  infoBox.style.display    = 'none';
  progressWrap.style.display = 'block';
});

btnStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_SCRAPE' });
  isRunning = false;
  setRunningUI(false);
  setStatus('done', 'Stopped manually.');
  progressWrap.style.display = 'none';
});

btnDownload.addEventListener('click', async () => {
  const stats = await getStats();
  if (stats.total === 0) {
    setStatus('error', 'Nothing to download yet!');
    return;
  }

  btnDownload.disabled = true;
  setStatus('running', 'Preparing download…');

  try {
    // Ask background for the CSV text
    const resp = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_CSV',
      onlyNoWebsite: chkNoWebsite ? chkNoWebsite.checked : false,
    });

    if (!resp || !resp.csv) {
      setStatus('error', 'No data to download.');
      btnDownload.disabled = false;
      return;
    }

    // Build a data URI and trigger download via a hidden <a> tag
    // This works in the popup page (has full DOM access unlike service worker)
    const bom      = '\uFEFF';  // UTF-8 BOM so Excel opens it correctly
    const dataUri  = 'data:text/csv;charset=utf-8,' + encodeURIComponent(bom + resp.csv);
    const filename = `maps_leads_${Date.now()}.csv`;

    const a    = document.createElement('a');
    a.href     = dataUri;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    const countDownloaded = resp.count !== undefined ? resp.count : stats.total;
    setStatus('done', `Downloaded ${countDownloaded} records.`);
  } catch (err) {
    setStatus('error', 'Download failed: ' + err.message);
  }

  btnDownload.disabled = stats.total === 0;
});

btnReset.addEventListener('click', async () => {
  if (!confirm('Reset all scraped data? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ type: 'RESET' });
  totalCount.textContent       = '0';
  batchCount.textContent       = '0';
  batchProgress.textContent    = '0';
  progressFill.style.width     = '0%';
  progressLabel.textContent    = '0';
  previewSection.style.display = 'none';
  btnDownload.disabled         = true;
  infoBox.style.display        = 'block';
  setStatus('idle', 'Data reset. Ready to scrape again.');
  batchStart = 0;
  lastTotal  = 0;
});

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  pollTimer = setInterval(refreshStats, 1200);
}

async function refreshStats() {
  const stats = await getStats();

  totalCount.textContent = stats.total;
  batchCount.textContent = stats.batchCount;

  // Show how many scraped since Start was clicked
  const inBatch = Math.max(stats.total - batchStart, 0);
  batchProgress.textContent = inBatch;
  // Progress bar: rolls over every 100 so user can see activity
  const pct = (inBatch % 100);
  progressFill.style.width  = pct + '%';
  progressLabel.textContent = inBatch + ' scraped';

  // Enable download if we have data
  btnDownload.disabled = stats.total === 0;

  // If background says scraping stopped (natural end), update UI
  if (isRunning && !stats.isRunning) {
    isRunning = false;
    setRunningUI(false);
    setStatus('done', `Done — ${stats.total} total records scraped.`);
    progressWrap.style.display = 'none';
  }

  // Refresh preview when total changes
  if (stats.total !== lastTotal) {
    lastTotal = stats.total;
    await refreshPreview();
  }
}

async function getStats() {
  try {
    return await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  } catch {
    return { total: 0, isRunning: false, batchCount: 0 };
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────
async function refreshPreview() {
  try {
    const data    = await chrome.storage.local.get(['scrape_results', 'onlyNoWebsite']);
    let results   = data['scrape_results'] || [];
    const filterActive = chkNoWebsite ? chkNoWebsite.checked : !!data['onlyNoWebsite'];

    if (filterActive) {
      results = results.filter(r => !r.link || r.link.trim() === '');
    }

    if (results.length === 0) { previewSection.style.display = 'none'; return; }

    // Show last 5 items matching filter
    const last5 = results.slice(-5).reverse();
    previewList.innerHTML = last5.map(r => `
      <div class="preview-item">
        <div class="preview-name">${escapeHtml(r.name || '—')}</div>
        ${r.phone ? `<div class="preview-phone">📞 ${escapeHtml(r.phone)}</div>` : ''}
        <div class="preview-link ${r.link ? '' : 'null-val'}">
          ${r.link ? `🌐 <a href="${escapeHtml(r.link)}" target="_blank" style="color: inherit; text-decoration: none;">${escapeHtml(r.link)}</a>` : '🚫 No website'}
        </div>
        ${r.profileUrl ? `
          <div class="preview-profile">
            <a href="${escapeHtml(r.profileUrl)}" target="_blank" style="color: #38bdf8; text-decoration: none; font-size: 10.5px; word-break: break-all;">📍 Maps Profile</a>
          </div>
        ` : ''}
      </div>
    `).join('');

    previewSection.style.display = 'block';
  } catch { /* storage error */ }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setRunningUI(running) {
  btnStart.disabled = running;
  btnStop.disabled  = !running;
  btnReset.disabled = running;
}

function setStatus(type, text) {
  statusText.textContent = text;
  statusDot.className    = 'status-dot';
  if (type === 'running') statusDot.classList.add('running');
  if (type === 'done')    statusDot.classList.add('done');
  if (type === 'error')   statusDot.classList.add('error');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
