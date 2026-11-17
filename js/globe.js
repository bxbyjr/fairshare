// Globe screen: slowly auto-rotating earth with HTML map-marker pins for meeting
// selfie clusters (red) and live locations from contacts sharing with you (blue).
// HTML/CSS2D markers avoid cylinder z-fighting; htmlTransitionDuration(0) prevents
// vertical jitter when live coordinates refresh.
const GLOBE_MARKER_SVG = `<svg viewBox="-4 0 36 36" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M14,0 C21.732,0 28,5.641 28,12.6 C28,23.963 14,36 14,36 C14,36 0,24.064 0,12.6 C0,5.641 6.268,0 14,0 Z"></path>
    <circle fill="white" cx="14" cy="14" r="6"></circle>
    </svg>`;
const CLUSTER_RADIUS_KM = 15;      // points within this distance collapse to one pin

let _globe = null;
let _globeResizeHandler = null;
let _globeClusters = [];           // cached clusters for click handling
let _clusterPopup = null;          // { overlay, state } while a popup is open

async function openGlobeScreen() {
    if (!currentUser) return;

    const container = document.getElementById('globeViz');
    const emptyHint = document.getElementById('globeEmptyHint');
    if (!container) return;

    if (typeof Globe !== 'function') {
        let tries = 0;
        while (typeof Globe !== 'function' && tries < 40) {
            await new Promise(r => setTimeout(r, 50));
            tries++;
        }
        if (typeof Globe !== 'function') {
            container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--dark-gray);">Could not load globe library.</div>';
            return;
        }
    }

    const selfies = await loadGlobeSelfies();
    if (typeof loadContactLocations === 'function') {
        await loadContactLocations();
    }

    _globeClusters = buildClusters(selfies).map(c => ({ ...c, globePinType: 'meeting' }));
    const livePins = await loadLiveShareGlobePins();
    const allPins = orderedGlobeHtmlMarkers(_globeClusters, livePins);

    if (_globe === null) {
        _globe = Globe()(container)
            .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
            .backgroundColor('rgba(0,0,0,0)')
            .pointsData([])
            .htmlElementsData([])
            .htmlLat('lat')
            .htmlLng('lng')
            // Slight lift reduces overlap with the globe texture at oblique angles.
            .htmlAltitude(0.012)
            // Live location polls update lat/lng often; animating CSS2D positions causes vertical flicker.
            .htmlTransitionDuration(0)
            .htmlElement(d => createGlobeHtmlMarker(d))
            .htmlElementVisibilityModifier((el, isVisible) => {
                el.style.opacity = isVisible ? '1' : '0';
            });

        const controls = _globe.controls();
        controls.autoRotateSpeed = 0.35;
        controls.enableDamping = true;

        // As soon as the user touches/grabs the globe, stop auto-rotation and
        // expand the globe to full-bleed so pins are easier to hit. OrbitControls
        // fires 'start' on pointer-down (drag, pinch, or tap).
        controls.addEventListener('start', () => {
            controls.autoRotate = false;
            expandGlobe();
        });

        _globeResizeHandler = () => sizeGlobeToContainer();
        window.addEventListener('resize', _globeResizeHandler);
    }

    // Each time the screen opens, reset to the compact, auto-rotating welcome
    // state. First interaction will stop rotation and expand.
    const wrap = document.querySelector('.globe-viz-wrap');
    if (wrap) wrap.classList.remove('expanded');
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    _globe.controls().autoRotate = !reduceMotion;

    _globe.htmlElementsData(allPins);

    requestAnimationFrame(() => {
        sizeGlobeToContainer();
        requestAnimationFrame(sizeGlobeToContainer);
    });

    if (emptyHint) {
        if (_globeClusters.length === 0 && livePins.length === 0) emptyHint.classList.remove('hidden');
        else emptyHint.classList.add('hidden');
    }

    renderGlobeStats(_globeClusters);
}

