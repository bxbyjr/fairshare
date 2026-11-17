let db;
let SUPABASE_AUTH_STORAGE_KEY = null;
try {
    const SUPABASE_PROJECT_REF = SUPABASE_URL.match(/\/\/([^.]+)\./)?.[1] || 'default';
    const DEFAULT_SUPABASE_AUTH_STORAGE_KEY = 'sb-' + SUPABASE_PROJECT_REF + '-auth-token';

    function readAuthStorageNamespace() {
        try {
            const params = new URLSearchParams(window.location.search);
            const raw = params.get('session');
            if (!raw) return '';
            return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
        } catch (_) {
            return '';
        }
    }

    const SUPABASE_AUTH_STORAGE_NAMESPACE = readAuthStorageNamespace();
    SUPABASE_AUTH_STORAGE_KEY = SUPABASE_AUTH_STORAGE_NAMESPACE
        ? DEFAULT_SUPABASE_AUTH_STORAGE_KEY + '-' + SUPABASE_AUTH_STORAGE_NAMESPACE
        : DEFAULT_SUPABASE_AUTH_STORAGE_KEY;

    if (SUPABASE_AUTH_STORAGE_NAMESPACE) {
        console.log('[auth] using test session namespace:', SUPABASE_AUTH_STORAGE_NAMESPACE);
    }

    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            storageKey: SUPABASE_AUTH_STORAGE_KEY
        }
    });
} catch (e) {
    console.error('Failed to initialize Supabase client:', e);
}
