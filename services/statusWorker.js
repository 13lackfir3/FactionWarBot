const IdleOp      = require('./models/IdleOp');
const { pollUserStatus } = require('./services/pollUserStatus');
const { SILENT_WEBHOOK_URL } = process.env;
const webhook = new WebhookClient({ url: SILENT_WEBHOOK_URL });

async function checkIdleOps() {
  const all = await IdleOp.find().lean();
  for (const doc of all) {
    const fresh = await pollUserStatus(doc.userId);
    const prev   = doc.lastAction || {};

    // shallow compare status + timestamp (or JSON.stringify)
    if (
      fresh.last_action.status !== prev.status
      // ignore timestamp-only changes
    ) {
      // send alert
      await webhook.send({
      username: 'OverWatch',
      content: `👀 **${fresh.name}** (ID:${fresh.id}) status changed:\n` +
           `• status: ${fresh.status.state}\n` +
           `• lastAction.status: ${fresh.last_action.status}\n` +
           `• lastAction.relative: ${fresh.last_action.relative}`
      });

      // update DB
      await IdleOp.findOneAndUpdate(
        { userId: fresh.id },
        { name: fresh.name,
          lastAction: {
            status:    fresh.last_action.status,
            timestamp: new Date(fresh.last_action.timestamp * 1000),
            relative:  fresh.last_action.relative
          }
        }
      );
    }
  }
}

module.exports = { checkIdleOps };
