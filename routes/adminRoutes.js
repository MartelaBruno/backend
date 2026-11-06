const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { verifierToken, verifierAdmin } = require('../middleware/auth');

router.use(verifierToken, verifierAdmin);

router.get('/statistiques', adminController.statistiques);
router.get('/utilisateurs', adminController.listerUtilisateurs);
router.get('/utilisateurs/:id/fiche', adminController.ficheUtilisateur);
router.patch('/utilisateurs/:id/basculer', adminController.basculerActivation);
router.delete('/utilisateurs/:id', adminController.supprimerUtilisateur);
router.get('/retards', adminController.listerRetards);
router.get('/admins', adminController.listerAdmins);
router.post('/admins', adminController.creerAdmin);
router.post('/admins/:id/invitation', adminController.renvoyerInvitation);
router.delete('/admins/:id', adminController.supprimerAdmin);
router.get('/fin-annee', adminController.apercuFinAnnee);
router.post('/fin-annee/suspendre', adminController.suspendreFinAnnee);
router.get('/matricules', adminController.listerMatricules);
router.post('/matricules', adminController.ajouterMatricules);
router.put('/matricules/:matricule', adminController.modifierMatricule);
router.delete('/matricules/:matricule', adminController.supprimerMatricule);
router.get('/signalements', adminController.listerSignalements);
router.patch('/signalements/:id/traiter', adminController.traiterSignalement);
router.get('/historique', adminController.historiqueGlobal);
router.get('/livres', adminController.listerLivres);
router.delete('/livres/:id', adminController.supprimerLivre);

module.exports = router;
