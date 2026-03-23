// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_MINS = 10;       // minutes per stop (park + physical delivery)
const DEFAULT_SPEED = 30;      // km/h Singapore urban average

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  jobs: [],
  startLocation: null,   // { lat, lng, address, postal }
  optimizedRoute: [],    // ordered stop objects with ETA annotations
  map: null,
  mapMarkers: [],
  fuelKmpl: null,
  fuelPrice: null,
  avgSpeed: null,
};

// ─── Persistence ──────────────────────────────────────────────────────────────

function save() {
  localStorage.setItem('jkd_jobs',     JSON.stringify(state.jobs));
  localStorage.setItem('jkd_location', JSON.stringify(state.startLocation));
  localStorage.setItem('jkd_fuel',     JSON.stringify({
    kmpl:  state.fuelKmpl,
    price: state.fuelPrice,
    speed: state.avgSpeed,
  }));
}

function load() {
  try {
    const jobs = localStorage.getItem('jkd_jobs');
    const loc  = localStorage.getItem('jkd_location');
    const fuel = localStorage.getItem('jkd_fuel');
    if (jobs) state.jobs = JSON.parse(jobs);
    if (loc)  state.startLocation = JSON.parse(loc);
    if (fuel) {
      const f = JSON.parse(fuel);
      state.fuelKmpl  = f.kmpl;
      state.fuelPrice = f.price;
      state.avgSpeed  = f.speed;
    }
  } catch (e) { /* ignore */ }
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function timeToMins(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minsToTimeStr(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function nowMins() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function fmtDuration(mins) {
  if (mins == null || mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}min`;
  return `${h}h ${m}min`;
}

// ─── OneMap Geocoding ─────────────────────────────────────────────────────────

async function geocodePostal(postal) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(postal)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Network error');
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  const r = data.results[0];
  return {
    postal,
    lat: parseFloat(r.LATITUDE),
    lng: parseFloat(r.LONGITUDE),
    address: buildAddress(r),
  };
}

function buildAddress(r) {
  const parts = [];
  if (r.BLK_NO && r.BLK_NO !== 'NIL') parts.push(r.BLK_NO);
  if (r.ROAD_NAME && r.ROAD_NAME !== 'NIL') parts.push(r.ROAD_NAME);
  if (r.BUILDING && r.BUILDING !== 'NIL' && r.BUILDING !== r.ROAD_NAME) parts.push(r.BUILDING);
  return parts.join(' ') || r.ADDRESS;
}

// ─── Route Optimization (Time-Window Aware) ───────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Time-aware nearest-neighbour for the Pickup-and-Delivery Problem.
 *
 * At each step:
 *   1. Filter to stops that are reachable before their time-window closes
 *      (if the stop has a TW; if not, it's always available).
 *   2. Score each candidate:  urgency × 1000 + distance
 *      urgency = how soon the TW deadline is after we arrive (lower slack = higher urgency)
 *   3. Pick lowest score.
 *   4. Advance current time:  travel_time + wait_if_early + SERVICE_MINS.
 *
 * If NO stop is reachable in time, fall back to the most urgent remaining stop
 * and mark it isLate = true.
 */
function computeRoute(jobs, startLat, startLng, startTimeMins, speedKmh) {
  const speed = speedKmh || DEFAULT_SPEED;
  const activeJobs = jobs.filter(j => j.status !== 'delivered');
  if (activeJobs.length === 0) return [];

  // Build stop pool
  const stops = [];
  activeJobs.forEach(job => {
    if (job.status === 'pending') {
      stops.push({
        type: 'pickup',
        jobId: job.id,
        lat: job.pickup.lat,
        lng: job.pickup.lng,
        twStart: timeToMins(job.pickupTwStart),
        twEnd:   timeToMins(job.pickupTwEnd),
        job,
      });
    }
    stops.push({
      type: 'dropoff',
      jobId: job.id,
      lat: job.dropoff.lat,
      lng: job.dropoff.lng,
      twStart: timeToMins(job.dropoffTwStart),
      twEnd:   timeToMins(job.dropoffTwEnd),
      job,
    });
  });

  const done     = new Set();
  const pickedUp = new Set();

  // Jobs already picked up
  activeJobs.forEach(job => {
    if (job.status === 'picked_up') pickedUp.add(job.id);
  });

  // Relative dropoff window durations
  const RELATIVE_MINS = { immediate: 30, '1hr': 60, '3hr': 180 };

  // Seed start position
  let curLat  = startLat;
  let curLng  = startLng;
  let curTime = startTimeMins; // null = ignore time windows

  if (curLat == null) {
    const first = stops.find(s => s.type === 'pickup');
    if (first) { curLat = first.lat; curLng = first.lng; }
  }

  const result = [];

  while (result.length < stops.length) {

    // --- candidates: not done, pickup constraint, TW reachable ---
    const candidates = stops.filter(s => {
      if (done.has(s.jobId + s.type)) return false;
      if (s.type === 'dropoff' && !pickedUp.has(s.jobId)) return false;
      if (curTime != null && s.twEnd != null) {
        const dist  = haversineKm(curLat, curLng, s.lat, s.lng);
        const tMins = (dist / speed) * 60;
        if (curTime + tMins > s.twEnd) return false; // can't make it
      }
      return true;
    });

    // Fallback if all time-feasible stops are exhausted (mark as late)
    const pool = candidates.length > 0 ? candidates : stops.filter(s => {
      if (done.has(s.jobId + s.type)) return false;
      if (s.type === 'dropoff' && !pickedUp.has(s.jobId)) return false;
      return true;
    });

    if (pool.length === 0) break;
    const isLate = candidates.length === 0;

    // --- score each candidate ---
    let best = null, bestScore = Infinity;

    for (const s of pool) {
      const dist    = haversineKm(curLat, curLng, s.lat, s.lng);
      const tMins   = (dist / speed) * 60;
      const arrival = curTime != null ? curTime + tMins : null;

      // Urgency: minutes of slack after arrival before TW closes (lower = more urgent)
      let urgency = 0;
      if (arrival != null && s.twEnd != null) {
        const slack = s.twEnd - arrival;
        urgency = -slack; // negative slack → very urgent
      } else if (s.twEnd != null) {
        urgency = -s.twEnd; // has deadline but no time tracking → prioritise earlier deadline
      }

      const score = urgency * 1000 + dist;
      if (score < bestScore) { bestScore = score; best = { s, dist, tMins, arrival }; }
    }

    const { s, dist, tMins, arrival } = best;

    // Compute wait and departure
    let serviceStart = arrival;
    let isEarly = false;
    if (arrival != null && s.twStart != null && arrival < s.twStart) {
      serviceStart = s.twStart;
      isEarly = true;
    }
    const departure = serviceStart != null ? serviceStart + SERVICE_MINS : null;

    // Annotate stop (clone to avoid mutating original)
    const annotated = {
      ...s,
      estimatedArrival:   arrival,
      estimatedDeparture: departure,
      waitMins: isEarly ? (s.twStart - arrival) : 0,
      isLate:  isLate && s.twEnd != null,
      isEarly,
    };

    result.push(annotated);
    done.add(s.jobId + s.type);

    // After pickup: dynamically set dropoff time window based on relative/custom constraint
    if (s.type === 'pickup') {
      pickedUp.add(s.jobId);
      const relKey = s.job.dropoffRelative;
      const dropoffStop = stops.find(st => st.jobId === s.jobId && st.type === 'dropoff');
      if (dropoffStop) {
        if (relKey === 'custom') {
          // Use stored absolute time window as-is
          dropoffStop.twStart = timeToMins(s.job.dropoffTwStart);
          dropoffStop.twEnd   = timeToMins(s.job.dropoffTwEnd);
        } else if (relKey && RELATIVE_MINS[relKey] != null && departure != null) {
          dropoffStop.twStart = departure;
          dropoffStop.twEnd   = departure + RELATIVE_MINS[relKey];
        }
      }
    }

    curLat  = s.lat;
    curLng  = s.lng;
    if (departure != null) curTime = departure;
  }

  return result;
}

function totalRouteKm(route) {
  if (route.length === 0) return 0;
  let dist = 0;
  const sl = state.startLocation;
  if (sl) dist += haversineKm(sl.lat, sl.lng, route[0].lat, route[0].lng);
  for (let i = 0; i < route.length - 1; i++) {
    dist += haversineKm(route[i].lat, route[i].lng, route[i+1].lat, route[i+1].lng);
  }
  return dist;
}

function totalRouteMins(route, speedKmh) {
  if (route.length === 0) return 0;
  const speed = speedKmh || DEFAULT_SPEED;
  let dist = totalRouteKm(route);
  const driveMins = (dist / speed) * 60;
  const serviceMins = route.length * SERVICE_MINS;
  const waitMins = route.reduce((s, r) => s + (r.waitMins || 0), 0);
  return driveMins + serviceMins + waitMins;
}

// ─── Map ──────────────────────────────────────────────────────────────────────

function initMap() {
  if (state.map) return;
  state.map = L.map('map', { zoomControl: true }).setView([1.3521, 103.8198], 12);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(state.map);
}

function renderMap() {
  initMap();
  state.mapMarkers.forEach(m => state.map.removeLayer(m));
  state.mapMarkers = [];
  const bounds = [];

  if (state.startLocation) {
    const { lat, lng, address } = state.startLocation;
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:28px;height:28px;border-radius:50%;background:#2563eb;border:3px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:13px;">🏠</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14],
    });
    const m = L.marker([lat, lng], { icon }).addTo(state.map).bindPopup(`<b>Start</b><br>${address}`);
    state.mapMarkers.push(m);
    bounds.push([lat, lng]);
  }

  const stops = state.optimizedRoute.length > 0 ? state.optimizedRoute : buildRawStops();

  stops.forEach((stop, i) => {
    const isPickup = stop.type === 'pickup';
    const color    = isPickup ? '#16a34a' : '#dc2626';
    const isDone   = (isPickup && stop.job.status !== 'pending') || stop.job.status === 'delivered';
    const bgColor  = stop.isLate ? '#dc2626' : isDone ? '#94a3b8' : color;

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:26px;height:26px;border-radius:50%;background:${bgColor};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35);color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${i + 1}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });

    const address = isPickup ? stop.job.pickup.address : stop.job.dropoff.address;
    const postal  = isPickup ? stop.job.pickup.postal  : stop.job.dropoff.postal;
    const eta     = stop.estimatedArrival != null ? `ETA ${minsToTimeStr(stop.estimatedArrival)}` : '';
    const tw      = stop.twStart != null ? `Window: ${minsToTimeStr(stop.twStart)}–${minsToTimeStr(stop.twEnd)}` : '';
    const lateTag = stop.isLate ? ' ⚠ LATE' : '';

    const m = L.marker([stop.lat, stop.lng], { icon }).addTo(state.map).bindPopup(
      `<b>${isPickup ? 'PICKUP' : 'DROPOFF'} #${i + 1}${lateTag}</b><br>${address}<br><small>${postal}</small>` +
      (eta ? `<br><small>${eta}</small>` : '') +
      (tw  ? `<br><small>${tw}</small>` : '') +
      `<br><a href="https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}" target="_blank">Open in Google Maps</a>`
    );
    state.mapMarkers.push(m);
    bounds.push([stop.lat, stop.lng]);
  });

  if (bounds.length > 0) state.map.fitBounds(bounds, { padding: [36, 36] });
}

