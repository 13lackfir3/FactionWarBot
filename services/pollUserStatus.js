// services/pollUserStatus.js
// Fetches a single Torn user’s online status from the API

const axios = require('axios');
const { TORN_API_KEY } = process.env;

/**
 * Poll a user’s current status (online/offline/idle) and last action
 * @param {number} userId - Torn user ID
 * @returns {Promise<Object>} - { id, name, status: { state, details, last_action: { status, timestamp, relative } } }
 */
async function pollUserStatus(userId) {
  const url = `https://api.torn.com/v2/user/${userId}`
            + `?selections=profile&key=${TORN_API_KEY}&striptags=true`;
  const res = await axios.get(url);
  if (res.data.error) throw new Error(res.data.error.error);

  // Torn returns the full user object at root
  const user = res.data;
  return {
    id: user.user_id || user.id,
    name: user.name,
    status: {
      state:       user.status.state,
      details:     user.status.description || null,
      last_action: {
        status:    user.last_action.status,
        timestamp: user.last_action.timestamp,
        relative:  user.last_action.relative
      }
    }
  };
}

module.exports = {
  pollUserStatus
};