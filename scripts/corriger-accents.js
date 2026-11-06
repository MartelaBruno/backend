// Corrige les accents abîmés (ex. « donn├®es » → « données ») dans la base.
// Utilisation : node scripts/corriger-accents.js
const pool = require('../config/db');

// Texte abîmé (UTF-8 lu en code page 850) → caractère correct
const REMPLACEMENTS = [
  ['├®', 'é'], // é
  ['├¿', 'è'], // è
  ['├á', 'à'], // à
  ['├¬', 'ê'], // ê
  ['├º', 'ç'], // ç
  ['├┤', 'ô'], // ô
  ['├«', 'î'], // î
  ['├»', 'ï'], // ï
  ['├ó', 'â'], // â
  ['├╗', 'û'], // û
  ['├╣', 'ù'], // ù
  ['├ë', 'É'], // É
  ['├ê', 'È'], // È
  ['├Ç', 'À'], // À
  ['├ç', 'Ç']  // Ç
];

function corriger(texte) {
  if (typeof texte !== 'string') return texte;
  let r = texte;
  for (const [mauvais, bon] of REMPLACEMENTS) r = r.split(mauvais).join(bon);
  return r;
}

const CIBLES = [
  { table: 'livre', cle: 'id_livre', colonnes: ['titre', 'auteur', 'description'] },
  { table: 'categorie', cle: 'id_categorie', colonnes: ['nom_categorie'] },
  { table: 'utilisateur', cle: 'id_utilisateur', colonnes: ['nom', 'prenom', 'filiere'] }
];

(async () => {
  let total = 0;
  for (const { table, cle, colonnes } of CIBLES) {
    const [lignes] = await pool.query(`SELECT ${cle}, ${colonnes.join(', ')} FROM ${table}`);
    for (const ligne of lignes) {
      const changes = {};
      for (const c of colonnes) {
        const propre = corriger(ligne[c]);
        if (propre !== ligne[c]) changes[c] = propre;
      }
      const noms = Object.keys(changes);
      if (noms.length === 0) continue;
      await pool.query(
        `UPDATE ${table} SET ${noms.map(n => n + ' = ?').join(', ')} WHERE ${cle} = ?`,
        [...noms.map(n => changes[n]), ligne[cle]]
      );
      total++;
      console.log(`${table} #${ligne[cle]} corrigé : ${noms.map(n => changes[n]).join(' | ')}`);
    }
  }
  console.log(total ? `\nTerminé : ${total} ligne(s) corrigée(s).` : '\nAucun texte abîmé trouvé.');
  await pool.end();
})().catch(err => { console.error('Erreur :', err.message); process.exit(1); });
