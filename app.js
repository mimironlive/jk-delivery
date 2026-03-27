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

function migrateJobs(jobs) {
  // Migrate old single-dropoff format to new dropoffs[] array format
  return jobs.map(job => {
    if (job.dropoff && !job.dropoffs) {
      job.dropoffs = [{
        id: uid(),
        postal:          job.dropoff.postal,
        address:         job.dropoff.address,
        lat:             job.dropoff.lat,
        lng:             job.dropoff.lng,
        dropoffRelative: job.dropoffRelative  || null,
        dropoffTwStart:  job.dropoffTwStart   || null,
        dropoffTwEnd:    job.dropoffTwEnd     || null,
        status: job.status === 'delivered' ? 'delivered' : 'pending',
      }];
      delete job.dropoff;
      delete job.dropoffRelative;
      delete job.dropoffTwStart;
      delete job.dropoffTwEnd;
    }
    return job;
  });
}

function load() {
  try {
    const jobs = localStorage.getItem('jkd_jobs');
    const loc  = localStorage.getItem('jkd_location');
    const fuel = localStorage.getItem('jkd_fuel');
    if (jobs) state.jobs = migrateJobs(JSON.parse(jobs));
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
  if (r.BLK_NO    && r.BLK_NO    !== 'NIL') parts.push(r.BLK_NO);
  if (r.ROAD_NAME && r.ROAD_NAME !== 'NIL') parts.push(r.ROAD_NAME);
  if (r.BUILDING  && r.BUILDING  !== 'NIL' && r.BUILDING !== r.ROAD_NAME) parts.push(r.BUILDING);
  return parts.join(' ') || r.ADDRESS;
}

// ─── Route Optimization (Time-Window Aware, Multi-Dropoff) ────────────────────

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
 * Time-aware nearest-neighbour for the multi-dropoff Pickup-and-Delivery Problem.
 *
 * Each job has one pickup and one or more dropoffs.
 * Constraint: all dropoffs for a job must come after its pickup.
 * Relative dropoff windows are computed dynamically after each pickup is processed.
 */
function computeRoute(jobs, startLat, startLng, startTimeMins, speedKmh) {
  const speed      = speedKmh || DEFAULT_SPEED;
  const activeJobs = jobs.filter(j => j.status !== 'delivered');
  if (activeJobs.length === 0) return [];

  // Build stop pool
  const stops = [];
  activeJobs.forEach(job => {
    if (job.status === 'pending') {
      stops.push({
        type:    'pickup',
        jobId:   job.id,
        stopKey: job.id + '_pickup',
        lat:     job.pickup.lat,
        lng:     job.pickup.lng,
        twStart: timeToMins(job.pickupTwStart),
        twEnd:   timeToMins(job.pickupTwEnd),
        job,
      });
    }
    job.dropoffs.forEach(dropoff => {
      if (dropoff.status !== 'delivered') {
        stops.push({
          type:            'dropoff',
          jobId:           job.id,
          dropoffId:       dropoff.id,
          stopKey:         job.id + '_dropoff_' + dropoff.id,
          lat:             dropoff.lat,
          lng:             dropoff.lng,
          twStart:         timeToMins(dropoff.dropoffTwStart),
          twEnd:           timeToMins(dropoff.dropoffTwEnd),
          dropoffRelative: dropoff.dropoffRelative,
          job,
          dropoff,
        });
      }
    });
  });

  const done     = new Set();
  const pickedUp = new Set();

  // Jobs already picked up
  activeJobs.forEach(job => {
    if (job.status === 'picked_up') pickedUp.add(job.id);
  });

  const RELATIVE_MINS = { immediate: 30, '1hr': 60, '3hr': 180 };

  let curLat  = startLat;
  let curLng  = startLng;
  let curTime = startTimeMins;

  if (curLat == null) {
    const first = stops.find(s => s.type === 'pickup');
    if (first) { curLat = first.lat; curLng = first.lng; }
  }

  const result = [];

  while (result.length < stops.length) {

    // Candidates: not done, pickup constraint satisfied, reachable before TW closes
    const candidates = stops.filter(s => {
      if (done.has(s.stopKey)) return false;
      if (s.type === 'dropoff' && !pickedUp.has(s.jobId)) return false;
      if (curTime != null && s.twEnd != null) {
        const dist  = haversineKm(curLat, curLng, s.lat, s.lng);
        const tMins = (dist / speed) * 60;
        if (curTime + tMins > s.twEnd) return false;
      }
      return true;
    });

    // Fallback: if no time-feasible stop, use any remaining valid stop (mark late)
    const pool = candidates.length > 0 ? candidates : stops.filter(s => {
      if (done.has(s.stopKey)) return false;
      if (s.type === 'dropoff' && !pickedUp.has(s.jobId)) return false;
      return true;
    });

    if (pool.length === 0) break;
    const isLate = candidates.length === 0;

    // Score: urgency (TW slack) × 1000 + distance — pick lowest
    let best = null, bestScore = Infinity;
    for (const s of pool) {
      const dist    = haversineKm(curLat, curLng, s.lat, s.lng);
      const tMins   = (dist / speed) * 60;
      const arrival = curTime != null ? curTime + tMins : null;
      let urgency   = 0;
      if (arrival != null && s.twEnd != null) urgency = -(s.twEnd - arrival);
      else if (s.twEnd != null)               urgency = -s.twEnd;
      const score = urgency * 1000 + dist;
      if (score < bestScore) { bestScore = score; best = { s, dist, tMins, arrival }; }
    }

    const { s, tMins, arrival } = best;

    let serviceStart = arrival;
    let isEarly      = false;
    if (arrival != null && s.twStart != null && arrival < s.twStart) {
      serviceStart = s.twStart;
      isEarly = true;
    }
    const departure = serviceStart != null ? serviceStart + SERVICE_MINS : null;

    result.push({
      ...s,
      estimatedArrival:   arrival,
      estimatedDeparture: departure,
      waitMins: isEarly ? (s.twStart - arrival) : 0,
      isLate:  isLate && s.twEnd != null,
      isEarly,
    });

    done.add(s.stopKey);

    // After pickup: dynamically apply relative dropoff TW to all this job's dropoffs
    if (s.type === 'pickup') {
      pickedUp.add(s.jobId);
      s.job.dropoffs.forEach(d => {
        const dropoffStop = stops.find(st => st.dropoffId === d.id);
        if (!dropoffStop) return;
        const relKey = d.dropoffRelative;
        if (relKey === 'custom') {
          dropoffStop.twStart = timeToMins(d.dropoffTwStart);
          dropoffStop.twEnd   = timeToMins(d.dropoffTwEnd);
        } else if (relKey && RELATIVE_MINS[relKey] != null && departure != null) {
          dropoffStop.twStart = departure;
          dropoffStop.twEnd   = departure + RELATIVE_MINS[relKey];
        }
      });
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
  for (let i = 0; i < route.length - 1; i++)
    dist += haversineKm(route[i].lat, route[i].lng, route[i+1].lat, route[i+1].lng);
  return dist;
}

function totalRouteMins(route, speedKmh) {
  if (route.length === 0) return 0;
  const speed      = speedKmh || DEFAULT_SPEED;
  const driveMins  = (totalRouteKm(route) / speed) * 60;
  const svcMins    = route.length * SERVICE_MINS;
  const waitMins   = route.reduce((s, r) => s + (r.waitMins || 0), 0);
  return driveMins + svcMins + waitMins;
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
    state.mapMarkers.push(L.marker([lat, lng], { icon }).addTo(state.map).bindPopup(`<b>Start</b><br>${address}`));
    bounds.push([lat, lng]);
  }

  const stops = state.optimizedRoute.length > 0 ? state.optimizedRoute : buildRawStops();

  stops.forEach((stop, i) => {
    const isPickup = stop.type === 'pickup';
    const color    = isPickup ? '#16a34a' : '#dc2626';
    const isDone   = stopIsDone(stop);
    const bgColor  = stop.isLate ? '#dc2626' : isDone ? '#94a3b8' : color;
    const address  = stopAddress(stop);
    const postal   = stopPostal(stop);

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:26px;height:26px;border-radius:50%;background:${bgColor};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35);color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${i + 1}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });

    const eta     = stop.estimatedArrival != null ? `ETA ${minsToTimeStr(stop.estimatedArrival)}` : '';
    const tw      = stop.twStart != null ? `Window: ${minsToTimeStr(stop.twStart)}–${minsToTimeStr(stop.twEnd)}` : '';
    const lateTag = stop.isLate ? ' ⚠ LATE' : '';

    state.mapMarkers.push(
      L.marker([stop.lat, stop.lng], { icon }).addTo(state.map).bindPopup(
        `<b>${isPickup ? 'PICKUP' : 'DROPOFF'} #${i + 1}${lateTag}</b><br>${address}<br><small>${postal}</small>` +
        (eta ? `<br><small>${eta}</small>` : '') +
        (tw  ? `<br><small>${tw}</small>`  : '') +
        `<br><a href="https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}" target="_blank">Open in Google Maps</a>`
      )
    );
    bounds.push([stop.lat, stop.lng]);
  });

  if (bounds.length > 0) state.map.fitBounds(bounds, { padding: [36, 36] });
}

