let demoAccountsVisible = false;
let demoAccountIds = new Set();

async function loadDemoAccountsSetting() {
    demoAccountIds = new Set();
    demoAccountsVisible = false;
    if (!db || !currentUser) return;

    try {
        const { data: visible, error: visErr } = await db.rpc('get_demo_accounts_visible');
        if (!visErr) demoAccountsVisible = !!visible;
    } catch (_) { /* RPC may not exist until migration runs */ }

    try {
        const { data: profiles, error: profErr } = await db
            .from('profiles')
            .select('id')
            .eq('is_demo_account', true);
        if (!profErr && profiles) {
            profiles.forEach((p) => { if (p.id) demoAccountIds.add(p.id); });
        }
    } catch (_) { /* column may not exist until migration runs */ }
}

function isDemoContact(contactId) {
    return demoAccountIds.has(contactId);
}
