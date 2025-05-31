const axios = require('axios');

/**
 * Fetch faction members from Torn API.
 * Used only in the snapshot loop to populate the DB once per minute.
 * @param {number} factionId
 * @returns {Promise<Array<Object>>} raw members array
 */
async function pollFactionMembers(factionId) {
  const apiKey = process.env.TORN_API_KEY;
  if (!apiKey) throw new Error('TORN_API_KEY is not set in environment');

  const url = `https://api.torn.com/v2/faction/${factionId}?selections=members&key=${apiKey}`;
  const res = await axios.get(url);
  const data = res.data;

  if (!data) {
    console.error(`No data returned for faction ${factionId}`);
    return [];
  }
  if (data.error) {
    console.error('Torn API error:', data.error);
    return [];
  }

  // Normalize v1 (object) vs v2 (array) structures
  let rawMembers = [];
  if (Array.isArray(data.members)) {
    rawMembers = data.members;
  } else if (data.members && typeof data.members === 'object') {
    rawMembers = Object.values(data.members);
  } else if (data.faction && Array.isArray(data.faction.members)) {
    rawMembers = data.faction.members;
  } else {
    console.error('Unexpected format for faction members:', data);
    return [];
  }

  return rawMembers;
}

module.exports = { pollFactionMembers };
