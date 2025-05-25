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
  PermissionFlagsBits,
  WebhookClient
} = require('discord.js');

// Environment variables
const MY_FACTION_ID      = parseInt(process.env.MY_FACTION_ID, 10);
const TORN_API_KEY       = process.env.TORN_API_KEY;
const TOKEN              = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID          = process.env.CLIENT_ID;
const GUILD_ID           = process.env.GUILD_ID;
const MONGO_URI          = process.env.MONGO_URI;
const HOSPITAL_INTERVAL  = 60 * 1000;       // 1 minute
const SNAPSHOT_INTERVAL  = 15 * 60 * 1000;  // 15 minutes
const HOSPITAL_WEBHOOK   = process.env.HOSPITAL_WEBHOOK_URL;
const FACTION_ROLE       = process.env.FACTION_ROLE_ID;
const SILENT_WEBHOOK_URL = process.env.SILENT_WEBHOOK_URL;
const IDLEOP_INTERVAL    = 30 * 1000;       // 30 seconds

// Models & services
const { pollFactionMembers }   = require('./services/pollFaction');
const { pollFactionHospital }  = require('./services/pollFactionHospital');
const EnemyFaction             = require('./models/EnemyFaction');
const Faction                  = require('./models/Faction');

// MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB'))
  .catch(console.error);

// Discord client & webhooks
const client          = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const hospitalWebhook = new WebhookClient({ url: HOSPITAL_WEBHOOK });
const silentWebhook   = new WebhookClient({ url: SILENT_WEBHOOK_URL });

// Watched factions persistence
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

// IdleOp watch persistence
let idleOpWatch = [];
function loadIdleOp() {
  try {
    idleOpWatch = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'idleopWatch.json'), 'utf8'));
  } catch {
    idleOpWatch = [];
  }
}
function saveIdleOp() {
  fs.writeFileSync(path.resolve(__dirname, 'idleopWatch.json'), JSON.stringify(idleOpWatch, null, 2));
}

// Transform API member data
function transformMembers(raw) {
  return raw.map(m => ({
    memberId:    m.id,
    name:        m.name,
    isRevivable: m.is_revivable,
    isInOc:      m.is_in_oc,
    status:      { state: m.status.state, until: m.status.until ? new Date(m.status.until * 1000) : null }
  }));
}

// Update own faction snapshot
async function upsertFactionSnapshot() {
  const raw = await pollFactionMembers(MY_FACTION_ID);
  await Faction.findOneAndUpdate(
    { factionId: MY_FACTION_ID },
    { monitoredAt: new Date(), members: raw },
    { upsert: true }
  );
}

// Hospital scheduling
const hospitalCache  = new Map();
const hospitalTimers = new Map();
async function scheduleHospitalTimersFor(factionId) {
  const now     = Date.now();
  const raw     = await pollFactionHospital(factionId);
  const members = transformMembers(raw);
  const hosp    = members.filter(m => m.status.state === 'Hospital' && m.status.until);

  const prevSet = hospitalCache.get(factionId) || new Set();
  const curSet  = new Set(hosp.map(m => m.memberId));

  for (const m of hosp) {
    const releaseAt = m.status.until.getTime();
    const msToAlert = releaseAt - now - 30000;  // 30s before
    if (msToAlert > 0) {
      const existing = hospitalTimers.get(m.memberId);
      if (!existing || existing.releaseAt !== releaseAt) {
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(async () => {
          await hospitalWebhook.send({
            username: 'Hospital Alert Bot',
            content: `<@&${FACTION_ROLE}> **${m.name}** leaving hospital in 30s! <https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.memberId}>`
          });
          hospitalTimers.delete(m.memberId);
        }, msToAlert);
        hospitalTimers.set(m.memberId, { timer, releaseAt });
      }
    }
  }

  for (const id of prevSet) {
    if (!curSet.has(id) && hospitalTimers.has(id)) {
      clearTimeout(hospitalTimers.get(id).timer);
      hospitalTimers.delete(id);
    }
  }

  hospitalCache.set(factionId, curSet);
}

// IdleOp polling helper
async function pollUserStatus(id) {
  const res = await axios.get(
    `https://api.torn.com/v2/user/${id}?selections=last_action&key=${TORN_API_KEY}`
  );
  if (res.data.error) throw new Error(res.data.error.error);
  return res.data.last_action.status;
}
// IdleOp checks loop
async function scheduleIdleOpChecks() {
  for (const e of idleOpWatch) {
    try {
      const oldStatus = e.status;
      const newStatus = await pollUserStatus(e.id);
      if (newStatus !== oldStatus) {
        await silentWebhook.send({
          username: 'IdleOp Alert Bot',
          content: `<@&${FACTION_ROLE}> **${e.name || e.id}** status ${oldStatus} → ${newStatus}`
        });
        e.status = newStatus;
        saveIdleOp();
      }
    } catch (err) {
      console.error('IdleOp error', err);
    }
  }
}

