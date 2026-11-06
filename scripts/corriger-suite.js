const pool = require('../config/db');

const REMPLACEMENTS = [
  ['\u251C\u00AE', '\u00E9'], ['\u251C\u00BF', '\u00E8'], ['\u251C\u00E1', '\u00E0'],
  ['\u251C\u00AC', '\u00EA'], ['\u251C\u00BA', '\u00E7'], ['\u251C\u2524', '\u00F4'],
  ['\u251C\u00AB', '\u00EE'], ['\u251C\u00BB', '\u00EF'], ['\u251C\u00F3', '\u00E2'],
  ['\u251C\u2557', '\u00FB'], ['\u251C\u2563', '\u00F9'], ['\u251C\u00EB', '\u00C9'],
  ['\u251C\u00EA', '\u00C8'], ['\u251C\u00C7', '\u00C0'], ['\u251C\u00E7', '\u00C7']
];

function corriger(texte) {
  if (typeof texte !== 'string') return texte;
  let r = texte;
  for (const [mauvais, bon] of REMPLACEMENTS) r = r.split(mauvais).join(bon);
  return r;
}

(async () => {
  // 1) Categories : si la version correcte existe deja, on fusionne
  const [cats] = await pool.query('SELECT id_categorie, nom_categorie FROM categorie');
  for (const c of cats) {
    const propre = corriger(c.nom_categorie);
    if (propre === c.nom_categorie) continue;
    const bonne = cats.find(x => x.nom_categorie === propre);
    if (bonne) {
      await pool.query('UPDATE livre SET id_categorie = ? WHERE id_categorie = ?', [bonne.id_categorie, c.id_categorie]);
      await pool.query('DELETE FROM categorie WHERE id_categorie = ?', [c.id_categorie]);
      console.log('categorie fusionnee : ' + propre);
    } else {
      await pool.query('UPDATE categorie SET nom_categorie = ? WHERE id_categorie = ?', [propre, c.id_categorie]);
      console.log('categorie corrigee : ' + propre);
    }
  }

  // 2) Utilisateurs
  const [users] = await pool.query('SELECT id_utilisateur, nom, prenom, filiere FROM utilisateur');
  for (const u of users) {
    const n = corriger(u.nom), p = corriger(u.prenom), f = corriger(u.filiere);
    if (n === u.nom && p === u.prenom && f === u.filiere) continue;
    await pool.query('UPDATE utilisateur SET nom = ?, prenom = ?, filiere = ? WHERE id_utilisateur = ?', [n, p, f, u.id_utilisateur]);
    console.log('utilisateur corrige : ' + p + ' ' + n);
  }

  console.log('Termine.');
  await pool.end();
})().catch(err => { console.error('Erreur :', err.message); process.exit(1); });