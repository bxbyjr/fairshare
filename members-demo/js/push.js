function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

function canUseWebPush() {
    if (IS_NATIVE) return false;
    const isWebProtocol = window.location.protocol === 'http:' || window.location.protocol === 'https:';
    return isWebProtocol && window.isSecureContext && ('serviceWorker' in navigator) && ('PushManager' in window);
}

function canUseNativePush() {
    if (!IS_NATIVE || !window.Capacitor?.Plugins?.PushNotifications) return false;
    // Android: @capacitor/push-notifications uses FCM; without google-services.json
    // FirebaseApp is never initialized and PushNotifications.register() crashes
    // the CapacitorPlugins thread. MainActivity sets __UNION_ANDROID_FCM__ when the
    // file is present (BuildConfig.HAS_GOOGLE_SERVICES).
    if (typeof NATIVE_PLATFORM !== 'undefined' && NATIVE_PLATFORM === 'android') {
        if (window.__UNION_ANDROID_FCM__ !== true) return false;
    }
    return true;
}

function canUsePush() {
    return canUseWebPush() || canUseNativePush();
}

function getNativePushPlatform() {
    return NATIVE_PLATFORM === 'android' ? 'android' : 'ios';
}

async function ensureAndroidPushChannel(PushNotifications) {
    if (getNativePushPlatform() !== 'android' || typeof PushNotifications.createChannel !== 'function') return;
    try {
        await PushNotifications.createChannel({
            id: 'default',
            name: APP_NAME,
            description: APP_NAME + ' notifications',
            importance: 4,
            visibility: 1,
            lights: true,
            lightColor: '#3A7CA5',
            vibration: true,
        });
    } catch (e) {
        console.warn('[push] Failed to create Android notification channel:', e);
    }
}

// ---- Native (APNs/FCM via Capacitor) ----

let _nativePushListenersRegistered = false;
let _pendingNativePushToken = null;
const NATIVE_PUSH_TOKEN_STORAGE_KEY = 'fairshare_native_push_token';

function cacheNativePushToken(tokenValue) {
    if (!tokenValue) return;
    try {
        localStorage.setItem(NATIVE_PUSH_TOKEN_STORAGE_KEY, tokenValue);
    } catch (_) { /* private mode / quota */ }
}

function getCachedNativePushToken() {
    try {
        return localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY) || null;
    } catch (_) {
        return null;
    }
}

async function saveNativeDeviceToken(tokenValue) {
    const platform = getNativePushPlatform();
    cacheNativePushToken(tokenValue);
    if (!currentUser?.id) {
        _pendingNativePushToken = tokenValue;
        console.log('[push] Token received before login; will save after sign-in');
        return;
    }
    try {
        const { error } = await db.from('device_push_tokens').upsert({
            user_id: currentUser.id,
            token: tokenValue,
            platform,
        }, { onConflict: 'user_id,token' });
        if (error) console.error('[push] Token upsert error:', error);
        else console.log('[push] Device token saved successfully');
    } catch (e) {
        console.warn('[push] Failed to save device token:', e);
    }
}

/** FCM often does not re-fire registration after the first time; re-upsert this device's cached token. */
async function resyncCachedNativePushToken() {
    const cached = getCachedNativePushToken();
    if (!cached || !currentUser?.id) return;
    console.log('[push] Re-syncing cached device token to Supabase');
    await saveNativeDeviceToken(cached);
}

async function flushPendingNativePushToken() {
    if (!_pendingNativePushToken || !currentUser?.id) return;
    const token = _pendingNativePushToken;
    _pendingNativePushToken = null;
    await saveNativeDeviceToken(token);
}

async function registerNativePushListeners() {
    const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
    if (!PushNotifications || _nativePushListenersRegistered) return PushNotifications;

    _nativePushListenersRegistered = true;

    await PushNotifications.addListener('registration', async (token) => {
        const platform = getNativePushPlatform();
        console.log('[push] Native device token:', platform, token.value);
        await saveNativeDeviceToken(token.value);
    });

    await PushNotifications.addListener('registrationError', (err) => {
        console.error('[push] Native push registration error:', JSON.stringify(err));
    });

    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[push] Foreground notification:', JSON.stringify(notification));
    });

    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        console.log('[push] Notification tapped:', JSON.stringify(action));
        const data = action.notification?.data || {};
        const url = data.url || action.notification?.link || '/';
        handleNotificationNavigation(url);
    });

    return PushNotifications;
}

/** Attach listeners at boot so FCM registration is not missed before sign-in. */
function initNativePushEarly() {
    if (!IS_NATIVE || !window.Capacitor?.Plugins?.PushNotifications) return;

    const attach = () => {
        if (NATIVE_PLATFORM === 'android' && window.__UNION_ANDROID_FCM__ !== true) return;
        void registerNativePushListeners();
    };

    if (NATIVE_PLATFORM !== 'android') {
        attach();
        return;
    }

    if (window.__UNION_ANDROID_FCM__ === true) {
        attach();
        return;
    }
    if (window.__UNION_ANDROID_FCM__ === false) return;

    let attempts = 0;
    const poll = setInterval(() => {
        attempts += 1;
        if (window.__UNION_ANDROID_FCM__ === true) {
            clearInterval(poll);
            attach();
        } else if (window.__UNION_ANDROID_FCM__ === false || attempts > 30) {
            clearInterval(poll);
        }
    }, 200);
}

