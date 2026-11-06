const express = require('express');
const router = express.Router();
const c = require('../controllers/notificationController');
const { verifierToken } = require('../middleware/auth');

router.use(verifierToken);

// Les routes fixes avant "/:id"
router.get('/preferences', c.obtenirPreferences);
router.put('/preferences', c.modifierPreferences);
router.patch('/lire-tout', c.lireTout);
router.get('/', c.lister);
router.patch('/:id/lire', c.lire);
router.delete('/:id', c.supprimer);
router.delete('/', c.toutSupprimer);

module.exports = router;
