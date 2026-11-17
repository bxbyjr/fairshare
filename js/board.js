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
const BOARD_CATS = {
    family:    { name: 'Family',         icon: 'home',            color: '#8e44ad' },
    food:      { name: 'Food & Drink',   icon: 'utensils',        color: '#e67e22' },
    arts:      { name: 'Arts & Culture', icon: 'palette',         color: '#b7791f' },
    music:     { name: 'Music',          icon: 'music',           color: '#c2185b' },
    tech:      { name: 'Tech & AI',      icon: 'laptop',          color: '#2d5f7d' },
    games:     { name: 'Games',          icon: 'dice-5',          color: '#a0522d' },
    outdoors:  { name: 'Outdoors',       icon: 'mountain',        color: '#167a52' },
    fitness:   { name: 'Fitness',        icon: 'dumbbell',        color: '#1f8a5b' },
    wellness:  { name: 'Wellness',       icon: 'leaf',            color: '#0f8b8d' },
    learning:  { name: 'Learning',       icon: 'book-open',       color: '#1f3a93' },
    community: { name: 'Community',      icon: 'users',           color: '#5f6b76' },
    market:    { name: 'Buy & Sell',     icon: 'shopping-bag',    color: '#6a3fb5' },
    help:      { name: 'Help & Favors',  icon: 'heart-handshake', color: '#d35400' },
};
const BOARD_PIN = { event: '#6a3fb5', offer: '#1f8a5b', ask: '#b7791f', notice: '#5f6b76' };