// Slash commands
const commands = [
  { name: 'start',     description: 'Start monitoring a faction',    options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stop',      description: 'Stop monitoring a faction',     options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'starthosp', description: 'Enable hosp alerts',            options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stophosp',  description: 'Disable hosp alerts',           options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'revives',   description: 'List revivable members' },
  { name: 'warrevives',description: 'List enemy revivable members', options: [{ name: 'id', type: 4, description: 'Faction ID', required: false }] },
  { name: 'oc',        description: 'List members not in OC' },
  { name: 'cleanup',   description: 'Bulk delete messages',          options: [{ name: 'count', type: 4, description: 'Number to remove', required: false }], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar',    description: 'Snapshot your faction data' },
  { name: 'idleop',    description: 'Manage idle watch',            options: [
      { name: 'add',    type: 1, description: 'Add user to watch',    options: [{ name: 'id', type: 4, description: 'User ID', required: true }] },
      { name: 'remove', type: 1, description: 'Remove user to watch', options: [{ name: 'id', type: 4, description: 'User ID', required: true }] },
      { name: 'list',   type: 1, description: 'List watched users' }  ] }
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
    console.error('Slash registration error:', error);
  }
})();

// Ready
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  loadWatched();
  loadIdleOp();
  watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId));
  setInterval(() => watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId)), HOSPITAL_INTERVAL);
  setInterval(upsertFactionSnapshot, SNAPSHOT_INTERVAL);
  setInterval(scheduleIdleOpChecks, IDLEOP_INTERVAL);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;
  await interaction.deferReply({ ephemeral: commandName === 'cleanup' });

  try {
    switch (commandName) {
      case 'start': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id });
          saveWatched();
          await interaction.editReply(`✅ Now watching faction ${id}`);
        } else {
          await interaction.editReply(`⚠️ Already watching faction ${id}`);
        }
        break;
      }
      case 'stop': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        await interaction.editReply(`✅ Stopped watching faction ${id}`);
        break;
      }
      case 'starthosp': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id });
          saveWatched();
        }
        await scheduleHospitalTimersFor(id);
        await interaction.editReply(`✅ Hospital alerts enabled for faction ${id}`);
        break;
      }
      case 'stophosp': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        const timers = hospitalCache.get(id) || new Set();
        timers.forEach(mid => {
          const info = hospitalTimers.get(mid);
          if (info) clearTimeout(info.timer);
        });
        hospitalCache.delete(id);
        await interaction.editReply(`✅ Hospital alerts disabled for faction ${id}`);
        break;
      }
      case 'revives': {
        const raw = await pollFactionMembers(MY_FACTION_ID);
        const list = transformMembers(raw).filter(m => m.isRevivable).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Revivable members:**\n${list}`);
        break;
      }
      case 'warrevives': {
        const id = options.getInteger('id') || (watchedFactions[0] && watchedFactions[0].factionId);
        if (!id) return await interaction.editReply('⚠️ No faction specified');
        const raw = await pollFactionMembers(id);
        const list = transformMembers(raw).filter(m => m.isRevivable).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Enemy faction ${id} revivable members:**\n${list}`);
        break;
      }
      case 'oc': {
        const raw = await pollFactionMembers(MY_FACTION_ID);
        const list = transformMembers(raw).filter(m => !m.isInOc).map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
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
        await interaction.editReply('✅ Faction snapshot saved');
        break;
      }
      case 'idleop': {
        const sub = options.getSubcommand();
        if (sub === 'add') {
          const id = options.getInteger('id');
          // refresh enemy faction data
          for (const w of watchedFactions) {
            const raw = await pollFactionMembers(w.factionId);
            await EnemyFaction.findOneAndUpdate(
              { factionId: w.factionId },
              { monitoredAt: new Date(), members: raw },
              { upsert: true }
            );
          }
          // fetch initial status and name
          const status = await pollUserStatus(id);
          let name = id;
          const doc = await EnemyFaction.findOne({ "members.memberId": id }).lean();
          if (doc) {
            const member = doc.members.find(m => m.memberId === id);
            if (member) name = member.name;
          }
          idleOpWatch.push({ id, name, status });
          saveIdleOp();
          await interaction.editReply(`✅ Now watching **${name}** (ID:${id}) — status: ${status}`);
        } else if (sub === 'remove') {
          const id = options.getInteger('id');
          idleOpWatch = idleOpWatch.filter(e => e.id !== id);
          saveIdleOp();
          await interaction.editReply(`✅ Removed user ID ${id} from watch`);
        } else if (sub === 'list') {
          const list = idleOpWatch.map(e => `• ${e.name} (ID:${e.id}) — ${e.status}`).join('\n') || '_None_';
          await interaction.editReply(`**IdleOp Watch:**\n${list}`);
        }
        break;
      }
      default:
        await interaction.editReply('⚠️ Unknown command.');
    }
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    await interaction.editReply(`❌ ${err.message}`);
  }
});

client.login(TOKEN);
