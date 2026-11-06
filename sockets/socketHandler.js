const { detecterMotif, preparerTables } = require('../utils/securite');
const { ontUneDemande, MESSAGE_SANS_DEMANDE } = require('../utils/messagerie');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

// Associe chaque id_utilisateur au(x) socket(s) actuellement connecté(s)
const utilisateursConnectes = new Map();
const LONGUEUR_MAX_MESSAGE = 1000;
const MESSAGES_MAX_PAR_MINUTE = 20;

let ioInstance = null;

// Envoie un événement à toutes les connexions (onglets) d'un utilisateur
function emettreVersUtilisateur(idUtilisateur, evenement, donnees) {
  if (ioInstance) ioInstance.to(`user:${idUtilisateur}`).emit(evenement, donnees);
}

function initialiserSocket(io) {
  ioInstance = io;

  // Middleware : vérifie le token JWT envoyé par le client lors de la connexion socket
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentification requise.'));

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) return next(new Error('Token invalide.'));
      socket.utilisateur = decoded; // { id_utilisateur, role }
      next();
    });
  });

  io.on('connection', (socket) => {
    const idUtilisateur = socket.utilisateur.id_utilisateur;
    utilisateursConnectes.set(idUtilisateur, socket.id);
    socket.join(`user:${idUtilisateur}`);
    console.log(`Utilisateur ${idUtilisateur} connecté (socket ${socket.id})`);

    // Le client envoie un message : { destinataire, contenu }
    let envoisRecents = [];
    socket.on('envoyer_message', async ({ destinataire, contenu } = {}) => {
      try {
        // Contrôles côté serveur : type, longueur et cadence (anti-spam)
        if (typeof contenu !== 'string') return;
        contenu = contenu.trim();
        if (!destinataire || !contenu) return;
        if (contenu.length > LONGUEUR_MAX_MESSAGE) {
          socket.emit('erreur_message', { message: `Message trop long (${LONGUEUR_MAX_MESSAGE} caractères maximum).` });
          return;
        }
        const maintenant = Date.now();
        envoisRecents = envoisRecents.filter(t => maintenant - t < 60000);
        if (envoisRecents.length >= MESSAGES_MAX_PAR_MINUTE) {
          socket.emit('erreur_message', { message: 'Vous envoyez trop de messages. Patientez un instant.' });
          return;
        }
        envoisRecents.push(maintenant);
        if (Number(destinataire) === idUtilisateur) return;
        // Messagerie réservée aux échanges entre étudiants : ni l'expéditeur ni le destinataire ne peut être administrateur
        if (socket.utilisateur.role !== 'etudiant') {
          socket.emit('erreur_message', { message: "La messagerie est réservée aux étudiants." });
          return;
        }
        const [dest] = await pool.execute("SELECT id_utilisateur FROM utilisateur WHERE id_utilisateur = ? AND actif = 1 AND role = 'etudiant'", [destinataire]);
        if (dest.length === 0) return;
        // Messagerie réservée à la remise des livres : il faut une demande de prêt entre les deux étudiants
        if (!(await ontUneDemande(idUtilisateur, Number(destinataire)))) {
          socket.emit('erreur_message', { message: MESSAGE_SANS_DEMANDE });
          return;
        }

        const [result] = await pool.execute(
          'INSERT INTO message (id_expediteur, id_destinataire, contenu) VALUES (?, ?, ?)',
          [idUtilisateur, destinataire, contenu.trim()]
        );

        // Détection automatique (harcèlement, arnaque, spam, propos amoureux) : signalement pour l'administrateur (le message n'est pas bloqué)
        try {
          let motif = detecterMotif(contenu);
          if (!motif) {
            // Spam : le même message envoyé 3 fois ou plus en 5 minutes à la même personne
            const [rep] = await pool.execute(
              "SELECT COUNT(*) AS n FROM message WHERE id_expediteur = ? AND id_destinataire = ? AND contenu = ? AND date_envoi > (NOW() - INTERVAL 5 MINUTE)",
              [idUtilisateur, destinataire, contenu.trim()]
            );
            if (rep[0].n >= 3) motif = 'spam';
          }
          if (motif) {
            await preparerTables();
            await pool.execute(
              "INSERT IGNORE INTO signalement_message (id_message, id_signaleur, id_signale, motif, commentaire, automatique) VALUES (?, ?, ?, ?, 'Détection automatique', 1)",
              [result.insertId, destinataire, idUtilisateur, motif]
            );
          }
        } catch (e) { console.error('Détection automatique :', e.message); }

        const message = {
          id_message: result.insertId,
          id_expediteur: idUtilisateur,
          id_destinataire: destinataire,
          contenu: contenu.trim(),
          date_envoi: new Date(),
          lu: false
        };

        // Renvoyer au destinataire s'il est connecté
        const socketDestinataire = utilisateursConnectes.get(destinataire);
        if (socketDestinataire) {
          io.to(socketDestinataire).emit('nouveau_message', message);
        }

        // Confirmer à l'expéditeur (pour afficher son propre message immédiatement)
        socket.emit('nouveau_message', message);
      } catch (err) {
        console.error('Erreur envoi message socket :', err);
        socket.emit('erreur_message', { message: "Le message n'a pas pu être envoyé." });
      }
    });

    socket.on('disconnect', () => {
      utilisateursConnectes.delete(idUtilisateur);
      console.log(`Utilisateur ${idUtilisateur} déconnecté`);
    });
  });
}

module.exports = { initialiserSocket, emettreVersUtilisateur };