function sizeGlobeToContainer() {
    if (!_globe) return;
    const container = document.getElementById('globeViz');
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) {
        _globe.width(w).height(h);
    }
}

function expandGlobe() {
    const wrap = document.querySelector('.globe-viz-wrap');
    if (!wrap || wrap.classList.contains('expanded')) return;
    wrap.classList.add('expanded');
    // Two-frame resize: the first frame lets the browser compute the new
    // layout; the second catches any settling (safe-area / dvh quirks).
    requestAnimationFrame(() => {
        sizeGlobeToContainer();
        requestAnimationFrame(sizeGlobeToContainer);
    });
}

// ---------- Data loading ----------

async function loadGlobeSelfies() {
    try {
        const { data: selfies, error } = await db
            .from('contact_selfies')
            .select('contact_id, captured_at, lat, lng, location_label, selfie_url')
            .eq('user_id', currentUser.id)
            .not('lat', 'is', null)
            .not('lng', 'is', null)
            .order('captured_at', { ascending: false });

        if (error) {
            console.error('[globe] Failed to load selfies:', error);
            return [];
        }
        if (!selfies || selfies.length === 0) return [];

        const contactIds = Array.from(new Set(selfies.map(s => s.contact_id).filter(Boolean)));
        const nameById = {};
        if (contactIds.length > 0) {
            const { data: profiles } = await db
                .from('profiles')
                .select('id, display_name')
                .in('id', contactIds);
            (profiles || []).forEach(p => { nameById[p.id] = p.display_name; });
        }

        return selfies
            .map(s => {
                const lat = Number(s.lat);
                const lng = Number(s.lng);
                if (!isFinite(lat) || !isFinite(lng)) return null;
                return {
                    lat,
                    lng,
                    contactId: s.contact_id,
                    contactName: nameById[s.contact_id] || 'Unknown',
                    date: s.captured_at,
                    locationLabel: s.location_label || '',
                    selfieUrl: s.selfie_url || ''
                };
            })
            .filter(Boolean);
    } catch (e) {
        console.error('[globe] loadGlobeSelfies error:', e);
        return [];
    }
}

// ---------- Clustering ----------

