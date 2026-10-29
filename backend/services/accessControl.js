// services/accessControl.js — Unified access control for Groups and Clusters / Batches
//
// Supports:
// 1. Role 'admin': Full access to all devices and groups across the organization.
// 2. Role 'operator' with Whole-Group Grant: Access to all devices in the group.
// 3. Role 'operator' with Cluster/Batch Grant: Strict batch isolation — operator
//    ONLY sees and controls devices assigned to their specific cluster/batch.
'use strict';
const { query, queryOne } = require('../db');

/**
 * Returns a SQL WHERE clause fragment and params to filter devices accessible by this user.
 * @param {object} user - req.user object ({ id, role })
 * @param {string} alias - table alias for devices (default 'd')
 * @returns {{ sql: string, params: Array }}
 */
function deviceAccessSql(user, alias = 'd') {
  if (user.role === 'admin') {
    return { sql: '1=1', params: [] };
  }
  const sql = `(
    ${alias}.status = 'needs_approval' OR
    EXISTS (SELECT 1 FROM user_cluster_access uca WHERE uca.cluster_id = ${alias}.cluster_id AND uca.user_id = ?) OR
    (
      EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.group_id = ${alias}.group_id AND uga.user_id = ?) AND
      NOT EXISTS (SELECT 1 FROM user_cluster_access uca WHERE uca.group_id = ${alias}.group_id AND uca.user_id = ?)
    )
  )`;
  return { sql, params: [user.id, user.id, user.id] };
}

/**
 * Checks whether a user can access a specific device.
 */
async function canUserAccessDevice(user, device) {
  if (user.role === 'admin') return true;
  if (!device.group_id) {
    return device.status === 'needs_approval';
  }

  // 1. Check if user has explicit cluster grant for this device's cluster
  if (device.cluster_id) {
    const clusterAccess = await queryOne(
      'SELECT 1 FROM user_cluster_access WHERE user_id = ? AND cluster_id = ?',
      [user.id, device.cluster_id]
    );
    if (clusterAccess) return true;
  }

  // 2. Check if user has any cluster restrictions in this group
  const hasClusterRestrictionsInGroup = await queryOne(
    'SELECT 1 FROM user_cluster_access WHERE user_id = ? AND group_id = ?',
    [user.id, device.group_id]
  );
  if (hasClusterRestrictionsInGroup) {
    // User has cluster-specific assignments in this group, so they cannot access unassigned/other devices
    return false;
  }

  // 3. User has whole-group access
  const groupAccess = await queryOne(
    'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
    [user.id, device.group_id]
  );
  return !!groupAccess;
}

/**
 * Checks whether a user can access a specific group.
 * Returns true if user is admin, has whole-group grant, or has cluster grant inside that group.
 */
async function canUserAccessGroup(user, groupId) {
  if (user.role === 'admin') return true;
  const access = await queryOne(
    'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ? ' +
    'UNION ' +
    'SELECT 1 FROM user_cluster_access WHERE user_id = ? AND group_id = ?',
    [user.id, groupId, user.id, groupId]
  );
  return !!access;
}

/**
 * Checks whether a user can access a specific cluster.
 */
async function canUserAccessCluster(user, clusterId, groupId) {
  if (user.role === 'admin') return true;
  const clusterAccess = await queryOne(
    'SELECT 1 FROM user_cluster_access WHERE user_id = ? AND cluster_id = ?',
    [user.id, clusterId]
  );
  if (clusterAccess) return true;

  // Check if user has whole-group access with no cluster restrictions
  const hasRestrictions = await queryOne(
    'SELECT 1 FROM user_cluster_access WHERE user_id = ? AND group_id = ?',
    [user.id, groupId]
  );
  if (hasRestrictions) return false;

  const groupAccess = await queryOne(
    'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
    [user.id, groupId]
  );
  return !!groupAccess;
}

module.exports = {
  deviceAccessSql,
  canUserAccessDevice,
  canUserAccessGroup,
  canUserAccessCluster,
};
