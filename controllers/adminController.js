const { preparerTables } = require('../utils/securite');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { envoyerEmailInvitation } = require('../utils/mailer');
const { DUREES_JOURS, leverSuspensionsExpirees } = require('../utils/suspension');
const { notifier } = require('../utils/notifier');
const { formaterDate, envoyerCsv, LIBELLE_STATUT } = require('../utils/csv');

// GET /api/admin/statistiques
async function statistiques(req, res) {
  try {
    await leverSuspensionsExpirees();
    const compter = async (from, where = '') => (await pool.query(`SELECT COUNT(*) AS n ${from} WHERE 1=1 ${where}`))[0][0].n;
    const DEPUIS_LIVRE = 'FROM livre l JOIN utilisateur u ON u.id_utilisateur = l.id_proprietaire';
    const DEPUIS_PRET = 'FROM demande_pret d JOIN livre l ON l.id_livre = d.id_livre JOIN utilisateur u ON u.id_utilisateur = l.id_proprietaire';
    const nb_etudiants = await compter('FROM utilisateur u', "AND u.role = 'etudiant'");
    const nb_livres = await compter(DEPUIS_LIVRE);
    const nb_prets_en_cours = await compter(DEPUIS_PRET, "AND d.statut = 'acceptee'");
    const nb_suspendus = await compter('FROM utilisateur u', "AND u.role = 'etudiant' AND u.actif = 0");
    const nb_en_attente = await compter(DEPUIS_PRET, "AND d.statut = 'en_attente'");
    const nb_retards = await compter(DEPUIS_PRET, "AND d.statut = 'acceptee' AND d.date_prevue_retour < CURDATE()");
    const nb_disponibles = await compter(DEPUIS_LIVRE, "AND l.disponibilite = 'disponible'");
    res.json({ nb_etudiants, nb_livres, nb_disponibles, nb_prets_en_cours, nb_suspendus, nb_en_attente, nb_retards });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/admin/utilisateurs
// Si les colonnes sexe / photo_profil n'existent pas encore en base, on réessaie sans elles.
async function listerUtilisateurs(req, res) {
  try { await leverSuspensionsExpirees(); } catch (err) { console.error(err); }
  const requete = (colonnes, suspension = '') => pool.query(
    `SELECT id_utilisateur, matricule, nom, prenom, email, telephone, ${colonnes} filiere, niveau_etude, role, actif, ${suspension} date_inscription,
            (SELECT COUNT(*) FROM livre WHERE livre.id_proprietaire = utilisateur.id_utilisateur) AS nb_livres,
            (SELECT COUNT(*) FROM demande_pret WHERE demande_pret.id_emprunteur = utilisateur.id_utilisateur AND demande_pret.statut = 'acceptee') AS nb_emprunts_en_cours
     FROM utilisateur WHERE role = 'etudiant' ORDER BY date_inscription DESC`
  );
  try {
    // On essaie avec toutes les colonnes récentes, puis on retire celles qui n'existent pas encore en base
    const essais = [['sexe, photo_profil,', 'suspendu_jusqu_au,'], ['sexe, photo_profil,', ''], ['', '']];
    let rows;
    for (let i = 0; i < essais.length; i++) {
      try {
        [rows] = await requete(...essais[i]);
        break;
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR' || i === essais.length - 1) throw err;
      }
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/admin/utilisateurs/:id/fiche : livres publiés et demandes d'un étudiant
async function ficheUtilisateur(req, res) {
  try {
    const id = req.params.id;
    const [livres] = await pool.query(
      'SELECT id_livre, titre, auteur, disponibilite FROM livre WHERE id_proprietaire = ? ORDER BY id_livre DESC LIMIT 20', [id]);
    const [demandes] = await pool.query(
      `SELECT d.id_demande, d.statut, d.date_demande, d.date_prevue_retour, d.date_reelle_retour, l.titre,
              CASE WHEN d.id_emprunteur = ? THEN 'emprunteur' ELSE 'proprietaire' END AS role_dans_pret
       FROM demande_pret d JOIN livre l ON d.id_livre = l.id_livre
       WHERE d.id_emprunteur = ? OR l.id_proprietaire = ?
       ORDER BY d.date_demande DESC LIMIT 20`, [id, id, id]);
    res.json({ livres, demandes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/admin/retards : prêts acceptés dont la date de retour est dépassée (les plus en retard d'abord)
async function listerRetards(req, res) {
  const requete = (suspension) => pool.query(
    `SELECT d.id_demande, d.date_prevue_retour, DATEDIFF(CURDATE(), d.date_prevue_retour) AS jours_retard, l.titre,
            e.id_utilisateur AS id_emprunteur, e.nom, e.prenom, e.email, e.telephone, e.actif, ${suspension}
            p.nom AS nom_proprietaire, p.prenom AS prenom_proprietaire
     FROM demande_pret d
     JOIN livre l ON l.id_livre = d.id_livre
     JOIN utilisateur e ON e.id_utilisateur = d.id_emprunteur
     JOIN utilisateur p ON p.id_utilisateur = l.id_proprietaire
     WHERE d.statut = 'acceptee' AND d.date_prevue_retour < CURDATE()
     ORDER BY d.date_prevue_retour ASC`
  );
  try {
    await leverSuspensionsExpirees();
    let rows;
    try {
      [rows] = await requete('e.suspendu_jusqu_au,');
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      [rows] = await requete('');
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// PATCH /api/admin/utilisateurs/:id/basculer (suspendre / réactiver)
// Corps facultatif pour suspendre : { duree: '1j' | '2j' | '3j' | '7j' | '14j' | '30j' | '90j' | '365j' | 'indefinie' }
async function basculerActivation(req, res) {
  try {
    const [rows] = await pool.execute('SELECT actif, role FROM utilisateur WHERE id_utilisateur = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    if (rows[0].role !== 'etudiant') return res.status(403).json({ message: 'Seuls les comptes étudiants peuvent être suspendus.' });

    // Réactivation (manuelle, avant la fin éventuelle de la suspension)
    if (!rows[0].actif) {
      try {
        await pool.execute('UPDATE utilisateur SET actif = 1, suspendu_jusqu_au = NULL WHERE id_utilisateur = ?', [req.params.id]);
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        await pool.execute('UPDATE utilisateur SET actif = 1 WHERE id_utilisateur = ?', [req.params.id]);
      }
      return res.json({ message: 'Compte réactivé.', actif: true, jusqu_au: null });
    }

    // Suspension : durée limitée ou illimitée
    const duree = (req.body && req.body.duree) || 'indefinie';
    if (duree !== 'indefinie' && !DUREES_JOURS[duree]) {
      return res.status(400).json({ message: 'Durée de suspension invalide.' });
    }
    const jusquAu = duree === 'indefinie' ? null : new Date(Date.now() + DUREES_JOURS[duree] * 24 * 3600 * 1000);
    try {
      await pool.execute('UPDATE utilisateur SET actif = 0, suspendu_jusqu_au = ? WHERE id_utilisateur = ?', [jusquAu, req.params.id]);
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      // Colonne absente (script SQL pas encore exécuté) : suspension sans limite de durée
      await pool.execute('UPDATE utilisateur SET actif = 0 WHERE id_utilisateur = ?', [req.params.id]);
    }
    res.json({ message: 'Compte suspendu.', actif: false, jusqu_au: jusquAu });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// DELETE /api/admin/utilisateurs/:id (suppression définitive d'un compte étudiant)
async function supprimerUtilisateur(req, res) {
  try {
    const [rows] = await pool.execute('SELECT nom, prenom, role FROM utilisateur WHERE id_utilisateur = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    if (rows[0].role !== 'etudiant') return res.status(403).json({ message: 'Seuls les comptes étudiants peuvent être supprimés.' });

    // On refuse tant qu'un prêt est en cours (le livre est chez quelqu'un)
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM demande_pret d JOIN livre l ON d.id_livre = l.id_livre
       WHERE d.statut = 'acceptee' AND (d.id_emprunteur = ? OR l.id_proprietaire = ?)`,
      [req.params.id, req.params.id]
    );
    if (nb > 0) {
      return res.status(409).json({ message: "Suppression impossible : cet étudiant a un prêt en cours (comme propriétaire ou emprunteur). Attendez le retour des livres, ou suspendez le compte." });
    }

    // Les livres, demandes, messages et notifications liés sont supprimés en cascade (clés étrangères)
    await pool.execute('DELETE FROM utilisateur WHERE id_utilisateur = ?', [req.params.id]);
    res.json({ message: 'Compte supprimé.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/admin/historique
async function historiqueGlobal(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT d.id_demande, l.titre, ue.nom AS emprunteur, up.nom AS proprietaire, ue.prenom AS emprunteur_prenom, up.prenom AS proprietaire_prenom, d.date_prevue_retour,
              d.date_demande, d.statut, d.date_reelle_retour, d.date_emprunt_reel
       FROM demande_pret d
       JOIN livre l ON d.id_livre = l.id_livre
       JOIN utilisateur ue ON d.id_emprunteur = ue.id_utilisateur
       JOIN utilisateur up ON l.id_proprietaire = up.id_utilisateur
       ORDER BY d.date_demande DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/admin/livres
async function listerLivres(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT l.id_livre, l.titre, l.auteur, l.disponibilite, l.etat_livre, l.image,
              u.nom AS proprietaire_nom, u.prenom AS proprietaire_prenom,
              c.nom_categorie,
              ue.nom AS emprunteur_nom, ue.prenom AS emprunteur_prenom, dp.date_prevue_retour, dp.date_emprunt_reel
       FROM livre l JOIN utilisateur u ON l.id_proprietaire = u.id_utilisateur
       LEFT JOIN categorie c ON l.id_categorie = c.id_categorie
       LEFT JOIN demande_pret dp ON dp.id_livre = l.id_livre AND dp.statut = 'acceptee'
       LEFT JOIN utilisateur ue ON dp.id_emprunteur = ue.id_utilisateur
       ORDER BY l.id_livre DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// DELETE /api/admin/livres/:id
async function supprimerLivre(req, res) {
  try {
    const [rows] = await pool.execute('SELECT titre, id_proprietaire, disponibilite FROM livre WHERE id_livre = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Livre introuvable.' });
    const livre = rows[0];

    const [[{ nb }]] = await pool.query("SELECT COUNT(*) AS nb FROM demande_pret WHERE id_livre = ? AND statut = 'acceptee'", [req.params.id]);
    if (livre.disponibilite !== 'disponible' || nb > 0) {
      return res.status(409).json({ message: "Impossible de supprimer un livre actuellement emprunté. Attendez son retour." });
    }

    // Informer les étudiants dont la demande était encore en attente, puis nettoyer les demandes liées
    const [enAttente] = await pool.execute("SELECT id_emprunteur FROM demande_pret WHERE id_livre = ? AND statut = 'en_attente'", [req.params.id]);
    await pool.execute('DELETE FROM demande_pret WHERE id_livre = ?', [req.params.id]);
    await pool.execute('DELETE FROM livre WHERE id_livre = ?', [req.params.id]);

    await notifier(livre.id_proprietaire, { type: 'admin', message: `Votre livre « ${livre.titre} » a été retiré de la plateforme par un administrateur.`, lien: '/mes-livres.html' });
    for (const d of enAttente) {
      await notifier(d.id_emprunteur, { type: 'admin', message: `Votre demande pour « ${livre.titre} » est annulée : le livre a été retiré de la plateforme.`, lien: '/mes-demandes.html' });
    }
    res.json({ message: 'Livre supprimé.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}


// ---------- Administrateurs ----------
// Crée un lien (48 h) pour choisir son mot de passe et l'envoie par e-mail. Retourne le lien si l'e-mail n'a pas pu partir.
async function inviter(utilisateur) {
  const { assurerTableReinit } = require('./authController');
  await assurerTableReinit();
  const token = crypto.randomBytes(32).toString('hex');
  await pool.execute('INSERT INTO reinitialisation_mdp (id_utilisateur, token, date_expiration) VALUES (?, ?, ?)', [utilisateur.id_utilisateur, token, new Date(Date.now() + 48 * 3600 * 1000)]);
  const libelle = utilisateur.role === 'scolarite' ? 'Scolarité' : 'Administrateur';
  const base = process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3000}`;
  const lien = `${base}/reset-password.html?token=${token}`;
  try {
    const r = await envoyerEmailInvitation(utilisateur.email, token, `${utilisateur.nom} ${utilisateur.prenom}`.trim(), libelle);
    return r.simule ? { envoye: false, lien } : { envoye: true };
  } catch (err) {
    console.error("Envoi de l'invitation impossible :", err.message);
    return { envoye: false, lien };
  }
}
async function renvoyerInvitation(req, res) {
  try {
    const [[u]] = await pool.query("SELECT id_utilisateur, nom, prenom, email, role FROM utilisateur WHERE id_utilisateur = ? AND role IN ('admin','scolarite')", [Number(req.params.id)]);
    if (!u) return res.status(404).json({ message: 'Compte introuvable.' });
    const r = await inviter(u);
    res.json({ message: r.envoye ? 'Invitation envoyée à ' + u.email + '.' : "L'e-mail n'a pas pu partir : copiez le lien ci-dessous.", ...r });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

async function listerAdmins(req, res) {
  try {
    await preparerTables();
    const [rows] = await pool.query("SELECT id_utilisateur, nom, prenom, email, role, departement, date_inscription FROM utilisateur WHERE role IN ('admin','scolarite') ORDER BY role, id_utilisateur");
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}
// Corps : { nom, prenom, email, mot_de_passe, role: 'admin' | 'scolarite' }
async function creerAdmin(req, res) {
  try {
    await preparerTables();
    const roleCompte = req.body.role === 'scolarite' ? 'scolarite' : 'admin';
    const nom = String(req.body.nom || '').trim().slice(0, 100), prenom = String(req.body.prenom || '').trim().slice(0, 100);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 150), mdp = String(req.body.mot_de_passe || '');
    const departementCompte = String(req.body.departement || '').trim().slice(0, 100) || null;
    if (!nom || !email) return res.status(400).json({ message: 'Le nom et l\'e-mail sont obligatoires.' });
    if (roleCompte === 'scolarite' && !departementCompte) return res.status(400).json({ message: 'Indiquez le département de ce compte scolarité (ex. ENI, ENS, DEGS).' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Adresse e-mail invalide.' });
    if (mdp && mdp.length < 8) return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    const [ex] = await pool.query('SELECT id_utilisateur FROM utilisateur WHERE email = ?', [email]);
    if (ex.length) return res.status(409).json({ message: 'Cette adresse e-mail est déjà utilisée.' });
    const invitation = !mdp; // pas de mot de passe saisi : invitation par e-mail
    const hash = await bcrypt.hash(mdp || crypto.randomBytes(24).toString('hex'), 10);
    const matricule = (roleCompte === 'scolarite' ? 'SCOL-' : 'ADMIN-') + Date.now().toString(36).toUpperCase();
    const [ins] = await pool.query("INSERT INTO utilisateur (matricule, nom, prenom, sexe, email, mot_de_passe, role, departement) VALUES (?, ?, ?, 'M', ?, ?, ?, ?)", [matricule, nom, prenom || '-', email, hash, roleCompte, roleCompte === 'scolarite' ? departementCompte : null]);
    const libelle = roleCompte === 'scolarite' ? 'Compte scolarité créé' : 'Administrateur créé';
    if (!invitation) return res.status(201).json({ message: libelle + '.' });
    const r = await inviter({ id_utilisateur: ins.insertId, nom, prenom, email, role: roleCompte });
    res.status(201).json({ message: libelle + (r.envoye ? '. Une invitation a été envoyée à ' + email + '.' : ". L'e-mail n'a pas pu partir : copiez le lien ci-dessous."), ...r });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}
async function supprimerAdmin(req, res) {
  try {
    const id = Number(req.params.id);
    if (id === req.utilisateur.id_utilisateur) return res.status(400).json({ message: 'Vous ne pouvez pas supprimer votre propre compte.' });
    const [[cible]] = await pool.query("SELECT role FROM utilisateur WHERE id_utilisateur = ? AND role IN ('admin','scolarite')", [id]);
    if (!cible) return res.status(404).json({ message: 'Compte introuvable.' });
    if (cible.role === 'admin') {
      const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM utilisateur WHERE role = 'admin'");
      if (n.n <= 1) return res.status(400).json({ message: 'Il doit rester au moins un administrateur.' });
    }
    const [r] = await pool.query("DELETE FROM utilisateur WHERE id_utilisateur = ? AND role IN ('admin','scolarite')", [id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Administrateur introuvable.' });
    res.json({ message: 'Administrateur supprimé.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Impossible de supprimer ce compte (il est lié à des données).' }); }
}

// ---------- Matricules autorisés ----------
async function listerMatricules(req, res) {
  try {
    await preparerTables();
    const [rows] = await pool.query(
      `SELECT m.matricule, m.nom_complet, m.ajoute_le, m.departement, m.annee,
              (SELECT COUNT(*) FROM utilisateur u WHERE UPPER(REPLACE(u.matricule, ' ', '')) COLLATE utf8mb4_unicode_ci = UPPER(REPLACE(m.matricule, ' ', '')) COLLATE utf8mb4_unicode_ci) AS inscrit
       FROM matricule_autorise m ORDER BY m.ajoute_le DESC, m.matricule ASC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

// Corps : { liste: "2024001\n2024002;Rabe Lala\n...", departement?, annee? } (une ligne par étudiant : matricule[;nom])
// Un matricule déjà présent est mis à jour (département / année) : c'est la réinscription.
async function importerMatricules(req, res, obligatoire) {
  try {
    await preparerTables();
    let departement = String(req.body.departement || '').trim().slice(0, 100) || null;
    if (req.utilisateur && req.utilisateur.role === 'scolarite') {
      const [[moi]] = await pool.query('SELECT departement FROM utilisateur WHERE id_utilisateur = ?', [req.utilisateur.id_utilisateur]);
      if (moi && moi.departement) departement = moi.departement; // un compte scolarité n'importe que pour son département
    }
    const annee = String(req.body.annee || '').trim().slice(0, 9) || null;
    if (obligatoire && (!departement || !annee)) return res.status(400).json({ message: "Indiquez le département et l'année universitaire (ex. 2026-2027)." });
    const lignes = String(req.body.liste || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.replace(/"/g, '').trim()).filter(l => l && !/^[:;,\t\s]*$/.test(l)).slice(0, 5000);
    let ajoutes = 0, misAJour = 0;
    for (const ligne of lignes) {
      const [mat, ...reste] = ligne.split(/[:;,\t]/);
      const matricule = (mat || '').trim().slice(0, 50);
      if (!matricule || /^matricule$/i.test(matricule)) continue;
      const nom = reste.join(' ').trim().slice(0, 150) || null;
      const [r] = await pool.execute(
        `INSERT INTO matricule_autorise (matricule, nom_complet, departement, annee, ajoute_par) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE nom_complet = COALESCE(VALUES(nom_complet), nom_complet),
           departement = COALESCE(VALUES(departement), departement), annee = COALESCE(VALUES(annee), annee), ajoute_par = VALUES(ajoute_par)`,
        [matricule, nom, departement, annee, req.utilisateur.id_utilisateur]);
      if (r.affectedRows === 1) ajoutes++; else if (r.affectedRows === 2) misAJour++;
    }
    res.json({ message: `${ajoutes} matricule(s) ajouté(s), ${misAJour} mis à jour.`, ajoutes, mis_a_jour: misAJour });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}
const ajouterMatricules = (req, res) => importerMatricules(req, res, false);
const importerParScolarite = (req, res) => importerMatricules(req, res, true);

// Fin d'année : étudiants dont le matricule n'est PAS dans la liste de l'année universitaire choisie
async function candidatsFinAnnee(annee) {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM matricule_autorise WHERE annee = ?', [annee]);
  if (!n) return { total_liste: 0, candidats: [] };
  const [rows] = await pool.query(
    `SELECT u.id_utilisateur, u.matricule, u.nom, u.prenom, u.email,
            (SELECT COUNT(*) FROM demande_pret d JOIN livre l ON d.id_livre = l.id_livre
              WHERE d.statut = 'acceptee' AND (d.id_emprunteur = u.id_utilisateur OR l.id_proprietaire = u.id_utilisateur)) AS nb_en_cours
       FROM utilisateur u
      WHERE u.role = 'etudiant' AND u.actif = 1
        AND NOT EXISTS (SELECT 1 FROM matricule_autorise m WHERE CONVERT(m.matricule USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(u.matricule USING utf8mb4) COLLATE utf8mb4_unicode_ci AND m.annee = ?)
      ORDER BY u.nom, u.prenom`, [annee]);
  return { total_liste: n, candidats: rows };
}
async function apercuFinAnnee(req, res) {
  try {
    await preparerTables();
    const [an] = await pool.query("SELECT DISTINCT annee FROM matricule_autorise WHERE annee IS NOT NULL AND annee <> '' ORDER BY annee DESC");
    const annees = an.map(r => r.annee);
    const annee = String(req.query.annee || annees[0] || '').trim();
    if (!annee) return res.json({ annees, annee: null, total_liste: 0, candidats: [] });
    res.json({ annees, annee, ...(await candidatsFinAnnee(annee)) });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}
async function suspendreFinAnnee(req, res) {
  try {
    const annee = String(req.body.annee || '').trim();
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    if (!annee || !ids.length) return res.status(400).json({ message: 'Aucun étudiant sélectionné.' });
    const { total_liste, candidats } = await candidatsFinAnnee(annee);
    if (!total_liste) return res.status(400).json({ message: "Aucune liste n'existe pour cette année universitaire." });
    // Sécurité : seulement ceux qui ne sont pas dans la liste ET sans prêt en cours (recalculé côté serveur)
    const ok = candidats.filter(x => ids.includes(x.id_utilisateur) && x.nb_en_cours === 0).map(x => x.id_utilisateur);
    if (ok.length) await pool.query('UPDATE utilisateur SET actif = 0, suspendu_jusqu_au = NULL WHERE id_utilisateur IN (?)', [ok]);
    res.json({ message: ok.length + ' compte(s) suspendu(s).' + (ok.length < ids.length ? ' ' + (ids.length - ok.length) + ' ignoré(s) (prêt en cours ou déjà dans la liste).' : ''), suspendus: ok.length });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

// Scolarité : son département (verrouillé par l'administration)
async function monDepartement(req, res) {
  try {
    await preparerTables();
    const [[u]] = await pool.query('SELECT departement FROM utilisateur WHERE id_utilisateur = ?', [req.utilisateur.id_utilisateur]);
    res.json({ departement: (u && u.departement) || null });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

// Scolarité : ses propres imports (l'admin voit tout)
async function listerMatriculesScolarite(req, res) {
  try {
    await preparerTables();
    const admin = req.utilisateur.role === 'admin';
    const [rows] = await pool.query(
      `SELECT matricule, nom_complet, departement, annee, ajoute_le FROM matricule_autorise
       ${admin ? '' : 'WHERE ajoute_par = ?'} ORDER BY ajoute_le DESC, matricule ASC LIMIT 5000`, admin ? [] : [req.utilisateur.id_utilisateur]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}
async function retirerMatriculeScolarite(req, res) {
  try {
    const admin = req.utilisateur.role === 'admin';
    const [r] = await pool.query(`DELETE FROM matricule_autorise WHERE matricule = ? ${admin ? '' : 'AND ajoute_par = ?'}`, admin ? [req.params.matricule] : [req.params.matricule, req.utilisateur.id_utilisateur]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Matricule introuvable ou ajouté par quelqu\'un d\'autre.' });
    res.json({ message: 'Matricule retiré de la liste.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

// PUT /api/admin/matricules/:matricule { matricule, nom_complet } : corrige une ligne de la liste (fautes de frappe)
async function modifierMatricule(req, res) {
  try {
    await preparerTables();
    const nouveau = String((req.body || {}).matricule || '').trim().slice(0, 50);
    const nom = String((req.body || {}).nom_complet || '').replace(/\s+/g, ' ').trim().slice(0, 150) || null;
    if (!nouveau) return res.status(400).json({ message: 'Le matricule ne peut pas être vide.' });
    const [r] = await pool.query('UPDATE matricule_autorise SET matricule = ?, nom_complet = ? WHERE matricule = ?', [nouveau, nom, req.params.matricule]);
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Matricule introuvable.' });
    res.json({ message: 'Matricule modifié.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ce matricule existe déjà dans la liste.' });
    console.error(err); res.status(500).json({ message: 'Erreur serveur.' });
  }
}

async function supprimerMatricule(req, res) {
  try {
    await preparerTables();
    await pool.query('DELETE FROM matricule_autorise WHERE matricule = ?', [req.params.matricule]);
    res.json({ message: 'Matricule retiré de la liste.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

// ---------- Signalements de messages ----------
// L'administrateur ne lit PAS toutes les conversations : il voit seulement les messages signalés, avec un court contexte.
async function listerSignalements(req, res) {
  try {
    await preparerTables();
    const [rows] = await pool.query(
      `SELECT s.id_signalement, s.id_message, s.motif, s.commentaire, s.statut, s.date_signalement,
              s.id_signaleur, s.id_signale, s.automatique,
              a.nom AS nom_signaleur, a.prenom AS prenom_signaleur,
              b.nom AS nom_signale, b.prenom AS prenom_signale, b.actif AS actif_signale,
              m.contenu, m.id_expediteur, m.id_destinataire, m.date_envoi
       FROM signalement_message s
       JOIN message m ON m.id_message = s.id_message
       JOIN utilisateur a ON a.id_utilisateur = s.id_signaleur
       JOIN utilisateur b ON b.id_utilisateur = s.id_signale
       ORDER BY (s.statut = 'ouvert') DESC, s.date_signalement DESC
       LIMIT 200`
    );
    for (const r of rows) {
      const [ctx] = await pool.execute(
        `SELECT id_expediteur, contenu, date_envoi FROM message
         WHERE ((id_expediteur = ? AND id_destinataire = ?) OR (id_expediteur = ? AND id_destinataire = ?))
           AND id_message <= ? ORDER BY id_message DESC LIMIT 5`,
        [r.id_expediteur, r.id_destinataire, r.id_destinataire, r.id_expediteur, r.id_message]
      );
      r.contexte = ctx.reverse();
    }
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

async function traiterSignalement(req, res) {
  try {
    await preparerTables();
    await pool.query("UPDATE signalement_message SET statut = 'traite' WHERE id_signalement = ?", [req.params.id]);
    res.json({ message: 'Signalement marqué comme traité.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Erreur serveur.' }); }
}

module.exports = { apercuFinAnnee, suspendreFinAnnee, monDepartement, renvoyerInvitation, modifierMatricule, importerParScolarite, listerMatriculesScolarite, retirerMatriculeScolarite, listerAdmins, creerAdmin, supprimerAdmin,
  listerMatricules, ajouterMatricules, supprimerMatricule, listerSignalements, traiterSignalement,
  listerRetards, statistiques, listerUtilisateurs, ficheUtilisateur, basculerActivation, supprimerUtilisateur, historiqueGlobal, supprimerLivre, listerLivres };
