export const ADMIN_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

export const ADMIN_PERMISSION_SECTIONS = [
    'dashboard',
    'point_of_sale',
    'food_management',
    'restaurant_management',
    'order_management',
    'promotions_management',
    'referral_rewards',
    'customer_management',
    'delivery_management',
    'support_management',
    'report_management',
    'transaction_management',
    'banner_management',
    'pages_social_media',
    // Both of these were already used by guards -- resolveSectionFromRequest
    // returns them and requireAdminPermission('sub_admin_management') gates
    // /sub-admins -- but neither was listed here. sanitizeAdminPermissions
    // drops every key it does not recognise, so they could never be granted and
    // those pages 403'd for every sub-admin no matter what the role editor was
    // set to.
    'system_settings',
];

/**
 * Sub-admin management is deliberately NOT grantable.
 *
 * Every one of its controllers calls ensureSuperAdmin, because a sub-admin who
 * can edit sub-admins can grant themselves every other permission -- the
 * section is a privilege-escalation path, not an ordinary one. It stays in the
 * route guard below so the intent is written down, but listing it above would
 * put a checkbox in the role editor that can never do anything, which is the
 * problem this list was fixed to stop having.
 */
export const SUPER_ADMIN_ONLY_SECTIONS = ['sub_admin_management'];

export const ADMIN_FULL_PERMISSIONS = Object.freeze(
    Object.fromEntries(
        ADMIN_PERMISSION_SECTIONS.map((section) => [section, [...ADMIN_ACTIONS]])
    )
);

const actionPriority = new Set(ADMIN_ACTIONS);
const sectionPriority = new Set(ADMIN_PERMISSION_SECTIONS);

export const sanitizeAdminPermissions = (raw = {}) => {
    const normalized = {};

    for (const section of ADMIN_PERMISSION_SECTIONS) {
        const sectionActions = Array.isArray(raw?.[section]) ? raw[section] : [];
        normalized[section] = [...new Set(sectionActions.map((it) => String(it).trim().toLowerCase()))]
            .filter((it) => actionPriority.has(it));
    }

    return normalized;
};

export const isValidPermissionPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

    for (const [section, actions] of Object.entries(payload)) {
        if (!sectionPriority.has(section)) return false;
        if (!Array.isArray(actions)) return false;
        if (actions.some((action) => !actionPriority.has(String(action).trim().toLowerCase()))) return false;
    }

    return true;
};
