// index.js
console.log('🚀 index.js loaded – edits are live');
require('dotenv').config();

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits,
  WebhookClient
} = require('discord.js');

// Environment variables
const MY_FACTION_ID     = parseInt(process.env.MY_FACTION_ID, 10);
const TOKEN             = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const MONGO_URI         = process.env.MONGO_URI;
const HOSPITAL_INTERVAL = 60 * 1000;
const SNAPSHOT_INTERVAL = 15 * 60 * 1000;
const WAR_CHANNEL_ID    = process.env.WAR_CHANNEL_ID;

// Roles & Webhooks
const FACTION_ROLE_ID   = process.env.FACTION_ROLE_ID;
const OWNER_ID          = process.env.OWNER_ID;
const CAPTAIN_ROLE_ID   = process.env.CAPTAIN_ROLE_ID;
const HOSPITAL_WEBHOOK_URL = process.env.HOSPITAL_WEBHOOK_URL;
const SILENT_WEBHOOK_URL   = process.env.SILENT_WEBHOOK_URL;

// Models
const EnemyFaction = require('./models/EnemyFaction');
const Faction      = require('./models/Faction');
const IdleOpWatch  = require('./models/IdleOpWatch');

// Services & Workers
const { pollFactionMembers }   = require('./services/pollFaction');
const { pollFactionHospital }  = require('./services/pollFactionHospital');
const { pollFactionStatus }    = require('./services/pollFactionStatus');
const { pollUserStatus }       = require('./services/pollUserStatus');
const { createHospitalWorker } = require('./services/hospitalWorker');
const { checkIdleOpStatus } = require('./services/statusWorker');
// … later in ready:
checkIdleOpStatus();
setInterval(checkIdleOpStatus, 30_000);


// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB'))
  .catch(console.error);

// Discord client setup
const client          = new Client({ intents: [GatewayIntentBits.Guilds] });
const hospitalWebhook = new WebhookClient({ url: HOSPITAL_WEBHOOK_URL });
const silentWebhook   = new WebhookClient({ url: SILENT_WEBHOOK_URL });

// Persistence for enemy factions
const watchedFile      = path.resolve(__dirname, 'watchedFactions.json');
let watchedFactions    = [];
function loadWatched() {
  try { watchedFactions = JSON.parse(fs.readFileSync(watchedFile, 'utf8')); }
  catch { watchedFactions = []; }
}
function saveWatched() {
  fs.writeFileSync(watchedFile, JSON.stringify(watchedFactions, null, 2));
}

// Transform raw Torn member data into our schema
function transformMembers(raw) {
  return raw.map(m => ({
    memberId:      m.id,
    name:          m.name,
    level:         m.level,
    daysInFaction: m.days_in_faction,
    lastAction: {
      status:    m.last_action?.status || '',
      timestamp: m.last_action ? new Date(m.last_action.timestamp * 1000) : new Date(),
      relative:  m.last_action?.relative || ''
    },
    status: {
      description: m.status?.description || '',
      details:     m.status?.details || null,
      state:       m.status?.state || '',
      until:       m.status?.until ? new Date(m.status.until * 1000) : null
    },
    reviveSetting: m.revive_setting || '',
    position:      m.position,
    isRevivable:   m.is_revivable,
    isInOc:        m.is_in_oc
  }));
}

