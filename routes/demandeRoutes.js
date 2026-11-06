const express = require('express');
const router = express.Router();
const demandeController = require('../controllers/demandeController');
const { verifierToken } = require('../middleware/auth');

router.use(verifierToken);

router.post('/', demandeController.envoyerDemande);
router.get('/recues', demandeController.demandesRecues);
router.get('/envoyees', demandeController.demandesEnvoyees);
router.delete('/:id', demandeController.annuler);
router.patch('/:id/accepter', demandeController.accepter);
router.patch('/:id/refuser', demandeController.refuser);
router.patch('/:id/retour', demandeController.enregistrerRetour);

module.exports = router;