function buildRawStops() {
  const stops = [];
  state.jobs.filter(j => j.status !== 'delivered').forEach(job => {
    if (job.status === 'pending')
      stops.push({ type: 'pickup', stopKey: job.id + '_pickup', lat: job.pickup.lat, lng: job.pickup.lng, job });
    job.dropoffs.forEach(d => {
      if (d.status !== 'delivered')
        stops.push({ type: 'dropoff', stopKey: job.id + '_dropoff_' + d.id, dropoffId: d.id, lat: d.lat, lng: d.lng, job, dropoff: d });
    });
  });
  return stops;
}

// ─── Stop helpers ─────────────────────────────────────────────────────────────

function stopAddress(stop) {
  return stop.type === 'pickup' ? stop.job.pickup.address : stop.dropoff.address;
}

function stopPostal(stop) {
  return stop.type === 'pickup' ? stop.job.pickup.postal : stop.dropoff.postal;
}

function stopIsDone(stop) {
  if (stop.type === 'pickup')  return stop.job.status !== 'pending';
  if (stop.dropoff)            return stop.dropoff.status === 'delivered';
  return stop.job.status === 'delivered';
}

// ─── Render: Next ─────────────────────────────────────────────────────────────

let _nextRefreshTimer = null;

function findNextStop() {
  return state.optimizedRoute.find(s => {
    if (s.type === 'pickup')  return s.job.status === 'pending';
    if (s.type === 'dropoff') return s.dropoff ? s.dropoff.status !== 'delivered' : s.job.status !== 'delivered';
    return false;
  }) || null;
}

