async function loadTransactions() {
    if (!selectedGroup) return;

    const { data, error } = await db
        .from('transactions')
        .select('*, sender:profiles!transactions_from_user_fkey(display_name), receiver:profiles!transactions_to_user_fkey(display_name)')
        .eq('group_id', selectedGroup.id)
        .order('created_at', { ascending: false })
        .limit(20);

    const txEl = document.getElementById('transactionsContent');
    if (!txEl) return;
    if (error || !data || data.length === 0) {
        txEl.innerHTML = '<p style="color:var(--dark-gray);">No transactions yet.</p>';
        return;
    }

    txEl.innerHTML = `<ul class="tx-list">
        ${data.map(tx => {
            const isMinted = tx.from_user === null;
            const isSender = !isMinted && tx.from_user === currentUser.id;
            const fromLabel = isMinted ? '&#x1F331; Daily Income' : esc(tx.sender?.display_name || '?');
            return `<li class="tx-item">
                <div class="tx-info">
                    <div class="tx-parties">${fromLabel} &rarr; ${esc(tx.receiver?.display_name || '?')}</div>
                    ${tx.memo && !isMinted ? `<div class="tx-memo">${esc(tx.memo)}</div>` : ''}
                    <div class="tx-date">${new Date(tx.created_at).toLocaleString()}</div>
                </div>
                <div class="tx-amount ${isSender ? 'sent' : 'received'}">
                    ${isSender ? '-' : '+'}${selectedGroup.currency_symbol} ${Number(tx.amount).toFixed(2)}
                    ${tx.fee > 0 ? `<div style="font-size:0.7rem;color:var(--dark-gray);">fee: ${Number(tx.fee).toFixed(2)}</div>` : ''}
                </div>
            </li>`;
        }).join('')}
    </ul>`;
}
