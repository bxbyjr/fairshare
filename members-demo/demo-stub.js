// Demo data for the "remove a member by vote" screen. No network, no login.
(function () {
  const names = ['Philip', 'Jane', 'Benjamin', 'Kaliya', 'Ryan'];
  const members = names.map((n, i) => ({ group_id: 'g1', user_id: 'u' + (i + 1), status: 'active', balance: 10 + i * 3, joined_at: '2026-09-0' + (i + 1), profiles: { display_name: n, profile_image_url: null } }));
  // A second group so the picker can show someone you share two groups with (Philip).
  ['u1', 'u2', 'u5'].forEach((id, i) => members.push({ group_id: 'g2', user_id: id, status: 'active', balance: 20, joined_at: '2026-10-1' + i, profiles: { display_name: names[parseInt(id.slice(1), 10) - 1], profile_image_url: null } }));
  // Recents: who you paid last, newest first.
  const recents = [{ to_user: 'u1', group_id: 'g1', from_user: 'u2', created_at: '2026-11-08' }, { to_user: 'u4', group_id: 'g1', from_user: 'u2', created_at: '2026-11-03' }];
  const PCT = 0.6, DAYS = 7;
  const state = { me: 'u2', proposals: [], events: [], balance: 42 };
  window.__demo = { state, members, names, PCT, DAYS };
  const nameOf = id => (members.find(m => m.user_id === id) || {}).profiles?.display_name || '?';
  const eligible = (target) => members.filter(m => m.status === 'active' && m.user_id !== target).length;
  const check = (p) => {
    const el = eligible(p.target_id), thr = Math.max(1, Math.ceil(el * PCT));
    if (p.status === 'open' && p.votes.size >= thr) {
      p.status = 'passed';
      const m = members.find(m => m.user_id === p.target_id); if (m) m.status = 'removed';
      state.events.push({ event_type: 'member_removed', summary: nameOf(p.target_id) + ' was removed by group vote', metadata: { user_id: p.target_id } });
    }
    return { id: p.id, status: p.status, votes: p.votes.size, threshold: thr, eligible: el, window_end: p.window_end };
  };
  const view = (p) => Object.assign(check(p), {
    target_id: p.target_id, target_name: nameOf(p.target_id), proposer_id: p.proposer_id, proposer_name: nameOf(p.proposer_id),
    reason: p.reason, created_at: p.created_at, i_voted: p.votes.has(state.me), i_proposed: p.proposer_id === state.me, is_me: p.target_id === state.me
  });
  const q = (table) => { const o = { _f: {}, _in: {}, select() { return o; }, eq(k, v) { o._f[k] = v; return o; }, in(k, v) { o._in[k] = v; return o; }, gte() { return o; }, not() { return o; }, order() { return o; }, limit() { return o; },
    maybeSingle() { if (table === 'contacts' && ['u1','u3','u4'].includes(o._f.contact_id)) return Promise.resolve({ data: { contact_id: o._f.contact_id } }); return Promise.resolve({ data: null }); }, single() { return Promise.resolve({ data: null }); },
    then(res) { let data = [];
      if (table === 'members') data = members.filter(m => (!o._f.status || m.status === o._f.status) && (!o._f.group_id || m.group_id === o._f.group_id) && (!o._in.group_id || o._in.group_id.includes(m.group_id)));
      if (table === 'transactions') data = recents.filter(t => t.from_user === state.me).map(t => Object.assign({}, t, { receiver: (members.find(m => m.user_id === t.to_user) || {}).profiles }));
      res({ data, error: null, count: data.length }); } }; return o; };
  const fake = {
    rpc: async (fn, a) => {
      if (fn === 'send_currency') { const fee = Math.round(a.p_amount * 0.02 * 100) / 100; state.balance -= a.p_amount; return { data: { success: true, amount: a.p_amount, fee, net: a.p_amount - fee } }; }
      if (fn === 'list_removal_proposals') return { data: state.proposals.filter(p => p.status === 'open').map(view).filter(v => v.status === 'open') };
      if (fn === 'propose_removal') {
        if (state.proposals.some(p => p.status === 'open' && p.target_id === a.p_target_id)) return { error: { message: 'There is already an open vote to remove this member' } };
        const p = { id: 'p' + Date.now(), target_id: a.p_target_id, proposer_id: state.me, reason: a.p_reason, created_at: new Date().toISOString(), window_end: new Date(Date.now() + DAYS * 864e5).toISOString(), status: 'open', votes: new Set([state.me]) };
        state.proposals.push(p); return { data: check(p) };
      }
      const p = state.proposals.find(p => p.id === a?.p_proposal_id);
      if (fn === 'vote_removal') { if (!p || p.status !== 'open') return { error: { message: 'This vote is closed' } }; if (p.target_id === state.me) return { error: { message: 'You cannot vote on your own removal' } }; p.votes.add(state.me); return { data: check(p) }; }
      if (fn === 'unvote_removal') { p.votes.delete(state.me); return { data: check(p) }; }
      if (fn === 'withdraw_removal') { p.status = 'withdrawn'; return { data: { status: 'withdrawn' } }; }
      return { data: null };
    },
    from: q,
    channel() { return { on() { return this; }, subscribe() { return this; } }; }, removeChannel() {},
    auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }, getSession: async () => ({ data: { session: null } }) }
  };
  window.supabase = { createClient: () => fake };
})();
