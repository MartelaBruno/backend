// Tables et vérifications de sécurité : matricules autorisés et signalements de messages.
// Les tables sont créées automatiquement au premier usage (aucune migration SQL à lancer).
const pool = require('../config/db');

let pret = null;
function preparerTables() {
  if (!pret) {
    pret = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS matricule_autorise (
        matricule VARCHAR(50) NOT NULL PRIMARY KEY,
        nom_complet VARCHAR(150) NULL,
        ajoute_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4`);
      await pool.query(`CREATE TABLE IF NOT EXISTS signalement_message (
        id_signalement INT AUTO_INCREMENT PRIMARY KEY,
        id_message INT NOT NULL,
        id_signaleur INT NOT NULL,
        id_signale INT NOT NULL,
        motif VARCHAR(40) NOT NULL,
        commentaire VARCHAR(300) NULL,
        statut ENUM('ouvert','traite') NOT NULL DEFAULT 'ouvert',
        date_signalement TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY un_signalement (id_message, id_signaleur)
      ) CHARACTER SET utf8mb4`);
      const colonne = async (table, nom, definition) => {
        const [c] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [nom]);
        if (c.length === 0) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${nom} ${definition}`);
      };
      await colonne('signalement_message', 'automatique', 'TINYINT(1) NOT NULL DEFAULT 0');
      // Listes fournies par la scolarité : département, année universitaire et auteur de l'import
      await colonne('matricule_autorise', 'departement', 'VARCHAR(100) NULL');
      await colonne('matricule_autorise', 'annee', 'VARCHAR(9) NULL');
      await colonne('matricule_autorise', 'ajoute_par', 'INT NULL');
      // Département rattaché à un compte scolarité (ENI, ENS, DEGS…)
      await colonne('utilisateur', 'departement', 'VARCHAR(100) NULL');
      // Plateforme d'un seul établissement : il n'y a plus de rôle « super_admin » (ses comptes deviennent « admin »).
      const [[role]] = await pool.query("SHOW COLUMNS FROM utilisateur LIKE 'role'");
      if (role && /super_admin/.test(role.Type)) {
        await pool.query("UPDATE utilisateur SET role = 'admin' WHERE role = 'super_admin'");
      }
      // Rôles : étudiant, admin (bibliothèque) et scolarité (import des listes de matricules uniquement)
      if (role && !/scolarite/.test(role.Type)) {
        await pool.query("ALTER TABLE utilisateur MODIFY COLUMN role ENUM('etudiant','admin','scolarite') NOT NULL DEFAULT 'etudiant'");
      }
    })().catch((err) => { pret = null; throw err; });
  }
  return pret;
}

