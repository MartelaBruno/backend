// Crée les 2 tables de sécurité (matricules autorisés, signalements). Usage : node scripts/migration-securite.js
require('dotenv').config();
const { preparerTables } = require('../utils/securite');
const pool = require('../config/db');

preparerTables()
  .then(async () => {
    const [t] = await pool.query("SHOW TABLES LIKE 'matricule_autorise'");
    const [s] = await pool.query("SHOW TABLES LIKE 'signalement_message'");
    console.log(t.length ? 'OK  : table matricule_autorise' : 'ERREUR : matricule_autorise absente');
    console.log(s.length ? 'OK  : table signalement_message' : 'ERREUR : signalement_message absente');
    process.exit(0);
  })
  .catch((err) => { console.error('Échec :', err.message); process.exit(1); });
