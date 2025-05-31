const axios = require('axios');
const EnemyFaction = require('../models/EnemyFaction');

/**
 * Retrieve cached hospital status from MongoDB (updated every minute).
 * Throws if no cache is available.
 * @param {number} factionId
 * @returns {Promise<Array<{ id: number, name: string, status: { state: string, until: number|null } }>>}
 */
async function pollFactionHospital(factionId) {
  const doc = await EnemyFaction.findOne({ factionId }).lean();
  if (!doc || !Array.isArray(doc.members)) {
    throw new Error(`No cached data for faction ${factionId}`);
  }
  return doc.members.map(m => ({
    id: m.memberId,
    name: m.name,
    status: {
      state: m.status.state || 'Unknown',
      until: m.status.until ? Math.floor(new Date(m.status.until).getTime() / 1000) : null
    }
  }));
}

module.exports = { pollFactionHospital };