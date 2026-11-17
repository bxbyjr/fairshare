function setGroupAvatar(url, cacheBust) {
    const el = document.getElementById('groupAvatarImg');
    if (!el) return;
    const displayUrl = url && cacheBust != null ? withImageCacheBust(url, cacheBust) : url;
    if (url) {
        // Replace placeholder with actual img
        const parent = el.parentElement;
        const img = document.createElement('img');
        img.className = 'group-avatar';
        img.id = 'groupAvatarImg';
        img.src = displayUrl;
        img.alt = 'Group logo';
        parent.replaceChild(img, el);
    } else {
        // Show placeholder
        if (el.tagName === 'IMG') {
            const parent = el.parentElement;
            const placeholder = document.createElement('div');
            placeholder.className = 'group-avatar-placeholder';
            placeholder.id = 'groupAvatarImg';
            placeholder.innerHTML = '<i data-lucide="users-round" aria-hidden="true"></i>';
            if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
            parent.replaceChild(placeholder, el);
        }
    }
}

/** @param {string|null|undefined} url @param {string|number|null|undefined} cacheBust optional query token so same storage URL reloads after replace */
function setHeaderAvatar(url, cacheBust) {
    const img = document.getElementById('headerAvatar');
    const fallback = document.getElementById('headerAvatarFallback');
    if (!img) return;
    const displayUrl = url && cacheBust != null ? withImageCacheBust(url, cacheBust) : url;
    if (url) {
        img.src = displayUrl || url;
        img.classList.remove('hidden');
        if (fallback) fallback.classList.add('hidden');
    } else {
        img.src = '';
        img.classList.add('hidden');
        if (fallback) fallback.classList.remove('hidden');
    }
}
