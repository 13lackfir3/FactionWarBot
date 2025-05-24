const axios = require('axios');
const EnemyFaction = require('../models/EnemyFaction');
const { TORN_API_KEY } = process.env;

/**
 * Fetch hospital data for a faction.
 * Attempts to read stored hospital times from MongoDB first,
 * falling back to Torn API if no valid snapshot exists.
 */
async function pollFactionHospital(factionId) {
  // Load stored snapshot
  const doc = await EnemyFaction.findOne({ factionId }).lean();
  if (doc && Array.isArray(doc.members) && doc.members.length) {
    // Use stored data if available
    return doc.members.map(m => ({
      id: m.memberId,
      name: m.name,
      status: {
        // status.state and status.until from DB are Date in ISO, convert
        state: m.status.state,
        until: m.status.until ? Math.floor(new Date(m.status.until).getTime() / 1000) : null
      }
    }));
  }

  // No valid DB record → fetch live from API
  const url = `https://api.torn.com/v2/faction/${factionId}`
            + `?selections=members,hospital&striptags=true&key=${TORN_API_KEY}`;
  const res = await axios.get(url);
  if (res.data.error) throw new Error(res.data.error.error);

  const { members = [], hospital = [] } = res.data.faction;
  const untilMap = new Map(hospital.map(h => [h.id, h.until]));

  // Merge live hospital times
  return members.map(m => ({
    id: m.id,
    name: m.name,
    status: {
      state: m.status.state,
      until: untilMap.get(m.id) || null
    }
  }));
}

module.exports = { pollFactionHospital };
