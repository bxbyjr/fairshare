async function ensureSession() {
    const session = await recoverSessionIfNeeded('ensureSession');
    if (session) {
        currentUser = session.user;
        return true;
    }
    warnSessionRecoveryFailed('Could not verify your session. Check your connection and try again.');
    return false;
}

// ---- Session keep-alive & recovery ----
// Two mechanisms work together:
//
// 1. visibilitychange — when the user returns after the tab was hidden (sleep,
//    minimised, switched tab).  If idle > 30 min, hard reload.
//
// 2. Periodic heartbeat (every 5 min) — catches the case where the tab stays
//    in the foreground on an awake computer but the session silently expires.
//    It makes a lightweight DB call; if it fails, the session is dead and we
//    force a reload.

let _lastActiveAt = Date.now();
const SESSION_STALE_MS = 30 * APP_TIMING.MINUTE_MS;

let _sessionRecoveryInFlight = null;
let _lastSessionRecoveryWarningAt = 0;

// --- Timeout-guarded getSession ---
// Supabase's internal navigator.locks can deadlock after a tab is
// backgrounded.  If getSession doesn't resolve within a few seconds,
// report a recoverable timeout instead of treating the user as signed out.
const GET_SESSION_TIMEOUT_MS = 5 * APP_TIMING.SECOND_MS;

function getSessionWithTimeout() {
    return new Promise((resolve) => {
        let settled = false;
        const resolveOnce = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            console.error('[session] getSession() hung for ' +
                GET_SESSION_TIMEOUT_MS + 'ms — Supabase client is stuck');
            const error = new Error('getSession timeout');
            error.recoverable = true;
            error.code = 'session_timeout';
            resolveOnce({ data: { session: null }, error, recoverable: true });
        }, GET_SESSION_TIMEOUT_MS);

        db.auth.getSession().then(result => {
            resolveOnce(result);
        }).catch(err => {
            console.warn('[session] getSession() threw:', err);
            if (err) err.recoverable = true;
            resolveOnce({ data: { session: null }, error: err, recoverable: true });
        });
    });
}

function isRecoverableSessionResult(result) {
    const err = result?.error;
    return Boolean(result?.recoverable || err?.recoverable || err?.code === 'session_timeout'
        || /timeout|network|fetch|lock/i.test(err?.message || ''));
}

async function refreshSessionWithTimeout() {
    try {
        return await Promise.race([
            db.auth.refreshSession(),
            new Promise(resolve => setTimeout(() => {
                const error = new Error('refreshSession timeout');
                error.recoverable = true;
                error.code = 'session_refresh_timeout';
                resolve({ data: { session: null }, error, recoverable: true });
            }, GET_SESSION_TIMEOUT_MS))
        ]);
    } catch (err) {
        if (err) err.recoverable = true;
        return { data: { session: null }, error: err, recoverable: true };
    }
}

async function recoverSessionIfNeeded(context) {
    if (_sessionRecoveryInFlight) return _sessionRecoveryInFlight;

    _sessionRecoveryInFlight = (async () => {
        const initial = await getSessionWithTimeout();
        if (initial?.data?.session) return initial.data.session;

        console.warn('[session] no session from getSession during', context, initial?.error || '');

        const refreshed = await refreshSessionWithTimeout();
        if (refreshed?.data?.session) {
            console.log('[session] refreshSession recovered session during', context);
            return refreshed.data.session;
        }

        const retry = await getSessionWithTimeout();
        if (retry?.data?.session) {
            console.log('[session] getSession recovered after refresh attempt during', context);
            return retry.data.session;
        }

        if (!isRecoverableSessionResult(initial)
                && !isRecoverableSessionResult(refreshed)
                && !isRecoverableSessionResult(retry)) {
            console.warn('[session] confirmed no local session during', context);
            showAuth();
        }
        return null;
    })();

    try {
        return await _sessionRecoveryInFlight;
    } finally {
        _sessionRecoveryInFlight = null;
    }
}