const bdDate = d => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const bdTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
const bdFirst = n => (n || 'Member').split(' ')[0];
const bdIni = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const bdIsPast = p => p.status === 'done' || (p.ends_at && new Date(p.ends_at) < new Date()) || (p.kind === 'event' && !p.ends_at && p.starts_at && new Date(p.starts_at) < Date.now() - 3 * 3600e3);
const bdMine = p => !!p.i_responded;
const bdIsLink = v => /^https?:\/\//i.test(v || '');
const bdPlaceLabel = p => bdIsLink(p.place_name) ? 'Online' : p.place_name;
const bdCoverClass = p => bdCoverAttrs(p).cls;
const bdCoverStyle = p => ` style="${bdCoverAttrs(p).style}"`;

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
                <button onclick="bdGoTab(2)">Map</button>
                <button onclick="bdGoTab(3)">Discover</button>
                <button onclick="bdGoTab(4)">Past</button>
                <span class="ink" id="bdInk"></span>
            </div>
            <div class="bd-panels" id="bdPanels">
                <div class="bd-panel" id="bdExplore"><p class="bd-empty">Loading…</p></div>
                <div class="bd-panel" id="bdCal"></div>
                <div class="bd-panel bd-panel-map" id="bdMapPanel"><div id="bdMap"></div><div class="bd-mapcard" id="bdMapCard"></div></div>
                <div class="bd-panel" id="bdDiscover"><p class="bd-empty">Loading…</p></div>
                <div class="bd-panel" id="bdPast"></div>
            </div>
            <button class="bd-fab" onclick="openBoardCompose()"><i data-lucide="plus" aria-hidden="true"></i>Post</button>
        </div>`;
    boardMap = null; boardPins = {};
    const panels = document.getElementById('bdPanels');
    panels.addEventListener('scroll', () => {
        const i = Math.round(panels.scrollLeft / panels.clientWidth);
        if (i !== boardTab) { bdSetTab(i); if (i === 2) bdShowMap(); if (i === 3) loadDiscover(); }
    });
    bdSetTab(boardTab);
    if (boardTab) panels.scrollLeft = boardTab * panels.clientWidth;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    await loadBoard();
    if (boardTab === 2) bdShowMap();
    if (boardTab === 3) loadDiscover();
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
        <div class="bd-cover ${bdCoverClass(p)}${past ? ' past' : ''}"${bdCoverStyle(p)}><div class="deco"></div>
            ${d ? `<div class="date"><small>${d.toLocaleDateString([], { month: 'short' })}</small><b>${d.getDate()}</b></div>` : ''}
            ${!ev && bdPrice(p) ? `<div class="pill">${esc(bdPrice(p))}</div>` : ''}
            ${past ? `<div class="pill">${p.status === 'done' ? 'Done' : 'Ended'}</div>` : (ev && bdMine(p) ? '<div class="pill">✓ Going</div>' : '')}
            <h3>${esc(p.title)}</h3>
        </div>
        <div class="bd-meta">${bdAvatar(p.author_name, p.author_image)}<span class="t"><b>${esc(bdFirst(p.author_name))}</b> · ${d ? `${bdDate(d)}, ${bdTime(d)}` : esc(bdPlaceLabel(p) || BOARD_KINDS[p.kind].label)}</span>${bdFaces(p)}</div>
    </button>`;
}
function bdRow(p) {
    const g = { offer: 'gift', ask: 'hand', notice: 'pin' }[p.kind] || 'circle';
    const sub = [bdFirst(p.author_name), bdPlaceLabel(p), (p.responders || []).length ? `${p.responders.length} ${BOARD_KINDS[p.kind].who}` : null].filter(Boolean).join(' · ');
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
        return `<div class="bd-day"><div class="d${today ? ' today' : ''}">${d ? `<small>${d.toLocaleDateString([], { weekday: 'short' })}</small><b>${d.getDate()}</b>` : '<small>TBD</small>'}</div><div class="items">${list.map(p => `<button class="bd-row" onclick="openBoardPost('${p.id}')"><span class="sw ${bdCoverClass(p)} time">${p.starts_at ? bdTime(p.starts_at).replace(' ', '<br>') : '?'}</span><span class="m"><b>${esc(p.title)}</b><span>${esc(bdPlaceLabel(p) || '')}${bdMine(p) ? ' · you’re going' : (p.responders || []).length ? ` · ${p.responders.length} going` : ''}</span></span></button>`).join('')}</div></div>`;
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
    if (b && ink) { ink.style.left = (b.offsetLeft + 10) + 'px'; ink.style.width = (b.offsetWidth - 20) + 'px'; b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); }
}
function bdGoTab(i) {
    bdSetTab(i);
    const panels = document.getElementById('bdPanels');
    panels.scrollTo({ left: i * panels.clientWidth, behavior: 'smooth' });
    if (i === 2) bdShowMap();
    if (i === 3) loadDiscover();
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
    closeModal(); bdGoTab(2);
    setTimeout(() => { boardMap.setView([p.lat, p.lng], 15, { animate: true }); boardPins[id]?.fire('click'); }, 420);
}

