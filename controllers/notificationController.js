const pool = require('../config/db');
const { lirePreferences, TYPES } = require('../utils/notifier');

const erreur = (res, err) => { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); };

// GET /api/notifications
async function lister(req, res) {
  try {
    const id = req.utilisateur.id_utilisateur;
    const [notifications] = await pool.query(
      `SELECT id_notification, type, message, lien, lue, date_creation FROM notification
       WHERE id_utilisateur = ? ORDER BY date_creation DESC, id_notification DESC LIMIT 50`, [id]);
    const [[{ nb_non_lues }]] = await pool.query('SELECT COUNT(*) AS nb_non_lues FROM notification WHERE id_utilisateur = ? AND lue = 0', [id]);
    res.json({ notifications, nb_non_lues });
  } catch (err) { erreur(res, err); }
}

// PATCH /api/notifications/:id/lire
async function lire(req, res) {
  try {
    await pool.execute('UPDATE notification SET lue = 1 WHERE id_notification = ? AND id_utilisateur = ?', [req.params.id, req.utilisateur.id_utilisateur]);
    res.json({ message: 'Notification lue.' });
  } catch (err) { erreur(res, err); }
}

// PATCH /api/notifications/lire-tout
async function lireTout(req, res) {
  try {
    await pool.execute('UPDATE notification SET lue = 1 WHERE id_utilisateur = ? AND lue = 0', [req.utilisateur.id_utilisateur]);
    res.json({ message: 'Toutes les notifications sont lues.' });
  } catch (err) { erreur(res, err); }
}

// DELETE /api/notifications/:id
async function supprimer(req, res) {
  try {
    await pool.execute('DELETE FROM notification WHERE id_notification = ? AND id_utilisateur = ?', [req.params.id, req.utilisateur.id_utilisateur]);
    res.json({ message: 'Notification supprimée.' });
  } catch (err) { erreur(res, err); }
}

// DELETE /api/notifications
async function toutSupprimer(req, res) {
  try {
    await pool.execute('DELETE FROM notification WHERE id_utilisateur = ?', [req.utilisateur.id_utilisateur]);
    res.json({ message: 'Notifications supprimées.' });
  } catch (err) { erreur(res, err); }
}

// GET /api/notifications/preferences
async function obtenirPreferences(req, res) {
  try {
    const prefs = await lirePreferences(req.utilisateur.id_utilisateur);
    const choix = {};
    for (const type of Object.keys(TYPES)) choix[type] = !(prefs.notifications && prefs.notifications[type] === false);
    res.json({ types: TYPES, notifications: choix });
  } catch (err) { erreur(res, err); }
}

// PUT /api/notifications/preferences  { notifications: { type: true|false } }
async function modifierPreferences(req, res) {
  try {
    const recu = req.body.notifications || {};
    const prefs = await lirePreferences(req.utilisateur.id_utilisateur);
    prefs.notifications = prefs.notifications || {};
    for (const type of Object.keys(TYPES)) {
      if (typeof recu[type] === 'boolean') prefs.notifications[type] = recu[type];
    }
    await pool.execute('UPDATE utilisateur SET preferences = ? WHERE id_utilisateur = ?', [JSON.stringify(prefs), req.utilisateur.id_utilisateur]);
    res.json({ message: 'Préférences enregistrées.' });
  } catch (err) { erreur(res, err); }
}

module.exports = { lister, lire, lireTout, supprimer, toutSupprimer, obtenirPreferences, modifierPreferences };
