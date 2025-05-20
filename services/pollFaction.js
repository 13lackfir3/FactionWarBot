// services/pollFaction.js
const axios = require('axios');
const { TORN_API_KEY } = process.env;

async function pollFactionMembers(factionId) {
  const url = `https://api.torn.com/v2/faction/${factionId}/members`
            + `?striptags=true&key=${TORN_API_KEY}`;
  const res = await axios.get(url);
  if (res.data.error) throw new Error(res.data.error.error);
  return res.data.members;  // ← this is the array you pasted
}

module.exports = { pollFactionMembers };
