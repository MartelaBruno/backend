const pool = require('../config/db');
const { emettreVersUtilisateur } = require('../sockets/socketHandler');

// Types de notifications que l'utilisateur peut activer / désactiver dans ses paramètres
const TYPES = {
  demande_recue: 'Nouvelle demande d\'emprunt sur un de mes livres',
  demande_acceptee: 'Ma demande a été acceptée',
  demande_refusee: 'Ma demande a été refusée',
  retour_confirme: 'Le retour d\'un livre a été confirmé',
  rappel: 'Rappel avant la date de retour d\'un livre emprunté',
  retard: 'Alerte en cas de retard de retour',
  admin: 'Message de l\'administration (ex. livre retiré)'
};

async function lirePreferences(idUtilisateur) {
  try {
    const [rows] = await pool.execute('SELECT preferences FROM utilisateur WHERE id_utilisateur = ?', [idUtilisateur]);
    return rows[0] && rows[0].preferences ? JSON.parse(rows[0].preferences) : {};
  } catch (err) {
    return {};
  }
}

// Crée la notification et la pousse en temps réel. Ne fait jamais échouer l'action principale.
async function notifier(idUtilisateur, { type, message, lien = null }) {
  try {
    const prefs = await lirePreferences(idUtilisateur);
    if (prefs.notifications && prefs.notifications[type] === false) return;

    const [result] = await pool.execute(
      'INSERT INTO notification (id_utilisateur, type, message, lien) VALUES (?, ?, ?, ?)',
      [idUtilisateur, type, String(message).slice(0, 255), lien]
    );
    emettreVersUtilisateur(idUtilisateur, 'notification', {
      id_notification: result.insertId, type, message, lien, lue: 0, date_creation: new Date()
    });
  } catch (err) {
    console.error('Erreur création notification :', err.message);
  }
}

module.exports = { notifier, lirePreferences, TYPES };