function buildRawStops() {
  const stops = [];
  state.jobs.filter(j => j.status !== 'delivered').forEach(job => {
    if (job.status === 'pending')
      stops.push({ type: 'pickup', lat: job.pickup.lat, lng: job.pickup.lng, job });
    stops.push({ type: 'dropoff', lat: job.dropoff.lat, lng: job.dropoff.lng, job });
  });
  return stops;
}

// ─── Render: Next ────────────────────────────────────────────────────────────

let _nextRefreshTimer = null;

function findNextStop() {
  return state.optimizedRoute.find(s => {
    if (s.type === 'pickup')  return s.job.status === 'pending';
    if (s.type === 'dropoff') return s.job.status !== 'delivered';
    return false;
  }) || null;
}

function renderNext() {
  const container = document.getElementById('next-content');
  if (!container) return;

  const activeJobs = state.jobs.filter(j => j.status !== 'delivered');

  // ── No active jobs ──
  if (activeJobs.length === 0) {
    container.innerHTML = `
      <div class="next-empty">
        <div class="next-empty-icon">🎉</div>
        <h2>All done for today!</h2>
        <p>All jobs have been delivered.<br>Great work!</p>
      </div>`;
    return;
  }

  // ── No route optimized ──
  const stop = findNextStop();
  if (!stop) {
    container.innerHTML = `
      <div class="next-empty">
        <div class="next-empty-icon">🗺️</div>
        <h2>No route yet</h2>
        <p>Head to the <b>Route</b> tab and tap <b>Optimize</b> to plan your stops.</p>
      </div>`;
    return;
  }

  const isPickup  = stop.type === 'pickup';
  const job       = stop.job;
  const address   = isPickup ? job.pickup.address  : job.dropoff.address;
  const postal    = isPickup ? job.pickup.postal   : job.dropoff.postal;
  const lat       = stop.lat;
  const lng       = stop.lng;

  // Stop position in route
  const stopIdx      = state.optimizedRoute.indexOf(stop) + 1;
  const totalRemaining = state.optimizedRoute.filter(s => {
    if (s.type === 'pickup')  return s.job.status === 'pending';
    if (s.type === 'dropoff') return s.job.status !== 'delivered';
    return false;
  }).length;

  // Time calculations (live, based on current clock)
  const now         = nowMins();
  const eta         = stop.estimatedArrival;           // mins since midnight from optimization
  const twEnd       = stop.twEnd;
  const twStart     = stop.twStart;
  const speed       = state.avgSpeed || DEFAULT_SPEED;

  // Travel time from current/start location to this stop
  const sl = state.startLocation;
  let travelMins = null;
  if (sl) {
    const dist = haversineKm(sl.lat, sl.lng, lat, lng);
    travelMins = Math.round((dist / speed) * 60);
  }

  // Time until deadline from now
  const minsToDeadline = twEnd != null ? Math.round(twEnd - now) : null;

  // Urgency
  let urgencyCls   = 'none';
  let urgencyText  = 'No deadline';
  if (minsToDeadline != null) {
    if (minsToDeadline < 0)  { urgencyCls = 'danger'; urgencyText = `Overdue ${Math.abs(minsToDeadline)} min`; }
    else if (minsToDeadline < 15) { urgencyCls = 'danger'; urgencyText = `${minsToDeadline} min left`; }
    else if (minsToDeadline < 30) { urgencyCls = 'warn';   urgencyText = `${minsToDeadline} min left`; }
    else                          { urgencyCls = 'ok';     urgencyText = `${minsToDeadline} min left`; }
  }

  // Equipment chips
  const equipHtml = (job.equipment && job.equipment.length > 0)
    ? `<div class="next-equip-row">
        ${job.equipment.map(e =>
          `<div class="next-equip-chip">${e === 'trolley' ? '🛒 Trolley' : '🧊 Food Bag'}</div>`
        ).join('')}
      </div>`
    : '';

  // Contractor / service type badges
  const cls    = job.contractor ? job.contractor.toLowerCase() : '';
  const svcCls = job.orderType  ? job.orderType.toLowerCase()  : '';
  const badgesHtml = `
    <div class="next-badges">
      ${job.contractor ? `<span class="contractor-badge ${cls}">${job.contractor}</span>` : ''}
      ${job.orderType  ? `<span class="service-badge ${svcCls}">${job.orderType}</span>`  : ''}
    </div>`;

  // Time block rows
  const etaRow = eta != null
    ? `<div class="next-time-row"><span class="next-time-label">Estimated arrival</span><span class="next-time-value">${minsToTimeStr(eta)}</span></div>`
    : '';
  const travelRow = travelMins != null
    ? `<div class="next-time-row"><span class="next-time-label">Travel time from start</span><span class="next-time-value">~${travelMins} min</span></div>`
    : '';
  const windowRow = (twStart != null || twEnd != null)
    ? `<div class="next-time-row"><span class="next-time-label">Time window</span><span class="next-time-value">${minsToTimeStr(twStart) || '—'} – ${minsToTimeStr(twEnd) || '—'}</span></div>`
    : '';
  const deadlineRow = minsToDeadline != null
    ? `<div class="next-deadline-row">
        <span class="next-deadline-label">Time until deadline</span>
        <span class="next-urgency ${urgencyCls}">${urgencyText}</span>
      </div>`
    : '';

  const hasTimeInfo = etaRow || travelRow || windowRow || deadlineRow;

  // Action button
  const actionBtn = isPickup
    ? `<button class="next-status-btn pickup" onclick="setStatus('${job.id}','picked_up');renderNext()">✓ Picked Up</button>`
    : `<button class="next-status-btn dropoff" onclick="setStatus('${job.id}','delivered');renderNext()">✓ Delivered</button>`;

  // After-this stop
  const nextIdx  = state.optimizedRoute.indexOf(stop) + 1;
  const afterStop = nextIdx < state.optimizedRoute.length ? state.optimizedRoute[nextIdx] : null;
  const afterHtml = afterStop ? (() => {
    const aIsPickup = afterStop.type === 'pickup';
    const aAddr     = aIsPickup ? afterStop.job.pickup.address  : afterStop.job.dropoff.address;
    const aEta      = afterStop.estimatedArrival;
    return `
      <div class="next-after-card">
        <div class="next-after-title">After this</div>
        <div class="next-after-row">
          <span class="next-after-type ${afterStop.type}">${aIsPickup ? 'Pickup' : 'Dropoff'}</span>
          <span class="next-after-addr">${escHtml(aAddr)}</span>
          ${aEta != null ? `<span class="next-after-eta">${minsToTimeStr(aEta)}</span>` : ''}
        </div>
      </div>`;
  })() : '';

  container.innerHTML = `
    <div class="next-card">
      <div class="next-card-header ${stop.type}">
        <span class="next-type-label ${stop.type}">${isPickup ? '📦 Pickup' : '🏠 Dropoff'}</span>
        <span class="next-stop-counter">Stop ${stopIdx} · ${totalRemaining} remaining</span>
      </div>
      <div class="next-card-body">
        ${badgesHtml}
        <div>
          <div class="next-address">${escHtml(address)}</div>
          <div class="next-postal">${postal}</div>
        </div>
        ${hasTimeInfo ? `<div class="next-time-block">${etaRow}${travelRow}${windowRow}${deadlineRow}</div>` : ''}
        ${equipHtml}
        ${job.note ? `<div class="next-note">📝 ${escHtml(job.note)}</div>` : ''}
        <button class="next-nav-btn" onclick="navTo(${lat},${lng})">↗ Navigate</button>
        ${actionBtn}
      </div>
    </div>
    ${afterHtml}`;
}

