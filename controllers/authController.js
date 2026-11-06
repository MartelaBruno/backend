const bcrypt = require('bcrypt');
const { evaluer: evaluerSuspension, messageSuspension } = require('../utils/suspension');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { matriculeAutorise, preparerTables } = require('../utils/securite');
const pool = require('../config/db');
const { envoyerEmailReinitialisation, envoyerCodeVerification } = require('../utils/mailer');
require('dotenv').config();

// POST /api/auth/inscription
// Inscriptions en attente de vérification par code (OTP), gardées en mémoire.
// Elles sont perdues si le serveur redémarre : l'étudiant recommence simplement l'inscription.
const inscriptionsEnAttente = new Map();
const DUREE_CODE_MS = 10 * 60 * 1000;
const DELAI_RENVOI_MS = 30 * 1000;
const MAX_TENTATIVES = 5;

const hacherCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const nouveauCode = () => String(crypto.randomInt(100000, 1000000));
const cle = (email) => String(email || '').trim().toLowerCase();

function oublierInscription(email) {
  inscriptionsEnAttente.delete(email);
}

function nettoyerExpirees() {
  const maintenant = Date.now();
  for (const [k, v] of inscriptionsEnAttente) if (v.expire < maintenant) oublierInscription(k);
}

// POST /api/auth/inscription : valide les données, envoie un code par e-mail (le compte n'est pas encore créé)
async function inscription(req, res) {
  const rejeter = (code, message) => res.status(code).json({ message });
  try {
    const { matricule, nom, prenom, sexe, email, mot_de_passe, filiere, niveau_etude, telephone } = req.body;

    if (!matricule || !nom || !prenom || !sexe || !email || !mot_de_passe) {
      return rejeter(400, 'Veuillez remplir tous les champs obligatoires.');
    }

    // Sécurité : le matricule (et le nom) doit figurer dans la liste officielle de l'établissement,
    // gérée par l'administrateur. Un compte ne peut donc être créé que par un vrai étudiant.
    await preparerTables();
    try {
      const verif = await matriculeAutorise(matricule, `${nom} ${prenom}`);
      if (!verif.autorise) {
        if (verif.raison === 'liste_vide') {
          return rejeter(403, "Les inscriptions ne sont pas encore ouvertes : l'administrateur n'a pas encore renseigné la liste des étudiants de l'établissement.");
        }
        return rejeter(403, "Votre matricule et votre nom ne correspondent pas à la liste des étudiants de l'établissement. Vérifiez-les (nom et prénom comme sur votre carte), ou contactez l'administrateur.");
      }
    } catch (err) {
      // En cas de panne de la base, on refuse plutôt que de laisser passer n'importe qui
      console.error('Vérification du matricule impossible :', err.message);
      return rejeter(503, 'Vérification impossible pour le moment. Réessayez dans un instant.');
    }

    const [existants] = await pool.execute(
      'SELECT id_utilisateur FROM utilisateur WHERE matricule = ? OR email = ?',
      [matricule, email]
    );
    if (existants.length > 0) {
      return rejeter(409, 'Ce matricule ou cet email est déjà utilisé.');
    }

    nettoyerExpirees();
    oublierInscription(cle(email));
    const hash = await bcrypt.hash(mot_de_passe, 10);
    const code = nouveauCode();
    inscriptionsEnAttente.set(cle(email), {
      donnees: { matricule, nom, prenom, sexe, email, hash, filiere: filiere || null, niveau_etude: niveau_etude || null, telephone: telephone || null },
      codeHache: hacherCode(code),
      expire: Date.now() + DUREE_CODE_MS,
      tentatives: 0,
      dernierEnvoi: Date.now()
    });

    let resultat;
    try {
      resultat = await envoyerCodeVerification(email, code, `${nom} ${prenom}`);
    } catch (err) {
      oublierInscription(cle(email));
      console.error('Envoi du code impossible :', err.message);
      return rejeter(502, "Impossible d'envoyer l'e-mail de vérification. Vérifiez l'adresse saisie puis réessayez.");
    }

    // En mode local (SMTP non configuré), le code est aussi renvoyé pour faciliter les tests
    res.json({ verification: true, email, message: 'Un code de vérification vient de vous être envoyé.', ...(resultat.simule ? { code_local: code } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de l\'inscription.' });
  }
}

// POST /api/auth/inscription/verifier : contrôle le code puis crée réellement le compte
async function verifierInscription(req, res) {
  try {
    const email = cle(req.body.email);
    const code = String(req.body.code || '').trim();
    const attente = inscriptionsEnAttente.get(email);

    if (!attente || attente.expire < Date.now()) {
      oublierInscription(email);
      return res.status(410).json({ message: 'Le code a expiré. Recommencez votre inscription.' });
    }
    if (attente.tentatives >= MAX_TENTATIVES) {
      oublierInscription(email);
      return res.status(429).json({ message: 'Trop de tentatives. Recommencez votre inscription.' });
    }
    if (!/^\d{6}$/.test(code) || hacherCode(code) !== attente.codeHache) {
      attente.tentatives++;
      const restantes = MAX_TENTATIVES - attente.tentatives;
      return res.status(400).json({ message: `Code incorrect. Il vous reste ${restantes} essai(s).` });
    }

    const d = attente.donnees;
    const [existants] = await pool.execute('SELECT id_utilisateur FROM utilisateur WHERE matricule = ? OR email = ?', [d.matricule, d.email]);
    if (existants.length > 0) {
      oublierInscription(email);
      return res.status(409).json({ message: 'Ce matricule ou cet email est déjà utilisé.' });
    }

    await pool.execute(
      `INSERT INTO utilisateur (matricule, nom, prenom, sexe, email, mot_de_passe, filiere, niveau_etude, telephone, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'etudiant')`,
      [d.matricule, d.nom, d.prenom, d.sexe, d.email, d.hash, d.filiere, d.niveau_etude, d.telephone]
    );
    inscriptionsEnAttente.delete(email);
    res.status(201).json({ message: 'Compte créé avec succès.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la vérification.' });
  }
}

// POST /api/auth/inscription/renvoyer : envoie un nouveau code
async function renvoyerCodeInscription(req, res) {
  try {
    const email = cle(req.body.email);
    const attente = inscriptionsEnAttente.get(email);
    if (!attente || attente.expire < Date.now()) {
      inscriptionsEnAttente.delete(email);
      return res.status(410).json({ message: 'Votre demande a expiré. Recommencez votre inscription.' });
    }
    const attendre = DELAI_RENVOI_MS - (Date.now() - attente.dernierEnvoi);
    if (attendre > 0) {
      return res.status(429).json({ message: `Patientez ${Math.ceil(attendre / 1000)} seconde(s) avant de redemander un code.` });
    }
    const code = nouveauCode();
    attente.codeHache = hacherCode(code);
    attente.expire = Date.now() + DUREE_CODE_MS;
    attente.tentatives = 0;
    attente.dernierEnvoi = Date.now();
    let resultat;
    try { resultat = await envoyerCodeVerification(attente.donnees.email, code, `${attente.donnees.nom} ${attente.donnees.prenom}`); }
    catch (err) { return res.status(502).json({ message: "Impossible d'envoyer l'e-mail. Réessayez dans un instant." }); }
    res.json({ message: 'Un nouveau code vient de vous être envoyé.', ...(resultat.simule ? { code_local: code } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// POST /api/auth/connexion
async function connexion(req, res) {
  try {
    const { email, mot_de_passe } = req.body;

    const [rows] = await pool.execute(
      'SELECT * FROM utilisateur WHERE email = ?',
      [email]
    );
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    const utilisateur = rows[0];
    if (!utilisateur.actif) {
      // Suspension temporaire : si la date est dépassée, le compte est réactivé automatiquement
      const statut = await evaluerSuspension(utilisateur.id_utilisateur, utilisateur);
      if (!statut.actif) {
        return res.status(403).json({ message: messageSuspension(statut.jusquAu) });
      }
    }

    const motDePasseValide = await bcrypt.compare(mot_de_passe, utilisateur.mot_de_passe);
    if (!motDePasseValide) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    const token = jwt.sign(
      { id_utilisateur: utilisateur.id_utilisateur, role: utilisateur.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      token,
      utilisateur: {
        id_utilisateur: utilisateur.id_utilisateur,
        nom: utilisateur.nom,
        prenom: utilisateur.prenom,
        email: utilisateur.email,
        role: utilisateur.role,
        sexe: utilisateur.sexe,
        photo_profil: utilisateur.photo_profil || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la connexion.' });
  }
}

// Crée la table des liens de réinitialisation si elle n'existe pas encore
let tableReinitPrete = false;
async function assurerTableReinit() {
  if (tableReinitPrete) return;
  await pool.execute(`CREATE TABLE IF NOT EXISTS reinitialisation_mdp (
    id_token INT AUTO_INCREMENT PRIMARY KEY,
    id_utilisateur INT NOT NULL,
    token VARCHAR(128) NOT NULL,
    date_expiration DATETIME NOT NULL,
    utilise BOOLEAN NOT NULL DEFAULT FALSE,
    date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_token (token),
    INDEX idx_utilisateur (id_utilisateur)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  tableReinitPrete = true;
}

// POST /api/auth/mot-de-passe-oublie
async function motDePasseOublie(req, res) {
  try {
    const email = String((req.body || {}).email || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Adresse e-mail invalide.' });
    await assurerTableReinit();

    const [rows] = await pool.execute('SELECT id_utilisateur, nom, prenom FROM utilisateur WHERE email = ?', [email]);

    // Message générique dans tous les cas (sécurité : ne pas révéler si l'email existe)
    if (rows.length > 0) {
      const idUtilisateur = rows[0].id_utilisateur;
      const token = crypto.randomBytes(32).toString('hex');
      const dateExpiration = new Date(Date.now() + 60 * 60 * 1000); // + 1 heure

      await pool.execute(
        'INSERT INTO reinitialisation_mdp (id_utilisateur, token, date_expiration) VALUES (?, ?, ?)',
        [idUtilisateur, token, dateExpiration]
      );

      let lienDev = null;
      try {
        const resultat = await envoyerEmailReinitialisation(email, token, `${rows[0].nom} ${rows[0].prenom}`);
        if (resultat && resultat.simule) lienDev = `/reset-password.html?token=${token}`;
      } catch (errMail) {
        // L'envoi a échoué : on le trace (avec le lien) sans casser la réponse
        console.error('Envoi de l\'e-mail impossible :', errMail.message);
        console.log('Lien de réinitialisation (secours) : ' + (process.env.FRONTEND_URL || 'http://localhost:' + (process.env.PORT || 3000)) + '/reset-password.html?token=' + token);
        lienDev = `/reset-password.html?token=${token}`;
      }
      // Mode local uniquement : si l'e-mail n'a pas pu partir et que la demande vient de CETTE machine
      // (jamais depuis Internet), on affiche le lien directement pour pouvoir tester / présenter le projet.
      const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '');
      const demandeLocale = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip);
      if (lienDev && demandeLocale) {
        return res.json({ message: 'Si un compte correspond à cet email, un lien de réinitialisation a été envoyé.', lien_dev: lienDev });
      }
    }

    res.json({ message: 'Si un compte correspond à cet email, un lien de réinitialisation a été envoyé.' });
  } catch (err) {
    console.error('Mot de passe oublié :', err.sqlMessage || err.message || err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// POST /api/auth/reinitialiser-mot-de-passe
async function reinitialiserMotDePasse(req, res) {
  try {
    const { token, nouveau_mot_de_passe } = req.body;
    if (typeof nouveau_mot_de_passe !== 'string' || nouveau_mot_de_passe.length < 6) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    await assurerTableReinit();

    const [rows] = await pool.execute(
      `SELECT * FROM reinitialisation_mdp
       WHERE token = ? AND utilise = FALSE AND date_expiration > NOW()`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'Lien invalide ou expiré. Veuillez recommencer.' });
    }

    const reinit = rows[0];
    const hash = await bcrypt.hash(nouveau_mot_de_passe, 10);

    await pool.execute('UPDATE utilisateur SET mot_de_passe = ? WHERE id_utilisateur = ?', [hash, reinit.id_utilisateur]);
    await pool.execute('UPDATE reinitialisation_mdp SET utilise = TRUE WHERE id_token = ?', [reinit.id_token]);

    res.json({ message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/auth/profil (utilisateur connecté)
async function obtenirProfil(req, res) {
  try {
    // SELECT * : le profil se charge même si une colonne optionnelle (photo, téléphone…) n'existe pas encore en base
    const [rows] = await pool.execute('SELECT * FROM utilisateur WHERE id_utilisateur = ?', [req.utilisateur.id_utilisateur]);
    if (rows.length === 0) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const u = rows[0];
    res.json({
      id_utilisateur: u.id_utilisateur, matricule: u.matricule, nom: u.nom, prenom: u.prenom,
      sexe: u.sexe || 'M', email: u.email, filiere: u.filiere || null, niveau_etude: u.niveau_etude || null,
      telephone: u.telephone || null, photo_profil: u.photo_profil || null,
      role: u.role, date_inscription: u.date_inscription
    });
  } catch (err) {
    console.error('Erreur obtenirProfil :', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// PUT /api/auth/profil (utilisateur connecté)
async function modifierProfil(req, res) {
  try {
    const { nom, prenom, sexe, filiere, niveau_etude, telephone, supprimer_avatar } = req.body;

    if (!nom || !prenom || !sexe) {
      return res.status(400).json({ message: 'Nom, prénom et sexe sont obligatoires.' });
    }

    const avatar = req.files?.avatar?.[0] ? `/uploads/${req.files.avatar[0].filename}` : null;

    const champs = ['nom = ?', 'prenom = ?', 'sexe = ?', 'filiere = ?', 'niveau_etude = ?', 'telephone = ?'];
    const valeurs = [nom, prenom, sexe, filiere || null, niveau_etude || null, telephone || null];

    if (avatar) { champs.push('photo_profil = ?'); valeurs.push(avatar); }
    else if (supprimer_avatar === '1') {
      // Suppression de la photo : on vide la colonne et on efface le fichier du disque
      try {
        const [anc] = await pool.execute('SELECT photo_profil FROM utilisateur WHERE id_utilisateur = ?', [req.utilisateur.id_utilisateur]);
        const chemin = anc[0] && anc[0].photo_profil;
        if (chemin && chemin.startsWith('/uploads/')) {
          require('fs').unlink(require('path').join(__dirname, '..', 'uploads', require('path').basename(chemin)), () => {});
        }
      } catch (e) { /* sans gravité */ }
      champs.push('photo_profil = ?'); valeurs.push(null);
    }

    valeurs.push(req.utilisateur.id_utilisateur);

    await pool.execute(`UPDATE utilisateur SET ${champs.join(', ')} WHERE id_utilisateur = ?`, valeurs);

    res.json({ message: supprimer_avatar === '1' && !avatar ? 'Photo de profil supprimée.' : 'Profil mis à jour avec succès.', photo_profil: avatar });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// PUT /api/auth/profil/mot-de-passe (utilisateur connecté)
async function changerMotDePasse(req, res) {
  try {
    const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body;

    const [rows] = await pool.execute('SELECT mot_de_passe FROM utilisateur WHERE id_utilisateur = ?', [req.utilisateur.id_utilisateur]);
    if (rows.length === 0) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const motDePasseValide = await bcrypt.compare(ancien_mot_de_passe, rows[0].mot_de_passe);
    if (!motDePasseValide) {
      return res.status(401).json({ message: "L'ancien mot de passe est incorrect." });
    }

    const hash = await bcrypt.hash(nouveau_mot_de_passe, 10);
    await pool.execute('UPDATE utilisateur SET mot_de_passe = ? WHERE id_utilisateur = ?', [hash, req.utilisateur.id_utilisateur]);

    res.json({ message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { assurerTableReinit, inscription, verifierInscription, renvoyerCodeInscription, connexion, motDePasseOublie, reinitialiserMotDePasse, obtenirProfil, modifierProfil, changerMotDePasse };

