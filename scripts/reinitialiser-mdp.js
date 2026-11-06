// Usage : node scripts/reinitialiser-mdp.js email@exemple.mg NouveauMotDePasse
// Dépannage local : change le mot de passe d'un compte (sans e-mail).
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/db');

(async () => {
  const [email, mdp] = process.argv.slice(2);
  if (!email || !mdp || mdp.length < 6) {
    console.log('Usage : node scripts/reinitialiser-mdp.js email NouveauMotDePasse (6 caractères minimum)');
    process.exit(1);
  }
  const hash = await bcrypt.hash(mdp, 10);
  const [r] = await pool.execute('UPDATE utilisateur SET mot_de_passe = ? WHERE email = ?', [hash, email]);
  console.log(r.affectedRows ? 'Mot de passe modifié pour ' + email : 'Aucun compte avec cet e-mail.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