function renderNext() {
  const container = document.getElementById('next-content');
  if (!container) return;

  const activeJobs = state.jobs.filter(j => j.status !== 'delivered');

  if (activeJobs.length === 0) {
    container.innerHTML = `
      <div class="next-empty">
        <div class="next-empty-icon">🎉</div>
        <h2>All done for today!</h2>
        <p>All jobs have been delivered.<br>Great work!</p>
      </div>`;
    return;
  }

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

  const isPickup = stop.type === 'pickup';
  const job      = stop.job;
  const address  = stopAddress(stop);
  const postal   = stopPostal(stop);
  const lat      = stop.lat;
  const lng      = stop.lng;

  // Dropoff index label for multi-dropoff jobs
  let dropoffLabel = '';
  if (!isPickup && job.dropoffs.length > 1) {
    const idx = job.dropoffs.findIndex(d => d.id === stop.dropoffId);
    dropoffLabel = `Dropoff ${idx + 1} of ${job.dropoffs.length}`;
  }

  const stopIdx0       = state.optimizedRoute.indexOf(stop);
  const stopIdx        = stopIdx0 + 1;
  const totalRemaining = state.optimizedRoute.filter(s => {
    if (s.type === 'pickup')  return s.job.status === 'pending';
    if (s.type === 'dropoff') return s.dropoff ? s.dropoff.status !== 'delivered' : s.job.status !== 'delivered';
    return false;
  }).length;

  const now   = nowMins();
  const eta   = stop.estimatedArrival;
  const twEnd = stop.twEnd;
  const twStart = stop.twStart;
  const speed = state.avgSpeed || DEFAULT_SPEED;

  const sl = state.startLocation;
  let travelMins = null;
  if (sl) {
    const dist = haversineKm(sl.lat, sl.lng, lat, lng);
    travelMins = Math.round((dist / speed) * 60);
  }

  const minsToDeadline = twEnd != null ? Math.round(twEnd - now) : null;

  let urgencyCls  = 'none';
  let urgencyText = 'No deadline';
  if (minsToDeadline != null) {
    if      (minsToDeadline < 0)  { urgencyCls = 'danger'; urgencyText = `Overdue ${Math.abs(minsToDeadline)} min`; }
    else if (minsToDeadline < 15) { urgencyCls = 'danger'; urgencyText = `${minsToDeadline} min left`; }
    else if (minsToDeadline < 30) { urgencyCls = 'warn';   urgencyText = `${minsToDeadline} min left`; }
    else                          { urgencyCls = 'ok';     urgencyText = `${minsToDeadline} min left`; }
  }

  const equipHtml = (job.equipment && job.equipment.length > 0)
    ? `<div class="next-equip-row">
        ${job.equipment.map(e =>
          `<div class="next-equip-chip">${e === 'trolley' ? '🛒 Trolley' : '🧊 Food Bag'}</div>`
        ).join('')}
      </div>`
    : '';

  const cls     = job.contractor ? job.contractor.toLowerCase() : '';
  const svcCls  = job.orderType  ? job.orderType.toLowerCase()  : '';
  const badgesHtml = `
    <div class="next-badges">
      ${job.contractor ? `<span class="contractor-badge ${cls}">${job.contractor}</span>` : ''}
      ${job.orderType  ? `<span class="service-badge ${svcCls}">${job.orderType}</span>`  : ''}
      ${job.refNo      ? `<span style="font-size:11px;font-weight:600;color:var(--muted)">🔖 ${escHtml(job.refNo)}</span>` : ''}
      ${job.pay != null ? `<span style="font-size:11px;font-weight:700;color:var(--success);background:#dcfce7;padding:2px 8px;border-radius:99px">S$ ${job.pay.toFixed(2)}</span>` : ''}
      ${dropoffLabel   ? `<span style="font-size:11px;font-weight:600;color:var(--muted)">${dropoffLabel}</span>` : ''}
    </div>`;

  const etaRow    = eta        != null ? `<div class="next-time-row"><span class="next-time-label">Estimated arrival</span><span class="next-time-value">${minsToTimeStr(eta)}</span></div>` : '';
  const travelRow = travelMins != null ? `<div class="next-time-row"><span class="next-time-label">Travel time from start</span><span class="next-time-value">~${travelMins} min</span></div>` : '';
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

  const actionBtn = isPickup
    ? `<button class="next-status-btn pickup"  onclick="setPickedUp('${job.id}')">✓ Picked Up</button>`
    : `<button class="next-status-btn dropoff" onclick="setDropoffDelivered('${job.id}','${stop.dropoffId}')">✓ Delivered</button>`;

  // Batch alert — multiple pending pickups at same postal
  const batchHtml = isPickup ? (() => {
    const batchCount = state.jobs.filter(j =>
      j.status === 'pending' && j.pickup.postal === postal
    ).length;
    return batchCount > 1
      ? `<div class="next-batch-alert">📦 ${batchCount} orders to collect at this location — pick up all before leaving</div>`
      : '';
  })() : '';

  // Before This — previous completed stop with ↩ Undo
  const prevStop  = stopIdx0 > 0 ? state.optimizedRoute[stopIdx0 - 1] : null;
  const beforeHtml = (prevStop && stopIsDone(prevStop)) ? (() => {
    const pAddr    = stopAddress(prevStop);
    const pIsPickup = prevStop.type === 'pickup';
    const undoFn   = pIsPickup
      ? `revertJob('${prevStop.job.id}')`
      : `revertDropoff('${prevStop.job.id}','${prevStop.dropoffId}')`;
    return `
      <div class="next-before-card">
        <div class="next-before-title">Before this</div>
        <div class="next-after-row">
          <span class="next-after-type ${prevStop.type}">${pIsPickup ? 'Pickup' : 'Dropoff'}</span>
          <span class="next-after-addr">${escHtml(pAddr)}</span>
          <button class="btn-revert" onclick="${undoFn}">↩ Undo</button>
        </div>
      </div>`;
  })() : '';

  const nextIdx  = stopIdx0 + 1;
  const afterStop = nextIdx < state.optimizedRoute.length ? state.optimizedRoute[nextIdx] : null;
  const afterHtml = afterStop ? (() => {
    const aIsPickup = afterStop.type === 'pickup';
    const aAddr     = stopAddress(afterStop);
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
    ${beforeHtml}
    <div class="next-card">
      <div class="next-card-header ${stop.type}">
        <span class="next-type-label ${stop.type}">${isPickup ? '📦 Pickup' : '🏠 Dropoff'}</span>
        <span class="next-stop-counter">Stop ${stopIdx} · ${totalRemaining} remaining</span>
      </div>
      <div class="next-card-body">
        ${badgesHtml}
        ${batchHtml}
        <div>
          <div class="next-address">${escHtml(address)}</div>
          <div class="next-postal">${postal}</div>
        </div>
        ${hasTimeInfo ? `<div class="next-time-block">${etaRow}${travelRow}${windowRow}${deadlineRow}</div>` : ''}
        ${equipHtml}
        ${job.note ? `<div class="next-note">📝 ${escHtml(job.note)}</div>` : ''}
        <div class="next-nav-row">
          <button class="next-nav-btn waze" onclick="navToWaze(${lat},${lng})">🚗 Waze</button>
          <button class="next-nav-btn" onclick="navTo(${lat},${lng})">🗺 Maps</button>
        </div>
        ${actionBtn}
      </div>
    </div>
    ${afterHtml}`;
}

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

  // Compute same-pickup groups among pending jobs
  const pickupCounts = {};
  pending.forEach(j => {
    pickupCounts[j.pickup.postal] = (pickupCounts[j.pickup.postal] || 0) + 1;
  });

  let html = '';
  if (pending.length)   { html += `<div class="section-label">Pending (${pending.length})</div>`;    html += pending.map(j => jobCardHTML(j, pickupCounts)).join(''); }
  if (pickedUp.length)  { html += `<div class="section-label">Picked Up (${pickedUp.length})</div>`; html += pickedUp.map(j => jobCardHTML(j, {})).join(''); }
  if (delivered.length) { html += `<div class="section-label">Delivered (${delivered.length})</div>`; html += delivered.map(j => jobCardHTML(j, {})).join(''); }
  container.innerHTML = html;
}

function twDisplay(start, end) {
  if (!start && !end) return '';
  if (start && end)   return `${start} – ${end}`;
  if (start)          return `From ${start}`;
  return `Until ${end}`;
}

function relativeLabel(d) {
  if (!d.dropoffRelative) return '';
  if (d.dropoffRelative === 'custom')
    return d.dropoffTwStart || d.dropoffTwEnd ? `⏰ ${twDisplay(d.dropoffTwStart, d.dropoffTwEnd)}` : '';
  return { immediate: '⚡ Within 30 min', '1hr': '⏱ Within 1 hr', '3hr': '⏱ Within 3 hrs' }[d.dropoffRelative] || '';
}

function jobCardHTML(job, pickupCounts = {}) {
  const cls         = job.contractor ? job.contractor.toLowerCase() : '';
  const statusClass = { pending: '', picked_up: 'status-picked-up', delivered: 'status-delivered' }[job.status];
  const svcCls      = job.orderType ? job.orderType.toLowerCase() : '';

  const equipTags = (job.equipment || []).map(e =>
    `<span class="equip-tag">${e === 'trolley' ? '🛒' : '🧊'} ${e}</span>`
  ).join('');

  const pickupTw = twDisplay(job.pickupTwStart, job.pickupTwEnd);

  // Pickup status
  const pickupAction = job.status === 'pending'
    ? `<button class="btn-status btn-pickup" onclick="setPickedUp('${job.id}')">✓ Picked Up</button>`
    : `<span style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px;color:var(--success);font-weight:700">✓ Picked Up</span>
        <button class="btn-revert" onclick="revertJob('${job.id}')" title="Undo">↩ Undo</button>
       </span>`;

  // Dropoff rows — one per dropoff
  const dropoffRows = job.dropoffs.map((d, i) => {
    const label      = job.dropoffs.length > 1 ? `D${i + 1}` : 'D';
    const relLabel   = relativeLabel(d);
    const isDelivered = d.status === 'delivered';

    let deliverBtn = '';
    if (job.status === 'picked_up' && !isDelivered) {
      deliverBtn = `<button class="btn-status btn-deliver" style="margin-top:5px;font-size:11px;padding:5px 10px" onclick="setDropoffDelivered('${job.id}','${d.id}')">✓ Delivered</button>`;
    } else if (isDelivered) {
      deliverBtn = `<span style="display:flex;align-items:center;gap:6px;margin-top:4px">
        <span style="font-size:11px;color:var(--success);font-weight:700">✓ Done</span>
        <button class="btn-revert" onclick="revertDropoff('${job.id}','${d.id}')" title="Undo">↩ Undo</button>
      </span>`;
    }

    return `
    <div class="stop-row" style="${isDelivered ? 'opacity:0.5' : ''}">
      <div class="stop-icon dropoff">${label}</div>
      <div class="stop-address" style="flex:1">
        <div class="stop-postal">${d.postal}</div>
        <div class="stop-addr-text">${escHtml(d.address)}</div>
        ${relLabel ? `<div class="stop-tw">${relLabel}</div>` : ''}
        ${deliverBtn}
      </div>
      <button class="btn-nav-sm" onclick="navTo(${d.lat},${d.lng})" style="flex-shrink:0;align-self:flex-start;margin-left:6px">↗</button>
    </div>`;
  }).join('');

  const multiLabel = job.dropoffs.length > 1
    ? `<span style="font-size:11px;color:var(--muted);font-weight:600">${job.dropoffs.length} dropoffs</span>`
    : '';

  const batchCount = pickupCounts[job.pickup.postal] || 0;
  const batchBadge = batchCount > 1
    ? `<span class="batch-badge">📦 Batch ×${batchCount}</span>`
    : '';

  const payBadge = job.pay != null
    ? `<span style="font-size:11px;font-weight:700;color:var(--success);background:#dcfce7;padding:2px 8px;border-radius:99px">S$ ${job.pay.toFixed(2)}</span>`
    : '';

  return `
<div class="job-card ${statusClass}">
  <div class="job-header">
    <span class="contractor-badge ${cls}">${job.contractor || 'No Contractor'}</span>
    ${job.orderType ? `<span class="service-badge ${svcCls}">${job.orderType}</span>` : ''}
    ${multiLabel}
    ${batchBadge}
    ${payBadge}
    <span class="job-header-right"><button class="job-delete-btn" onclick="deleteJob('${job.id}')" title="Delete">✕</button></span>
  </div>
  ${job.refNo ? `<div class="job-note" style="font-size:11px">🔖 Ref: <b>${escHtml(job.refNo)}</b></div>` : ''}
  ${equipTags ? `<div class="job-note" style="margin-bottom:6px">${equipTags}</div>` : ''}
  ${job.note ? `<div class="job-note">📝 ${escHtml(job.note)}</div>` : ''}
  <div class="job-stops">
    <div class="stop-row">
      <div class="stop-icon pickup">P</div>
      <div class="stop-address" style="flex:1">
        <div class="stop-postal">${job.pickup.postal}</div>
        <div class="stop-addr-text">${escHtml(job.pickup.address)}</div>
        ${pickupTw ? `<div class="stop-tw">⏰ ${pickupTw}</div>` : ''}
      </div>
      <button class="btn-nav-sm" onclick="navTo(${job.pickup.lat},${job.pickup.lng})" style="flex-shrink:0;align-self:flex-start;margin-left:6px">↗</button>
    </div>
    ${dropoffRows}
  </div>
  <div class="job-actions">
    ${pickupAction}
  </div>
</div>`;
}

// ─── Render: Route ────────────────────────────────────────────────────────────

function renderRoute() {
  const list    = document.getElementById('route-list');
  const summary = document.getElementById('route-summary');
  const active  = state.jobs.filter(j => j.status !== 'delivered');

  const fullRouteBtn = document.getElementById('open-full-route-btn');

  if (state.optimizedRoute.length === 0) {
    summary.textContent = active.length === 0
      ? 'No active jobs.'
      : `${active.length} active job(s) · Press Optimize to plan your route.`;
    list.innerHTML = active.length === 0
      ? `<div class="empty-state"><div class="empty-icon">🎉</div><p>All jobs completed!</p></div>`
      : '';
    if (fullRouteBtn) fullRouteBtn.classList.add('hidden');
    return;
  }

  if (fullRouteBtn) fullRouteBtn.classList.remove('hidden');

  const speed     = state.avgSpeed || DEFAULT_SPEED;
  const km        = totalRouteKm(state.optimizedRoute);
  const totalMin  = totalRouteMins(state.optimizedRoute, speed);
  const lateCount = state.optimizedRoute.filter(s => s.isLate).length;
  const lateNote  = lateCount > 0 ? ` · ⚠ ${lateCount} late` : '';
  summary.textContent = `${state.optimizedRoute.length} stops · ~${km.toFixed(1)} km · ~${fmtDuration(totalMin)}${lateNote}`;

  list.innerHTML = state.optimizedRoute.map((stop, i) => {
    const isPickup = stop.type === 'pickup';
    const address  = stopAddress(stop);
    const postal   = stopPostal(stop);
    const isDone   = stopIsDone(stop);
    const numCls   = isDone ? 'done' : stop.type;

    let etaHtml = '';
    if (stop.estimatedArrival != null) {
      const twStr = stop.twStart != null
        ? `<span class="eta-tw">Window: ${minsToTimeStr(stop.twStart)}–${minsToTimeStr(stop.twEnd)}</span>`
        : '';
      let tag = '';
      if      (stop.isLate)                  tag = `<span class="eta-tag late">Late</span>`;
      else if (stop.isEarly)                 tag = `<span class="eta-tag early">Wait ${stop.waitMins|0}min</span>`;
      else if (stop.twEnd != null)           tag = `<span class="eta-tag ok">On time</span>`;
      etaHtml = `<div class="route-stop-eta">
        <span class="eta-time">ETA ${minsToTimeStr(stop.estimatedArrival)}</span>
        ${twStr}${tag}
      </div>`;
    }

    // Multi-dropoff label
    let dropoffNum = '';
    if (!isPickup && stop.job.dropoffs.length > 1) {
      const idx = stop.job.dropoffs.findIndex(d => d.id === stop.dropoffId);
      dropoffNum = idx >= 0 ? ` (D${idx + 1}/${stop.job.dropoffs.length})` : '';
    }

    const stopCls = stop.isLate ? 'is-late' : stop.isEarly ? 'is-early' : '';

    return `
<div class="route-stop ${isDone ? 'is-done' : ''} ${stopCls}">
  <div class="stop-num ${numCls}">${i + 1}</div>
  <div class="route-stop-body">
    <div class="route-stop-type ${stop.type}">${isPickup ? 'PICKUP' : `DROPOFF${dropoffNum}`}</div>
    <div class="route-stop-address">${escHtml(address)}</div>
    <div class="route-stop-meta">${postal}${stop.job.contractor ? ' · ' + stop.job.contractor : ''}${stop.job.orderType ? ' · ' + stop.job.orderType : ''}${stop.job.note ? ' · ' + escHtml(stop.job.note) : ''}</div>
    ${etaHtml}
  </div>
  <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
    <button class="btn-nav-sm" onclick="navTo(${stop.lat},${stop.lng})">↗</button>
    ${isDone ? `<button class="btn-revert" onclick="${stop.type === 'pickup' ? `revertJob('${stop.job.id}')` : `revertDropoff('${stop.job.id}','${stop.dropoffId}')`}" title="Undo">↩</button>` : ''}
  </div>
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
  const stops   = state.jobs.reduce((acc, j) => acc + 1 + (j.dropoffs ? j.dropoffs.length : 1), 0);

  document.getElementById('stat-jobs').textContent  = total;
  document.getElementById('stat-stops').textContent = stops;

  const hasRoute  = state.optimizedRoute.length > 0;
  const noRouteEl = document.getElementById('stat-no-route');

  if (hasRoute) {
    const km      = totalRouteKm(state.optimizedRoute);
    const durMins = totalRouteMins(state.optimizedRoute, speed);
    document.getElementById('stat-distance').textContent = km.toFixed(1);
    document.getElementById('stat-duration').textContent = fmtDuration(durMins);
    noRouteEl.classList.add('hidden');

    const kmpl  = state.fuelKmpl;
    const price = state.fuelPrice;
    document.getElementById('fr-distance').textContent = `${km.toFixed(1)} km`;
    if (kmpl && kmpl > 0) {
      const litres = km / kmpl;
      document.getElementById('fr-litres').textContent = `${litres.toFixed(2)} L`;
      document.getElementById('fr-cost').textContent   = (price && price > 0) ? `S$ ${(litres * price).toFixed(2)}` : '—';
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

  // Earnings summary
  const totalEarnings = state.jobs.reduce((sum, j) => sum + (j.pay || 0), 0);
  const fuelCostVal   = (hasRoute && state.fuelKmpl > 0 && state.fuelPrice > 0)
    ? (totalRouteKm(state.optimizedRoute) / state.fuelKmpl) * state.fuelPrice
    : null;
  const profit = (totalEarnings > 0 && fuelCostVal != null) ? totalEarnings - fuelCostVal : null;

  document.getElementById('er-earnings').textContent = totalEarnings > 0  ? `S$ ${totalEarnings.toFixed(2)}` : '—';
  document.getElementById('er-fuel').textContent     = fuelCostVal != null ? `S$ ${fuelCostVal.toFixed(2)}`  : '—';
  const profitEl = document.getElementById('er-profit');
  if (profit != null) {
    profitEl.textContent = `S$ ${profit.toFixed(2)}`;
    profitEl.style.color = profit >= 0 ? 'var(--success)' : 'var(--danger)';
  } else {
    profitEl.textContent = '—';
    profitEl.style.color = '';
  }

  const breakdown = [
    { label: 'Pending',   count: pending,          color: '#2563eb' },
    { label: 'Picked Up', count: active - pending,  color: '#d97706' },
    { label: 'Delivered', count: done,              color: '#16a34a' },
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
  el.textContent = state.startLocation ? `📍 ${state.startLocation.address}` : 'Not set';
}

// ─── Dropoff Entry Management (form) ──────────────────────────────────────────

function createDropoffEntry(idx) {
  const div = document.createElement('div');
  div.className  = 'dropoff-entry';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="dropoff-entry-header">
      <span class="dropoff-entry-label">Dropoff ${idx + 1}</span>
      <button type="button" class="remove-dropoff-btn" title="Remove">✕</button>
    </div>
    <div class="form-group">
      <input type="text" class="dropoff-postal" maxlength="6" placeholder="Postal code (e.g. 018956)" inputmode="numeric">
    </div>
    <div class="tw-section" style="margin-bottom:6px">
      <div class="tw-label">Dropoff Window <span class="tw-optional">(relative to pickup)</span></div>
      <select class="dropoff-relative">
        <option value="">No limit</option>
        <option value="immediate">Immediate (within 30 min)</option>
        <option value="1hr">Within 1 hour</option>
        <option value="3hr">Within 3 hours</option>
        <option value="custom">Custom timeframe</option>
      </select>
      <div class="dropoff-custom-tw form-row" style="display:none;margin-top:8px">
        <div class="form-group">
          <label>From</label>
          <input type="time" class="dropoff-tw-start">
        </div>
        <div class="form-group">
          <label>To</label>
          <input type="time" class="dropoff-tw-end">
        </div>
      </div>
    </div>`;

  div.querySelector('.dropoff-relative').addEventListener('change', e => {
    div.querySelector('.dropoff-custom-tw').style.display = e.target.value === 'custom' ? 'grid' : 'none';
  });
  attachClipboard(div.querySelector('.dropoff-postal'));
  div.querySelector('.remove-dropoff-btn').addEventListener('click', () => {
    div.remove();
    refreshDropoffLabels();
    refreshRemoveButtons();
  });

  return div;
}

function addDropoffEntry() {
  const container = document.getElementById('dropoffs-container');
  container.appendChild(createDropoffEntry(container.children.length));
  refreshDropoffLabels();
  refreshRemoveButtons();
}

function refreshDropoffLabels() {
  document.querySelectorAll('.dropoff-entry').forEach((el, i) => {
    el.querySelector('.dropoff-entry-label').textContent = `Dropoff ${i + 1}`;
  });
}

function refreshRemoveButtons() {
  const entries = document.querySelectorAll('.dropoff-entry');
  entries.forEach(el => {
    el.querySelector('.remove-dropoff-btn').style.display = entries.length > 1 ? '' : 'none';
  });
}

function getDropoffFormData() {
  return [...document.querySelectorAll('.dropoff-entry')].map(entry => ({
    postal:          entry.querySelector('.dropoff-postal').value.trim(),
    dropoffRelative: entry.querySelector('.dropoff-relative').value,
    dropoffTwStart:  entry.querySelector('.dropoff-tw-start').value || null,
    dropoffTwEnd:    entry.querySelector('.dropoff-tw-end').value   || null,
  }));
}

function resetDropoffEntries() {
  document.getElementById('dropoffs-container').innerHTML = '';
  addDropoffEntry();
}

function initDropoffEntries() {
  addDropoffEntry();
  document.getElementById('add-dropoff-btn').addEventListener('click', addDropoffEntry);
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
  const contractor    = document.getElementById('contractor').value;
  const orderType     = document.getElementById('order-type').value;
  const refNo         = document.getElementById('job-ref').value.trim();
  const pay           = parseFloat(document.getElementById('job-pay').value) || null;
  const pickupPostal  = document.getElementById('pickup-postal').value.trim();
  const pickupTwStart = document.getElementById('pickup-tw-start').value;
  const pickupTwEnd   = document.getElementById('pickup-tw-end').value;
  const note          = document.getElementById('job-note').value.trim();
  const equipment     = [...document.querySelectorAll('.equip-btn.active')].map(b => b.dataset.equip);
  const dropoffData   = getDropoffFormData();

  // Validate
  if (!/^\d{6}$/.test(pickupPostal)) { toast('Enter a valid 6-digit pickup postal code'); return; }
  if (pickupTwStart && pickupTwEnd && pickupTwStart >= pickupTwEnd) { toast('Pickup window: start must be before end'); return; }

  for (let i = 0; i < dropoffData.length; i++) {
    const d = dropoffData[i];
    if (!/^\d{6}$/.test(d.postal)) { toast(`Dropoff ${i + 1}: enter a valid 6-digit postal code`); return; }
    if (d.dropoffRelative === 'custom' && d.dropoffTwStart && d.dropoffTwEnd && d.dropoffTwStart >= d.dropoffTwEnd) {
      toast(`Dropoff ${i + 1}: window start must be before end`); return;
    }
  }

  const btn = document.getElementById('add-job-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Geocoding…';

  try {
    const pickupResult   = await geocodePostal(pickupPostal);
    if (!pickupResult) { toast(`Postal ${pickupPostal} not found`); return; }

    const dropoffResults = await Promise.all(dropoffData.map(d => geocodePostal(d.postal)));
    for (let i = 0; i < dropoffResults.length; i++) {
      if (!dropoffResults[i]) { toast(`Dropoff ${i + 1}: postal ${dropoffData[i].postal} not found`); return; }
    }

    const dropoffs = dropoffData.map((d, i) => ({
      id:              uid(),
      postal:          dropoffResults[i].postal,
      address:         dropoffResults[i].address,
      lat:             dropoffResults[i].lat,
      lng:             dropoffResults[i].lng,
      dropoffRelative: d.dropoffRelative || null,
      dropoffTwStart:  d.dropoffRelative === 'custom' ? d.dropoffTwStart : null,
      dropoffTwEnd:    d.dropoffRelative === 'custom' ? d.dropoffTwEnd   : null,
      status:          'pending',
    }));

    state.jobs.push({
      id: uid(),
      contractor, orderType,
      refNo:          refNo || null,
      pay,
      pickup:         pickupResult,
      dropoffs,
      pickupTwStart:  pickupTwStart || null,
      pickupTwEnd:    pickupTwEnd   || null,
      equipment,
      note,
      status:    'pending',
      createdAt: Date.now(),
    });

    state.optimizedRoute = [];
    save();
    renderJobs();
    renderRoute();

    // Reset form
    ['pickup-postal', 'pickup-tw-start', 'pickup-tw-end', 'job-note', 'job-ref', 'job-pay']
      .forEach(id => { document.getElementById(id).value = ''; });
    document.querySelectorAll('.equip-btn.active').forEach(b => b.classList.remove('active'));
    resetDropoffEntries();

    toast(`Job added ✓  (${dropoffs.length} dropoff${dropoffs.length > 1 ? 's' : ''})`);
  } catch (e) {
    toast('Geocoding failed — check your connection');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Add Job';
  }
}

function setPickedUp(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  job.status = 'picked_up';
  save();
  renderNext();
  renderJobs();
  renderRoute();
}

function setDropoffDelivered(jobId, dropoffId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  const dropoff = job.dropoffs.find(d => d.id === dropoffId);
  if (!dropoff) return;
  dropoff.status = 'delivered';
  // If all dropoffs delivered, mark job complete
  if (job.dropoffs.every(d => d.status === 'delivered')) job.status = 'delivered';
  save();
  renderNext();
  renderJobs();
  renderRoute();
}

function revertJob(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  job.status = 'pending';
  job.dropoffs.forEach(d => { d.status = 'pending'; });
  state.optimizedRoute = [];
  save(); renderNext(); renderJobs(); renderRoute();
  toast('Job reset to Pending');
}

function revertDropoff(jobId, dropoffId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  const dropoff = job.dropoffs.find(d => d.id === dropoffId);
  if (!dropoff) return;
  dropoff.status = 'pending';
  if (job.status === 'delivered') job.status = 'picked_up';
  save(); renderNext(); renderJobs(); renderRoute();
  toast('Dropoff reset to Pending');
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

  if (lateCount > 0) toast(`Route optimized — ⚠ ${lateCount} stop(s) may arrive late`);
  else               toast(`Route optimized — ${state.optimizedRoute.length} stops`);
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

function navToWaze(lat, lng) {
  window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank');
}

function openFullRoute() {
  const remaining = state.optimizedRoute.filter(s => !stopIsDone(s));
  if (remaining.length === 0) { toast('No remaining stops'); return; }

  const MAX = 10;
  const stops = remaining.slice(0, MAX);
  const sl = state.startLocation;

  const dest = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lng}`;
  let wps = '';
  if (sl) {
    wps = stops.slice(0, -1).map(s => `${s.lat},${s.lng}`).join('|');
  } else {
    wps = stops.slice(1, -1).map(s => `${s.lat},${s.lng}`).join('|');
  }
  const origin = sl ? `&origin=${sl.lat},${sl.lng}` : '';
  const url = `https://www.google.com/maps/dir/?api=1${origin}&destination=${dest}${wps ? '&waypoints=' + encodeURIComponent(wps) : ''}`;

  window.open(url, '_blank');
  if (remaining.length > MAX) toast(`Showing first ${MAX} of ${remaining.length} stops`);
}

// ─── Fuel inputs (live) ───────────────────────────────────────────────────────

function initFuelInputs() {
  const kmplEl  = document.getElementById('fuel-kmpl');
  const priceEl = document.getElementById('fuel-price');
  const speedEl = document.getElementById('avg-speed');

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

// ─── Clipboard postal detection ───────────────────────────────────────────────

async function tryPastePostal(inputEl) {
  if (inputEl.value !== '') return;
  try {
    const text = await navigator.clipboard.readText();
    const match = text.match(/\b(\d{6})\b/);
    if (match) {
      inputEl.value = match[1];
      inputEl.dispatchEvent(new Event('input'));
      toast(`📋 Postal ${match[1]} filled from clipboard`);
    }
  } catch (e) { /* permission denied — silently skip */ }
}

function attachClipboard(inputEl) {
  inputEl.addEventListener('focus', () => tryPastePostal(inputEl));
}

// ─── Equipment toggles ────────────────────────────────────────────────────────

function initEquipToggles() {
  document.querySelectorAll('.equip-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg) {
  document.querySelectorAll('.toast').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className  = 'toast';
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
  initDropoffEntries();
  initFuelInputs();

  document.getElementById('add-job-btn').addEventListener('click', handleAddJob);
  document.getElementById('optimize-btn').addEventListener('click', handleOptimize);
  document.getElementById('set-location-btn').addEventListener('click', handleSetLocation);
  document.getElementById('use-gps-btn').addEventListener('click', handleGPS);
  document.getElementById('clear-all-btn').addEventListener('click', handleClearCompleted);

  document.getElementById('start-postal').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSetLocation();
  });

  // Clipboard detection on pickup postal
  attachClipboard(document.getElementById('pickup-postal'));

  // Auto-advance to first dropoff postal after 6 digits typed in pickup
  document.getElementById('pickup-postal').addEventListener('input', e => {
    if (e.target.value.length === 6) {
      const firstDropoff = document.querySelector('.dropoff-postal');
      if (firstDropoff) firstDropoff.focus();
    }
  });

  renderLocation();
  renderJobs();
  renderRoute();
  renderNext();
  startNextRefresh();
}

document.addEventListener('DOMContentLoaded', init);
