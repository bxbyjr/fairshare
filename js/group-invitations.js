let groupInvitationsChannel = null;

function subscribeToGroupInvitations() {
    if (groupInvitationsChannel) {
        db.removeChannel(groupInvitationsChannel);
        groupInvitationsChannel = null;
    }
    if (!currentUser) return;

    groupInvitationsChannel = db.channel('group-invitations')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'group_invitations',
            filter: 'candidate_id=eq.' + currentUser.id
        }, (payload) => {
            showGroupInvitationDialog(payload.new);
        })
        .subscribe();
}

async function checkPendingGroupInvitations() {
    if (!currentUser) return;
    try {
        const { data: invitations, error } = await db
            .from('group_invitations')
            .select('*')
            .eq('candidate_id', currentUser.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error || !invitations || invitations.length === 0) return;

        showGroupInvitationDialog(invitations[0]);
    } catch (e) {
        console.error('checkPendingGroupInvitations error:', e);
    }
}

async function showGroupInvitationDialog(invitation) {
    if (!invitation) return;

    let sponsorName = 'Someone';
    let groupName = 'a group';

    try {
        const [sponsorRes, groupRes] = await Promise.all([
            db.from('profiles').select('display_name, profile_image_url').eq('id', invitation.sponsor_id).single(),
            db.from('groups').select('name').eq('id', invitation.group_id).single()
        ]);
        if (sponsorRes.data?.display_name) sponsorName = sponsorRes.data.display_name;
        if (groupRes.data?.name) groupName = groupRes.data.name;
    } catch (_) {}

    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    overlay.classList.remove('hidden');

    const invId = esc(invitation.id);
    body.innerHTML = `
        <h3>Group Membership Offer</h3>
        <p style="font-size:1rem;line-height:1.6;margin-bottom:1.5rem;">
            <strong>${esc(sponsorName)}</strong> has offered to sponsor your membership in <strong>${esc(groupName)}</strong>, do you accept?
        </p>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="respondToGroupInvitation('${invId}', false)">Decline</button>
            <button type="button" class="btn btn-primary" onclick="respondToGroupInvitation('${invId}', true)">Accept</button>
        </div>
    `;
}

async function respondToGroupInvitation(invitationId, accept) {
    const buttons = document.querySelectorAll('#modalBody .form-actions .btn');
    buttons.forEach(b => b.disabled = true);

    try {
        const { data, error } = await db.rpc('respond_to_group_invitation', {
            p_invitation_id: invitationId,
            p_accept: accept
        });

        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        closeModal({ refreshContactList: false });

        if (accept) {
            if (data.admitted) {
                showToast(`Welcome to "${data.group_name}"! You've been admitted as a member.`, 'success');
            } else {
                showToast(`You've accepted the offer to join "${data.group_name}". Awaiting group endorsement.`, 'success');
            }
            await loadMyGroups(data.group_id);
            navigateTo('groups');
        } else {
            showToast('Invitation declined.', 'info');
        }

        setTimeout(checkPendingGroupInvitations, 500);
    } catch (e) {
        console.error('respondToGroupInvitation error:', e);
        showToast('Error: ' + (e.message || 'Could not respond to invitation'), 'error');
        buttons.forEach(b => b.disabled = false);
    }
}
