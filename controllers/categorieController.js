const pool = require('../config/db');

// GET /api/categories
async function lister(req, res) {
  try {
    const [rows] = await pool.query('SELECT id_categorie, nom_categorie FROM categorie ORDER BY nom_categorie');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { lister };
