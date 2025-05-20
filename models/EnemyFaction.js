// models/EnemyFaction.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// sub-document schema for members
const MemberSchema = new Schema({
  memberId:     { type: Number, required: true, index: true },
  name:         String,
  level:        Number,
  position:     String,
  reviveSetting:String,
  isRevivable:  Boolean,
  status: {
    state:       String,
    description: String,
    until:       Date
  },
  lastAction: {
    status:    String,
    timestamp: Date,
    relative:  String
  },
  scheduledAlertAt: Date,
  travel: {
    destination: String,
    origin:      String,
    mode:        String,
    cost:        Number,
    arrival:     Date,
    elapsed:     Number,
    route:       String
  }
}, { _id: false });

// top-level schema for the faction
const EnemyFactionSchema = new Schema({
  factionId:   { type: Number, required: true, unique: true, index: true },
  monitoredAt: { type: Date,   default: Date.now },
  warStatus: {
    status:     String,
    opponentId: Number,
    startedAt:  Date
  },
  members:    [ MemberSchema ]
}, { timestamps: true });

module.exports = mongoose.model('EnemyFaction', EnemyFactionSchema);
