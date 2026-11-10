// Delegates: the group elects a member to hold one or both of the things it
// otherwise decides by vote. Money policy (fee rate and daily income) and
// admissions (who gets in). Elected and recalled with the same vote card as
// removal. No delegate means nothing changes: the group keeps voting.
//
// Backend (to write): list_delegates, list_delegate_proposals, propose_delegate,
// propose_recall, vote_delegate, unvote_delegate, withdraw_delegate,
// delegate_set_policy. Until then this runs against the demo stub only.

let delegates = [];            // [{user_id, name, powers:['money','admissions'], since}]
const DELEGATE_ALL = ['money', 'admissions'];   // one role, both powers; a split is a later option
let delegateProposals = [];    // same shape as removal proposals, plus kind and powers

const DELEGATE_POWERS = {
    money:      { label: 'Money policy', sub: 'Sets the fee rate and daily income directly' },
    admissions: { label: 'Admissions',   sub: 'Admits or declines people asking to join' },
};

function delegateFor(power) { return delegates.find(d => (d.powers || []).includes(power)) || null; }
function delegateOf(userId) { return delegates.find(d => d.user_id === userId) || null; }
function powersLabel(powers) {
    const p = (powers || []).map(k => (DELEGATE_POWERS[k]?.label || k).toLowerCase());
    return p.length === 2 ? `${p[0]} and ${p[1]}` : (p[0] || '');
}

async function loadDelegates() {
    if (!selectedGroup) return;
    try {
        const [a, b] = await Promise.all([
            db.rpc('list_delegates', { p_group_id: selectedGroup.id }),
            db.rpc('list_delegate_proposals', { p_group_id: selectedGroup.id }),
        ]);
        delegates = Array.isArray(a.data) ? a.data : [];
        delegateProposals = Array.isArray(b.data) ? b.data : [];
    } catch (e) {
        console.warn('delegates:', e);
        delegates = []; delegateProposals = [];
    }
    renderDelegateVotes();
}

// Vote cards on the Members tab, next to the removal ones.
function renderDelegateVotes() {
    const el = document.getElementById('delegateVotesContent');
    if (!el) return;
    if (!delegateProposals.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<h4 class="removal-h">Delegate votes</h4>` + delegateProposals.map(p => {
        const left = typeof removalDaysLeft === 'function' ? removalDaysLeft(p.window_end) : null;
        const meta = [`${p.votes} of ${p.threshold} votes`, left].filter(Boolean).join(' · ');
        const who = p.is_me ? '<strong>you</strong>' : `<strong>${esc(p.target_name)}</strong>`;
        const title = p.kind === 'recall'
            ? `Recall ${who} as delegate?`
            : `Make ${who} the group's delegate?`;
        let action = '';
        if (p.is_me) { /* the person being voted on watches, same as removal */ }
        else if (p.i_proposed) action = `<button class="btn btn-small btn-ghost" onclick="withdrawDelegate('${p.id}')">Withdraw</button>`;
        else if (p.i_voted) action = `<button class="btn btn-small btn-ghost" onclick="unvoteDelegate('${p.id}')">Undo vote</button>`;
        else action = `<button class="btn btn-small ${p.kind === 'recall' ? 'btn-danger' : 'btn-primary'}" onclick="voteDelegate('${p.id}')">${p.kind === 'recall' ? 'Vote to recall' : 'Vote yes'}</button>`;
        return `<div class="removal-card delegate-card${p.is_me ? ' is-me' : ''}">
            <div class="removal-main">
                <div class="removal-title">${title}</div>
                <div class="removal-meta">Proposed by ${esc(p.proposer_name)} · ${meta}${p.is_me ? ' · you cannot vote on this one' : ''}</div>
                ${p.reason ? `<div class="removal-reason">“${esc(p.reason)}”</div>` : ''}
            </div>
            ${action ? `<div class="removal-action">${action}</div>` : ''}
        </div>`;
    }).join('');
}

