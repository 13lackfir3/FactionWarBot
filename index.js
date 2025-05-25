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
const MY_FACTION_ID     = parseInt(process.env.MY_FACTION_ID, 10);
const TORN_API_KEY      = process.env.TORN_API_KEY;
const TOKEN             = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const MONGO_URI         = process.env.MONGO_URI;
const HOSPITAL_INTERVAL = 60 * 1000;
const SNAPSHOT_INTERVAL = 15 * 60 * 1000;

// Webhooks & Roles
const HOSPITAL_WEBHOOK = process.env.HOSPITAL_WEBHOOK_URL;
const SILENT_WEBHOOK   = process.env.SILENT_WEBHOOK_URL;
const FACTION_ROLE     = process.env.FACTION_ROLE_ID;
const WAR_CHANNEL_ID   = process.env.WAR_CHANNEL_ID;
const OWNER_ID         = process.env.OWNER_ID;
const ALLOWED_ROLES    = process.env.ALLOWED_ROLES.split(',');
const CAPTAIN_ROLE_ID  = process.env.CAPTAIN_ROLE_ID;

// Models & services
const { pollFactionMembers }  = require('./services/pollFaction');
const { pollFactionHospital } = require('./services/pollFactionHospital');
const { pollUserStatus }      = require('./services/pollUserStatus');
const EnemyFaction            = require('./models/EnemyFaction');
const Faction                 = require('./models/Faction');
const IdleOpWatch             = require('./models/IdleOpWatch');

// Connect to MongoDB
tmongoose = mongoose;
mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB'))
  .catch(console.error);

// Discord client setup
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const hospitalWebhook = new WebhookClient({ url: HOSPITAL_WEBHOOK });
const silentWebhook   = new WebhookClient({ url: SILENT_WEBHOOK });

// Persistence for enemy factions
const watchedFile = path.resolve(__dirname, 'watchedFactions.json');
let watchedFactions = [];
function loadWatched() {
  try { watchedFactions = JSON.parse(fs.readFileSync(watchedFile, 'utf8')); }
  catch { watchedFactions = []; }
}
function saveWatched() {
  fs.writeFileSync(watchedFile, JSON.stringify(watchedFactions, null, 2));
}

// Transform API data
function transformMembers(raw) {
  return raw.map(m => ({
    memberId: m.id,
    name: m.name,
    isRevivable: m.is_revivable,
    isInOc: m.is_in_oc,
    lastAction: m.last_action || {},
    status: m.status || {},
    reviveSetting: m.revive_setting || ''
  }));
}

// Snapshot functions
async function upsertFactionSnapshot() {
  const raw     = await pollFactionMembers(MY_FACTION_ID);
  const members = transformMembers(raw.members || raw);
  await Faction.findOneAndUpdate(
    { factionId: MY_FACTION_ID },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
}
async function upsertEnemyFactionSnapshot(id) {
  const raw     = await pollFactionMembers(id);
  const members = transformMembers(raw.members || raw);
  await EnemyFaction.findOneAndUpdate(
    { factionId: id },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
  console.log(`💾 Saved snapshot for enemy faction ${id}`);
}

// Hospital timers
const hospitalTimers = new Map();
async function scheduleHospitalTimersFor(id) {
  const data = await pollFactionHospital(id);
  const members = transformMembers(data.hospital || data);
  const now = Date.now();

  // Cancel expired timers
  for (const [mid, { releaseAt, timer }] of hospitalTimers) {
    if (!members.find(m => m.memberId === mid && m.status.until * 1000 === releaseAt)) {
      clearTimeout(timer);
      hospitalTimers.delete(mid);
      console.log(`🚫 Canceled hospital timer for ${mid}`);
    }
  }

  // Schedule
  for (const m of members) {
    if (m.status.state === 'Hospital' && m.status.until) {
      const releaseMs = m.status.until * 1000;
      const alertIn = releaseMs - now - 30000;
      if (alertIn > 0 && !hospitalTimers.has(m.memberId)) {
        const t = setTimeout(() => {
          hospitalWebhook.send({
            username: 'Hospital Alert Bot',
            content: `<@&${FACTION_ROLE}> **${m.name}** exits hospital in 30s! ` +
                     `https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.memberId}`
          }).catch(console.error);
          hospitalTimers.delete(m.memberId);
        }, alertIn);
        hospitalTimers.set(m.memberId, { releaseAt: releaseMs, timer: t });
        console.log(`⏱ Scheduled alert for ${m.name} in ${Math.round(alertIn/1000)}s`);
      }
    }
  }
}

// IdleOp checker
async function checkIdleOpStatus() {
  const watches = await IdleOpWatch.find().lean();
  for (const doc of watches) {
    try {
      const res = await pollUserStatus(doc.userId);
      const curr = res.status.last_action;
      // Only notify when status changes
      const prevStatus = doc.lastAction?.status;
      if (prevStatus && prevStatus === curr.status) continue;
      // Update lastAction in DB
      await IdleOpWatch.updateOne(
        { userId: doc.userId },
        { lastAction: curr }
      );
      // Send full notification
      await silentWebhook.send({
        username: 'IdleOp Watch',
        content: `👀 **${res.name}** is now **${curr.status}** – ${curr.relative} (${new Date(curr.timestamp * 1000).toISOString()})`
      });
    } catch (e) {
      console.error('Idle-op error:', e);
    }
  }
}

// Slash commands registration
const commands = [
  { name: 'start',      description: 'Watch faction', options: [{ name:'id', type:4, description:'Faction ID', required:true }] },
  { name: 'stop',       description: 'Unwatch faction', options: [{ name:'id', type:4, description:'Faction ID', required:true }] },
  { name: 'starthosp',  description: 'Enable hospital', options: [{ name:'id', type:4, description:'Faction ID', required:true }] },
  { name: 'stophosp',   description: 'Disable hospital',options: [{ name:'id', type:4, description:'Faction ID', required:true }] },
  { name: 'revives',    description: 'List revivable members' },
  { name: 'warrevives', description: 'List enemy revivable',options:[{name:'id',type:4,description:'Faction ID',required:false}]},
  { name: 'oc',         description: 'List in OC' },
  { name: 'cleanup',    description: 'Delete messages',options:[{name:'count',type:4,description:'Number',required:false}],defaultMemberPermissions:PermissionFlagsBits.ManageMessages.toString()},
  { name: 'prewar',     description: 'Snapshot own faction' },
  { name: 'idleop', description: 'Watch user status', options: [
    { name: 'add', type: 1, description: 'Add idle-op watch', options: [
        { name: 'id', type: 4, description: 'Torn user ID', required: true }
    ]},
    { name: 'remove', type: 1, description: 'Remove idle-op watch', options: [
        { name: 'id', type: 4, description: 'Torn user ID', required: true }
    ]}
]}
];
(async () => {
  const rest = new REST({ version:'10' }).setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body:commands });
  console.log('✅ Commands registered');
})();

