require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

const authRoutes = require('./routes/authRoutes');
const livreRoutes = require('./routes/livreRoutes');
const demandeRoutes = require('./routes/demandeRoutes');
const messageRoutes = require('./routes/messageRoutes');
const adminRoutes = require('./routes/adminRoutes');
const categorieRoutes = require('./routes/categorieRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const { initialiserSocket } = require('./sockets/socketHandler');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques (frontend + images uploadées)
// Le frontend (dossier ../frontend) est servi par le backend : un seul déploiement, pas de CORS à configurer.
// La page d'accueil (site vitrine) est frontend/index.html
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes API
app.use('/api/auth', authRoutes);
app.use('/api/livres', livreRoutes);
app.use('/api/demandes', demandeRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/scolarite', require('./routes/scolariteRoutes'));
app.use('/api/admin', adminRoutes);
app.use('/api/categories', categorieRoutes);
app.use('/api/notifications', notificationRoutes);

// Socket.io (messagerie temps réel)
initialiserSocket(io);

// Gestion des erreurs générales
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Une erreur est survenue sur le serveur.' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  require('./utils/rappels').demarrerRappels();
});
