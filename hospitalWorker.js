const { pollFactionHospital } = require('../services/pollFactionHospital');

/**
 * Worker to schedule hospital exit alerts for watched factions.
 * @param {Array<{ factionId: number, channelId: string }>} watchedFactions
 * @param {object} client - Discord Client instance
 * @param {Map<number, Set<number>>} hospitalCache - factionId → Set of memberIds
 * @param {Map<number, object>} hospitalTimers - memberId → { timer, releaseAt, channelId }
 * @param {number} intervalMs - poll interval in milliseconds
 * @returns {{ start: Function, stop: Function }}
 */
function createHospitalWorker(watchedFactions, client, hospitalCache, hospitalTimers, intervalMs) {
  let timerId;

  async function runCycle() {
    const now = Date.now();
    for (const { factionId, channelId } of watchedFactions) {
      try {
        const raw = await pollFactionHospital(factionId);
        // status.until is Unix seconds
        const hospitalized = raw.filter(m => m.status.state === 'Hospital' && m.status.until);
        const prevSet = hospitalCache.get(factionId) || new Set();
        const currentSet = new Set(hospitalized.map(m => m.id));

        // schedule new
        for (const m of hospitalized) {
          const releaseAt = m.status.until * 1000;
          const msUntilAlert = releaseAt - now - 10000; // 10s before
          const existing = hospitalTimers.get(m.id);
          if (msUntilAlert > 0 && (!existing || existing.releaseAt !== releaseAt)) {
            if (existing) clearTimeout(existing.timer);
            const timer = setTimeout(async () => {
              try {
                const ch = await client.channels.fetch(channelId);
                await ch.send(
                  `@everyone **${m.name}** leaving hospital in 10s! <https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.id}>`
                );
              } catch (err) {
                console.error('Hospital alert send failed:', err);
              }
              hospitalTimers.delete(m.id);
            }, msUntilAlert);
            hospitalTimers.set(m.id, { timer, releaseAt, channelId });
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
      } catch (err) {
        console.error(`Hospital data error for faction ${factionId}:`, err.message);
      }
    }
  }

  return {
    start() {
      runCycle();
      timerId = setInterval(runCycle, intervalMs);
    },
    stop() {
      if (timerId) clearInterval(timerId);
      // clear any pending timeouts
      for (const { timer } of hospitalTimers.values()) {
        clearTimeout(timer);
      }
      hospitalTimers.clear();
      hospitalCache.clear();
    }
  };
}

module.exports = { createHospitalWorker };