async function afterDelegateChange(result) {
    if (result?.status === 'passed') {
        showToast(result.kind === 'recall' ? 'The group recalled the delegate.' : 'The group elected a delegate.', 'info');
        if (activeTab === 'members' && typeof renderMembersTab === 'function') { await renderMembersTab(); return; }
    }
    await loadDelegates();
}
async function voteDelegate(id) {
    const { data, error } = await db.rpc('vote_delegate', { p_proposal_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    if (data?.status === 'open') showToast('Vote recorded', 'info');
    await afterDelegateChange(data);
}
async function unvoteDelegate(id) {
    const { data, error } = await db.rpc('unvote_delegate', { p_proposal_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    await afterDelegateChange(data);
}
async function withdrawDelegate(id) {
    const { error } = await db.rpc('withdraw_delegate', { p_proposal_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Proposal withdrawn', 'info');
    await loadDelegates();
}

// Member sheet -> nominate. Tick what they would hold.
function openNominateDelegate(userId, displayName) {
    if (!selectedGroup || !currentUser) return;
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;
    body.classList.remove('beta-ios-modal');
    const me = userId === currentUser.id;
    const name = me ? 'yourself' : esc(displayName || 'this member');
    const first = me ? 'you' : esc((displayName || 'they').split(' ')[0]);
    const pct = Math.round((typeof parseNewMemberThreshold === 'function' ? parseNewMemberThreshold(selectedGroup.constitution) : 1) * 100);
    const days = typeof parseVotingPeriodDays === 'function' ? parseVotingPeriodDays(selectedGroup.constitution) : null;
    const rule = `${pct}% of the other members have to agree` + (days ? `, within ${days} day${days === 1 ? '' : 's'}` : '') + '.';
    const current = delegates[0] && delegates[0].user_id !== userId ? delegates[0].name : null;
    body.innerHTML = `
        <h3>Nominate ${name} as delegate</h3>
        <p class="removal-explain">The delegate sets the fee rate and daily income, and decides who gets in, instead of the group voting each time. The group can recall ${first} the same way, any time. This starts a vote everyone can see. ${rule} Your nomination counts as your vote.</p>
        ${current ? `<p class="removal-explain"><strong>${esc(current)}</strong> is the delegate now. If this passes, ${first.replace('you', 'you')} take${me ? '' : 's'} over.</p>` : ''}
        <div class="form-group">
            <label for="delegateReason">Why ${first}? (optional, shown to the group)</label>
            <textarea id="delegateReason" rows="2" maxlength="280" placeholder="Keep it short."></textarea>
        </div>
        <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-primary" onclick="submitNominateDelegate('${userId}')">Start the vote</button>
        </div>`;
    overlay.classList.remove('hidden');
}
async function submitNominateDelegate(userId) {
    const powers = DELEGATE_ALL;
    const reason = (document.getElementById('delegateReason')?.value || '').trim();
    const { data, error } = await db.rpc('propose_delegate', {
        p_group_id: selectedGroup.id, p_target_id: userId, p_powers: powers, p_reason: reason || null
    });
    if (error) { showToast(error.message, 'error'); return; }
    closeModal();
    if (data?.status === 'passed') { await afterDelegateChange(data); return; }
    showToast('Vote started. The group has been told.', 'info');
    await loadDelegates();
}
async function proposeRecallDelegate(userId, displayName) {
    const d = delegateOf(userId); if (!d) return;
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    const name = esc(displayName || d.name);
    body.classList.remove('beta-ios-modal');
    body.innerHTML = `
        <h3>Recall ${name} as delegate?</h3>
        <p class="removal-explain">${name} currently sets money policy and decides admissions for the group. If the recall passes, the group goes back to voting on both. Same rule as any other vote.</p>
        <div class="form-group">
            <label for="delegateReason">Why? (optional, shown to the group)</label>
            <textarea id="delegateReason" rows="2" maxlength="280"></textarea>
        </div>
        <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-danger" onclick="submitRecallDelegate('${userId}')">Start the vote</button>
        </div>`;
    overlay.classList.remove('hidden');
}
async function submitRecallDelegate(userId) {
    const reason = (document.getElementById('delegateReason')?.value || '').trim();
    const { data, error } = await db.rpc('propose_recall', { p_group_id: selectedGroup.id, p_target_id: userId, p_reason: reason || null });
    if (error) { showToast(error.message, 'error'); return; }
    closeModal();
    if (data?.status === 'passed') { await afterDelegateChange(data); return; }
    showToast('Recall vote started.', 'info');
    await loadDelegates();
}

// Governance tab: who decides what, today.
function whoDecidesHtml() {
    if (!selectedGroup) return '';
    const pct = Math.round((typeof parseNewMemberThreshold === 'function' ? parseNewMemberThreshold(selectedGroup.constitution) : 1) * 100);
    const money = delegateFor('money'), adm = delegateFor('admissions');
    const row = (label, d, fallback) => `
        <div class="decides-row">
            <div class="decides-what">${label}</div>
            <div class="decides-who">${d
                ? `<span class="delegate-badge">Delegate</span> <b>${esc(d.name)}</b><small>since ${esc(d.since || 'now')}. Recall from their row on Members.</small>`
                : `<b>Everyone</b><small>${fallback}</small>`}</div>
        </div>`;
    return `<div class="decides">
        <h4 class="removal-h">Who decides</h4>
        ${row('Money policy', money, 'Fee rate and daily income are the median of all votes.')}
        ${row('Admissions', adm, `A candidate gets in at ${pct}% endorsements.`)}
        <p class="decides-note">${delegates.length ? 'A delegate\'s changes show up in the group feed with their name on them.' : 'To hand both of these to one person, open them on the Members tab and tap Nominate as delegate.'}</p>
    </div>`;
}

// Money tab: the two policy cells. The money delegate sets them; everyone else
// sees who set them. No delegate: the vote links as today.
function moneyPolicyCellsHtml(myFeeVote, myIncomeVote) {
    const sym = esc(selectedGroup.currency_symbol || '');
    const d = delegateFor('money');
    const fee = `${(Number(selectedGroup.fee_rate) * 100).toFixed(1)}%`;
    const inc = `${sym} ${Number(selectedGroup.daily_income).toFixed(2)}`;
    if (d) {
        const mine = d.user_id === currentUser?.id;
        const link = mine ? `<div class="info-vote-link" onclick="openSetPolicy()">change</div>` : `<div class="info-set-by">set by ${esc(d.name.split(' ')[0])}</div>`;
        return `<div class="info-item"><div class="info-label">Fee Rate</div><div class="info-value">${fee}</div>${link}</div>
                <div class="info-item"><div class="info-label">Daily Income</div><div class="info-value">${inc}</div>${link}</div>`;
    }
    return `<div class="info-item"><div class="info-label">Fee Rate</div><div class="info-value">${fee}</div>
            ${myFeeVote ? `<div class="info-my-vote info-vote-link" onclick="showVoteDialog('fee_rate')">Your vote: ${(Number(myFeeVote.value) * 100).toFixed(1)}%</div>` : `<div class="info-vote-link" onclick="showVoteDialog('fee_rate')">vote</div>`}</div>
            <div class="info-item"><div class="info-label">Daily Income</div><div class="info-value">${inc}</div>
            ${myIncomeVote ? `<div class="info-my-vote info-vote-link" onclick="showVoteDialog('daily_income')">Your vote: ${sym} ${Number(myIncomeVote.value).toFixed(2)}</div>` : `<div class="info-vote-link" onclick="showVoteDialog('daily_income')">vote</div>`}</div>`;
}
function openSetPolicy() {
    const body = document.getElementById('modalBody');
    body.classList.remove('beta-ios-modal');
    const sym = esc(selectedGroup.currency_symbol || '');
    body.innerHTML = `
        <h3>Set money policy</h3>
        <p class="removal-explain">You are the group's delegate for money. This takes effect now, and the group is told it was you.</p>
        <div class="form-group"><label>Fee rate (%)</label><input type="number" id="polFee" min="0" max="100" step="0.1" value="${(Number(selectedGroup.fee_rate) * 100).toFixed(1)}"></div>
        <div class="form-group"><label>Daily income (${sym})</label><input type="number" id="polInc" min="0" step="0.01" value="${Number(selectedGroup.daily_income).toFixed(2)}"></div>
        <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-primary" onclick="submitSetPolicy()">Apply</button>
        </div>`;
    document.getElementById('modalOverlay').classList.remove('hidden');
}
async function submitSetPolicy() {
    const fee = Number(document.getElementById('polFee').value) / 100, inc = Number(document.getElementById('polInc').value);
    if (!(fee >= 0 && fee <= 1) || !(inc >= 0)) { showToast('Check the numbers', 'error'); return; }
    const { error } = await db.rpc('delegate_set_policy', { p_group_id: selectedGroup.id, p_fee_rate: fee, p_daily_income: inc });
    if (error) { showToast(error.message, 'error'); return; }
    closeModal();
    showToast('Policy updated. The group has been told.', 'info');
    if (typeof renderMoneyTab === 'function') await renderMoneyTab();
}
