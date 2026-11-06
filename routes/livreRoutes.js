const express = require('express');
const router = express.Router();
const livreController = require('../controllers/livreController');
const { verifierToken } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.get('/', verifierToken, livreController.rechercher);
router.get('/mes-livres', verifierToken, livreController.mesLivres);
router.get('/:id', verifierToken, livreController.obtenirDetail);
router.post('/', verifierToken, upload.single('image'), livreController.publier);
router.put('/:id', verifierToken, upload.single('image'), livreController.modifier);
router.delete('/:id', verifierToken, livreController.supprimer);

module.exports = router;
