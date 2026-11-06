const pool = require('../config/db');

// Durées proposées à l'administrateur (en jours). « indefinie » = jusqu'à réactivation manuelle.
const DUREES_JOURS = { '1j': 1, '2j': 2, '3j': 3, '7j': 7, '14j': 14, '30j': 30, '90j': 90, '365j': 365 };

function formaterDate(date) {
  return new Date(date).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Indian/Antananarivo'
  });
}

function messageSuspension(jusquAu) {
  return jusquAu
    ? `Votre compte est suspendu jusqu'au ${formaterDate(jusquAu)}. Il sera réactivé automatiquement à cette date.`
    : 'Votre compte a été suspendu. Contactez un administrateur.';
}

// Réactive tous les comptes dont la suspension est terminée (sans effet si la colonne n'existe pas encore)
async function leverSuspensionsExpirees() {
  try {
    await pool.execute(
      'UPDATE utilisateur SET actif = 1, suspendu_jusqu_au = NULL WHERE actif = 0 AND suspendu_jusqu_au IS NOT NULL AND suspendu_jusqu_au <= ?',
      [new Date()]
    );
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
  }
}

// État d'un compte : { actif, jusquAu }. Si la suspension est terminée, le compte est réactivé ici même.
async function lireStatut(idUtilisateur) {
  let rows;
  try {
    [rows] = await pool.execute('SELECT actif, suspendu_jusqu_au FROM utilisateur WHERE id_utilisateur = ?', [idUtilisateur]);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    [rows] = await pool.execute('SELECT actif FROM utilisateur WHERE id_utilisateur = ?', [idUtilisateur]);
  }
  if (rows.length === 0) return null;
  return evaluer(idUtilisateur, rows[0]);
}

async function evaluer(idUtilisateur, ligne) {
  const actif = !!ligne.actif;
  const fin = ligne.suspendu_jusqu_au ? new Date(ligne.suspendu_jusqu_au) : null;
  if (!actif && fin && fin.getTime() <= Date.now()) {
    try { await pool.execute('UPDATE utilisateur SET actif = 1, suspendu_jusqu_au = NULL WHERE id_utilisateur = ?', [idUtilisateur]); } catch (e) { /* sera refait au prochain accès */ }
    return { actif: true, jusquAu: null };
  }
  return { actif, jusquAu: actif ? null : fin };
}

module.exports = { DUREES_JOURS, formaterDate, messageSuspension, leverSuspensionsExpirees, lireStatut, evaluer };
