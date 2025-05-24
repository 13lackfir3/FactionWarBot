// index.js
console.log('🚀 index.js loaded – edits are live');
require('dotenv').config();

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits
} = require('discord.js');

// Environment variables
const MY_FACTION_ID     = parseInt(process.env.MY_FACTION_ID, 10);
const TORN_API_KEY      = process.env.TORN_API_KEY;
const TOKEN             = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const MONGO_URI         = process.env.MONGO_URI;
const HOSPITAL_INTERVAL = 60 * 1000;
const SNAPSHOT_INTERVAL = 15 * 60 * 1000;

// Services & models
const { pollFactionMembers }  = require('./services/pollFaction');
const { pollFactionHospital } = require('./services/pollFactionHospital');
const EnemyFaction            = require('./models/EnemyFaction');
const Faction                 = require('./models/Faction');

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// In-memory state
let watchedFactions = [];
function loadWatched() {
  try {
    watchedFactions = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'watchedFactions.json'), 'utf8'));
  } catch {
    watchedFactions = [];
  }
}
function saveWatched() {
  fs.writeFileSync(path.resolve(__dirname, 'watchedFactions.json'), JSON.stringify(watchedFactions, null, 2));
}

// Transform API member data
function transformMembers(raw) {
  return raw.map(m => ({
    memberId: m.id,
    name: m.name,
    level: m.level,
    daysInFaction: m.days_in_faction,
    lastAction: {
      status:    m.last_action.status,
      timestamp: new Date(m.last_action.timestamp * 1000),
      relative:  m.last_action.relative
    },
    status: {
      description: m.status.description,
      details:     m.status.details,
      state:       m.status.state,
      until:       m.status.until ? new Date(m.status.until * 1000) : null
    },
    reviveSetting: m.revive_setting,
    position:      m.position,
    isRevivable:   m.is_revivable,
    isInOc:        m.is_in_oc,
    scheduledAlertAt: null
  }));
}

// Snapshot own faction in DB
async function upsertFactionSnapshot() {
  const raw     = await pollFactionMembers(MY_FACTION_ID);
  const members = transformMembers(raw);
  await Faction.findOneAndUpdate(
    { factionId: MY_FACTION_ID },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
}

// Hospital monitoring state
const hospitalCache  = new Map();
const hospitalTimers = new Map();

// Core hospital scheduling logic for one faction
async function scheduleHospitalTimersFor(factionId) {
  const now = Date.now();
  const raw   = await pollFactionHospital(factionId);
  const members = transformMembers(raw);
  const hospitalized = members.filter(m => m.status.state === 'Hospital');

  const prevSet    = hospitalCache.get(factionId) || new Set();
  const currentSet = new Set(hospitalized.map(m => m.memberId));

  for (const m of hospitalized) {
    if (!m.status.until) continue;
    const releaseAt    = m.status.until.getTime();
    const msUntilAlert = releaseAt - now - 10000;
    const existing     = hospitalTimers.get(m.memberId);
    if (msUntilAlert > 0 && (!existing || existing.releaseAt !== releaseAt)) {
      if (existing) clearTimeout(existing.timer);
      const channelId = watchedFactions.find(w => w.factionId === factionId)?.channelId;
      const timer = setTimeout(async () => {
        try {
          const ch = await client.channels.fetch(channelId);
          await ch.send(`@everyone **${m.name}** leaving hospital in 10s! <https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.memberId}>`);
        } catch (err) {
          console.error('Hospital alert send failed:', err);
        }
        hospitalTimers.delete(m.memberId);
      }, msUntilAlert);
      hospitalTimers.set(m.memberId, { timer, releaseAt, channelId });
    }
  }

  for (const prevId of prevSet) {
    if (!currentSet.has(prevId) && hospitalTimers.has(prevId)) {
      clearTimeout(hospitalTimers.get(prevId).timer);
      hospitalTimers.delete(prevId);
    }
  }
  hospitalCache.set(factionId, currentSet);
}

// Slash commands
const commands = [
  { name: 'start',    description: 'Start monitoring a faction', options: [
      { name: 'id',   type: 4, description: 'Faction ID', required: true }
    ] },
  { name: 'stop',     description: 'Stop monitoring a faction',  options: [
      { name: 'id',   type: 4, description: 'Faction ID', required: true }
    ] },
  { name: 'starthosp',description: 'Start hospital alerts',      options: [
      { name: 'id',   type: 4, description: 'Faction ID', required: true }
    ] },
  { name: 'stophosp', description: 'Stop hospital alerts',       options: [
      { name: 'id',   type: 4, description: 'Faction ID', required: true }
    ] },
  { name: 'revives',  description: 'List revivable members' },
  { name: 'warrevives', description: 'List enemy revivable members', options: [
      { name: 'id', type: 4, description: 'Faction ID', required: false }
    ] },
  { name: 'oc',        description: 'List members not in OC' },
  { name: 'cleanup',   description: 'Bulk delete messages', options: [
      { name: 'count', type: 4, description: 'Number to remove', required: false }
    ], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar',    description: 'Snapshot your faction data' },
  { name: 'updateenemy', description: 'Re-poll and update an enemy faction in DB', options: [
      { name: 'id', type: 4, description: 'Enemy Faction ID', required: true }
    ] }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    console.log('🔄 Registering slash commands…');
    const target = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(target, { body: commands });
    console.log('✅ Commands registered');
  } catch (error) {
    console.error('Slash registration error:', error);
  }
})();

// Ready
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  loadWatched();
  watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId));
  upsertFactionSnapshot();
  setInterval(() => watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId)), HOSPITAL_INTERVAL);
  setInterval(upsertFactionSnapshot, SNAPSHOT_INTERVAL);
});

// Interaction handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;
  await interaction.deferReply({ ephemeral: commandName === 'cleanup' });

  try {
    let raw, list;
    switch (commandName) {
      case 'start': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id, channelId: interaction.channelId });
          saveWatched();
          raw = await pollFactionMembers(id);
          await EnemyFaction.findOneAndUpdate({ factionId: id }, { monitoredAt: new Date(), members: raw }, { upsert: true });
          return interaction.editReply(`✅ Monitoring faction ${id}.`);
        } else {
          return interaction.editReply(`⚠️ Already monitoring ${id}.`);
        }
      }
      // ... other cases unchanged ...
      case 'updateenemy': {
        const id = options.getInteger('id');
        raw = await pollFactionMembers(id);
        const docs = transformMembers(raw);
        await EnemyFaction.findOneAndUpdate({ factionId: id }, { monitoredAt: new Date(), members: docs }, { upsert: true });
        return interaction.editReply(`✅ Enemy faction ${id} refreshed in database (${docs.length} members).`);
      }
      default:
        return interaction.editReply('⚠️ Unknown command.');
    }
  } catch (err) {
    console.error(`Error executing ${commandName}:`, err);
    return interaction.editReply(`❌ ${err.message}`);
  }
});

client.login(TOKEN);
