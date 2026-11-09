const CHAT_IMAGE_PATTERN = /^📷image:(.+)$/;
const CHAT_IMAGE_MAX_EDGE = 1200;
const CHAT_IMAGE_JPEG_QUALITY = 0.85;
const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function chatImageStoragePrefix() {
    return `${SUPABASE_URL}/storage/v1/object/public/avatars/`;
}

function parseImageBody(body) {
    const m = body && String(body).trim().match(CHAT_IMAGE_PATTERN);
    if (!m) return null;
    const url = m[1].trim();
    if (!url.startsWith(chatImageStoragePrefix())) return null;
    return { url };
}

function chatImageBodyFromUrl(url) {
    return `📷image:${url}`;
}

function _drawScaledImageToJpegFile(source, sourceW, sourceH) {
    const maxEdge = Math.max(sourceW, sourceH);
    const scale = maxEdge > CHAT_IMAGE_MAX_EDGE ? CHAT_IMAGE_MAX_EDGE / maxEdge : 1;
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (!b) reject(new Error('Could not process image'));
            else resolve(new File([b], 'chat.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', CHAT_IMAGE_JPEG_QUALITY);
    });
}

async function resizeImageFileForChat(file) {
    if (!file) throw new Error('No image selected');
    if (file.size > CHAT_IMAGE_MAX_BYTES) {
        throw new Error('Image is too large (max 5 MB)');
    }
    const type = file.type || '';
    if (type && !CHAT_IMAGE_ALLOWED_TYPES.includes(type) && type !== 'image/heic' && type !== 'image/heif') {
        throw new Error('Please choose a JPEG, PNG, or WebP image');
    }

    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file);
            try {
                return await _drawScaledImageToJpegFile(bitmap, bitmap.width, bitmap.height);
            } finally {
                bitmap.close();
            }
        } catch (_) { /* fall through to Image() */ }
    }

    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Could not read image'));
            el.src = objectUrl;
        });
        return await _drawScaledImageToJpegFile(img, img.naturalWidth, img.naturalHeight);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function canvasToChatFile(canvas) {
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture image'))), 'image/jpeg', CHAT_IMAGE_JPEG_QUALITY);
    });
    return new File([blob], 'chat.jpg', { type: 'image/jpeg' });
}

async function fileOrCanvasToChatFile(fileOrCanvas) {
    if (fileOrCanvas instanceof HTMLCanvasElement) {
        return canvasToChatFile(fileOrCanvas);
    }
    return resizeImageFileForChat(fileOrCanvas);
}

function chatImageStoragePath(context) {
    const ts = Date.now();
    if (context.kind === 'group') {
        return `${currentUser.id}/chat_group_${context.groupId}_${ts}.jpg`;
    }
    if (context.kind === 'dm') {
        return `${currentUser.id}/chat_dm_${context.contactId}_${ts}.jpg`;
    }
    throw new Error('Invalid chat image context');
}

async function uploadChatImage(file, context) {
    if (!currentUser) throw new Error('Not signed in');
    const filePath = chatImageStoragePath(context);
    const { error: upErr } = await db.storage.from('avatars').upload(filePath, file, { upsert: false });
    if (upErr) throw upErr;
    const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
    const url = urlData?.publicUrl;
    if (!url) throw new Error('Could not create image URL');
    return url;
}

async function sendGroupChatImage(groupId, fileOrCanvas) {
    if (!groupId || !currentUser) throw new Error('No group selected');
    const file = await fileOrCanvasToChatFile(fileOrCanvas);
    const url = await uploadChatImage(file, { kind: 'group', groupId });
    const { data: msg, error } = await db.from('chat_messages').insert({
        group_id: groupId,
        user_id: currentUser.id,
        body: chatImageBodyFromUrl(url)
    }).select().single();
    if (error) throw error;
    return msg;
}

async function sendDirectChatImage(contactId, conversationKey, fileOrCanvas) {
    if (!contactId || !conversationKey || !currentUser) throw new Error('No conversation');
    const file = await fileOrCanvasToChatFile(fileOrCanvas);
    const url = await uploadChatImage(file, { kind: 'dm', contactId });
    const { data: msg, error } = await db.from('direct_messages').insert({
        conversation_key: conversationKey,
        from_user_id: currentUser.id,
        to_user_id: contactId,
        body: chatImageBodyFromUrl(url)
    }).select().single();
    if (error) throw error;
    return msg;
}

async function sendChatPhotoFromCanvas(canvas, context) {
    if (context.kind === 'group') {
        return sendGroupChatImage(context.groupId, canvas);
    }
    if (context.kind === 'dm') {
        return sendDirectChatImage(context.contactId, context.conversationKey, canvas);
    }
    throw new Error('Invalid chat image context');
}

function renderChatImagePreview(container, url) {
    if (!container || !url) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Photo';
    img.loading = 'lazy';
    img.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof openLightbox === 'function') openLightbox(url);
    });
    container.appendChild(img);
}

let chatPhotoActionSheetEl = null;
let chatPhotoFileInputEl = null;
let chatPhotoPickerContext = null;

