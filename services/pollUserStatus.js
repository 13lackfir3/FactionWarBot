// services/pollUserStatus.js
const axios = require('axios');

/**
 * Fetches a user's online/idle/offline status from Torn API v1 or v2.
 * @param {number|string} userId
 * @returns {Promise<{ id: number, name: string, status: { last_action: { status: string, timestamp: number, relative: string } } }>}
 */
async function pollUserStatus(userId) {
  const apiKey = process.env.TORN_API_KEY;
  if (!apiKey) throw new Error('TORN_API_KEY is not set in environment');

  const url = `https://api.torn.com/v2/user/${userId}?selections=profile&key=${apiKey}&striptags=true`;
  const res = await axios.get(url);
  const data = res.data;
  if (!data) throw new Error(`No data returned for user ${userId}`);
  if (data.error) {
    throw new Error(data.error.error || data.error);
  }

  // Support v2 (contains data.profile) or v1 (returns profile at root)
  const payload = data.data ? data.data : data;
  const profile = payload.profile || payload;
  if (!profile || (!profile.player_id && !profile.id)) {
    throw new Error(`No profile returned for user ${userId}`);
  }

  const la = profile.last_action || {};
  return {
    id: profile.player_id || profile.id,
    name: profile.name,
    status: {
      last_action: {
        status:    la.status || 'unknown',
        timestamp: la.timestamp || 0,
      }
    }
  };
}

module.exports = { pollUserStatus };