// Ready
client.once('ready', () => {
  loadWatched();
  watchedFactions.forEach(id => { upsertEnemyFactionSnapshot(id); scheduleHospitalTimersFor(id); });
  upsertFactionSnapshot();
  checkIdleOpStatus();
  setInterval(() => watchedFactions.forEach(id => { upsertEnemyFactionSnapshot(id); scheduleHospitalTimersFor(id); }), HOSPITAL_INTERVAL);
  setInterval(upsertFactionSnapshot, SNAPSHOT_INTERVAL);
  setInterval(checkIdleOpStatus, 30 * 1000);
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const userId = interaction.user.id;
  const member = interaction.member;
  if (userId !== OWNER_ID && !member.roles.cache.has(CAPTAIN_ROLE_ID))
    return interaction.reply({ content:'⚠️ No permission',ephemeral:true });
  const { commandName, options } = interaction;
  const isCleanup = commandName === 'cleanup';
  await interaction.deferReply({ ephemeral:isCleanup });
  try {
    switch(commandName) {
      case 'start': {
        const id = options.getInteger('id');
        if(!watchedFactions.includes(id)){
          watchedFactions.push(id); saveWatched(); upsertEnemyFactionSnapshot(id); scheduleHospitalTimersFor(id);
        }
        return interaction.editReply(`✅ Watching faction ${id}`);
      }
      case 'stop': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(f=>f!==id); saveWatched();
        return interaction.editReply(`🛑 Unwatched faction ${id}`);
      }
      case 'starthosp': {
        const id = options.getInteger('id');
        await Faction.findOneAndUpdate({factionId:id},{},{upsert:true});
        return interaction.editReply(`✅ Hospital alerts on for ${id}`);
      }
      case 'stophosp': {
        const id = options.getInteger('id');
        await Faction.deleteOne({factionId:id});
        return interaction.editReply(`🛑 Hospital alerts off for ${id}`);
      }
      case 'revives': {
        const doc = await Faction.findOne({factionId:MY_FACTION_ID});
        const list = (doc?.members||[]).filter(m=>m.isRevivable);
        return interaction.editReply(`💪 ${list.length} revivable: ${list.map(m=>m.name).join(', ')}`);
      }
      case 'warrevives': {
        const id = options.getInteger('id')||watchedFactions[0]; if(!id) return interaction.editReply('⚠️ No faction');
        const doc = await EnemyFaction.findOne({factionId:id});
        const list = (doc?.members||[]).filter(m=>m.isRevivable);
        return interaction.editReply(`⚔️ ${list.length} enemy revivable: ${list.map(m=>m.name).join(', ')}`);
      }
      case 'oc': {
        const doc = await Faction.findOne({factionId:MY_FACTION_ID});
        const list = (doc?.members||[]).filter(m=>m.isInOc);
        return interaction.editReply(`⛔ ${list.length} in OC: ${list.map(m=>m.name).join(', ')}`);
      }
      case 'prewar': {
        await upsertFactionSnapshot();
        return interaction.editReply('📸 Snapshot done');
      }
      case 'cleanup': {
        const cnt = options.getInteger('count')||10;
        const msgs = await interaction.channel.messages.fetch({limit:cnt});
        await interaction.channel.bulkDelete(msgs,true);
        return interaction.editReply(`🧹 Deleted ${msgs.size} messages`);
      }
      case 'idleop': {
        const sub = options.getSubcommand(); const uid = options.getInteger('id').toString();
        if(sub==='add'){
          const res = await pollUserStatus(uid);
          await IdleOpWatch.findOneAndUpdate({userId:uid},{name:res.name,lastAction:res.status.last_action,channelId:interaction.channelId},{upsert:true});
          await silentWebhook.send(`➕ Watching ${res.name}`);
          return interaction.editReply(`✅ Watching ${res.name}`);
        } else {
          await IdleOpWatch.deleteOne({userId:uid});
          await silentWebhook.send(`➖ Unwatched ${uid}`);
          return interaction.editReply(`🛑 Stopped watching ${uid}`);
        }
      }
      default:
        return interaction.editReply('⚠️ Unknown command');
    }
  } catch(e) {
    console.error(e);
    return interaction.editReply(`❌ ${e.message}`);
  }
});

client.login(TOKEN);
