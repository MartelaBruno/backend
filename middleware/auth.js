const { lireStatut, messageSuspension } = require('../utils/suspension');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { preparerTables } = require('../utils/securite');
require('dotenv').config();

// Vérifie que l'utilisateur est connecté (token JWT valide)
function verifierToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ message: 'Vous devez être connecté.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Session invalide ou expirée.' });
    }
    try {
      // Un compte suspendu perd l'accès immédiatement (sans attendre l'expiration du token)
      const statut = await lireStatut(decoded.id_utilisateur);
      if (!statut) {
        return res.status(403).json({ message: 'Compte introuvable. Contactez un administrateur.' });
      }
      if (!statut.actif) {
        return res.status(403).json({ message: messageSuspension(statut.jusquAu) });
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: 'Erreur serveur.' });
    }
    try {
      // Rôle lu dans la base (toujours à jour, même si le jeton est ancien)
      await preparerTables();
      const [[u]] = await pool.query('SELECT role FROM utilisateur WHERE id_utilisateur = ?', [decoded.id_utilisateur]);
      decoded.role = u.role;
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: 'Erreur serveur.' });
    }
    req.utilisateur = decoded; // { id_utilisateur, role }
    next();
  });
}

// Administrateur de la plateforme
function verifierAdmin(req, res, next) {
  if (req.utilisateur.role !== 'admin') {
    return res.status(403).json({ message: 'Accès réservé à l\'administrateur.' });
  }
  next();
}

// Scolarité (import des listes de matricules) ou administrateur
function verifierScolarite(req, res, next) {
  if (req.utilisateur.role !== 'scolarite' && req.utilisateur.role !== 'admin') {
    return res.status(403).json({ message: 'Accès réservé à la scolarité.' });
  }
  next();
}

module.exports = { verifierToken, verifierAdmin, verifierScolarite };