// ---------- discover: across all my groups ----------
let discoverPosts = [];
let discoverCat = null;
async function loadDiscover() {
    const el = document.getElementById('bdDiscover'); if (!el) return;
    const { data, error } = await db.rpc('list_board_all');
    if (error) { el.innerHTML = `<p class="bd-empty">${/list_board_all/.test(error.message) ? 'Discover is not set up on this server yet (re-run sql/board-schema.sql).' : 'Could not load.'}</p>`; return; }
    discoverPosts = data || [];
    renderDiscover();
}
function bdCatCount(k) { return discoverPosts.filter(p => (p.category || 'community') === k).length; }
function renderDiscover() {
    const el = document.getElementById('bdDiscover'); if (!el) return;
    const groups = [...new Set(discoverPosts.map(p => p.group_name))];
    if (discoverCat) {
        const c = BOARD_CATS[discoverCat]; const list = discoverPosts.filter(p => (p.category || 'community') === discoverCat);
        el.innerHTML = `<button class="bd-back" onclick="discoverCat=null; renderDiscover()"><i data-lucide="chevron-left" aria-hidden="true"></i>Discover</button>
            <div class="bd-dh"><span class="bd-cat-ic" style="color:${c.color};background:${c.color}18"><i data-lucide="${c.icon}" aria-hidden="true"></i></span><div><h3>${esc(c.name)}</h3><small>${list.length} across ${groups.length} group${groups.length === 1 ? '' : 's'}</small></div></div>
            ${list.length ? list.map(p => bdDiscoverCard(p)).join('') : '<div class="bd-empty">Nothing in this category right now.</div>'}`;
    } else {
        const soon = discoverPosts.filter(p => p.kind === 'event' && p.starts_at).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 4);
        el.innerHTML = `<div class="bd-dhero"><h2>Discover</h2><p>What’s happening across ${groups.length === 1 ? 'your group' : `your ${groups.length} groups`}. Browse by category, or see what’s coming up.</p></div>
            <div class="bd-sec">Browse by category</div>
            <div class="bd-cats">${Object.entries(BOARD_CATS).map(([k, c]) => { const n = bdCatCount(k); return `<button class="bd-cat${n ? '' : ' empty'}" onclick="discoverCat='${k}'; renderDiscover()"><span class="bd-cat-ic" style="color:${c.color};background:${c.color}18"><i data-lucide="${c.icon}" aria-hidden="true"></i></span><span><b>${esc(c.name)}</b><small>${n} ${n === 1 ? 'post' : 'posts'}</small></span></button>`; }).join('')}</div>
            ${soon.length ? `<div class="bd-sec" style="margin-top:18px">Coming up</div>${soon.map(p => bdDiscoverCard(p)).join('')}` : ''}
            ${!discoverPosts.length ? '<div class="bd-empty">Nothing posted in any of your groups yet. Be the first.</div>' : ''}`;
    }
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}
function bdDiscoverCard(p) {
    const ev = p.kind === 'event'; const d = ev && p.starts_at ? new Date(p.starts_at) : null;
    const price = p.price == null ? '' : (Number(p.price) === 0 ? 'Free' : `${p.currency_symbol || ''} ${Number(p.price)}`);
    return `<button class="bd-card" onclick="openDiscoverPost('${p.id}')">
        <div class="bd-cover ${bdCoverClass(p)}"${bdCoverStyle(p)}><div class="deco"></div>
            ${d ? `<div class="date"><small>${d.toLocaleDateString([], { month: 'short' })}</small><b>${d.getDate()}</b></div>` : ''}
            ${price ? `<div class="pill">${esc(price)}</div>` : ''}
            <h3>${esc(p.title)}</h3></div>
        <div class="bd-meta">${bdAvatar(p.author_name, p.author_image)}<span class="t"><b>${esc(p.group_name)}</b> · ${d ? `${bdDate(d)}, ${bdTime(d)}` : esc(bdPlaceLabel(p) || BOARD_KINDS[p.kind].label)}</span>${bdFaces(p)}</div>
    </button>`;
}
function openDiscoverPost(id) {
    const p = discoverPosts.find(x => x.id === id); if (!p) return;
    if (!boardPosts.find(x => x.id === id)) boardPosts.push(p);   // so the shared detail sheet can find it
    openBoardPost(id);
}