function warnSessionRecoveryFailed(message) {
    const now = Date.now();
    if ((now - _lastSessionRecoveryWarningAt) < APP_TIMING.MINUTE_MS) return;
    _lastSessionRecoveryWarningAt = now;
    showToast(message, 'error');
}

function resumeAfterSessionVerified() {
    if (selectedGroup) subscribeToGroup(selectedGroup.id);
    subscribeToContactEvents();
    if (typeof resumeLocationSharingAfterForeground === 'function') {
        resumeLocationSharingAfterForeground();
    }
    Object.keys(contactSelfiesCache).forEach(k => delete contactSelfiesCache[k]);
    const expandedRow = document.querySelector('.contact-row.expanded');
    if (expandedRow?.dataset?.contactId) {
        reloadContactSelfiesStrip(expandedRow.dataset.contactId);
    }
}

// --- Mechanism 1: visibilitychange ---
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
        _lastActiveAt = Date.now();
        return;
    }
    // Page just became visible again
    if (!currentUser) return;

    const elapsed = Date.now() - _lastActiveAt;
    console.log(`[visibility] Tab resumed after ${Math.round(elapsed / 1000)}s`);

    if (!IS_NATIVE && elapsed > SESSION_STALE_MS) {
        // Web only: been away too long — hard reload lets init() do a clean token refresh.
        // On native iOS the app is suspended by the OS; reloading restarts the
        // entire WebView which is far more disruptive than a soft recovery.
        console.log(`[visibility] Idle ${Math.round(elapsed / APP_TIMING.MINUTE_MS)} min — reloading`);
        window.location.reload();
        return;
    }

    // Verify the session and re-subscribe to Realtime. Ambiguous failures are
    // recoverable; only an explicit SIGNED_OUT event should perform logout.
    try {
        const session = await recoverSessionIfNeeded('visibility');
        if (!session) {
            warnSessionRecoveryFailed('Could not verify your session after resume. Retrying soon.');
        } else {
            currentUser = session.user;
            resumeAfterSessionVerified();
        }
    } catch (e) {
        console.warn('[visibility] Session check failed:', e);
    }
});

// --- Mechanism 2: periodic heartbeat ---
// Every 5 minutes, make a tiny authenticated request. If the session is dead
// the request will fail and we reload to get a clean start.
const HEARTBEAT_MS = 5 * APP_TIMING.MINUTE_MS;
const HEARTBEAT_TIMEOUT_MS = APP_TIMING.HEARTBEAT_TIMEOUT_MS;
setInterval(async () => {
    if (!currentUser) return;
    console.log('[heartbeat] checking session…');
    try {
        const { error } = await Promise.race([
            db.from('profiles').select('id').eq('id', currentUser.id).single(),
            new Promise((_, reject) => setTimeout(() =>
                reject(new Error('Heartbeat timed out (' + (HEARTBEAT_TIMEOUT_MS / APP_TIMING.SECOND_MS) + 's) — client may be stuck')),
                HEARTBEAT_TIMEOUT_MS))
        ]);
        if (error) {
            console.warn('[heartbeat] failed — attempting session recovery', error);
            const session = await recoverSessionIfNeeded('heartbeat-error');
            if (session) {
                currentUser = session.user;
                console.log('[heartbeat] session recovered OK after DB failure');
                if (typeof refreshNativeLocationSharingAuth === 'function') {
                    refreshNativeLocationSharingAuth();
                }
            } else {
                warnSessionRecoveryFailed('Connection issue while checking your session. Retrying.');
            }
        } else {
            console.log('[heartbeat] OK');
        }
    } catch (e) {
        console.warn('[heartbeat] exception', e);
        const session = await recoverSessionIfNeeded('heartbeat-exception');
        if (session) {
            currentUser = session.user;
            if (typeof refreshNativeLocationSharingAuth === 'function') {
                refreshNativeLocationSharingAuth();
            }
        } else {
            warnSessionRecoveryFailed('Connection issue while checking your session. Retrying.');
        }
    }
}, HEARTBEAT_MS);
