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
const MY_FACTION_ID        = parseInt(process.env.MY_FACTION_ID, 10);
const TORN_API_KEY         = process.env.TORN_API_KEY;
const TOKEN                = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID            = process.env.CLIENT_ID;
const GUILD_ID             = process.env.GUILD_ID;
const MONGO_URI            = process.env.MONGO_URI;
const HOSPITAL_INTERVAL    = (parseInt(process.env.HOSPITAL_INTERVAL, 10) || 300) * 1000;
const SNAPSHOT_INTERVAL    = 15 * 60 * 1000;
const ATTACK_POLL_INTERVAL = 10 * 1000;

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
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// In-memory state
let watchedFactions = [];
function loadWatched() {
  try {
    watchedFactions = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'watchedFactions.json'), 'utf8')
    );
  } catch {
    watchedFactions = [];
  }
}
function saveWatched() {
  fs.writeFileSync(
    path.resolve(__dirname, 'watchedFactions.json'),
    JSON.stringify(watchedFactions, null, 2)
  );
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
    isInOc:        m.is_in_oc
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
const hospitalCache  = new Map(); // factionId -> Set of memberIds
const hospitalTimers = new Map(); // memberId  -> { timer, releaseAt, channelId }

// Core hospital scheduling logic for one faction
async function scheduleHospitalTimersFor(factionId) {
  const now = Date.now();
  const raw   = await pollFactionHospital(factionId);
  const members = transformMembers(raw);
  const hospitalized = members.filter(m => m.status.state === 'Hospital');

  const prevSet    = hospitalCache.get(factionId) || new Set();
  const currentSet = new Set(hospitalized.map(m => m.memberId));

  // schedule new alerts
  for (const m of hospitalized) {
    if (!m.status.until) continue;
    const releaseAt    = m.status.until.getTime();
    const msUntilAlert = releaseAt - now - 10000; // 10s before
    const existing     = hospitalTimers.get(m.memberId);
    if (msUntilAlert > 0 && (!existing || existing.releaseAt !== releaseAt)) {
      if (existing) clearTimeout(existing.timer);
      const channelId = watchedFactions.find(w => w.factionId === factionId).channelId;
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

  // cancel recovered
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
      { name: 'id', type: 4, description: 'Faction ID', required: false, autocomplete: true }
    ] },
  { name: 'oc',        description: 'List members not in OC' },
  { name: 'cleanup',   description: 'Bulk delete messages', options: [
      { name: 'count', type: 4, description: 'Number to remove', required: false }
    ], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar',    description: 'Snapshot your faction data' }
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
    let list, raw;
    switch (commandName) {
      case 'start': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id, channelId: interaction.channelId });
          saveWatched();
          raw = await pollFactionMembers(id);
          await EnemyFaction.findOneAndUpdate({ factionId: id }, { monitoredAt: new Date(), members: raw }, { upsert: true });
          await interaction.editReply(`✅ Monitoring faction ${id}.`);
        } else {
          await interaction.editReply(`⚠️ Already monitoring ${id}.`);
        }
        break;
      }
      case 'stop': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        await interaction.editReply(`✅ Stopped monitoring ${id}.`);
        break;
      }
      case 'starthosp': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id, channelId: interaction.channelId });
          saveWatched();
          await scheduleHospitalTimersFor(id);
          await interaction.editReply(`✅ Hospital alerts started for faction ${id}.`);
        } else {
          await interaction.editReply(`⚠️ Hospital alerts already running for ${id}.`);
        }
        break;
      }
      case 'stophosp': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        const memberIds = hospitalCache.get(id) || new Set();
        for (const memberId of memberIds) {
          const info = hospitalTimers.get(memberId);
          if (info) clearTimeout(info.timer), hospitalTimers.delete(memberId);
        }
        hospitalCache.delete(id);
        await interaction.editReply(`✅ Hospital alerts stopped for faction ${id}.`);
        break;
      }
      case 'revives': {
        raw = await pollFactionMembers(MY_FACTION_ID);
        list = transformMembers(raw).filter(m => m.isRevivable).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Revivable members:**\n${list}`);
        break;
      }
      case 'warrevives': {
        const watchedIds = watchedFactions.map(w => w.factionId);
        const id = options.getInteger('id') || watchedIds[0];
        raw = await pollFactionMembers(id);
        list = transformMembers(raw).filter(m => m.isRevivable).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Enemy faction ${id} revives:**\n${list}`);
        break;
      }
      case 'oc': {
        raw = await pollFactionMembers(MY_FACTION_ID);
        list = transformMembers(raw).filter(m => !m.isInOc).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Not in OC:**\n${list}`);
        break;
      }
      case 'cleanup': {
        const count = options.getInteger('count') || 10;
        const msgs = await interaction.channel.messages.fetch({ limit: count });
        await interaction.channel.bulkDelete(msgs, true);
        break;
      }
      case 'prewar': {
        await upsertFactionSnapshot();
        await interaction.editReply('✅ Snapshot saved.');
        break;
      }
      default:
        await interaction.editReply('⚠️ Unknown command.');
    }
  } catch (err) {
    console.error(`Error executing ${commandName}:`, err);
    await interaction.editReply(`❌ ${err.message}`);
  }
});

client.login(TOKEN);
