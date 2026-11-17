// Board tab: one feed per group for events, offers, asks and notices.
// Explore / Calendar / Past / Map, swipeable. Data: public.group_posts and
// public.post_responses (sql/board-schema.sql), read through list_board().

let boardPosts = [];
let boardTab = 0;
let boardMap = null;
let boardPins = {};

const BOARD_KINDS = {
    event:  { label: 'Event',  verb: 'I’m going',    done: 'You’re going',     who: 'going',      cover: 'bd-c-event' },
    offer:  { label: 'Offer',  verb: 'I’ll take it', done: 'You asked for it', who: 'interested', cover: 'bd-c-offer' },
    ask:    { label: 'Ask',    verb: 'I can help',   done: 'You offered',      who: 'can help',   cover: 'bd-c-ask' },
    notice: { label: 'Notice', verb: 'Got it',       done: 'Seen',             who: 'seen',       cover: 'bd-c-notice' },
};
const BOARD_PIN = { event: '#6a3fb5', offer: '#1f8a5b', ask: '#b7791f', notice: '#5f6b76' };

const bdDate = d => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const bdTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
const bdFirst = n => (n || 'Member').split(' ')[0];
const bdIni = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const bdIsPast = p => p.status === 'done' || (p.ends_at && new Date(p.ends_at) < new Date()) || (p.kind === 'event' && !p.ends_at && p.starts_at && new Date(p.starts_at) < Date.now() - 3 * 3600e3);
const bdMine = p => !!p.i_responded;
const bdCoverClass = p => BOARD_KINDS[p.kind].cover + ((parseInt(String(p.id).replace(/-/g, '').slice(0, 6), 16) % 2) ? ' alt' : '');

function bdAvatar(name, image, cls) {
    return image ? `<img class="bd-av ${cls || ''}" src="${esc(image)}" alt="">` : `<span class="bd-av ${cls || ''}">${esc(bdIni(name))}</span>`;
}
function bdSym() { return selectedGroup?.currency_symbol || ''; }
function bdPrice(p) {
    if (p.price === null || p.price === undefined) return '';
    return Number(p.price) === 0 ? 'Free' : `${bdSym()} ${Number(p.price) % 1 ? Number(p.price).toFixed(2) : Number(p.price)}`;
}
function bdFaces(p) {
    const r = p.responders || [];
    if (!r.length) return '';
    return `<span class="bd-faces"><span class="s">${r.slice(0, 3).map(x => bdAvatar(x.name, x.image)).join('')}</span>${r.length} ${BOARD_KINDS[p.kind].who}</span>`;
}

// ---------- render ----------
async function renderBoardTab() {
    if (!selectedGroup) return;
    const content = document.getElementById('tabContent');
    content.innerHTML = `
        <div class="bd">
            <div class="bd-tabs" id="bdTabs">
                <button onclick="bdGoTab(0)">Explore</button>
                <button onclick="bdGoTab(1)">Calendar<span class="count" id="bdCalCount"></span></button>
                <button onclick="bdGoTab(2)">Past</button>
                <button onclick="bdGoTab(3)">Map</button>
                <span class="ink" id="bdInk"></span>
            </div>
            <div class="bd-panels" id="bdPanels">
                <div class="bd-panel" id="bdExplore"><p class="bd-empty">Loading…</p></div>
                <div class="bd-panel" id="bdCal"></div>
                <div class="bd-panel" id="bdPast"></div>
                <div class="bd-panel bd-panel-map" id="bdMapPanel"><div id="bdMap"></div><div class="bd-mapcard" id="bdMapCard"></div></div>
            </div>
            <button class="bd-fab" onclick="openBoardCompose()"><i data-lucide="plus" aria-hidden="true"></i>Post</button>
        </div>`;
    boardMap = null; boardPins = {};
    const panels = document.getElementById('bdPanels');
    panels.addEventListener('scroll', () => {
        const i = Math.round(panels.scrollLeft / panels.clientWidth);
        if (i !== boardTab) { bdSetTab(i); if (i === 3) bdShowMap(); }
    });
    bdSetTab(boardTab);
    if (boardTab) panels.scrollLeft = boardTab * panels.clientWidth;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    await loadBoard();
    if (boardTab === 3) bdShowMap();
}

