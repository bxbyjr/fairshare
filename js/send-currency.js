async function loadSendModal() {
    if (!selectedGroup || !groupCurrencyEnabled(selectedGroup)) {
        showToast('This group does not use currency', 'error');
        return;
    }
    const body = document.getElementById('modalBody');

    // Load active members (excluding self)
    const { data: members } = await db
        .from('members')
        .select('user_id, profiles(display_name)')
        .eq('group_id', selectedGroup.id)
        .eq('status', 'active')
        .neq('user_id', currentUser.id);

    const options = (members || []).map(m =>
        `<option value="${m.user_id}">${esc(m.profiles?.display_name || 'Unknown')}</option>`
    ).join('');

    body.innerHTML = `
        <h3>Send ${esc(selectedGroup.currency_symbol)}</h3>
        <form id="sendForm">
            <div class="form-group">
                <label>To</label>
                <select id="sendTo" required>${options || '<option disabled>No other members</option>'}</select>
            </div>
            <div class="form-group">
                <label>Amount</label>
                <input type="number" id="sendAmount" required min="0.01" step="any" placeholder="0.00">
            </div>
            <div class="form-group">
                <label>Memo (optional)</label>
                <input type="text" id="sendMemo" placeholder="What's this for?">
            </div>
            <p style="font-size:0.8rem;color:var(--dark-gray);">
                Fee rate: ${(Number(selectedGroup.fee_rate) * 100).toFixed(1)}%
            </p>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary" ${!options ? 'disabled' : ''}>Send</button>
            </div>
        </form>
    `;
    document.getElementById('sendForm').addEventListener('submit', (e) => sendCurrency(e));
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

async function sendCurrency(e) {
    e.preventDefault();
    const toUser = document.getElementById('sendTo').value;
    const amount = parseFloat(document.getElementById('sendAmount').value);
    const memo = document.getElementById('sendMemo').value.trim() || null;

    const { data, error } = await db.rpc('send_currency', {
        p_group_id: selectedGroup.id,
        p_to_user: toUser,
        p_amount: amount,
        p_memo: memo
    });

    if (error) { showToast(error.message, 'error'); return; }

    showToast(`Sent ${selectedGroup.currency_symbol} ${amount.toFixed(2)} (fee: ${selectedGroup.currency_symbol} ${Number(data.fee).toFixed(2)})`, 'success');
    closeModal();
    // Refresh balance + transactions
    await loadMyGroups();
    if (activeTab === 'money') await renderMoneyTab();
}
