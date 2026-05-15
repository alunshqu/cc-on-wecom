const AgentState = {
  IDLE: 'idle',
  INIT: 'init',
  WAITING_TRUST: 'waiting_trust',
  SENT_MSG: 'sent_msg',
  PROCESSING: 'processing',
  AWAITING_INPUT: 'awaiting_input',
  STOPPED: 'stopped',
};

module.exports = { AgentState };