async function loadBoard() {
    if (!selectedGroup) return;
    const { data, error } = await db.rpc('list_board', { p_group_id: selectedGroup.id });
    if (error) {
        console.warn('board:', error);
        const el = document.getElementById('bdExplore');
        if (el) el.innerHTML = `<p class="bd-empty">${/list_board/.test(error.message) ? 'The board is not set up on this server yet (run sql/board-schema.sql).' : 'Could not load the board.'}</p>`;
        return;
    }
    boardPosts = data || [];
    bdRenderAll();
}

function bdCard(p, past) {
    const ev = p.kind === 'event';
    const d = ev && p.starts_at ? new Date(p.starts_at) : null;
    return `<button class="bd-card" onclick="openBoardPost('${p.id}')">
        <div class="bd-cover ${bdCoverClass(p)}${past ? ' past' : ''}"><div class="deco"></div>
            ${d ? `<div class="date"><small>${d.toLocaleDateString([], { month: 'short' })}</small><b>${d.getDate()}</b></div>` : ''}
            ${!ev && bdPrice(p) ? `<div class="pill">${esc(bdPrice(p))}</div>` : ''}
            ${past ? `<div class="pill">${p.status === 'done' ? 'Done' : 'Ended'}</div>` : (ev && bdMine(p) ? '<div class="pill">✓ Going</div>' : '')}
            <h3>${esc(p.title)}</h3>
        </div>
        <div class="bd-meta">${bdAvatar(p.author_name, p.author_image)}<span class="t"><b>${esc(bdFirst(p.author_name))}</b> · ${d ? `${bdDate(d)}, ${bdTime(d)}` : esc(p.place_name || BOARD_KINDS[p.kind].label)}</span>${bdFaces(p)}</div>
    </button>`;
}
function bdRow(p) {
    const g = { offer: 'gift', ask: 'hand', notice: 'pin' }[p.kind] || 'circle';
    const sub = [bdFirst(p.author_name), p.place_name, (p.responders || []).length ? `${p.responders.length} ${BOARD_KINDS[p.kind].who}` : null].filter(Boolean).join(' · ');
    return `<button class="bd-row" onclick="openBoardPost('${p.id}')"><span class="sw" style="background:${BOARD_PIN[p.kind]}"><i data-lucide="${g}" aria-hidden="true"></i></span><span class="m"><b>${esc(p.title)}</b><span>${esc(sub)}</span></span>${bdPrice(p) ? `<span class="price">${esc(bdPrice(p))}</span>` : ''}</button>`;
}
function bdRenderAll() {
    const up = boardPosts.filter(p => !bdIsPast(p));
    const events = up.filter(p => p.kind === 'event').sort((a, b) => new Date(a.starts_at || 0) - new Date(b.starts_at || 0));
    const rest = up.filter(p => p.kind !== 'event');
    const ex = document.getElementById('bdExplore'); if (!ex) return;
    ex.innerHTML = (!up.length ? `<div class="bd-empty"><b>Nothing on the board yet.</b><br>Post an event, offer something, or ask for a hand.</div>` : '') +
        (events.length ? `<div class="bd-sec">Coming up</div>${events.slice(0, 2).map(p => bdCard(p)).join('')}` : '') +
        (rest.length ? `<div class="bd-sec">Offers and asks</div>${rest.map(bdRow).join('')}` : '') +
        (events.length > 2 ? `<div class="bd-sec">More events</div>${events.slice(2).map(p => bdCard(p)).join('')}` : '');
    // calendar
    document.getElementById('bdCalCount').textContent = events.length || '';
    const days = {};
    events.forEach(p => { const k = p.starts_at ? new Date(p.starts_at).toDateString() : 'tbd'; (days[k] = days[k] || []).push(p); });
    document.getElementById('bdCal').innerHTML = Object.entries(days).map(([k, list]) => {
        const d = list[0].starts_at ? new Date(list[0].starts_at) : null;
        const today = d && d.toDateString() === new Date().toDateString();
        return `<div class="bd-day"><div class="d${today ? ' today' : ''}">${d ? `<small>${d.toLocaleDateString([], { weekday: 'short' })}</small><b>${d.getDate()}</b>` : '<small>TBD</small>'}</div><div class="items">${list.map(p => `<button class="bd-row" onclick="openBoardPost('${p.id}')"><span class="sw ${bdCoverClass(p)} time">${p.starts_at ? bdTime(p.starts_at).replace(' ', '<br>') : '?'}</span><span class="m"><b>${esc(p.title)}</b><span>${esc(p.place_name || '')}${bdMine(p) ? ' · you’re going' : (p.responders || []).length ? ` · ${p.responders.length} going` : ''}</span></span></button>`).join('')}</div></div>`;
    }).join('') || '<div class="bd-empty">Nothing on the calendar yet.</div>';
    // past
    const past = boardPosts.filter(bdIsPast);
    document.getElementById('bdPast').innerHTML = past.length ? past.map(p => bdCard(p, true)).join('') : '<div class="bd-empty">Nothing here yet.</div>';
    bdRenderPins();
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

// ---------- tabs ----------
function bdSetTab(i) {
    boardTab = i;
    const tabs = document.getElementById('bdTabs'); if (!tabs) return;
    const btns = [...tabs.querySelectorAll('button')];
    btns.forEach((b, j) => b.classList.toggle('on', j === i));
    const b = btns[i], ink = document.getElementById('bdInk');
    if (b && ink) { ink.style.left = (b.offsetLeft + 10) + 'px'; ink.style.width = (b.offsetWidth - 20) + 'px'; }
}
function bdGoTab(i) {
    bdSetTab(i);
    const panels = document.getElementById('bdPanels');
    panels.scrollTo({ left: i * panels.clientWidth, behavior: 'smooth' });
    if (i === 3) bdShowMap();
}

// ---------- map ----------
function bdShowMap() {
    if (typeof L === 'undefined') return;
    if (!boardMap) {
        const withPlace = boardPosts.filter(p => p.lat && p.lng && !bdIsPast(p));
        const center = withPlace.length ? [withPlace[0].lat, withPlace[0].lng] : [37.78, -122.42];
        boardMap = L.map('bdMap', { zoomControl: false }).setView(center, 13);
        L.tileLayer(APP_MAP.TILE_URL, { attribution: APP_MAP.ATTRIBUTION || '© OpenStreetMap, © CARTO', maxZoom: 19 }).addTo(boardMap);
        boardMap.on('click', () => { document.getElementById('bdMapCard')?.classList.remove('on'); bdClearSel(); });
        if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos => {
            L.marker([pos.coords.latitude, pos.coords.longitude], { icon: L.divIcon({ className: '', html: '<div class="bd-pin me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(boardMap);
            if (!withPlace.length) boardMap.setView([pos.coords.latitude, pos.coords.longitude], 13);
        }, () => {}, { timeout: 4000 });
    }
    setTimeout(() => { boardMap.invalidateSize(); bdRenderPins(); }, 350);
}
function bdClearSel() { Object.values(boardPins).forEach(m => m.getElement()?.querySelector('.bd-pin')?.classList.remove('sel')); }
function bdRenderPins() {
    if (!boardMap) return;
    Object.values(boardPins).forEach(m => boardMap.removeLayer(m)); boardPins = {};
    const pts = [];
    boardPosts.filter(p => p.lat && p.lng && !bdIsPast(p)).forEach(p => {
        const lab = p.kind === 'event' && p.starts_at ? new Date(p.starts_at).getDate() : '';
        const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="bd-pin" style="background:${BOARD_PIN[p.kind]}">${lab}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(boardMap);
        m.on('click', () => { bdClearSel(); m.getElement()?.querySelector('.bd-pin')?.classList.add('sel'); const c = document.getElementById('bdMapCard'); c.innerHTML = bdCard(p); c.classList.add('on'); boardMap.panTo([p.lat, p.lng], { animate: true }); });
        boardPins[p.id] = m; pts.push([p.lat, p.lng]);
    });
    if (pts.length > 1) boardMap.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
}
function bdShowPostOnMap(id) {
    const p = boardPosts.find(x => x.id === id); if (!p || !p.lat) return;
    closeModal(); bdGoTab(3);
    setTimeout(() => { boardMap.setView([p.lat, p.lng], 15, { animate: true }); boardPins[id]?.fire('click'); }, 420);
}

// ---------- detail ----------
function openBoardPost(id) {
    const p = boardPosts.find(x => x.id === id); if (!p) return;
    const k = BOARD_KINDS[p.kind], ev = p.kind === 'event', past = bdIsPast(p), mine = p.author_id === currentUser?.id;
    const body = document.getElementById('modalBody'); const overlay = document.getElementById('modalOverlay');
    body.classList.remove('beta-ios-modal'); body.classList.add('bd-sheet');
    const r = p.responders || [];
    body.innerHTML = `
        <div class="bd-cover big ${bdCoverClass(p)}${past ? ' past' : ''}"><div class="deco"></div><h3>${esc(p.title)}</h3></div>
        <div class="bd-sh">
            <div class="bd-host">${bdAvatar(p.author_name, p.author_image, 'lg')}<div><b>${esc(p.author_name)}</b><span>${ev ? 'is hosting' : p.kind === 'ask' ? 'is asking' : 'posted this'} · ${bdDate(p.created_at)}</span></div></div>
            <div class="bd-facts">
                ${ev && p.starts_at ? `<div class="f"><i data-lucide="calendar" aria-hidden="true"></i>${bdDate(p.starts_at)} · ${bdTime(p.starts_at)}${p.ends_at ? ' to ' + bdTime(p.ends_at) : ''}</div>` : ''}
                ${p.place_name ? `<div class="f"${p.lat ? ` onclick="bdShowPostOnMap('${p.id}')"` : ''}><i data-lucide="map-pin" aria-hidden="true"></i>${esc(p.place_name)}${p.lat ? '<span class="go">Map ›</span>' : ''}</div>` : ''}
                ${bdPrice(p) ? `<div class="f"><i data-lucide="coins" aria-hidden="true"></i>${esc(bdPrice(p))}${Number(p.price) ? ` ${esc(selectedGroup.currency_name || 'credits')}, paid in the app` : ''}</div>` : ''}
            </div>
            ${p.detail ? `<p class="bd-desc">${esc(p.detail)}</p>` : ''}
            ${r.length ? `<div class="bd-going"><span class="s">${r.slice(0, 5).map(x => bdAvatar(x.name, x.image)).join('')}</span>${r.slice(0, 2).map(x => bdFirst(x.name)).join(', ')}${r.length > 2 ? ` and ${r.length - 2} more` : ''} ${k.who}</div>` : ''}
            ${past ? `<div class="bd-btns"><button class="bd-btn ghost" style="flex:1" onclick="closeModal()">${p.status === 'done' ? 'This one’s done' : 'This one’s over'}</button></div>` :
              mine ? `<div class="bd-btns"><button class="bd-btn ghost" style="flex:1" onclick="boardMarkDone('${p.id}')">Mark as done</button></div>` :
              `<div class="bd-btns"><button class="bd-btn${bdMine(p) ? ' done' : ''}" onclick="boardRespond('${p.id}')">${bdMine(p) ? '✓ ' + k.done : k.verb}</button>${Number(p.price) && p.kind === 'offer' ? `<button class="bd-btn ghost" onclick="boardPay('${p.id}')">Pay</button>` : `<button class="bd-btn ghost" onclick="boardMessage('${p.id}')">Message</button>`}</div>`}
        </div>`;
    overlay.classList.remove('hidden');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}
async function boardRespond(id) {
    const p = boardPosts.find(x => x.id === id); if (!p || !currentUser) return;
    const q = bdMine(p)
        ? db.from('post_responses').delete().eq('post_id', id).eq('user_id', currentUser.id)
        : db.from('post_responses').insert({ post_id: id, user_id: currentUser.id });
    const { error } = await q;
    if (error) { showToast(error.message, 'error'); return; }
    showToast(bdMine(p) ? 'Removed you' : `${bdFirst(p.author_name)} gets a notification`, 'info');
    await loadBoard(); openBoardPost(id);
}
async function boardMarkDone(id) {
    const { error } = await db.from('group_posts').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) { showToast(error.message, 'error'); return; }
    closeModal(); await loadBoard();
}
function boardMessage(id) {
    const p = boardPosts.find(x => x.id === id); closeModal();
    try { if (typeof openDirectMessageScreen === 'function') return openDirectMessageScreen(p.author_id); } catch (_) {}
    showToast(`Message ${bdFirst(p.author_name)} from their profile`, 'info');
}
function boardPay(id) {
    const p = boardPosts.find(x => x.id === id); closeModal();
    if (typeof openPayToPerson === 'function') openPayToPerson(p.author_id, p.author_name, selectedGroup.id, p.author_image);
    else if (typeof showModal === 'function') showModal('send');
}

// ---------- compose ----------
let bdKind = 'event';
function openBoardCompose() {
    const body = document.getElementById('modalBody'); const overlay = document.getElementById('modalOverlay');
    body.classList.remove('beta-ios-modal'); body.classList.add('bd-sheet');
    body.innerHTML = `
        <div class="bd-sh">
            <h3 class="bd-h">New post</h3>
            <div class="bd-kinds" id="bdKinds"></div>
            <input class="bd-f" id="bdTitle" placeholder="Title" maxlength="120">
            <textarea class="bd-f" id="bdDetail" rows="2" placeholder="A line or two (optional)" maxlength="1000"></textarea>
            <div id="bdEvF">
                <div class="bd-frow"><input class="bd-f" id="bdStart" type="datetime-local"><input class="bd-f" id="bdEnd" type="time" title="Ends"></div>
            </div>
            <input class="bd-f" id="bdPlace" placeholder="Where (optional)">
            <label class="bd-check"><input type="checkbox" id="bdHere"> Pin my current location on the map</label>
            <input class="bd-f" id="bdPriceIn" placeholder="Price in ${esc(selectedGroup.currency_name || 'credits')} (blank = free)" inputmode="decimal" style="display:none">
            <p class="bd-hint">Everyone in ${esc(selectedGroup.name)} sees it and gets a notification. It moves to Past when it’s over or you mark it done.</p>
            <button class="bd-btn" style="width:100%" id="bdPostBtn" onclick="submitBoardPost()">Post</button>
        </div>`;
    bdRenderKinds();
    overlay.classList.remove('hidden');
    setTimeout(() => document.getElementById('bdTitle')?.focus(), 250);
}
function bdRenderKinds() {
    document.getElementById('bdKinds').innerHTML = Object.entries(BOARD_KINDS).map(([k, v]) => `<button type="button" class="${bdKind === k ? 'on' : ''}" onclick="bdKind='${k}';bdRenderKinds()">${v.label}</button>`).join('');
    document.getElementById('bdEvF').style.display = bdKind === 'event' ? 'block' : 'none';
    document.getElementById('bdPriceIn').style.display = (bdKind === 'offer' || bdKind === 'ask') ? 'block' : 'none';
}
function bdGetPosition() {
    return new Promise(res => {
        if (!navigator.geolocation) return res(null);
        navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 6000, maximumAge: 60000 });
    });
}
async function submitBoardPost() {
    const title = document.getElementById('bdTitle').value.trim();
    if (!title) { showToast('Give it a title', 'error'); return; }
    const btn = document.getElementById('bdPostBtn'); btn.disabled = true; btn.textContent = 'Posting…';
    const row = { group_id: selectedGroup.id, author_id: currentUser.id, kind: bdKind, title, detail: document.getElementById('bdDetail').value.trim() || null, place_name: document.getElementById('bdPlace').value.trim() || null };
    if (bdKind === 'event') {
        const s = document.getElementById('bdStart').value;
        if (!s) { showToast('When is it?', 'error'); btn.disabled = false; btn.textContent = 'Post'; return; }
        row.starts_at = new Date(s).toISOString();
        const e = document.getElementById('bdEnd').value;
        if (e) { const d = new Date(s); const [h, m] = e.split(':').map(Number); d.setHours(h, m, 0, 0); if (d < new Date(s)) d.setDate(d.getDate() + 1); row.ends_at = d.toISOString(); }
        else { const d = new Date(s); d.setHours(d.getHours() + 3); row.ends_at = d.toISOString(); }
    }
    if (bdKind === 'offer' || bdKind === 'ask') { const v = document.getElementById('bdPriceIn').value.trim(); row.price = v ? Number(v) : (bdKind === 'offer' ? 0 : null); if (v && !(row.price >= 0)) { showToast('Check the price', 'error'); btn.disabled = false; btn.textContent = 'Post'; return; } }
    if (document.getElementById('bdHere').checked) { const pos = await bdGetPosition(); if (pos) { row.lat = pos.lat; row.lng = pos.lng; } else showToast('Could not get your location, posting without a pin', 'error'); }
    const { error } = await db.from('group_posts').insert(row);
    if (error) { showToast(error.message, 'error'); btn.disabled = false; btn.textContent = 'Post'; return; }
    closeModal();
    showToast('Posted. The group gets a notification.', 'info');
    await loadBoard();
    bdGoTab(bdKind === 'event' ? 1 : 0);
}
