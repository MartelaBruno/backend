const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifierToken } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.post('/inscription', authController.inscription);
router.post('/inscription/verifier', authController.verifierInscription);
router.post('/inscription/renvoyer', authController.renvoyerCodeInscription);
router.post('/connexion', authController.connexion);
router.post('/mot-de-passe-oublie', authController.motDePasseOublie);
router.post('/reinitialiser-mot-de-passe', authController.reinitialiserMotDePasse);

router.get('/profil', verifierToken, authController.obtenirProfil);
router.put(
  '/profil',
  verifierToken,
  upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'couverture', maxCount: 1 }]),
  authController.modifierProfil
);
router.put('/profil/mot-de-passe', verifierToken, authController.changerMotDePasse);

module.exports = router;
