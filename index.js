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

// Models & services
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

// Stub functions for hospital timers & attacks
async function scheduleHospitalTimersFor(factionId) {
  // TODO
}
async function pollFactionAttacks() {
  const url = `https://api.torn.com/v2/faction/attacks?limit=100&sort=DESC&key=${TORN_API_KEY}`;
  const res = await axios.get(url);
  if (res.data.error) throw new Error(res.data.error.error);
  return res.data.attacks;
}
async function handleAttacks() {
  // TODO
}

// Slash commands
const commands = [
  { name: 'start', description: 'Start monitoring a faction', options: [
      { name: 'id', type: 4, description: 'Faction ID to monitor', required: true },
      { name: 'reason', type: 3, description: 'Reason (war, raid, just because)', required: true, choices: [
        { name: 'war', value: 'war' },
        { name: 'raid', value: 'raid' },
        { name: 'just because', value: 'just because' }
      ] }
    ] },
  { name: 'stop', description: 'Stop monitoring a faction', options: [
      { name: 'id', type: 4, description: 'Faction ID to stop monitoring', required: true }
    ] },
  { name: 'revives', description: 'List revivable members in your faction' },
  { name: 'warrevives', description: 'List revivable members in watched enemy factions', options: [
      { name: 'id', type: 4, description: 'Select a watched faction ID', required: false, autocomplete: true }
    ] },
  { name: 'oc', description: 'List your faction members not in OC' },
  { name: 'cleanup', description: 'Bulk delete recent messages', options: [
      { name: 'count', type: 4, description: 'Number of messages to delete', required: false }
    ], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar', description: 'Snapshot your faction data into the database' }
];

// Register commands
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
    console.error('Slash commands registration error:', error);
  }
})();

// Ready
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  loadWatched();
  watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId));
  upsertFactionSnapshot();
  handleAttacks();
  setInterval(() => watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId)), HOSPITAL_INTERVAL);
  setInterval(upsertFactionSnapshot, SNAPSHOT_INTERVAL);
  setInterval(handleAttacks, ATTACK_POLL_INTERVAL);
});

// Interaction handling
client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete() && interaction.commandName === 'warrevives') {
    const focused = interaction.options.getFocused(true);
    const choices = watchedFactions.map(w => w.factionId.toString());
    const filtered = choices.filter(c => c.startsWith(focused.value));
    return interaction.respond(filtered.map(c => ({ name: c, value: parseInt(c, 10) })));
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;

  try {
    switch (commandName) {
      case 'start': {
        await interaction.deferReply({ ephemeral: true });
        const id = options.getInteger('id');
        const reason = options.getString('reason');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id, channelId: interaction.channelId, reason });
          saveWatched();
          const rawMembers = await pollFactionMembers(id);
          const members = transformMembers(rawMembers);
          await EnemyFaction.findOneAndUpdate(
            { factionId: id },
            { monitoredAt: new Date(), members },
            { upsert: true }
          );
          await EnemyFaction.updateOne(
            { factionId: id },
            { $push: { watchHistory: { reason, timestamp: new Date() } } }
          );
          await interaction.editReply(`✅ Now monitoring faction ${id} for '${reason}'.`);
        } else {
          await interaction.editReply(`⚠️ Faction ${id} is already being monitored.`);
        }
        break;
      }
      case 'stop': {
        await interaction.deferReply({ ephemeral: true });
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        await interaction.editReply(`✅ Stopped monitoring faction ${id}.`);
        break;
      }
      case 'revives': {
        await interaction.deferReply();
        const raw = await pollFactionMembers(MY_FACTION_ID);
        const members = transformMembers(raw);
        await Faction.findOneAndUpdate(
          { factionId: MY_FACTION_ID },
          { monitoredAt: new Date(), members },
          { upsert: true }
        );
        const list = members.filter(m => m.isRevivable).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Revivable members:**\n${list}`);
        break;
      }
      case 'warrevives': {
        await interaction.deferReply({ ephemeral: true });
        const watchedIds = watchedFactions.map(w => w.factionId);
        const id = options.getInteger('id');
        if (!id) {
          return interaction.editReply(`Please specify a faction ID: ${watchedIds.join(', ')}`);
        }
        if (!watchedIds.includes(id)) {
          return interaction.editReply(`⚠️ Faction ${id} is not watched. Valid IDs: ${watchedIds.join(', ')}`);
        }
        const raw = await pollFactionMembers(id);
        const members = transformMembers(raw);
        await EnemyFaction.findOneAndUpdate(
          { factionId: id },
          { monitoredAt: new Date(), members },
          { upsert: true }
        );
        const list = members.filter(m => m.isRevivable).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Enemy faction ${id} revivable members:**\n${list}`);
        break;
      }
      case 'oc': {
        await interaction.deferReply();
        const raw = await pollFactionMembers(MY_FACTION_ID);
        const members = transformMembers(raw);
        await Faction.findOneAndUpdate(
          { factionId: MY_FACTION_ID },
          { monitoredAt: new Date(), members },
          { upsert: true }
        );
        const list = members.filter(m => !m.isInOc).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Members NOT in OC:**\n${list}`);
        break;
      }
      case 'cleanup': {
        const count = options.getInteger('count') || 10;
        await interaction.reply({ content: `Deleting ${count} messages…`, ephemeral: true });
        const msgs = await interaction.channel.messages.fetch({ limit: count });
        await interaction.channel.bulkDelete(msgs, true);
        break;
      }
      case 'prewar': {
        await interaction.deferReply({ ephemeral: true });
        await upsertFactionSnapshot();
        await interaction.editReply('✅ Faction snapshot saved.');
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error(`Error executing ${commandName}:`, err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    } else {
      await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
    }
  }
});

client.login(TOKEN);
