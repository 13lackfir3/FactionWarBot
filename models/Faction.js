const mongoose = require('mongoose');
const { Schema } = mongoose;

// sub-document schema for watch history entries
const WatchHistorySchema = new Schema({
  reason:    { type: String, required: true },
  timestamp: { type: Date,   default: Date.now }
}, { _id: false });

// sub-document schema for faction members
const MemberSchema = new Schema({
  memberId:      { type: Number, required: true, index: true },
  name:          String,
  level:         Number,
  daysInFaction: Number,
  lastAction: {
    status:    String,
    timestamp: Date,
    relative:  String
  },
  status: {
    description: String,
    details:     String,
    state:       String,
    until:       Date
  },
  reviveSetting:    String,
  position:         String,
  isRevivable:      Boolean,
  isOnWall:         Boolean,
  isInOc:           Boolean,
  hasEarlyDischarge:Boolean,
  scheduledAlertAt: Date
}, { _id: false });

// top-level schema for the user's own faction
const FactionSchema = new Schema({
  factionId:    { type: Number, required: true, unique: true, index: true },
  monitoredAt:  { type: Date,   default: Date.now },
  watchHistory: [ WatchHistorySchema ],
  members:      [ MemberSchema ]
}, { timestamps: true });

module.exports = mongoose.model('Faction', FactionSchema);
