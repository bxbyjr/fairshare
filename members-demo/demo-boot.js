// Boots straight into a group's Members tab with demo data and a "view as" switcher.
(function () {
  const d = window.__demo;
  function applyUser() {
    currentUser = { id: d.state.me };
    currentProfile = { display_name: d.names[parseInt(d.state.me.slice(1), 10) - 1] };
    document.getElementById('demoWho').textContent = currentProfile.display_name;
  }
  async function render() {
    await renderMembersTab();
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
  }
  window.demoSwitch = async function (id) {
    d.state.me = id; applyUser(); closeDemoMenu(); await render();
  };
  window.demoReset = async function () {
    d.state.proposals.length = 0; d.members.forEach(m => m.status = 'active'); closeDemoMenu(); await render();
    showToast('Demo reset', 'info');
  };
  window.openDirectMessageScreen = () => showToast('Demo: this would open your chat with them', 'info');
  window.openContactDetailsById = () => showToast('Demo: this would open their contact card', 'info');
  // The real Pay screen asks for the camera first. In the demo skip straight in so the row under it shows.
  const _compose = window.openPayCompose;
  window.openPayCompose = async function (direction) {
    const orig = navigator.mediaDevices?.getUserMedia;
    try { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('demo')); await _compose(direction); }
    finally { if (navigator.mediaDevices && orig) navigator.mediaDevices.getUserMedia = orig; }
  };
  // Hide the demo pill while the pay screen is up; it sat on top of the Paying badge.
  const _show = window.payShowView, _close = window.closePayFlow;
  window.payShowView = function (v) { _show(v); document.getElementById('demoBar')?.classList.add('hidden'); };
  window.closePayFlow = function () { _close(); document.getElementById('demoBar')?.classList.remove('hidden'); };
  window.toggleDemoMenu = function () { document.getElementById('demoMenu').classList.toggle('hidden'); };
  window.closeDemoMenu = function () { document.getElementById('demoMenu').classList.add('hidden'); };
  // Hook the toasts that come from the server in real life.
  const origShowToast = window.showToast;
  window.showToast = function (msg, kind) { origShowToast(msg, kind); };

  document.addEventListener('DOMContentLoaded', async () => {
    document.title = 'Union demo: removal votes';
    selectedGroup = { id: 'g1', name: 'CIMC', currency_symbol: '$', currency_name: 'credits', currency_enabled: true, created_by: 'u1',
      constitution: 'Admission: 60% members $NEW_MEMBER_PERCENTAGE. Votes last 7 days $VOTING_PERIOD_DAYS.' };
    const tavern = { id: 'g2', name: 'The Velvet Tavern', currency_symbol: '🍺', currency_name: 'tokens', currency_enabled: true, created_by: 'u1', constitution: '' };
    myGroups = [{ group_id: 'g1', status: 'active', balance: d.state.balance, groups: selectedGroup }, { group_id: 'g2', status: 'active', balance: 20, groups: tavern }];
    window.loadMyGroups = async () => { myGroups[0].balance = d.state.balance; };
    activeTab = 'members';
    ['loadingScreen', 'authScreen', 'contactsScreen', 'profileScreen', 'contactDetailsScreen', 'directMessageScreen', 'globeScreen', 'groupList'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
    ['appScreen', 'groupsContent', 'groupView'].forEach(id => document.getElementById(id)?.classList.remove('hidden'));
    document.getElementById('groupNameDisplay').textContent = 'CIMC';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'members'));
    const bar = document.createElement('div');
    bar.id = 'demoBar';
    bar.innerHTML = `<button onclick="toggleDemoMenu()">Demo · viewing as <strong id="demoWho"></strong> ▾</button>
      <div id="demoMenu" class="hidden">
        ${d.names.map((n, i) => `<button onclick="demoSwitch('u${i + 1}')">${n}</button>`).join('')}
        <button class="reset" onclick="demoReset()">Reset demo</button>
      </div>`;
    document.body.appendChild(bar);
    const css = document.createElement('style');
    css.textContent = `#demoBar.hidden{display:none}#demoBar{position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);z-index:5000;font:13px Inter,system-ui,sans-serif}
      #demoBar>button{background:#111;color:#fff;border:0;border-radius:999px;padding:7px 14px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
      #demoMenu{position:absolute;top:38px;left:50%;transform:translateX(-50%);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.2);padding:6px;display:flex;flex-direction:column;min-width:180px}
      #demoMenu button{background:none;border:0;text-align:left;padding:9px 12px;border-radius:8px;font-size:14px}
      #demoMenu button:hover{background:#f2f2f2}#demoMenu .reset{color:#b00020;border-top:1px solid #eee;margin-top:4px}
      #demoMenu.hidden{display:none}
      .tab-bar .tab-btn:not([data-tab=members]){opacity:.35;pointer-events:none}`;
    document.head.appendChild(css);
    applyUser();
    await render();
  });
})();
