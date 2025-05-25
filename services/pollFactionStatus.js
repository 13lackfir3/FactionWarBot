
const axios = require('axios');
const { TORN_API_KEY } = process.env;

async function pollFactionStatus(factionId) {
  const url = `https://api.torn.com/v2/faction/${factionId}?selections=members&striptags=true&key=${TORN_API_KEY}`;
  const res = await axios.get(url);
  if (res.data.error) throw new Error(res.data.error.error);
  // res.data.faction.members is an array of member objects including .status
  return res.data.faction.members;
}

module.exports = { pollFactionStatus };
