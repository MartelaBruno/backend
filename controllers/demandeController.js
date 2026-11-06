const pool = require('../config/db');
const { formaterDate, envoyerCsv, LIBELLE_STATUT } = require('../utils/csv');
const { notifier } = require('../utils/notifier');

// POST /api/demandes (emprunteur)
async function envoyerDemande(req, res) {
  try {
    const { id_livre, date_prevue_retour } = req.body;
    const id_emprunteur = req.utilisateur.id_utilisateur;

    // La date de retour est obligatoire, future, et au plus dans un an
    const dateRetour = new Date(`${date_prevue_retour}T00:00:00`);
    const demain = new Date(); demain.setHours(0, 0, 0, 0); demain.setDate(demain.getDate() + 1);
    const maxDate = new Date(demain); maxDate.setDate(maxDate.getDate() + 365);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date_prevue_retour || '') || isNaN(dateRetour) || dateRetour < demain || dateRetour > maxDate) {
      return res.status(400).json({ message: 'Date de retour invalide : choisissez une date à partir de demain, dans un an maximum.' });
    }

    const [livres] = await pool.execute('SELECT * FROM livre WHERE id_livre = ?', [id_livre]);
    if (livres.length === 0) return res.status(404).json({ message: 'Livre introuvable.' });
    if (livres[0].disponibilite !== 'disponible') {
      return res.status(409).json({ message: "Ce livre n'est plus disponible." });
    }
    if (livres[0].id_proprietaire === id_emprunteur) {
      return res.status(400).json({ message: 'Vous ne pouvez pas emprunter votre propre livre.' });
    }

    const [doublon] = await pool.execute(
      "SELECT id_demande FROM demande_pret WHERE id_livre = ? AND id_emprunteur = ? AND statut = 'en_attente'", [id_livre, id_emprunteur]);
    if (doublon.length > 0) return res.status(409).json({ message: 'Vous avez déjà une demande en attente pour ce livre.' });

    const [result] = await pool.execute(
      `INSERT INTO demande_pret (id_livre, id_emprunteur, statut, date_prevue_retour)
       VALUES (?, ?, 'en_attente', ?)`,
      [id_livre, id_emprunteur, date_prevue_retour || null]
    );

    const [[emprunteur]] = await pool.execute('SELECT prenom, nom FROM utilisateur WHERE id_utilisateur = ?', [id_emprunteur]);
    await notifier(livres[0].id_proprietaire, {
      type: 'demande_recue', lien: '/mes-livres.html',
      message: `${emprunteur.nom} ${emprunteur.prenom} souhaite emprunter « ${livres[0].titre} ».`
    });

    res.status(201).json({ message: 'Demande envoyée.', id_demande: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/demandes/recues (propriétaire connecté)
async function demandesRecues(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT d.id_demande, d.date_demande, d.statut, d.date_prevue_retour, d.date_emprunt_reel, d.date_reelle_retour,
              l.id_livre, l.titre, l.image, u.id_utilisateur AS id_emprunteur, u.nom, u.prenom
       FROM demande_pret d
       JOIN livre l ON d.id_livre = l.id_livre
       JOIN utilisateur u ON d.id_emprunteur = u.id_utilisateur
       WHERE l.id_proprietaire = ?
       ORDER BY d.date_demande DESC`,
      [req.utilisateur.id_utilisateur]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/demandes/envoyees (emprunteur connecté)
async function demandesEnvoyees(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT d.id_demande, d.id_livre, d.date_demande, d.statut, d.date_prevue_retour, d.date_emprunt_reel, d.date_reelle_retour, l.titre, l.auteur, l.image,
              l.id_proprietaire, up.nom AS nom_proprietaire, up.prenom AS prenom_proprietaire
       FROM demande_pret d
       JOIN livre l ON d.id_livre = l.id_livre
       JOIN utilisateur up ON l.id_proprietaire = up.id_utilisateur
       WHERE d.id_emprunteur = ?
       ORDER BY d.date_demande DESC`,
      [req.utilisateur.id_utilisateur]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// DELETE /api/demandes/:id (emprunteur : annuler sa demande encore en attente)
async function annuler(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT d.id_demande, d.statut, l.titre, l.id_proprietaire FROM demande_pret d JOIN livre l ON d.id_livre = l.id_livre
       WHERE d.id_demande = ? AND d.id_emprunteur = ?`, [req.params.id, req.utilisateur.id_utilisateur]);
    if (rows.length === 0) return res.status(403).json({ message: 'Action non autorisée.' });
    if (rows[0].statut !== 'en_attente') return res.status(409).json({ message: "Seule une demande en attente peut être annulée." });
    await pool.execute("DELETE FROM demande_pret WHERE id_demande = ? AND statut = 'en_attente'", [req.params.id]);
    await notifier(rows[0].id_proprietaire, { type: 'demande_refusee', lien: '/mes-livres.html', message: `${req.utilisateur.prenom || 'Un étudiant'} a annulé sa demande pour « ${rows[0].titre} ».` });
    res.json({ message: 'Demande annulée.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// PATCH /api/demandes/:id/accepter (propriétaire)
async function accepter(req, res) {
  try {
    const demande = await verifierProprietaireDemande(req.params.id, req.utilisateur.id_utilisateur);
    if (!demande) return res.status(403).json({ message: 'Action non autorisée.' });

    if (demande.statut !== 'en_attente') return res.status(409).json({ message: "Cette demande n'est plus en attente." });

    // Mise à jour conditionnelle : un livre ne peut être prêté qu'à une seule personne
    const [maj] = await pool.execute("UPDATE livre SET disponibilite = 'emprunte' WHERE id_livre = ? AND disponibilite = 'disponible'", [demande.id_livre]);
    if (maj.affectedRows === 0) return res.status(409).json({ message: 'Ce livre est déjà prêté.' });

    await pool.execute(
      "UPDATE demande_pret SET statut = 'acceptee', date_emprunt_reel = NOW() WHERE id_demande = ?",
      [req.params.id]
    );
    await notifier(demande.id_emprunteur, { type: 'demande_acceptee', lien: '/mes-demandes.html', message: `Votre demande pour « ${demande.titre} » a été acceptée.` });

    // Les autres demandes en attente pour ce livre sont refusées automatiquement
    const [autres] = await pool.execute("SELECT id_demande, id_emprunteur FROM demande_pret WHERE id_livre = ? AND statut = 'en_attente'", [demande.id_livre]);
    for (const autre of autres) {
      await pool.execute("UPDATE demande_pret SET statut = 'refusee' WHERE id_demande = ?", [autre.id_demande]);
      await notifier(autre.id_emprunteur, { type: 'demande_refusee', lien: '/mes-demandes.html', message: `« ${demande.titre} » vient d'être prêté à quelqu'un d'autre.` });
    }

    res.json({ message: 'Demande acceptée.', demandes_refusees_automatiquement: autres.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// PATCH /api/demandes/:id/refuser (propriétaire)
async function refuser(req, res) {
  try {
    const demande = await verifierProprietaireDemande(req.params.id, req.utilisateur.id_utilisateur);
    if (!demande) return res.status(403).json({ message: 'Action non autorisée.' });

    if (demande.statut !== 'en_attente') return res.status(409).json({ message: "Cette demande n'est plus en attente." });

    await pool.execute("UPDATE demande_pret SET statut = 'refusee' WHERE id_demande = ?", [req.params.id]);
    await notifier(demande.id_emprunteur, { type: 'demande_refusee', lien: '/mes-demandes.html', message: `Votre demande pour « ${demande.titre} » a été refusée.` });
    res.json({ message: 'Demande refusée.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// PATCH /api/demandes/:id/retour (propriétaire)
async function enregistrerRetour(req, res) {
  try {
    const demande = await verifierProprietaireDemande(req.params.id, req.utilisateur.id_utilisateur);
    if (!demande) return res.status(403).json({ message: 'Action non autorisée.' });

    if (demande.statut !== 'acceptee') return res.status(409).json({ message: "Ce livre n'est pas actuellement prêté." });

    await pool.execute(
      "UPDATE demande_pret SET statut = 'retournee', date_reelle_retour = NOW() WHERE id_demande = ?",
      [req.params.id]
    );
    await pool.execute("UPDATE livre SET disponibilite = 'disponible' WHERE id_livre = ?", [demande.id_livre]);

    await notifier(demande.id_emprunteur, { type: 'retour_confirme', lien: '/mes-demandes.html', message: `Le retour de « ${demande.titre} » a été confirmé. Merci !` });
    res.json({ message: 'Retour enregistré.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// Vérifie que la demande existe et que l'utilisateur connecté est bien le propriétaire du livre concerné
async function verifierProprietaireDemande(idDemande, idUtilisateur) {
  const [rows] = await pool.execute(
    `SELECT d.*, l.id_proprietaire, l.titre FROM demande_pret d
     JOIN livre l ON d.id_livre = l.id_livre
     WHERE d.id_demande = ?`,
    [idDemande]
  );
  if (rows.length === 0 || rows[0].id_proprietaire !== idUtilisateur) return null;
  return rows[0];
}

module.exports = { envoyerDemande, demandesRecues, demandesEnvoyees, annuler, accepter, refuser, enregistrerRetour };