// Snapshot functions (write to DB)
async function upsertFactionSnapshot() {
  console.log('🔄 upsertFactionSnapshot triggered');
  const raw     = await pollFactionMembers(MY_FACTION_ID);
  const members = transformMembers(raw);
  await Faction.findOneAndUpdate(
    { factionId: MY_FACTION_ID },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
}
async function upsertEnemyFactionSnapshot(id) {
  console.log(`🔄 upsertEnemyFactionSnapshot for faction ${id}`);
  const raw     = await pollFactionMembers(id);
  const members = transformMembers(raw);
  await EnemyFaction.findOneAndUpdate(
    { factionId: id },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
}

// Register slash commands
const commands = [
  { name: 'start',      description: 'Watch an enemy faction',          options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stop',       description: 'Stop watching an enemy faction',  options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'starthosp',  description: 'Enable hospital alerts',          options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stophosp',   description: 'Disable hospital alerts',         options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'revives',    description: 'List revivable members' },
  { name: 'warrevives', description: 'List enemy revivable members',    options: [{ name: 'id', type: 4, description: 'Faction ID', required: false }] },
  { name: 'oc',         description: 'List own faction members in OC' },
  { name: 'cleanup',    description: 'Bulk delete messages',            options: [{ name: 'count', type: 4, description: 'Number to remove', required: false }], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar',     description: 'Snapshot own faction data' },
  { name: 'idleop',     description: 'Watch user status',               options: [
      { name: 'add',    type: 1, description: 'Add idle-op watch',    options: [{ name: 'id', type: 4, description: 'Torn user ID', required: true }] },
      { name: 'remove', type: 1, description: 'Remove idle-op watch', options: [{ name: 'id', type: 4, description: 'Torn user ID', required: true }] }
  ]}
];
(async () => {
  const rest  = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log('✅ Registered slash commands');
})();

// Ready handler
client.once('ready', () => {
  console.log('✅ Client ready, initializing loops');
  loadWatched();

  // Start hospital worker
  const hospitalCache  = new Map();
  const hospitalTimers = new Map();
  const hospitalWorker = createHospitalWorker(
    watchedFactions.map(id => ({ factionId: id, channelId: WAR_CHANNEL_ID })),
    client,
    hospitalCache,
    hospitalTimers,
    HOSPITAL_INTERVAL
  );
  hospitalWorker.start();

  // Initial snapshots
  upsertFactionSnapshot();
  watchedFactions.forEach(id => upsertEnemyFactionSnapshot(id));

  // Recurring loops
  setInterval(() => {
    console.log('⏰ Enemy snapshot loop');
    watchedFactions.forEach(id => upsertEnemyFactionSnapshot(id));
  }, HOSPITAL_INTERVAL);

  setInterval(() => {
    console.log('⏰ Own faction snapshot loop');
    upsertFactionSnapshot();
  }, SNAPSHOT_INTERVAL);

  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;
  const isCleanup = commandName === 'cleanup';
  await interaction.deferReply({ ephemeral: isCleanup });

  // Permission check
  const userId = interaction.user.id;
  const member = interaction.member;
  if (userId !== OWNER_ID && !member.roles.cache.has(CAPTAIN_ROLE_ID)) {
    return interaction.reply({ content: '⚠️ You do not have permission.', ephemeral: true });
  }

  try {
    switch (commandName) {
      case 'start': {
        const id = options.getInteger('id');
        if (!watchedFactions.includes(id)) { watchedFactions.push(id); saveWatched(); }
        return interaction.editReply(`✅ Now watching faction ${id}`);
      }
      case 'stop': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(f => f !== id); saveWatched();
        return interaction.editReply(`🛑 Stopped watching faction ${id}`);
      }
      case 'starthosp': {
        const id = options.getInteger('id');
        await Faction.findOneAndUpdate({ factionId: id }, {}, { upsert: true });
        return interaction.editReply(`✅ Hospital alerts enabled for faction ${id}`);
      }
      case 'stophosp': {
        const id = options.getInteger('id');
        await Faction.deleteOne({ factionId: id });
        return interaction.editReply(`🛑 Hospital alerts disabled for faction ${id}`);
      }
      case 'revives': {
       // List revivable members from your own faction snapshot
        const doc = await Faction.findOne({ factionId: MY_FACTION_ID });
        const members = doc?.members || [];
        const list = members.filter(m => m.isRevivable);
        const formatted = list
        .map(m => `• ${m.name} (${m.memberId})`)
        .join('\n') || 'None';
        return interaction.editReply(`**Revivable members:**\n${formatted}`);
      }
      case 'warrevives': {
        const fid = options.getInteger('id') || watchedFactions[0];
        if (!fid) return interaction.editReply('⚠️ No faction specified');
        const members = await pollFactionStatus(fid);
        const list = members.filter(m => m.isRevivable);
        const formatted = list.map(m => `• ${m.name} (${m.memberId})`).join('\n') || 'None';
        return interaction.editReply(`**Enemy revivable for ${fid}:**\n${formatted}`);
      }
      case 'oc': {
        const doc = await Faction.findOne({ factionId: MY_FACTION_ID });
        const list = members.filter(m => m.isInOc);
        const formatted = list.map(m => `• ${m.name} (${m.memberId})`).join('\n') || 'None';
        return interaction.editReply(`**Members in OC:**\n${formatted}`);
      }
      case 'cleanup': {
        const cnt = options.getInteger('count') || 10;
        const msgs = await interaction.channel.messages.fetch({ limit: cnt });
        await interaction.channel.bulkDelete(msgs, true);
        return interaction.editReply(`🧹 Deleted ${msgs.size} messages`);
      }
      case 'prewar': {
        await upsertFactionSnapshot();
        return interaction.editReply('📸 Own faction snapshot complete');
      }
      case 'idleop': {
        const sub = options.getSubcommand();
        const uid = options.getInteger('id').toString();
        if (sub === 'add') {
          if (await IdleOpWatch.exists({ userId: uid })) {
            return interaction.editReply(`⚠️ Already watching ${uid}`);
          }
          const res = await pollUserStatus(uid);
          await IdleOpWatch.create({ userId: uid, name: res.name, lastAction: res.status.last_action, channelId: interaction.channelId });
          await silentWebhook.send({ username: 'D4 Intelligence', content: `➕ Watching ${res.name}` });
          return interaction.editReply(`✅ Watching ${res.name}`);
        } else {
          const removed = await IdleOpWatch.deleteOne({ userId: uid });
          if (!removed.deletedCount) {
            return interaction.editReply(`⚠️ ${uid} was not watched`);
          }
          await silentWebhook.send({ username: 'D4 Intelligence', content: `➖ Unwatched ${uid}` });
          return interaction.editReply(`🛑 Stopped watching ${uid}`);
        }
      }
      default:
        return interaction.editReply('⚠️ Unknown command');
    }
  } catch (e) {
    console.error(e);
    return interaction.editReply(`❌ ${e.message}`);
  }
});

client.login(TOKEN);