function closeChatPhotoActionSheet() {
    if (chatPhotoActionSheetEl) {
        chatPhotoActionSheetEl.classList.remove('active');
        setTimeout(() => {
            if (chatPhotoActionSheetEl?.parentNode) {
                chatPhotoActionSheetEl.parentNode.removeChild(chatPhotoActionSheetEl);
            }
            chatPhotoActionSheetEl = null;
        }, 200);
    }
    chatPhotoPickerContext = null;
}

function ensureChatPhotoFileInput() {
    if (chatPhotoFileInputEl) return chatPhotoFileInputEl;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        input.value = '';
        const ctx = chatPhotoPickerContext;
        closeChatPhotoActionSheet();
        if (!file || !ctx) return;
        try {
            await sendChatPhotoFromLibrary(file, ctx);
        } catch (err) {
            console.error('Chat photo library error:', err);
            showToast('Could not send photo: ' + (err.message || 'error'), 'error');
        }
    });
    document.body.appendChild(input);
    chatPhotoFileInputEl = input;
    return input;
}

async function sendChatPhotoFromLibrary(file, context) {
    let msg;
    if (context.kind === 'group') {
        msg = await sendGroupChatImage(context.groupId, file);
        if (msg && typeof appendChatMessage === 'function') appendChatMessage(msg, true);
        if (typeof scheduleLayoutChatPanel === 'function') scheduleLayoutChatPanel();
    } else if (context.kind === 'dm') {
        msg = await sendDirectChatImage(context.contactId, context.conversationKey, file);
        if (typeof stopDirectMessageTyping === 'function') stopDirectMessageTyping();
        if (msg && typeof appendDirectMessage === 'function') appendDirectMessage(msg, true);
    }
    if (msg) showToast('Photo sent', 'success');
    return msg;
}

function openChatPhotoActionSheet(context) {
    closeChatPhotoActionSheet();
    chatPhotoPickerContext = context;

    const sheet = document.createElement('div');
    sheet.className = 'chat-photo-action-sheet';
    sheet.innerHTML = `
        <div class="chat-photo-action-sheet-backdrop"></div>
        <div class="chat-photo-action-sheet-panel">
            <button type="button" class="chat-photo-action-item" data-action="camera">Take photo</button>
            <button type="button" class="chat-photo-action-item" data-action="library">Choose from library</button>
            <button type="button" class="chat-photo-action-item chat-photo-action-cancel" data-action="cancel">Cancel</button>
        </div>`;

    sheet.querySelector('.chat-photo-action-sheet-backdrop').addEventListener('click', closeChatPhotoActionSheet);
    sheet.querySelector('[data-action="cancel"]').addEventListener('click', closeChatPhotoActionSheet);
    sheet.querySelector('[data-action="library"]').addEventListener('click', () => {
        const ctx = chatPhotoPickerContext;
        closeChatPhotoActionSheet();
        if (!ctx) return;
        chatPhotoPickerContext = ctx;
        ensureChatPhotoFileInput().click();
    });
    sheet.querySelector('[data-action="camera"]').addEventListener('click', () => {
        const ctx = chatPhotoPickerContext;
        closeChatPhotoActionSheet();
        if (!ctx) return;
        openChatPhotoCamera(ctx);
    });

    document.body.appendChild(sheet);
    chatPhotoActionSheetEl = sheet;
    requestAnimationFrame(() => sheet.classList.add('active'));
}

function openChatPhotoCamera(context) {
    const banner = context.kind === 'group'
        ? `Send a photo to ${selectedGroup?.name || 'the group'}`
        : 'Send a photo';
    openCameraOverlay({
        banner,
        context,
        onUse: async (canvas) => {
            const useBtn = document.getElementById('newContactSelfieUseBtn');
            if (useBtn) useBtn.disabled = true;
            try {
                const msg = await sendChatPhotoFromCanvas(canvas, context);
                if (context.kind === 'group') {
                    if (msg && typeof appendChatMessage === 'function') appendChatMessage(msg, true);
                    if (typeof scheduleLayoutChatPanel === 'function') scheduleLayoutChatPanel();
                } else if (context.kind === 'dm') {
                    if (typeof stopDirectMessageTyping === 'function') stopDirectMessageTyping();
                    if (msg && typeof appendDirectMessage === 'function') appendDirectMessage(msg, true);
                }
                showToast('Photo sent', 'success');
            } finally {
                if (useBtn) useBtn.disabled = false;
            }
        }
    });
}

function openGroupChatPhotoPicker() {
    if (!selectedGroup) {
        showToast('Select a group first', 'error');
        return;
    }
    openChatPhotoActionSheet({ kind: 'group', groupId: selectedGroup.id });
}

function openDirectChatPhotoPicker() {
    if (!activeDirectMessageContactId || !activeDirectMessageConversationKey) {
        showToast('No conversation open', 'error');
        return;
    }
    openChatPhotoActionSheet({
        kind: 'dm',
        contactId: activeDirectMessageContactId,
        conversationKey: activeDirectMessageConversationKey
    });
}
