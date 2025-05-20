// services/pollFactionHospital.js
const axios = require('axios');
const { TORN_API_KEY } = process.env;

async function pollFactionHospital(factionId) {
  // request both members and hospital in one go
  const url = `https://api.torn.com/v2/faction/${factionId}`
            + `?selections=members,hospital&striptags=true&key=${TORN_API_KEY}`;
  const res = await axios.get(url);
  if (res.data.error) throw new Error(res.data.error.error);

  const { members = [], hospital = [] } = res.data.faction;

  // map hospital until times
  const untilMap = new Map(hospital.map(h => [h.id, h.until]));

  // merge `until` into each member
  return members.map(m => ({
    ...m,
    status: {
      ...m.status,
      until: untilMap.get(m.id) || null
    }
  }));
}

module.exports = { pollFactionHospital };