function normaliser(m) {
  return String(m || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Mots d'un nom (sans accents, minuscules) pour comparer « Rabe Lala » et « LALA rabe »
function motsDuNom(texte) {
  return String(texte || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
// Le nom saisi est accepté si tous ses mots figurent dans le nom de la liste (ordre indifférent)
function nomCorrespond(saisi, liste) {
  const motsListe = motsDuNom(liste);
  const motsSaisis = motsDuNom(saisi);
  return motsSaisis.length > 0 && motsSaisis.every((m) => motsListe.includes(m));
}

// Sécurité : seuls les étudiants figurant dans la liste officielle de l'établissement (matricule ET nom, si la liste
// contient le nom) peuvent créer un compte. L'administrateur gère cette liste (Admin → Matricules).
// Liste vide = inscriptions fermées, sauf si INSCRIPTION_LIBRE=1 dans le fichier .env (réservé aux tests).
async function matriculeAutorise(matricule, nomSaisi) {
  await preparerTables();
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM matricule_autorise');
  if (total === 0) {
    if (process.env.INSCRIPTION_LIBRE === '1') return { controle: false, autorise: true };
    return { controle: true, autorise: false, raison: 'liste_vide' };
  }
  const [rows] = await pool.execute('SELECT nom_complet FROM matricule_autorise WHERE UPPER(REPLACE(matricule, " ", "")) COLLATE utf8mb4_unicode_ci = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [normaliser(matricule)]);
  if (rows.length === 0) return { controle: true, autorise: false };
  const nomListe = rows[0].nom_complet;
  if (!nomListe) return { controle: true, autorise: true };            // la liste n'a pas de nom pour ce matricule
  return { controle: true, autorise: nomCorrespond(nomSaisi, nomListe), raison: 'nom' };
}

const MOTIFS = {
  harcelement: 'Harcèlement ou insultes',
  sentimental: 'Propos amoureux ou déplacés',
  spam: 'Spam ou publicité',
  arnaque: 'Arnaque ou demande d\'argent',
  autre: 'Autre'
};

// Détection automatique : si un message contient un de ces mots, un signalement « automatique » est créé pour l'administrateur.
// Le message n'est PAS bloqué. Pour ajouter ou retirer un mot, modifier simplement cette liste.
const MOTS_SENSIBLES = [
  "je t'aime", "j'adore", 'cheri', 'cherie', 'mon coeur', 'sortir avec moi', 'tu me plais',
  'petit ami', 'petite amie', 'bisous', 'crush',
  'tiako ianao', 'tia anao', 'fitiavana', 'mpitia'
];

function contientMotSensible(texte) {
  const t = ' ' + String(texte || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`]/g, "'").replace(/œ/g, 'oe') + ' ';
  return MOTS_SENSIBLES.some((mot) => new RegExp("(^|[^a-z0-9])" + mot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "([^a-z0-9]|$)").test(t));
}

// ---- Détection automatique par catégorie (le message n'est jamais bloqué : l'administrateur décide) ----
const MOTS_PAR_MOTIF = {
  harcelement: [
    'je vais te tuer', 'je vais te frapper', 'je vais te casser', 'je te tuerai', 'tu vas mourir', 'tu vas le regretter',
    'fils de pute', 'connard', 'connasse', 'salope', 'enfoire', 'ferme ta gueule', 'ta gueule', 'idiot', 'idiote', 'imbecile', 'debile',
    'mamono anao', 'hamono anao', 'hamely anao', 'ho faty ianao', 'adala', 'kamo', 'bobo'
  ],
  arnaque: [
    "envoie de l'argent", 'envoie moi de l argent', "envoyer de l'argent", "envoie-moi de l'argent", "donne moi de l'argent", "donne-moi de l'argent",
    'mvola', 'orange money', 'airtel money', 'western union', 'transfert d argent', "transfert d'argent",
    'gagner de l argent', "gagner de l'argent", 'gagne de l argent', "gagne de l'argent", 'investir', 'investissement',
    'alefaso vola', 'omeo vola', 'mandoa vola', 'andefaso vola', 'hahazo vola', 'vola maimaim-poana'
  ],
  spam: [
    'cliquez ici', 'clique ici', 'cliquez sur le lien', 'abonne toi', 'abonnez vous', 'promo', 'promotion', 'publicite', 'offre exclusive',
    'telecharge', 'telechargez', 'ampidino ny rohy', 'tsindrio eto'
  ]
};

function nettoyerTexte(texte) {
  return ' ' + String(texte || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`]/g, "'").replace(/œ/g, 'oe').replace(/-/g, ' ') + ' ';
}

function contientMot(t, mot) {
  const m = mot.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' ');
  return new RegExp('(^|[^a-z0-9])' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t);
}

// Retourne le motif ('harcelement' | 'arnaque' | 'spam' | 'sentimental') ou null. Priorité : le plus grave d'abord.
function detecterMotif(texte) {
  const t = nettoyerTexte(texte);
  for (const motif of ['harcelement', 'arnaque']) {
    if (MOTS_PAR_MOTIF[motif].some((mot) => contientMot(t, mot))) return motif;
  }
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|mg|xyz|ru|cc|me|ly)\b)/.test(t)) return 'spam';
  if (MOTS_PAR_MOTIF.spam.some((mot) => contientMot(t, mot))) return 'spam';
  if (contientMotSensible(texte)) return 'sentimental';
  return null;
}

module.exports = { detecterMotif, nomCorrespond, contientMotSensible, preparerTables, matriculeAutorise, normaliser, MOTIFS };
