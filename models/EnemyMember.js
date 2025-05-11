import mongoose from 'mongoose';

const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: String,
  level: Number,
  rank: String,
  position: String,
  daysInFaction: Number,
  factionPosition: String,
  factionId: String,

  status: {
    status: String,
    color: String,
    details: {
      cooldown: Number, // seconds remaining (if hospitalized)
      // future: revive, travel, etc.
    }
  },

  lastAction: {
    status: String,
    timestamp: Number,
    relative: String
  },

  totalStats: { type: Number, default: null },
  lastSeen: { type: Date, default: Date.now }
});

export default mongoose.model('EnemyMember', memberSchema);
