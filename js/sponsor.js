let sponsorSelectedContactId = null;
let sponsorContactRows = [];

function startSponsorMeet() {
    if (!selectedGroup) return;
    sponsorSelectedContactId = null;
    sponsorContactRows = [];

    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    overlay.classList.remove('hidden');

    body.innerHTML = `
        <h3>Sponsor a New Member</h3>
        <div class="sponsor-choice-tabs">
            <button type="button" class="sponsor-tab active" data-choice="contact" onclick="switchSponsorChoice('contact')">From Contacts</button>
            <button type="button" class="sponsor-tab" data-choice="new" onclick="switchSponsorChoice('new')">Not a Member Yet</button>
        </div>
        <form id="sponsorForm">
            <div id="sponsorContactChoice">
                <div class="form-group">
                    <input type="search" id="sponsorContactSearch" class="contacts-search-input"
                        placeholder="Search contacts…" autocomplete="off" oninput="filterSponsorContacts()">
                </div>
                <div id="sponsorContactList" class="sponsor-contact-list">
                    <p style="color:var(--dark-gray);text-align:center;padding:1rem;">Loading contacts…</p>
                </div>
            </div>
            <div id="sponsorNewChoice" class="hidden">
                <div class="form-group">
                    <label>Describe the person you'd like to sponsor</label>
                    <textarea id="sponsorMessage" rows="2" placeholder="e.g. Jane Smith, my colleague"></textarea>
                </div>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary" id="sponsorSubmitBtn" disabled>Send Offer</button>
            </div>
        </form>
    `;

    loadSponsorContacts();

    document.getElementById('sponsorForm').addEventListener('submit', (e) => {
        e.preventDefault();
        handleSponsorSubmit();
    });
}

function switchSponsorChoice(choice) {
    document.querySelectorAll('.sponsor-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.choice === choice));
    document.getElementById('sponsorContactChoice').classList.toggle('hidden', choice !== 'contact');
    document.getElementById('sponsorNewChoice').classList.toggle('hidden', choice !== 'new');

    const btn = document.getElementById('sponsorSubmitBtn');
    if (choice === 'contact') {
        btn.textContent = 'Send Offer';
        btn.disabled = !sponsorSelectedContactId;
    } else {
        btn.textContent = 'Next';
        btn.disabled = false;
    }
}

async function loadSponsorContacts() {
    const listEl = document.getElementById('sponsorContactList');
    if (!listEl) return;

    try {
        const { data: members } = await db
            .from('members')
            .select('user_id')
            .eq('group_id', selectedGroup.id)
            .in('status', ['active', 'pending']);

        const memberIds = new Set((members || []).map(m => m.user_id));

        let contacts = contactsLoadedRows;
        if (!contacts || contacts.length === 0) {
            const { data: rawContacts } = await db
                .from('contacts')
                .select('*')
                .eq('user_id', currentUser.id)
                .order('met_at', { ascending: false });

            if (rawContacts && rawContacts.length > 0) {
                const contactIds = [...new Set(rawContacts.map(c => c.contact_id))];
                let profileMap = {};
                const { data: profiles } = await db
                    .from('profiles')
                    .select('id, display_name, profile_image_url')
                    .in('id', contactIds);
                if (profiles) profiles.forEach(p => { profileMap[p.id] = p; });
                contacts = rawContacts.map(c => ({
                    contact: c,
                    profile: profileMap[c.contact_id] || {}
                }));
            } else {
                contacts = [];
            }
        }

        // Also check for pending invitations already sent
        const { data: pendingInvites } = await db
            .from('group_invitations')
            .select('candidate_id')
            .eq('group_id', selectedGroup.id)
            .eq('sponsor_id', currentUser.id)
            .eq('status', 'pending');
        const pendingIds = new Set((pendingInvites || []).map(i => i.candidate_id));

        sponsorContactRows = contacts.filter(r => {
            const cid = r.contact?.contact_id;
            return cid && !memberIds.has(cid) && !pendingIds.has(cid) && cid !== currentUser.id;
        });

        renderSponsorContacts();
    } catch (e) {
        console.error('loadSponsorContacts error:', e);
        listEl.innerHTML = '<p style="color:var(--red);text-align:center;padding:1rem;">Failed to load contacts.</p>';
    }
}

function filterSponsorContacts() {
    renderSponsorContacts();
}

function renderSponsorContacts() {
    const listEl = document.getElementById('sponsorContactList');
    if (!listEl) return;

    const query = (document.getElementById('sponsorContactSearch')?.value || '').trim().toLowerCase();
    const filtered = sponsorContactRows.filter(r => {
        if (!query) return true;
        return (r.profile?.display_name || '').toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
        listEl.innerHTML = sponsorContactRows.length === 0
            ? '<p style="color:var(--dark-gray);text-align:center;padding:1rem;">No eligible contacts. All your contacts are already members of this group.</p>'
            : '<p style="color:var(--dark-gray);text-align:center;padding:1rem;">No matching contacts.</p>';
        return;
    }

    listEl.innerHTML = filtered.map(r => {
        const cid = r.contact.contact_id;
        const name = r.profile?.display_name || 'Unknown';
        const avatarUrl = r.profile?.profile_image_url;
        const isSelected = cid === sponsorSelectedContactId;
        const avatarHtml = avatarUrl
            ? `<img class="sponsor-contact-avatar" src="${esc(avatarUrl)}" alt="">`
            : '<div class="sponsor-contact-avatar-placeholder"><i data-lucide="user-round" aria-hidden="true"></i></div>';
        return `<div class="sponsor-contact-row${isSelected ? ' selected' : ''}" onclick="selectSponsorContact('${esc(cid)}')">
            ${avatarHtml}
            <span class="sponsor-contact-name">${esc(name)}</span>
            ${isSelected ? '<span class="sponsor-contact-check">✓</span>' : ''}
        </div>`;
    }).join('');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function selectSponsorContact(contactId) {
    sponsorSelectedContactId = contactId;
    renderSponsorContacts();
    const btn = document.getElementById('sponsorSubmitBtn');
    if (btn) btn.disabled = false;
}

async function handleSponsorSubmit() {
    const isContactMode = !document.getElementById('sponsorContactChoice').classList.contains('hidden');

    if (isContactMode) {
        if (!sponsorSelectedContactId) return;
        const btn = document.getElementById('sponsorSubmitBtn');
        if (btn) btn.disabled = true;

        try {
            const { data, error } = await db.rpc('offer_group_membership', {
                p_group_id: selectedGroup.id,
                p_candidate_id: sponsorSelectedContactId
            });

            if (error) throw error;
            if (data?.error) throw new Error(data.error);

            const contactRow = sponsorContactRows.find(r => r.contact.contact_id === sponsorSelectedContactId);
            const name = contactRow?.profile?.display_name || 'contact';
            showToast(`Membership offer sent to ${name}`, 'success');
            closeModal({ refreshContactList: false });
        } catch (e) {
            console.error('offer_group_membership error:', e);
            showToast('Could not send offer: ' + (e.message || 'error'), 'error');
            if (btn) btn.disabled = false;
        }
    } else {
        const message = document.getElementById('sponsorMessage').value.trim() || null;
        closeModal({ refreshContactList: false });
        openMeetScreen({
            groupId: selectedGroup.id,
            groupName: selectedGroup.name,
            message: message
        });
    }
}