// Auto-refresh the Next tab every minute (keeps countdown live)
function startNextRefresh() {
  stopNextRefresh();
  _nextRefreshTimer = setInterval(() => {
    const nextTab = document.getElementById('tab-next');
    if (nextTab && nextTab.classList.contains('active')) renderNext();
  }, 60000);
}

function stopNextRefresh() {
  if (_nextRefreshTimer) { clearInterval(_nextRefreshTimer); _nextRefreshTimer = null; }
}

// ─── Render: Jobs ─────────────────────────────────────────────────────────────

function renderJobs() {
  const container = document.getElementById('job-list');
  const pending   = state.jobs.filter(j => j.status === 'pending');
  const pickedUp  = state.jobs.filter(j => j.status === 'picked_up');
  const delivered = state.jobs.filter(j => j.status === 'delivered');

  const active = pending.length + pickedUp.length;
  const badge  = document.getElementById('header-badge');
  if (active > 0) { badge.textContent = `${active} active`; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const clearRow = document.getElementById('clear-all-row');
  delivered.length > 0 ? clearRow.classList.remove('hidden') : clearRow.classList.add('hidden');

  if (state.jobs.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>No jobs yet.<br>Add your first pickup above.</p></div>`;
    return;
  }

  let html = '';
  if (pending.length)  { html += `<div class="section-label">Pending (${pending.length})</div>`; html += pending.map(jobCardHTML).join(''); }
  if (pickedUp.length) { html += `<div class="section-label">Picked Up (${pickedUp.length})</div>`; html += pickedUp.map(jobCardHTML).join(''); }
  if (delivered.length){ html += `<div class="section-label">Delivered (${delivered.length})</div>`; html += delivered.map(jobCardHTML).join(''); }
  container.innerHTML = html;
}

function twDisplay(start, end) {
  if (!start && !end) return '';
  if (start && end)   return `${start} – ${end}`;
  if (start)          return `From ${start}`;
  return `Until ${end}`;
}

function jobCardHTML(job) {
  const cls         = job.contractor ? job.contractor.toLowerCase() : '';
  const statusClass = { pending: '', picked_up: 'status-picked-up', delivered: 'status-delivered' }[job.status];
  const svcCls      = job.orderType ? job.orderType.toLowerCase() : '';

  const actionBtn = {
    pending:   `<button class="btn-status btn-pickup"  onclick="setStatus('${job.id}','picked_up')">✓ Picked Up</button>`,
    picked_up: `<button class="btn-status btn-deliver" onclick="setStatus('${job.id}','delivered')">✓ Delivered</button>`,
    delivered: `<span style="font-size:12px;color:var(--muted)">Done</span>`,
  }[job.status];

  const pickupTw  = twDisplay(job.pickupTwStart, job.pickupTwEnd);
  const relativeLabel = job.dropoffRelative === 'custom'
    ? (job.dropoffTwStart || job.dropoffTwEnd ? `⏰ Dropoff ${twDisplay(job.dropoffTwStart, job.dropoffTwEnd)}` : '')
    : ({ immediate: '⚡ Dropoff within 30 min', '1hr': '⏱ Dropoff within 1 hr', '3hr': '⏱ Dropoff within 3 hrs' }[job.dropoffRelative] || '');
  const equipTags = (job.equipment || []).map(e =>
    `<span class="equip-tag">${e === 'trolley' ? '🛒' : '🧊'} ${e}</span>`
  ).join('');

  return `
<div class="job-card ${statusClass}">
  <div class="job-header">
    <span class="contractor-badge ${cls}">${job.contractor || 'No Contractor'}</span>
    ${job.orderType ? `<span class="service-badge ${svcCls}">${job.orderType}</span>` : ''}
    <span class="job-header-right"><button class="job-delete-btn" onclick="deleteJob('${job.id}')" title="Delete">✕</button></span>
  </div>
  ${equipTags ? `<div class="job-note" style="margin-bottom:6px">${equipTags}</div>` : ''}
  ${job.note ? `<div class="job-note">📝 ${escHtml(job.note)}</div>` : ''}
  <div class="job-stops">
    <div class="stop-row">
      <div class="stop-icon pickup">P</div>
      <div class="stop-address">
        <div class="stop-postal">${job.pickup.postal}</div>
        <div class="stop-addr-text">${escHtml(job.pickup.address)}</div>
        ${pickupTw ? `<div class="stop-tw">⏰ ${pickupTw}</div>` : ''}
      </div>
    </div>
    <div class="stop-row">
      <div class="stop-icon dropoff">D</div>
      <div class="stop-address">
        <div class="stop-postal">${job.dropoff.postal}</div>
        <div class="stop-addr-text">${escHtml(job.dropoff.address)}</div>
        ${relativeLabel ? `<div class="stop-tw">${relativeLabel}</div>` : ''}
      </div>
    </div>
  </div>
  <div class="job-actions">
    ${actionBtn}
    <button class="btn-nav-sm" onclick="navTo(${job.pickup.lat},${job.pickup.lng})">↗ Pickup</button>
    <button class="btn-nav-sm" onclick="navTo(${job.dropoff.lat},${job.dropoff.lng})">↗ Dropoff</button>
  </div>
</div>`;
}

// ─── Render: Route ────────────────────────────────────────────────────────────

function renderRoute() {
  const list    = document.getElementById('route-list');
  const summary = document.getElementById('route-summary');
  const active  = state.jobs.filter(j => j.status !== 'delivered');

  if (state.optimizedRoute.length === 0) {
    summary.textContent = active.length === 0
      ? 'No active jobs.'
      : `${active.length} active job(s) · Press Optimize to plan your route.`;
    list.innerHTML = active.length === 0
      ? `<div class="empty-state"><div class="empty-icon">🎉</div><p>All jobs completed!</p></div>`
      : '';
    return;
  }

  const speed    = state.avgSpeed || DEFAULT_SPEED;
  const km       = totalRouteKm(state.optimizedRoute);
  const totalMin = totalRouteMins(state.optimizedRoute, speed);
  const lateCount= state.optimizedRoute.filter(s => s.isLate).length;
  const lateNote = lateCount > 0 ? ` · ⚠ ${lateCount} late` : '';
  summary.textContent = `${state.optimizedRoute.length} stops · ~${km.toFixed(1)} km · ~${fmtDuration(totalMin)}${lateNote}`;

  list.innerHTML = state.optimizedRoute.map((stop, i) => {
    const isPickup = stop.type === 'pickup';
    const address  = isPickup ? stop.job.pickup.address : stop.job.dropoff.address;
    const postal   = isPickup ? stop.job.pickup.postal  : stop.job.dropoff.postal;
    const isDone   = (isPickup && stop.job.status !== 'pending') || stop.job.status === 'delivered';
    const numCls   = isDone ? 'done' : stop.type;

    // ETA section
    let etaHtml = '';
    if (stop.estimatedArrival != null) {
      const twStr = (stop.twStart != null)
        ? `<span class="eta-tw">Window: ${minsToTimeStr(stop.twStart)}–${minsToTimeStr(stop.twEnd)}</span>`
        : '';
      let tag = '';
      if (stop.isLate)  tag = `<span class="eta-tag late">Late</span>`;
      else if (stop.isEarly) tag = `<span class="eta-tag early">Wait ${stop.waitMins|0}min</span>`;
      else if (stop.twEnd != null) tag = `<span class="eta-tag ok">On time</span>`;

      etaHtml = `<div class="route-stop-eta">
        <span class="eta-time">ETA ${minsToTimeStr(stop.estimatedArrival)}</span>
        ${twStr}${tag}
      </div>`;
    }

    const stopCls = stop.isLate ? 'is-late' : stop.isEarly ? 'is-early' : '';

    return `
<div class="route-stop ${isDone ? 'is-done' : ''} ${stopCls}">
  <div class="stop-num ${numCls}">${i + 1}</div>
  <div class="route-stop-body">
    <div class="route-stop-type ${stop.type}">${isPickup ? 'PICKUP' : 'DROPOFF'}</div>
    <div class="route-stop-address">${escHtml(address)}</div>
    <div class="route-stop-meta">${postal}${stop.job.contractor ? ' · ' + stop.job.contractor : ''}${stop.job.orderType ? ' · ' + stop.job.orderType : ''}${stop.job.note ? ' · ' + escHtml(stop.job.note) : ''}</div>
    ${etaHtml}
  </div>
  <button class="btn-nav-sm" onclick="navTo(${stop.lat},${stop.lng})" style="flex-shrink:0">↗</button>
</div>`;
  }).join('');
}

// ─── Render: Stats ────────────────────────────────────────────────────────────

function renderStats() {
  const speed   = state.avgSpeed || DEFAULT_SPEED;
  const total   = state.jobs.length;
  const pending = state.jobs.filter(j => j.status === 'pending').length;
  const done    = state.jobs.filter(j => j.status === 'delivered').length;
  const active  = state.jobs.filter(j => j.status !== 'delivered').length;

  document.getElementById('stat-jobs').textContent   = total;
  document.getElementById('stat-stops').textContent  = total * 2;

  const hasRoute = state.optimizedRoute.length > 0;
  const noRouteEl = document.getElementById('stat-no-route');

  if (hasRoute) {
    const km      = totalRouteKm(state.optimizedRoute);
    const durMins = totalRouteMins(state.optimizedRoute, speed);
    document.getElementById('stat-distance').textContent = km.toFixed(1);
    document.getElementById('stat-duration').textContent = fmtDuration(durMins);
    noRouteEl.classList.add('hidden');

    // Fuel calculator
    const kmpl  = state.fuelKmpl;
    const price = state.fuelPrice;
    document.getElementById('fr-distance').textContent = `${km.toFixed(1)} km`;
    if (kmpl && kmpl > 0) {
      const litres = km / kmpl;
      document.getElementById('fr-litres').textContent = `${litres.toFixed(2)} L`;
      if (price && price > 0) {
        const cost = litres * price;
        document.getElementById('fr-cost').textContent = `S$ ${cost.toFixed(2)}`;
      } else {
        document.getElementById('fr-cost').textContent = '—';
      }
    } else {
      document.getElementById('fr-litres').textContent = '—';
      document.getElementById('fr-cost').textContent   = '—';
    }
  } else {
    document.getElementById('stat-distance').textContent = '—';
    document.getElementById('stat-duration').textContent = '—';
    noRouteEl.classList.remove('hidden');
    document.getElementById('fr-distance').textContent = '—';
    document.getElementById('fr-litres').textContent   = '—';
    document.getElementById('fr-cost').textContent     = '—';
  }

  // Jobs breakdown bar chart
  const breakdown = [
    { label: 'Pending',   count: pending,             color: '#2563eb' },
    { label: 'Picked Up', count: active - pending,    color: '#d97706' },
    { label: 'Delivered', count: done,                color: '#16a34a' },
  ];
  const max = Math.max(total, 1);

  document.getElementById('jobs-breakdown').innerHTML = breakdown.map(row => `
<div class="breakdown-row">
  <span class="breakdown-label">${row.label}</span>
  <div class="breakdown-bar-wrap">
    <div class="breakdown-bar" style="width:${(row.count / max * 100).toFixed(0)}%;background:${row.color}"></div>
  </div>
  <span class="breakdown-count" style="color:${row.color}">${row.count}</span>
</div>`).join('');
}

// ─── Render: Location ─────────────────────────────────────────────────────────

function renderLocation() {
  const el = document.getElementById('location-display');
  el.textContent = state.startLocation
    ? `📍 ${state.startLocation.address}`
    : 'Not set';
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleAddJob() {
  const contractor      = document.getElementById('contractor').value;
  const orderType       = document.getElementById('order-type').value;
  const pickupPostal    = document.getElementById('pickup-postal').value.trim();
  const dropoffPostal   = document.getElementById('dropoff-postal').value.trim();
  const pickupTwStart   = document.getElementById('pickup-tw-start').value;
  const pickupTwEnd     = document.getElementById('pickup-tw-end').value;
  const dropoffRelative  = document.getElementById('dropoff-relative').value;
  const dropoffTwStart   = document.getElementById('dropoff-tw-start').value;
  const dropoffTwEnd     = document.getElementById('dropoff-tw-end').value;
  const note             = document.getElementById('job-note').value.trim();

  if (dropoffRelative === 'custom' && dropoffTwStart && dropoffTwEnd && dropoffTwStart >= dropoffTwEnd) {
    toast('Dropoff window: start must be before end'); return;
  }
  const equipment       = [...document.querySelectorAll('.equip-btn.active')].map(b => b.dataset.equip);

  if (!/^\d{6}$/.test(pickupPostal))  { toast('Enter a valid 6-digit pickup postal code'); return; }
  if (!/^\d{6}$/.test(dropoffPostal)) { toast('Enter a valid 6-digit dropoff postal code'); return; }
  if (pickupTwStart && pickupTwEnd && pickupTwStart >= pickupTwEnd) { toast('Pickup window: start must be before end'); return; }

  const btn = document.getElementById('add-job-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Geocoding…';

  try {
    const [pickup, dropoff] = await Promise.all([
      geocodePostal(pickupPostal),
      geocodePostal(dropoffPostal),
    ]);
    if (!pickup)  { toast(`Postal ${pickupPostal} not found`);  return; }
    if (!dropoff) { toast(`Postal ${dropoffPostal} not found`); return; }

    state.jobs.push({
      id: uid(),
      contractor, orderType,
      pickup, dropoff,
      pickupTwStart:  pickupTwStart  || null,
      pickupTwEnd:    pickupTwEnd    || null,
      dropoffRelative:  dropoffRelative || null,
      dropoffTwStart:   (dropoffRelative === 'custom' ? dropoffTwStart  : null) || null,
      dropoffTwEnd:     (dropoffRelative === 'custom' ? dropoffTwEnd    : null) || null,
      equipment,
      note,
      status: 'pending',
      createdAt: Date.now(),
    });

    state.optimizedRoute = [];
    save();
    renderJobs();
    renderRoute();

    // Reset form
    ['pickup-postal','dropoff-postal','job-note',
     'pickup-tw-start','pickup-tw-end','dropoff-relative','dropoff-tw-start','dropoff-tw-end']
      .forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('dropoff-custom-tw').style.display = 'none';
    document.querySelectorAll('.equip-btn.active').forEach(b => b.classList.remove('active'));

    toast('Job added ✓');
  } catch (e) {
    toast('Geocoding failed — check your connection');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Add Job';
  }
}

function setStatus(jobId, newStatus) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  job.status = newStatus;
  // Keep route but don't clear — next stop advances automatically
  save();
  renderNext();
  renderJobs();
  renderRoute();
}

function deleteJob(jobId) {
  if (!confirm('Delete this job?')) return;
  state.jobs = state.jobs.filter(j => j.id !== jobId);
  state.optimizedRoute = [];
  save();
  renderJobs();
  renderRoute();
}

function handleOptimize() {
  const activeJobs = state.jobs.filter(j => j.status !== 'delivered');
  if (activeJobs.length === 0) { toast('No active jobs to optimize'); return; }

  const sl    = state.startLocation;
  const speed = state.avgSpeed || DEFAULT_SPEED;
  state.optimizedRoute = computeRoute(
    state.jobs,
    sl ? sl.lat : null,
    sl ? sl.lng : null,
    nowMins(),
    speed
  );

  const lateCount = state.optimizedRoute.filter(s => s.isLate).length;
  renderRoute();
  renderStats();
  if (state.map) renderMap();

  if (lateCount > 0)
    toast(`Route optimized — ⚠ ${lateCount} stop(s) may arrive late`);
  else
    toast(`Route optimized — ${state.optimizedRoute.length} stops`);
}

async function handleSetLocation() {
  const postal = document.getElementById('start-postal').value.trim();
  if (!/^\d{6}$/.test(postal)) { toast('Enter a valid 6-digit postal code'); return; }

  const btn = document.getElementById('set-location-btn');
  btn.disabled = true; btn.textContent = '…';

  try {
    const loc = await geocodePostal(postal);
    if (!loc) { toast('Postal code not found'); return; }
    state.startLocation = loc;
    save();
    renderLocation();
    toast('Location set ✓');
  } catch (e) {
    toast('Failed to geocode');
  } finally {
    btn.disabled = false; btn.textContent = 'Set';
  }
}

function handleGPS() {
  if (!navigator.geolocation) { toast('GPS not supported'); return; }
  toast('Getting GPS…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.startLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        address: 'Current GPS Location',
        postal: null,
      };
      save();
      renderLocation();
      toast('Location set via GPS ✓');
    },
    () => toast('Could not get GPS location')
  );
}

function handleClearCompleted() {
  if (!confirm('Remove all delivered jobs?')) return;
  state.jobs = state.jobs.filter(j => j.status !== 'delivered');
  state.optimizedRoute = [];
  save();
  renderJobs();
  renderRoute();
  renderStats();
}

function navTo(lat, lng) {
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
}

// ─── Fuel inputs (live) ───────────────────────────────────────────────────────

function initFuelInputs() {
  const kmplEl  = document.getElementById('fuel-kmpl');
  const priceEl = document.getElementById('fuel-price');
  const speedEl = document.getElementById('avg-speed');

  // Populate saved values
  if (state.fuelKmpl)  kmplEl.value  = state.fuelKmpl;
  if (state.fuelPrice) priceEl.value = state.fuelPrice;
  if (state.avgSpeed)  speedEl.value = state.avgSpeed;

  function onFuelChange() {
    state.fuelKmpl  = parseFloat(kmplEl.value)  || null;
    state.fuelPrice = parseFloat(priceEl.value) || null;
    state.avgSpeed  = parseFloat(speedEl.value) || null;
    save();
    renderStats();
  }

  kmplEl.addEventListener('input',  onFuelChange);
  priceEl.addEventListener('input', onFuelChange);
  speedEl.addEventListener('input', onFuelChange);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + target).classList.add('active');

      if (target === 'next')  { renderNext(); startNextRefresh(); }
      else stopNextRefresh();
      if (target === 'map') {
        initMap();
        renderMap();
        setTimeout(() => state.map && state.map.invalidateSize(), 150);
      }
      if (target === 'stats') renderStats();
    });
  });
}

// ─── Collapsible form ─────────────────────────────────────────────────────────

function initFormToggle() {
  const btn  = document.getElementById('toggle-form-btn');
  const form = document.getElementById('add-job-form');
  btn.addEventListener('click', () => {
    const collapsed = form.style.display === 'none';
    form.style.display = collapsed ? '' : 'none';
    btn.textContent = collapsed ? '▲ Collapse' : '▼ Expand';
  });
}

function initEquipToggles() {
  document.querySelectorAll('.equip-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });
  document.getElementById('dropoff-relative').addEventListener('change', e => {
    const customRow = document.getElementById('dropoff-custom-tw');
    customRow.style.display = e.target.value === 'custom' ? 'grid' : 'none';
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg) {
  document.querySelectorAll('.toast').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  load();
  initTabs();
  initFormToggle();
  initEquipToggles();
  initFuelInputs();

  document.getElementById('add-job-btn').addEventListener('click', handleAddJob);
  document.getElementById('optimize-btn').addEventListener('click', handleOptimize);
  document.getElementById('set-location-btn').addEventListener('click', handleSetLocation);
  document.getElementById('use-gps-btn').addEventListener('click', handleGPS);
  document.getElementById('clear-all-btn').addEventListener('click', handleClearCompleted);

  document.getElementById('start-postal').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSetLocation();
  });

  // Auto-advance pickup → dropoff postal after 6 digits
  document.getElementById('pickup-postal').addEventListener('input', e => {
    if (e.target.value.length === 6) document.getElementById('dropoff-postal').focus();
  });

  renderNext();
  startNextRefresh();
  renderLocation();
  renderJobs();
  renderRoute();
  renderStats();
}

document.addEventListener('DOMContentLoaded', init);
