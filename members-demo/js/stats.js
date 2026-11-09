async function loadStatsContent() {
    if (!selectedGroup) return;
    const el = document.getElementById('statsContent');
    if (!el) return;

    const currencyOn = groupCurrencyEnabled(selectedGroup);
    const baseQueries = [
        db.from('members').select('*', { count: 'exact', head: true })
            .eq('group_id', selectedGroup.id).eq('status', 'active'),
        db.from('members').select('*', { count: 'exact', head: true })
            .eq('group_id', selectedGroup.id).eq('status', 'pending')
    ];
    if (currencyOn) {
        baseQueries.push(
            db.from('members').select('balance')
                .eq('group_id', selectedGroup.id).eq('status', 'active'),
            db.from('transactions').select('*', { count: 'exact', head: true })
                .eq('group_id', selectedGroup.id)
        );
    }
    const results = await Promise.all(baseQueries);
    const memberCount = results[0].count;
    const pendingCount = results[1].count;
    let totalSupply = 0;
    let txCount = 0;
    let fees30 = 0;
    let income30 = 0;
    if (currencyOn) {
        const members = results[2].data;
        txCount = results[3].count;
        totalSupply = (members || []).reduce((sum, m) => sum + Number(m.balance), 0);
        const thirtyDaysAgo = new Date(Date.now() - 30 * APP_TIMING.DAY_MS).toISOString();
        const { data: recentTx } = await db
            .from('transactions')
            .select('fee, amount, from_user')
            .eq('group_id', selectedGroup.id)
            .gte('created_at', thirtyDaysAgo);
        fees30 = (recentTx || [])
            .filter(tx => tx.from_user !== null)
            .reduce((sum, tx) => sum + Number(tx.fee), 0);
        income30 = (recentTx || [])
            .filter(tx => tx.from_user === null)
            .reduce((sum, tx) => sum + Number(tx.amount), 0);
    }
    const sym = selectedGroup.currency_symbol;
    const memberStats = `
            <div class="info-item"><div class="info-label">Active Members</div><div class="info-value">${memberCount || 0}</div></div>
            <div class="info-item"><div class="info-label">Pending Candidates</div><div class="info-value">${pendingCount || 0}</div></div>`;
    const currencyStats = currencyOn ? `
            <div class="info-item"><div class="info-label">Total Supply</div><div class="info-value">${sym} ${totalSupply.toFixed(2)}</div></div>
            <div class="info-item"><div class="info-label">Total Transactions</div><div class="info-value">${txCount || 0}</div></div>
            <div class="info-item"><div class="info-label">Fee Rate</div><div class="info-value">${(Number(selectedGroup.fee_rate) * 100).toFixed(1)}%</div></div>
            <div class="info-item"><div class="info-label">Daily Income</div><div class="info-value">${sym} ${Number(selectedGroup.daily_income).toFixed(2)}</div></div>
            <div class="info-item"><div class="info-label">30 Day Fees</div><div class="info-value">${sym} ${fees30.toFixed(2)}</div></div>
            <div class="info-item"><div class="info-label">30 Day Income</div><div class="info-value">${sym} ${income30.toFixed(2)}</div></div>` : '';
    el.innerHTML = `<div class="stats-grid">${memberStats}${currencyStats}</div>`;
}
