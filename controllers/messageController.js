const { preparerTables, MOTIFS } = require('../utils/securite');
const pool = require('../config/db');

// GET /api/messages/conversations (liste des contacts avec le dernier message)
// Exécute la requête ; si la colonne photo_profil n'existe pas encore en base, on réessaie sans elle
async function executerAvecPhoto(sql, params) {
  try {
    return await pool.execute(sql, params);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    return pool.execute(sql.replace(/,\s*(u\.)?photo_profil/, ''), params);
  }
}

// GET /api/messages/utilisateurs?q=... (recherche d'un utilisateur actif par nom, pour démarrer une conversation)
async function rechercherUtilisateurs(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const motif = '%' + q.replace(/[%_]/g, '') + '%';
    const filtreRole = " AND role = 'etudiant'";
    const [rows] = await executerAvecPhoto(
      `SELECT id_utilisateur AS id_contact, nom, prenom, photo_profil
       FROM utilisateur
       WHERE actif = 1 AND id_utilisateur <> ?${filtreRole}
         AND (nom LIKE ? OR prenom LIKE ? OR CONCAT(prenom, ' ', nom) LIKE ?)
         AND EXISTS (SELECT 1 FROM demande_pret d JOIN livre l ON l.id_livre = d.id_livre
                     WHERE d.statut = 'acceptee'
                       AND ((d.id_emprunteur = utilisateur.id_utilisateur AND l.id_proprietaire = ?)
                         OR (d.id_emprunteur = ? AND l.id_proprietaire = utilisateur.id_utilisateur)))
       ORDER BY nom, prenom LIMIT 8`,
      [req.utilisateur.id_utilisateur, motif, motif, motif, req.utilisateur.id_utilisateur, req.utilisateur.id_utilisateur]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erreur recherche utilisateurs :', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

async function listerConversations(req, res) {
  try {
    const idUtilisateur = req.utilisateur.id_utilisateur;

    const [rows] = await executerAvecPhoto(
      `SELECT u.id_utilisateur AS id_contact, u.nom, u.prenom, u.photo_profil, u.role AS role_contact,
              lm.contenu AS dernier_message, lm.id_expediteur AS dernier_expediteur, lm.date_envoi AS dernier_message_date,
              (SELECT COUNT(*) FROM message x
                WHERE x.id_expediteur = u.id_utilisateur AND x.id_destinataire = ? AND x.lu = FALSE) AS nb_non_lus
       FROM utilisateur u
       JOIN message lm ON lm.id_message = (
         SELECT m2.id_message FROM message m2
         WHERE (m2.id_expediteur = ? AND m2.id_destinataire = u.id_utilisateur)
            OR (m2.id_expediteur = u.id_utilisateur AND m2.id_destinataire = ?)
         ORDER BY m2.date_envoi DESC, m2.id_message DESC LIMIT 1
       )
       WHERE u.role = 'etudiant'
       ORDER BY lm.date_envoi DESC, lm.id_message DESC`,
      [idUtilisateur, idUtilisateur, idUtilisateur]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/messages/:idContact (historique d'une conversation)
async function obtenirConversation(req, res) {
  try {
    const idUtilisateur = req.utilisateur.id_utilisateur;
    const idContact = req.params.idContact;

    const [rows] = await pool.execute(
      `SELECT id_message, id_expediteur, id_destinataire, contenu, date_envoi, lu
       FROM message
       WHERE (id_expediteur = ? AND id_destinataire = ?)
          OR (id_expediteur = ? AND id_destinataire = ?)
       ORDER BY date_envoi ASC`,
      [idUtilisateur, idContact, idContact, idUtilisateur]
    );

    // Marquer comme lus les messages reçus de ce contact
    await pool.execute(
      'UPDATE message SET lu = TRUE WHERE id_expediteur = ? AND id_destinataire = ? AND lu = FALSE',
      [idContact, idUtilisateur]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/messages/non-lus/compte
async function compterNonLus(req, res) {
  try {
    // Un enregistrement par expéditeur ayant des messages non lus
    const [rows] = await pool.query(
      `SELECT m.id_expediteur, s.role, COUNT(*) AS nb
       FROM message m JOIN utilisateur s ON s.id_utilisateur = m.id_expediteur
       WHERE m.id_destinataire = ? AND m.lu = FALSE
       GROUP BY m.id_expediteur, s.role`,
      [req.utilisateur.id_utilisateur]
    );
    // Pastille « Messagerie » = nombre d'étudiants qui ont écrit (pas le nombre de messages)
    const personnes = rows.filter(r => r.role === 'etudiant');
    res.json({ nb_non_lus: personnes.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// POST /api/messages/signaler : un étudiant signale un message qu'il a REÇU
async function signalerMessage(req, res) {
  try {
    await preparerTables();
    const moi = req.utilisateur.id_utilisateur;
    const idMessage = parseInt(req.body.id_message, 10);
    const motif = Object.keys(MOTIFS).includes(req.body.motif) ? req.body.motif : 'autre';
    const commentaire = String(req.body.commentaire || '').trim().slice(0, 300) || null;
    if (!idMessage) return res.status(400).json({ message: 'Message invalide.' });

    const [rows] = await pool.execute('SELECT id_expediteur, id_destinataire FROM message WHERE id_message = ?', [idMessage]);
    if (rows.length === 0 || rows[0].id_destinataire !== moi) {
      return res.status(403).json({ message: 'Vous ne pouvez signaler que les messages que vous avez reçus.' });
    }
    await pool.execute(
      'INSERT IGNORE INTO signalement_message (id_message, id_signaleur, id_signale, motif, commentaire) VALUES (?, ?, ?, ?, ?)',
      [idMessage, moi, rows[0].id_expediteur, motif, commentaire]
    );
    res.json({ message: "Merci. L'administrateur va examiner ce message." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { signalerMessage, rechercherUtilisateurs, listerConversations, obtenirConversation, compterNonLus };
