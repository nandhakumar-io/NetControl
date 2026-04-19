// src/hooks/usePermissions.js
import { useAuthStore } from '../store/authStore'

// Bit map — must match backend middleware/auth.js
export const PERM = {
  VIEW_DEVICES:    1,
  MANAGE_DEVICES:  2,
  RUN_ACTIONS:     4,
  VIEW_GROUPS:     8,
  MANAGE_GROUPS:   16,
  VIEW_SCHEDULES:  32,
  MANAGE_SCHEDULES:64,
  VIEW_AUDIT:      128,
  MANAGE_USERS:    256,
  MANAGE_ROLES:    512,
}

const ROLE_PERMS = {
  admin:    0xFFFF,
  operator: 1 | 4 | 8 | 32 | 128,
  viewer:   1 | 8 | 32 | 128,
}

export function usePermissions() {
  const user = useAuthStore(s => s.user)

  if (!user) return {
    role: null,
    isAdmin: false,
    isOperator: false,
    isViewer: false,
    can: () => false,
  }

  const staticPerms = ROLE_PERMS[user.role]
  const perms = staticPerms !== undefined ? staticPerms : (user.permissions || 0)

  return {
    role:       user.role,
    isAdmin:    user.role === 'admin',
    isOperator: user.role === 'operator',
    isViewer:   user.role === 'viewer',
    isCustom:   user.role === 'custom',
    can: (bit) => (perms & bit) !== 0,
  }
}
