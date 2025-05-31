const { pollFactionHospital } = require('./pollFactionHospital');
const { WebhookClient }      = require('discord.js');

// Webhook for hospital departure alerts
const hospitalWebhook = new WebhookClient({ url: process.env.HOSPITAL_WEBHOOK_URL });

/**
 * Worker to schedule hospital exit alerts for watched factions.
 * @param {Array<number|object>} watchedFactions - list of faction IDs or objects { factionId }
 * @param {object} client - Discord client (unused here)
 * @param {Map<number, Set<number>>} hospitalCache - factionId → Set of memberIds currently scheduled
 * @param {Map<number, object>} hospitalTimers - memberId → { timer, releaseAt }
 * @param {number} intervalMs - polling interval in ms
 * @returns {{ start: Function, stop: Function }}
 */
function createHospitalWorker(watchedFactions, client, hospitalCache, hospitalTimers, intervalMs) {
  let intervalId;

  async function runCycle() {
    const now = Date.now();
    // Normalize watchedFactions to array of IDs
    const factionIds = watchedFactions.map(w => typeof w === 'object' ? w.factionId : w);

    for (const factionId of factionIds) {
      try {
        // Retrieve cached hospital statuses
        const raw = await pollFactionHospital(factionId);
        // Filter those still in hospital
        const hospitalized = raw.filter(m => m.status.state === 'Hospital' && m.status.until);
        const prevSet = hospitalCache.get(factionId) || new Set();
        const currentSet = new Set(hospitalized.map(m => m.id));

        // Schedule new alerts
        for (const m of hospitalized) {
          const releaseAt = m.status.until * 1000;
          const msToAlert = releaseAt - now - 30000; // 30s before release
          const existing = hospitalTimers.get(m.id);
          if (msToAlert > 0 && (!existing || existing.releaseAt !== releaseAt)) {
            if (existing) clearTimeout(existing.timer);
            const timer = setTimeout(async () => {
              try {
                await hospitalWebhook.send({
                  username: 'Hospital Alert Bot',
                  content: `<@&${process.env.FACTION_ROLE_ID}> **${m.name}** exits hospital in 30s! https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.id}`
                });
              } catch (err) {
                console.error('Hospital alert failed:', err);
              }
              hospitalTimers.delete(m.id);
            }, msToAlert);
            hospitalTimers.set(m.id, { timer, releaseAt });
          }
        }

        // Cancel alerts for those no longer hospitalized
        for (const memberId of prevSet) {
          if (!currentSet.has(memberId) && hospitalTimers.has(memberId)) {
            clearTimeout(hospitalTimers.get(memberId).timer);
            hospitalTimers.delete(memberId);
          }
        }

        hospitalCache.set(factionId, currentSet);
      } catch (err) {
        console.error(`Hospital worker error for faction ${factionId}:`, err);
      }
    }
  }

  return {
    start() {
      runCycle();
      intervalId = setInterval(runCycle, intervalMs);
    },
    stop() {
      if (intervalId) clearInterval(intervalId);
      for (const { timer } of hospitalTimers.values()) {
        clearTimeout(timer);
      }
      hospitalTimers.clear();
      hospitalCache.clear();
    }
  };
}

module.exports = { createHospitalWorker };