// ---------- detail ----------
function openBoardPost(id) {
    const p = boardPosts.find(x => x.id === id); if (!p) return;
    const k = BOARD_KINDS[p.kind], ev = p.kind === 'event', past = bdIsPast(p), mine = p.author_id === currentUser?.id;
    const body = document.getElementById('modalBody'); const overlay = document.getElementById('modalOverlay');
    body.classList.remove('beta-ios-modal'); body.classList.add('bd-sheet');
    const r = p.responders || [];
    body.style.setProperty('--bd-accent', bdAccent(p));
    body.innerHTML = `
        <div class="bd-cover big ${bdCoverClass(p)}${past ? ' past' : ''}"${bdCoverStyle(p)}><div class="deco"></div><h3>${esc(p.title)}</h3></div>
        <div class="bd-sh">
            <div class="bd-host">${bdAvatar(p.author_name, p.author_image, 'lg')}<div><b>${esc(p.author_name)}</b><span>${ev ? 'is hosting' : p.kind === 'ask' ? 'is asking' : 'posted this'}${p.group_name && p.group_id !== selectedGroup?.id ? ` in ${esc(p.group_name)}` : ''} · ${bdDate(p.created_at)}</span></div></div>
            <div class="bd-facts">
                ${ev && p.starts_at ? `<div class="f"><i data-lucide="calendar" aria-hidden="true"></i>${bdDate(p.starts_at)} · ${bdTime(p.starts_at)}${p.ends_at ? ' to ' + bdTime(p.ends_at) : ''}</div>` : ''}
                ${p.place_name ? (bdIsLink(p.place_name)
                    ? `<a class="f" href="${esc(p.place_name)}" target="_blank" rel="noopener"><i data-lucide="video" aria-hidden="true"></i>Online · ${esc(p.place_name.replace(/^https?:\/\//, '').split('/')[0])}<span class="go">Open ›</span></a>`
                    : `<div class="f"${p.lat ? ` onclick="bdShowPostOnMap('${p.id}')"` : ''}><i data-lucide="map-pin" aria-hidden="true"></i>${esc(p.place_name)}${p.lat ? '<span class="go">Map ›</span>' : ''}</div>`) : ''}
                ${p.category && BOARD_CATS[p.category] ? `<div class="f"><i data-lucide="${BOARD_CATS[p.category].icon}" aria-hidden="true"></i>${esc(BOARD_CATS[p.category].name)}</div>` : ''}
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

// ---------- themes (built-in covers) ----------
// A post's look is stored in image_url: a real URL for an uploaded photo, or
// "theme:<key>" for one of these. Nothing to set up server side.
const BOARD_THEMES = {
    dusk:    { name: 'Dusk',     bg: 'linear-gradient(135deg,#6a3fb5,#b05fa8)', pat: 'dots',   accent: '#6a3fb5' },
    tide:    { name: 'Tide',     bg: 'linear-gradient(135deg,#1f3a93,#2d8fd5)', pat: 'waves',  accent: '#1f3a93' },
    grove:   { name: 'Grove',    bg: 'linear-gradient(135deg,#167a52,#5bc48a)', pat: 'leaves', accent: '#167a52' },
    ember:   { name: 'Ember',    bg: 'linear-gradient(135deg,#b4541a,#f0a26a)', pat: 'rays',   accent: '#b4541a' },
    honey:   { name: 'Honey',    bg: 'linear-gradient(135deg,#b7791f,#f2c94c)', pat: 'dots',   accent: '#9a6416' },
    rose:    { name: 'Rose',     bg: 'linear-gradient(135deg,#c2185b,#f48fb1)', pat: 'confetti', accent: '#c2185b' },
    midnight:{ name: 'Midnight', bg: 'linear-gradient(135deg,#0f2d45,#1a4a6e)', pat: 'stars',  accent: '#1a4a6e' },
    mint:    { name: 'Mint',     bg: 'linear-gradient(135deg,#0f8b8d,#7fd1c4)', pat: 'waves',  accent: '#0f8b8d' },
    slate:   { name: 'Slate',    bg: 'linear-gradient(135deg,#3b4a5c,#7a8ea3)', pat: 'grid',   accent: '#3b4a5c' },
    party:   { name: 'Party',    bg: 'linear-gradient(135deg,#ff6b6b,#feca57,#48dbfb)', pat: 'confetti', accent: '#e05252' },
    paper:   { name: 'Paper',    bg: 'linear-gradient(135deg,#f6f1e7,#e9e1d1)', pat: 'grid',   accent: '#8a7355', dark: true },
    neon:    { name: 'Neon',     bg: 'linear-gradient(135deg,#111,#2a2a2a)', pat: 'rays',   accent: '#b3ff00', glow: '#b3ff00' },
};
const BOARD_DEFAULT_THEME = { event: 'dusk', offer: 'grove', ask: 'honey', notice: 'slate' };
function bdThemeOf(p) {
    if (p.image_url && p.image_url.startsWith('theme:')) return BOARD_THEMES[p.image_url.slice(6)] ? p.image_url.slice(6) : BOARD_DEFAULT_THEME[p.kind];
    if (p.image_url) return null;
    return BOARD_DEFAULT_THEME[p.kind] || 'dusk';
}
function bdCoverAttrs(p) {
    const t = bdThemeOf(p);
    if (!t) return { cls: 'has-img', style: `background-image:url('${esc(p.image_url)}')` };
    const th = BOARD_THEMES[t];
    return { cls: `pat-${th.pat}${th.dark ? ' dark' : ''}${th.glow ? ' glow' : ''}`, style: `background:${th.bg}` };
}
function bdAccent(p) { const t = bdThemeOf(p); return t ? BOARD_THEMES[t].accent : '#1a2433'; }

// ---------- compose ----------
let bdKind = 'event';
let bdCoverFile = null;      // uploaded photo (File)
let bdCoverTheme = 'dusk';   // selected built-in theme, ignored when a photo is set
let bdLocMode = 'place';     // 'place' | 'online'
let bdCat = null;            // optional category key
function bdTzLabel() {
    try { const parts = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()); const tz = parts.find(x => x.type === 'timeZoneName')?.value || ''; const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; return `${zone.replace(/_/g, ' ')}${tz ? ' (' + tz + ')' : ''}`; } catch (_) { return 'your local time'; }
}
function bdLocalInput(d) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function bdTimeInput(d) { const z = n => String(n).padStart(2, '0'); return `${z(d.getHours())}:${z(d.getMinutes())}`; }
function openBoardCompose() {
    const body = document.getElementById('modalBody'); const overlay = document.getElementById('modalOverlay');
    body.classList.remove('beta-ios-modal'); body.classList.add('bd-sheet', 'bd-keep'); body.style.removeProperty('--bd-accent');
    bdCoverFile = null; bdCoverTheme = BOARD_DEFAULT_THEME[bdKind]; bdLocMode = 'place'; bdCat = null;
    const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(18, 0, 0, 0);
    const end = new Date(start); end.setHours(21);
    body.innerHTML = `
        <div class="bd-preview" id="bdPreview"><div class="deco"></div><div class="bd-preview-top"><button type="button" class="bd-x light" onclick="closeModal()">Cancel</button><span class="bd-preview-tag" id="bdPreviewTag">Event</span></div><h3 id="bdPreviewTitle">Your title here</h3></div>
        <div class="bd-sh">
            <div class="bd-kinds" id="bdKinds"></div>
            <div class="bd-covers" id="bdCovers"></div>
            <div class="bd-catrow" id="bdCatRow"></div>
            <input class="bd-f big" id="bdTitle" placeholder="Title" maxlength="120" oninput="bdPreviewUpdate()">
            <textarea class="bd-f" id="bdDetail" rows="2" placeholder="A line or two (optional)" maxlength="1000"></textarea>
            <div id="bdEvF" class="bd-when">
                <div class="bd-when-row"><span class="dot start"></span><b>Start</b><input class="bd-f sm" id="bdStartD" type="date" value="${bdLocalInput(start)}"><input class="bd-f sm" id="bdStartT" type="time" value="${bdTimeInput(start)}"></div>
                <div class="bd-when-row"><span class="dot end"></span><b>End</b><input class="bd-f sm" id="bdEndD" type="date" value="${bdLocalInput(end)}"><input class="bd-f sm" id="bdEndT" type="time" value="${bdTimeInput(end)}"></div>
                <div class="bd-tz"><i data-lucide="globe" aria-hidden="true"></i>${esc(bdTzLabel())}</div>
            </div>
            <div class="bd-loc">
                <div class="bd-seg"><button type="button" class="on" id="bdLocPlace" onclick="bdSetLoc('place')">In person</button><button type="button" id="bdLocOnline" onclick="bdSetLoc('online')">Online</button></div>
                <div id="bdLocPlaceF"><input class="bd-f" id="bdPlace" placeholder="Address or place name"><label class="bd-check"><input type="checkbox" id="bdHere"> Pin my current location on the map</label></div>
                <div id="bdLocOnlineF" style="display:none"><input class="bd-f" id="bdLink" type="url" placeholder="https://… (Zoom, Meet, Second Life, anything)"></div>
            </div>
            <input class="bd-f" id="bdPriceIn" placeholder="Price in ${esc(selectedGroup.currency_name || 'credits')} (blank = free)" inputmode="decimal" style="display:none">
            <p class="bd-hint">Everyone in ${esc(selectedGroup.name)} sees it and gets a notification. It moves to Past when it’s over or you mark it done.</p>
            <button class="bd-btn" style="width:100%" id="bdPostBtn" onclick="submitBoardPost()">Post</button>
        </div>`;
    bdRenderKinds(); bdRenderCovers(); bdRenderCats(); bdPreviewUpdate();
    overlay.classList.remove('hidden');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    setTimeout(() => document.getElementById('bdTitle')?.focus(), 250);
}
function bdRenderKinds() {
    document.getElementById('bdKinds').innerHTML = Object.entries(BOARD_KINDS).map(([k, v]) => `<button type="button" class="${bdKind === k ? 'on' : ''}" onclick="bdSetKind('${k}')">${v.label}</button>`).join('');
    document.getElementById('bdEvF').style.display = bdKind === 'event' ? 'block' : 'none';
    document.getElementById('bdPriceIn').style.display = (bdKind === 'offer' || bdKind === 'ask') ? 'block' : 'none';
    document.getElementById('bdPreviewTag').textContent = BOARD_KINDS[bdKind].label;
}
function bdSetKind(k) { const wasDefault = bdCoverTheme === BOARD_DEFAULT_THEME[bdKind]; bdKind = k; if (wasDefault && !bdCoverFile) bdCoverTheme = BOARD_DEFAULT_THEME[k]; bdRenderKinds(); bdRenderCovers(); bdPreviewUpdate(); }
function bdSetLoc(m) { bdLocMode = m; document.getElementById('bdLocPlace').classList.toggle('on', m === 'place'); document.getElementById('bdLocOnline').classList.toggle('on', m === 'online'); document.getElementById('bdLocPlaceF').style.display = m === 'place' ? 'block' : 'none'; document.getElementById('bdLocOnlineF').style.display = m === 'online' ? 'block' : 'none'; }
function bdRenderCovers() {
    const el = document.getElementById('bdCovers'); if (!el) return;
    el.innerHTML = `<label class="bd-tile upload${bdCoverFile ? ' on' : ''}" title="Your photo"><input type="file" accept="image/*" onchange="bdPickCover(this)" hidden>${bdCoverFile ? `<img src="${URL.createObjectURL(bdCoverFile)}" alt="">` : '<i data-lucide="image-plus" aria-hidden="true"></i><small>Photo</small>'}</label>` +
        Object.entries(BOARD_THEMES).map(([k, t]) => `<button type="button" class="bd-tile pat-${t.pat}${t.dark ? ' dark' : ''}${!bdCoverFile && bdCoverTheme === k ? ' on' : ''}" style="background:${t.bg}" onclick="bdChooseTheme('${k}')" title="${t.name}"><small>${t.name}</small></button>`).join('');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}
function bdRenderCats() {
    const el = document.getElementById('bdCatRow'); if (!el) return;
    el.innerHTML = `<span class="lab">Category</span>` + Object.entries(BOARD_CATS).map(([k, c]) => `<button type="button" class="${bdCat === k ? 'on' : ''}" style="${bdCat === k ? `background:${c.color};border-color:${c.color}` : ''}" onclick="bdCat = bdCat === '${k}' ? null : '${k}'; bdRenderCats()"><i data-lucide="${c.icon}" aria-hidden="true"></i>${esc(c.name)}</button>`).join('');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}
function bdChooseTheme(k) { bdCoverTheme = k; bdCoverFile = null; bdRenderCovers(); bdPreviewUpdate(); }
async function bdPickCover(input) {
    const f = input.files && input.files[0]; if (!f) return;
    try { bdCoverFile = typeof resizeImageFileForChat === 'function' ? await resizeImageFileForChat(f) : f; } catch (_) { bdCoverFile = f; }
    bdRenderCovers(); bdPreviewUpdate();
}
function bdPreviewUpdate() {
    const pv = document.getElementById('bdPreview'); if (!pv) return;
    const t = document.getElementById('bdTitle')?.value.trim();
    document.getElementById('bdPreviewTitle').textContent = t || 'Your title here';
    pv.className = 'bd-preview';
    if (bdCoverFile) { pv.classList.add('has-img'); pv.style.background = `url('${URL.createObjectURL(bdCoverFile)}') center/cover`; }
    else { const th = BOARD_THEMES[bdCoverTheme]; pv.classList.add('pat-' + th.pat); if (th.dark) pv.classList.add('dark'); if (th.glow) pv.classList.add('glow'); pv.style.background = th.bg; }
}
async function bdUploadCover() {
    if (!bdCoverFile) return null;
    const path = `${currentUser.id}/board_${Date.now()}.jpg`;
    const { error } = await db.storage.from('avatars').upload(path, bdCoverFile, { upsert: false, contentType: bdCoverFile.type || 'image/jpeg' });
    if (error) throw error;
    return db.storage.from('avatars').getPublicUrl(path).data?.publicUrl || null;
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
    const btn = document.getElementById('bdPostBtn'); const fail = m => { showToast(m, 'error'); btn.disabled = false; btn.textContent = 'Post'; };
    btn.disabled = true; btn.textContent = 'Posting…';
    const row = { group_id: selectedGroup.id, author_id: currentUser.id, kind: bdKind, title, detail: document.getElementById('bdDetail').value.trim() || null, place_name: null, category: bdCat };
    if (bdLocMode === 'online') { const link = document.getElementById('bdLink').value.trim(); if (link && !/^https?:\/\//i.test(link)) return fail('The link should start with https://'); row.place_name = link || null; }
    else row.place_name = document.getElementById('bdPlace').value.trim() || null;
    if (bdKind === 'event') {
        const sd = document.getElementById('bdStartD').value, st = document.getElementById('bdStartT').value || '18:00';
        if (!sd) return fail('When does it start?');
        const start = new Date(`${sd}T${st}`); if (isNaN(start)) return fail('Check the start date');
        const ed = document.getElementById('bdEndD').value || sd, et = document.getElementById('bdEndT').value;
        let end = et ? new Date(`${ed}T${et}`) : new Date(start.getTime() + 3 * 3600e3);
        if (isNaN(end) || end <= start) return fail('The end needs to be after the start');
        row.starts_at = start.toISOString(); row.ends_at = end.toISOString();
    }
    if (bdKind === 'offer' || bdKind === 'ask') { const v = document.getElementById('bdPriceIn').value.trim(); row.price = v ? Number(v) : (bdKind === 'offer' ? 0 : null); if (v && !(row.price >= 0)) return fail('Check the price'); }
    if (bdLocMode === 'place' && document.getElementById('bdHere').checked) { const pos = await bdGetPosition(); if (pos) { row.lat = pos.lat; row.lng = pos.lng; } else showToast('Could not get your location, posting without a pin', 'error'); }
    if (bdCoverFile) { try { row.image_url = await bdUploadCover(); } catch (e) { showToast('Photo upload failed, using the theme instead', 'error'); row.image_url = 'theme:' + bdCoverTheme; } }
    else row.image_url = 'theme:' + bdCoverTheme;
    const { error } = await db.from('group_posts').insert(row);
    if (error) return fail(error.message);
    closeModal();
    showToast('Posted. The group gets a notification.', 'info');
    await loadBoard();
    bdGoTab(bdKind === 'event' ? 1 : 0);
}
