const pool = require('../config/db');

// Les messages servent à s'arranger pour la remise du livre (jour, heure, lieu).
// Deux étudiants peuvent donc s'écrire seulement si le propriétaire a ACCEPTÉ une demande de prêt entre eux (livre en cours de prêt).
async function ontUneDemande(idA, idB) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM demande_pret d JOIN livre l ON l.id_livre = d.id_livre
     WHERE d.statut = 'acceptee' AND ((d.id_emprunteur = ? AND l.id_proprietaire = ?) OR (d.id_emprunteur = ? AND l.id_proprietaire = ?)) LIMIT 1`,
    [idA, idB, idB, idA]
  );
  return rows.length > 0;
}

const MESSAGE_SANS_DEMANDE = "Vous pouvez écrire à un étudiant seulement lorsqu'une demande de prêt a été acceptée entre vous (pour fixer la remise du livre).";

module.exports = { ontUneDemande, MESSAGE_SANS_DEMANDE };
