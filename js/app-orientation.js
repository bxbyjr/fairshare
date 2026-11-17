/**
 * Native shell (Capacitor): keep portrait everywhere except the contact selfie
 * preview (#newContactSelfieOverlay), where we unlock so the user can rotate
 * while framing. Web/PWA is unchanged (browser chrome handles orientation).
 */
async function lockAppToPortrait() {
    if (typeof IS_NATIVE === 'undefined' || !IS_NATIVE) return;
    const ScreenOrientation = window.Capacitor?.Plugins?.ScreenOrientation;
    if (!ScreenOrientation?.lock) return;
    try {
        await ScreenOrientation.lock({ orientation: 'portrait' });
    } catch (e) {
        console.warn('[orientation] lock portrait failed:', e?.message || e);
    }
}

async function unlockNativeOrientationForSelfiePreview() {
    if (typeof IS_NATIVE === 'undefined' || !IS_NATIVE) return;
    const ScreenOrientation = window.Capacitor?.Plugins?.ScreenOrientation;
    if (!ScreenOrientation?.unlock) return;
    try {
        await ScreenOrientation.unlock();
    } catch (e) {
        console.warn('[orientation] unlock failed:', e?.message || e);
    }
}