// Simple greedy clustering by great-circle distance. Each selfie joins the
// first existing cluster whose centroid is within CLUSTER_RADIUS_KM; otherwise
// seeds a new cluster. Cluster centroid is updated as a running mean.
function buildClusters(selfies) {
    const clusters = [];
    for (const s of selfies) {
        let joined = null;
        for (const c of clusters) {
            if (haversineKm(c.lat, c.lng, s.lat, s.lng) <= CLUSTER_RADIUS_KM) {
                joined = c;
                break;
            }
        }
        if (joined) {
            joined.selfies.push(s);
            const n = joined.selfies.length;
            joined.lat = ((joined.lat * (n - 1)) + s.lat) / n;
            joined.lng = ((joined.lng * (n - 1)) + s.lng) / n;
            if (!joined.locationLabel && s.locationLabel) joined.locationLabel = s.locationLabel;
        } else {
            clusters.push({
                lat: s.lat,
                lng: s.lng,
                selfies: [s],
                locationLabel: s.locationLabel || ''
            });
        }
    }
    // Attach derived fields that globe.gl's accessors can read.
    for (const c of clusters) {
        c.count = c.selfies.length;
        c.contactCount = new Set(c.selfies.map(s => s.contactId).filter(Boolean)).size;
    }
    return clusters;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function countInboundLocationShares() {
    return Object.keys(locationSharesInbound || {}).length;
}

/** Meetings first, then live shares so CSS2D stack order paints blue markers on top */
function orderedGlobeHtmlMarkers(meetingClusters, livePins) {
    return [...meetingClusters, ...(livePins || [])].sort((a, b) => {
        const rk = x => (x.globePinType === 'liveShare' ? 1 : 0);
        return rk(a) - rk(b);
    });
}

function globeMarkerPixelWidth(d) {
    if (d.globePinType === 'liveShare') return 27;
    const base = 26;
    const bump = Math.min(20, Math.log2((d.count || 1) + 1) * 6.5);
    return Math.round(base + bump);
}

/** Label shown in custom tooltip + native title attribute */
function globeMarkerTooltipLabel(d) {
    if (d.globePinType === 'liveShare') {
        return d.contactName || 'Someone';
    }
    const title = d.locationLabel || 'Unknown location';
    const meetings = d.count === 1 ? '1 meeting' : `${d.count} meetings`;
    return `${title} · ${meetings}`;
}

function handleGlobeMarkerClick(d) {
    if (!d) return;
    if (d.globePinType === 'liveShare') {
        const plain = d.contactName || 'Someone';
        const msg = `${plain} is sharing their location with you`;
        if (typeof showToast === 'function') showToast(msg);
        else window.alert(msg);
        return;
    }
    openClusterPopup(d);
}

function createGlobeHtmlMarker(d) {
    const anchor = document.createElement('div');
    const isLive = d.globePinType === 'liveShare';
    anchor.className = `globe-marker-anchor${isLive ? ' globe-marker-anchor--live' : ' globe-marker-anchor--meeting'}`;

    const tip = document.createElement('div');
    tip.className = `globe-marker-tooltip${isLive ? ' globe-marker-tooltip--live' : ' globe-marker-tooltip--meeting'}`;
    tip.textContent = globeMarkerTooltipLabel(d);

    const el = document.createElement('div');
    el.className = `globe-marker-icon${isLive ? ' globe-marker-icon--live' : ' globe-marker-icon--meeting'}`;
    el.style.width = `${globeMarkerPixelWidth(d)}px`;
    el.innerHTML = GLOBE_MARKER_SVG;
    el.setAttribute('role', 'button');
    el.title = globeMarkerTooltipLabel(d);

    const showTip = () => tip.classList.add('globe-marker-tooltip--visible');
    const hideTip = () => tip.classList.remove('globe-marker-tooltip--visible');
    anchor.addEventListener('pointerenter', showTip);
    anchor.addEventListener('pointerleave', hideTip);

    el.addEventListener('click', ev => {
        ev.stopPropagation();
        handleGlobeMarkerClick(d);
    });

    anchor.appendChild(tip);
    anchor.appendChild(el);
    return anchor;
}

async function loadLiveShareGlobePins() {
    const inbound = locationSharesInbound || {};
    const ids = [];
    for (const cid of Object.keys(inbound)) {
        const loc = contactLocationsCache[cid];
        if (!loc) continue;
        const lat = Number(loc.lat);
        const lng = Number(loc.lng);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        ids.push(cid);
    }

    const nameById = {};
    if (ids.length > 0) {
        try {
            const { data: profiles, error } = await db
                .from('profiles')
                .select('id, display_name')
                .in('id', ids);
            if (!error) {
                (profiles || []).forEach(p => { nameById[p.id] = p.display_name; });
            }
        } catch (_) { /* best effort */ }
    }

    return ids.map(cid => {
        const loc = contactLocationsCache[cid];
        return {
            globePinType: 'liveShare',
            lat: Math.round(Number(loc.lat) * 1e5) / 1e5,
            lng: Math.round(Number(loc.lng) * 1e5) / 1e5,
            contactId: cid,
            contactName: nameById[cid] || 'Someone',
            count: 1
        };
    });
}

async function refreshGlobePinsIfOnScreen() {
    if (activeMainView !== 'globe' || !_globe) return;
    if (!currentUser) return;
    try {
        if (typeof loadContactLocations === 'function') {
            await loadContactLocations();
        }
        const livePins = await loadLiveShareGlobePins();
        const allPins = orderedGlobeHtmlMarkers(_globeClusters, livePins);

        _globe.htmlElementsData(allPins);

        const emptyHint = document.getElementById('globeEmptyHint');
        if (emptyHint) {
            if (_globeClusters.length === 0 && livePins.length === 0) emptyHint.classList.remove('hidden');
            else emptyHint.classList.add('hidden');
        }
    } catch (e) {
        console.warn('[globe] refreshGlobePinsIfOnScreen:', e);
    }
}

window.addEventListener('union:contactLocationsLoaded', () => {
    refreshGlobePinsIfOnScreen();
});

// ---------- Stats ----------

async function renderGlobeStats(meetingClusters) {
    const sharingEl = document.getElementById('globeSharingLine');
    const citiesEl = document.getElementById('globeCitiesLine');
    const tbody = document.getElementById('globeStatsTableBody');
    if (!citiesEl || !tbody) return;

    const inboundN = countInboundLocationShares();
    if (sharingEl) {
        if (inboundN === 0) {
            sharingEl.textContent = '';
        } else {
            const peopleWord = inboundN === 1 ? 'person is' : 'people are';
            sharingEl.textContent = `${inboundN} ${peopleWord} sharing location with you.`;
        }
    }

    const n = meetingClusters.length;
    if (n === 0) {
        citiesEl.textContent = '';
    } else {
        const word = n === 1 ? 'city' : 'cities';
        citiesEl.textContent = `Contacts in ${n} ${word}.`;
    }

    function row(label, valueHtml) {
        return `<tr><th scope="row">${esc(label)}</th><td>${valueHtml}</td></tr>`;
    }

    try {
        const { data, error } = await db.rpc('get_my_attestation_counts');
        if (error) throw error;

        const love        = data.love_count            || 0;
        const trust       = data.trust_count           || 0;
        const respect     = data.respect_count         || 0;
        const help        = data.help_count            || 0;
        const pic         = data.profile_picture_count || 0;
        const sponsDirect = data.sponsored_direct      || 0;
        const sponsMore   = data.sponsored_indirect    || 0;

        const rows = [];
        if (sponsDirect > 0) {
            const personWord = sponsDirect === 1 ? 'person' : 'people';
            let val = `You have sponsored ${sponsDirect} ${personWord}`;
            if (sponsMore > 0) val += `, who have sponsored ${sponsMore} more`;
            rows.push({ label: 'Sponsorship', text: val + '.' });
        }
        const addLine = (cnt, label, phrase) => {
            const line = formatHeartStatLine(cnt, phrase);
            if (line) rows.push({ label, text: line });
        };
        addLine(pic,     'Profile photo', 'people have validated your profile picture');
        addLine(help,    'Help',          'others will help you');
        addLine(respect, 'Respect',       'others respect you');
        addLine(trust,   'Trust',         'others trust you');
        addLine(love,    'Love',          'others love you');

        tbody.innerHTML = rows.length
            ? rows.map(r => row(r.label, esc(r.text))).join('')
            : `<tr><td class="globe-stats-empty" colspan="2">${esc('No attestations yet.')}</td></tr>`;
    } catch (e) {
        console.error('[globe] Failed to load attestation counts:', e);
        tbody.innerHTML = `<tr><td class="globe-stats-empty" colspan="2">${esc('Could not load trust stats.')}</td></tr>`;
    }
}

// ---------- Cluster popup (carousel) ----------

function openClusterPopup(cluster) {
    if (!cluster || !cluster.selfies || cluster.selfies.length === 0) return;

    closeClusterPopup(); // belt and suspenders

    // Pause auto-rotation so the globe isn't moving behind the popup.
    let restoreAutoRotate = false;
    if (_globe) {
        const controls = _globe.controls();
        if (controls.autoRotate) {
            restoreAutoRotate = true;
            controls.autoRotate = false;
        }
    }

    const state = { index: 0, selfies: cluster.selfies, cluster, restoreAutoRotate };

    const overlay = document.createElement('div');
    overlay.className = 'globe-cluster-overlay';
    overlay.innerHTML = `
        <div class="globe-cluster-modal" role="dialog" aria-modal="true">
            <button class="globe-cluster-close" aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
            <div class="globe-cluster-header">
                <div class="globe-cluster-title" id="globeClusterTitle"></div>
                <div class="globe-cluster-subtitle" id="globeClusterSubtitle"></div>
            </div>
            <div class="globe-cluster-carousel">
                <img class="globe-cluster-img" id="globeClusterImg" alt="">
            </div>
            <div class="globe-cluster-caption">
                <button class="globe-cluster-nav globe-cluster-prev" aria-label="Previous">‹</button>
                <div class="globe-cluster-caption-info">
                    <div class="globe-cluster-caption-name" id="globeClusterName"></div>
                    <div class="globe-cluster-caption-date" id="globeClusterDate"></div>
                </div>
                <div class="globe-cluster-counter" id="globeClusterCounter"></div>
                <button class="globe-cluster-nav globe-cluster-next" aria-label="Next">›</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    _clusterPopup = { overlay, state };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeClusterPopup();
    });
    overlay.querySelector('.globe-cluster-close').addEventListener('click', closeClusterPopup);
    overlay.querySelector('.globe-cluster-prev').addEventListener('click', () => stepClusterPopup(-1));
    overlay.querySelector('.globe-cluster-next').addEventListener('click', () => stepClusterPopup(+1));

    document.addEventListener('keydown', clusterKeyHandler);

    renderClusterPopupFrame();
}

function stepClusterPopup(delta) {
    if (!_clusterPopup) return;
    const { state } = _clusterPopup;
    const n = state.selfies.length;
    state.index = (state.index + delta + n) % n;
    renderClusterPopupFrame();
}

function renderClusterPopupFrame() {
    if (!_clusterPopup) return;
    const { overlay, state } = _clusterPopup;
    const s = state.selfies[state.index];
    const n = state.selfies.length;

    const title = state.cluster.locationLabel || 'Unknown location';
    const contactCount = state.cluster.contactCount || new Set(state.selfies.map(x => x.contactId).filter(Boolean)).size;
    const contactWord = contactCount === 1 ? 'contact' : 'contacts';
    const meetingWord = n === 1 ? 'meeting' : 'meetings';

    overlay.querySelector('#globeClusterTitle').textContent = title;
    overlay.querySelector('#globeClusterSubtitle').textContent = `${n} ${meetingWord} with ${contactCount} ${contactWord}`;

    const img = overlay.querySelector('#globeClusterImg');
    img.src = s.selfieUrl || '';
    img.alt = s.contactName ? `Selfie with ${s.contactName}` : 'Selfie';

    overlay.querySelector('#globeClusterName').textContent = s.contactName || 'Unknown';
    overlay.querySelector('#globeClusterDate').textContent = formatClusterDate(s.date);
    overlay.querySelector('#globeClusterCounter').textContent = `${state.index + 1} of ${n}`;

    const prev = overlay.querySelector('.globe-cluster-prev');
    const next = overlay.querySelector('.globe-cluster-next');
    const single = n <= 1;
    prev.disabled = single;
    next.disabled = single;
    prev.style.display = single ? 'none' : '';
    next.style.display = single ? 'none' : '';
}

function closeClusterPopup() {
    if (!_clusterPopup) return;
    const { overlay, state } = _clusterPopup;
    if (state.restoreAutoRotate && _globe) {
        _globe.controls().autoRotate = true;
    }
    document.removeEventListener('keydown', clusterKeyHandler);
    overlay.remove();
    _clusterPopup = null;
}

function clusterKeyHandler(e) {
    if (!_clusterPopup) return;
    if (e.key === 'Escape') closeClusterPopup();
    else if (e.key === 'ArrowLeft') stepClusterPopup(-1);
    else if (e.key === 'ArrowRight') stepClusterPopup(+1);
}

function formatClusterDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (_) {
        return '';
    }
}
