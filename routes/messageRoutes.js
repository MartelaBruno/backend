const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { verifierToken } = require('../middleware/auth');

router.use(verifierToken);

// Les routes fixes doivent être déclarées AVANT "/:idContact"
router.get('/conversations', messageController.listerConversations);
router.get('/utilisateurs', messageController.rechercherUtilisateurs);
router.get('/non-lus/compte', messageController.compterNonLus);
router.post('/signaler', messageController.signalerMessage);
router.get('/:idContact', messageController.obtenirConversation);

module.exports = router;
