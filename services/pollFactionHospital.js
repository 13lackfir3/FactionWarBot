// services/pollFactionHospital.js
const axios = require('axios');
const EnemyFaction = require('../models/EnemyFaction');
const { TORN_API_KEY } = process.env;

/**
 * Fetches a faction's hospital times and member statuses.
 * First attempts to read stored data from MongoDB, falling back to Torn API if none exists.
 * @param {number} factionId
 * @returns {Promise<Array<{id: number,name: string,status: {state: string,until: number|null}}>>>}
 */
async function pollFactionHospital(factionId) {
  // Try loading from DB
  const doc = await EnemyFaction.findOne({ factionId }).lean();
  if (doc && Array.isArray(doc.members) && doc.members.length) {
    return doc.members.map(m => ({
      id: m.memberId || m.id,
      name: m.name,
      status: {
        state: m.status.state,
        until: m.status.until ? Math.floor(new Date(m.status.until).getTime() / 1000) : null
      }
    }));
  }

  // Fallback to Torn API
  

  const { members = [], hospital = [] } = res.data.faction || {};
  const untilMap = new Map(hospital.map(h => [h.id, h.until]));

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
