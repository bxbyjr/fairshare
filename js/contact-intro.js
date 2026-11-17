// Contact intro: deep link + push + Realtime → modal dialogs (see sql/contact-intro-and-met-via-migration.sql).

async function showContactIntroDialog(introId) {
    if (!introId || !currentUser) return;

    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;

    overlay.classList.remove('hidden');
    body.classList.remove('share-modal', 'modal-wide');
    body.innerHTML = '<h3>Intro</h3><p style="color:var(--dark-gray);">Loading\u2026</p>';

    let data;
    try {
        const res = await db.rpc('get_contact_intro_dialog', { p_intro_id: introId });
        if (res.error) throw res.error;
        data = res.data;
    } catch (e) {
        console.error('get_contact_intro_dialog error:', e);
        showToast('Could not load intro: ' + (e.message || 'error'), 'error');
        closeModal();
        return;
    }

    const introName = data?.introducer_display_name || 'Someone';
    const otherName = data?.other_display_name || 'Someone';
    const introText = data?.intro_text || '';
    const already = !!data?.already_connected;

    if (already) {
        body.innerHTML = `
            <h3>${esc(introName)} is re-introducing you to ${esc(otherName)}</h3>
            <div class="form-actions" style="margin-top:1rem;">
                <button type="button" class="btn btn-primary" onclick="closeModal()">OK</button>
            </div>
        `;
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
        return;
    }

    body.innerHTML = `
        <h3>${esc(introName)} wants you to meet ${esc(otherName)}</h3>
        <p style="font-size:0.9rem;color:var(--dark-gray);margin:0.75rem 0;">${esc(introText)}</p>
        <div class="form-actions" style="flex-wrap:wrap;gap:0.5rem;">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Ignore</button>
            <button type="button" class="btn btn-primary" onclick="acceptContactIntroFromDialog('${esc(introId)}')">Add as contact</button>
        </div>
    `;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

async function acceptContactIntroFromDialog(introId) {
    if (!introId || !currentUser) return;
    try {
        if (typeof window !== 'undefined') window.__suppressContactOpenOnInsert = true;
        const { data, error } = await db.rpc('accept_contact_intro', { p_intro_id: introId });
        if (error) throw error;
        if (data?.already_connected) {
            closeModal();
            return;
        }
        closeModal();
        if (typeof loadAndRenderContactList === 'function') {
            await loadAndRenderContactList();
        }
        showToast('Added to your contacts.', 'success');
    } catch (e) {
        console.error('accept_contact_intro error:', e);
        showToast('Could not add contact: ' + (e.message || 'error'), 'error');
    } finally {
        setTimeout(() => {
            if (typeof window !== 'undefined') window.__suppressContactOpenOnInsert = false;
        }, 800);
    }
}
