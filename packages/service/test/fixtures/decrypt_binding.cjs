// Offline stand-in for nt_helper; executed by the real export worker.
const { writeFileSync } = require('node:fs');

module.exports = {
  getInitStatus: () => 0,
  fastDecryptDatabase: (dbPath, outPath, key, algo) => {
    writeFileSync(outPath, JSON.stringify({ method: 'fast', dbPath, key, algo }));
  },
  safeDecryptDatabase: (dbPath, outPath, key, algo) => {
    writeFileSync(outPath, JSON.stringify({ method: 'safe', dbPath, key, algo }));
  },
};
