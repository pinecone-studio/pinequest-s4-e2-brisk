'use strict';

const SNAPSHOT_INTERVAL = 3000;

// Stats counters
let stats = { total: 0, smoking: 0, garbage: 0, cameras_online: 0 };

function updateStatEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function refreshStats() {
  fetch('/api/stats')
    .then(r => r.json())
    .then(data => {
      stats = data;
      updateStatEl('stat-total',   data.total);
      updateStatEl('stat-smoking', data.smoking);
      updateStatEl('stat-garbage', data.garbage);
      updateStatEl('stat-cameras', data.cameras_online);
    })
    .catch(() => {});
}

// Camera snapshots
function refreshSnapshots() {
  document.querySelectorAll('.camera-tile img[data-cam]').forEach(img => {
    const camId = img.dataset.cam;
    img.src = `/api/snapshot/${camId}?t=${Date.now()}`;
  });
}

function refreshCameraStatus() {
  fetch('/api/cameras')
    .then(r => r.json())
    .then(cams => {
      cams.forEach(cam => {
        const tile = document.querySelector(`.camera-tile[data-cam="${cam.id}"]`);
        if (!tile) return;
        const badge = tile.querySelector('.cam-badge');
        if (badge) {
          badge.textContent = cam.online ? 'LIVE' : 'OFFLINE';
          badge.className = 'cam-badge ' + (cam.online ? 'online' : 'offline');
        }
        tile.classList.toggle('cam-offline', !cam.online);
      });
    })
    .catch(() => {});
}

// Violation feed
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  return d.toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildFeedItem(v) {
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.dataset.id = v.id;

  const thumbSrc = v.image_path
    ? `/evidence/${v.image_path.replace(/^evidence\//, '')}`
    : '';
  const confPct = Math.round((v.confidence || 0) * 100);

  item.innerHTML = `
    <img class="feed-thumb" src="${thumbSrc}" alt="evidence" onerror="this.style.opacity=0.2">
    <div class="feed-info">
      <span class="feed-badge ${v.type}">${v.type.toUpperCase()}</span>
      <div class="feed-meta">${v.camera_id} &bull; Floor ${v.floor} &bull; ${v.zone}</div>
      <div class="feed-time">${formatTime(v.created_at)} &bull; ${confPct}% conf</div>
      <div class="conf-bar"><div class="conf-fill" style="width:${confPct}%"></div></div>
    </div>`;
  return item;
}

function prependViolation(v) {
  const feed = document.getElementById('violation-feed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();
  feed.insertBefore(buildFeedItem(v), feed.firstChild);

  // Keep feed from growing unbounded
  while (feed.children.length > 100) feed.removeChild(feed.lastChild);
}

function loadInitialViolations() {
  fetch('/api/violations')
    .then(r => r.json())
    .then(violations => {
      const feed = document.getElementById('violation-feed');
      feed.innerHTML = '';
      if (!violations.length) {
        feed.innerHTML = '<div class="feed-empty">No violations recorded today</div>';
        return;
      }
      violations.forEach(v => feed.appendChild(buildFeedItem(v)));
    })
    .catch(() => {});
}

// WebSocket
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (evt) => {
    try {
      const v = JSON.parse(evt.data);
      prependViolation(v);
      // bump counters
      stats.total++;
      if (v.type === 'smoking') stats.smoking++;
      if (v.type === 'garbage') stats.garbage++;
      updateStatEl('stat-total',   stats.total);
      updateStatEl('stat-smoking', stats.smoking);
      updateStatEl('stat-garbage', stats.garbage);
    } catch (e) { /* ignore */ }
  };

  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  refreshStats();
  refreshCameraStatus();
  loadInitialViolations();
  connectWS();

  setInterval(refreshSnapshots,     SNAPSHOT_INTERVAL);
  setInterval(refreshCameraStatus,  SNAPSHOT_INTERVAL);
  setInterval(refreshStats,         10_000);

  // Immediate first snapshot
  refreshSnapshots();
});