async function subscribeToNativePush() {
    const PushNotifications = await registerNativePushListeners();
    if (!PushNotifications) return;

    await flushPendingNativePushToken();

    await ensureAndroidPushChannel(PushNotifications);

    const permResult = await PushNotifications.requestPermissions();
    console.log('[push] Permission result:', JSON.stringify(permResult));
    if (permResult.receive !== 'granted') {
        console.warn('[push] Native push permission not granted:', permResult.receive);
        return;
    }
    await PushNotifications.register();
    console.log('[push] register() called successfully');
    // Toggle on/off may call register() when FCM will not emit registration again.
    await resyncCachedNativePushToken();
}

async function unsubscribeNativePush() {
    const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
    if (!PushNotifications) return;
    if (!currentUser?.id) return;
    const cached = getCachedNativePushToken();
    try {
        let query = db.from('device_push_tokens').delete().eq('user_id', currentUser.id);
        // Only remove this device's token so emulator + phone can both stay registered.
        if (cached) query = query.eq('token', cached);
        await query;
        if (cached) console.log('[push] Removed device token for this install from Supabase');
    } catch (e) {
        console.warn('[push] Failed to remove device tokens:', e);
    }
}

async function isNativePushRegistered() {
    const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
    if (!PushNotifications) return false;
    try {
        const perm = await PushNotifications.checkPermissions();
        if (perm.receive !== 'granted') return false;
        const cached = getCachedNativePushToken();
        let query = db.from('device_push_tokens').select('id').eq('user_id', currentUser.id);
        if (cached) query = query.eq('token', cached);
        const { data, error } = await query.limit(1);
        return !error && data && data.length > 0;
    } catch { return false; }
}

// ---- Web Push (existing) ----

async function subscribeToWebPush() {
    if (!canUseWebPush()) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if (!reg) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });
        }
        const subJson = sub.toJSON();
        await db.from('push_subscriptions').upsert({
            user_id: currentUser.id,
            endpoint: subJson.endpoint,
            keys_p256dh: subJson.keys.p256dh,
            keys_auth: subJson.keys.auth,
        }, { onConflict: 'user_id,endpoint' });
    } catch (e) {
        console.warn('Push subscription failed:', e);
    }
}

async function unsubscribeWebPush() {
    if (!canUseWebPush()) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            const endpoint = sub.endpoint;
            await sub.unsubscribe();
            await db.from('push_subscriptions')
                .delete()
                .eq('user_id', currentUser.id)
                .eq('endpoint', endpoint);
        }
    } catch (e) {
        console.warn('Push unsubscribe failed:', e);
    }
}

async function isWebPushSubscribed() {
    if (!canUseWebPush()) return false;
    try {
        const reg = await navigator.serviceWorker.ready;
        if (!reg) return false;
        const sub = await reg.pushManager.getSubscription();
        return !!sub;
    } catch { return false; }
}

// ---- Unified API (called by auth.js and modals.js) ----

async function subscribeToPush() {
    if (canUseNativePush()) return subscribeToNativePush();
    if (IS_NATIVE && NATIVE_PLATFORM === 'android') {
        console.warn('[push] Native push skipped; __UNION_ANDROID_FCM__=', window.__UNION_ANDROID_FCM__);
    }
    return subscribeToWebPush();
}

if (typeof IS_NATIVE !== 'undefined' && IS_NATIVE) {
    initNativePushEarly();
}

async function unsubscribePush() {
    if (canUseNativePush()) return unsubscribeNativePush();
    return unsubscribeWebPush();
}

async function isPushSubscribed() {
    if (canUseNativePush()) return isNativePushRegistered();
    return isWebPushSubscribed();
}

// ---- Deep-link handler (shared by native tap + SW message) ----

function handleNotificationNavigation(url) {
    try {
        const parsed = new URL(url, window.location.origin);
        const params = new URLSearchParams(parsed.search);

        if (params.get('action') === 'suggested_picture') {
            fetchAndShowSuggestedPicture();
        }

        if (params.get('action') === 'view_contact') {
            const cid = params.get('contact');
            if (cid) {
                if (typeof openContactDetailsById === 'function') {
                    openContactDetailsById(cid);
                } else {
                    // App not fully wired up yet — stash for showApp() to pick up.
                    pendingOpenContactId = cid;
                }
                return;
            }
        }

        if (params.get('action') === 'view_dm') {
            const cid = params.get('contact');
            if (cid) {
                if (typeof openDirectMessageScreen === 'function') {
                    openDirectMessageScreen(cid);
                } else {
                    pendingOpenDmContactId = cid;
                }
                return;
            }
        }

        if (params.get('action') === 'contact_intro') {
            const iid = params.get('intro');
            if (iid && typeof showContactIntroDialog === 'function') {
                showContactIntroDialog(iid);
                return;
            }
        }

        const groupId = params.get('group');
        if (groupId) {
            const tab = params.get('tab');
            if (tab) activeTab = tab;
            navigateTo('groups');
            const membership = myGroups.find(m => m.group_id === groupId);
            if (membership) {
                selectGroup(membership.groups, membership);
            } else {
                loadMyGroups(groupId);
            }
        } else {
            Object.keys(contactSelfiesCache).forEach(k => delete contactSelfiesCache[k]);
            const expandedRow = document.querySelector('.contact-row.expanded');
            if (expandedRow?.dataset?.contactId) {
                reloadContactSelfiesStrip(expandedRow.dataset.contactId);
            }
        }
    } catch (e) {
        console.warn('[push] handleNotificationNavigation error:', e);
    }
}
