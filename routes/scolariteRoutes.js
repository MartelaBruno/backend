const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { verifierToken, verifierScolarite } = require('../middleware/auth');

// Espace scolarité : importer les listes d'inscrits / réinscrits (par département et année) et consulter ses imports
router.use(verifierToken, verifierScolarite);
router.get('/moi', adminController.monDepartement);
router.get('/matricules', adminController.listerMatriculesScolarite);
router.post('/matricules', adminController.importerParScolarite);
router.delete('/matricules/:matricule', adminController.retirerMatriculeScolarite);

module.exports = router;
