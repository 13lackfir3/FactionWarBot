const EnemyFaction = require('../models/EnemyFaction');

/**
 * Retrieve cached faction members from MongoDB (updated every minute).
 * Throws if no cached members are available.
 * @param {number} factionId
 * @returns {Promise<Array<Object>>} Array of member docs
 */
async function pollFactionStatus(factionId) {
  const doc = await EnemyFaction.findOne({ factionId }).lean();
  if (!doc || !Array.isArray(doc.members)) {
    throw new Error(`No cached data for faction ${factionId}`);
  }
  return doc.members;
}

module.exports = { pollFactionStatus };
