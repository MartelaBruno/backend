const pool = require('../config/db');

// GET /api/livres?recherche=&id_categorie=  (tous les livres : un livre emprunté reste visible avec le badge « Déjà emprunté »)
async function rechercher(req, res) {
  try {
    const { recherche = '' } = req.query;
    const categorie = req.query.id_categorie || req.query.categorie;

    let sql = `
      SELECT l.id_livre, l.titre, l.auteur, l.id_categorie, l.etat_livre, l.image, l.disponibilite, l.description,
             c.nom_categorie, u.id_utilisateur AS id_proprietaire, u.nom AS nom_proprietaire, u.prenom AS prenom_proprietaire, u.filiere AS filiere_proprietaire
      FROM livre l
      LEFT JOIN categorie c ON l.id_categorie = c.id_categorie
      LEFT JOIN utilisateur u ON l.id_proprietaire = u.id_utilisateur
      WHERE (l.titre LIKE ? OR l.auteur LIKE ?)
    `;
    const params = [`%${recherche}%`, `%${recherche}%`];

    if (categorie) {
      sql += ' AND l.id_categorie = ?';
      params.push(categorie);
    }
    sql += ' ORDER BY l.date_ajout DESC';

    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/livres/:id
async function obtenirDetail(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT l.*, c.nom_categorie, u.nom AS nom_proprietaire, u.prenom AS prenom_proprietaire, u.filiere AS filiere_proprietaire
       FROM livre l
       LEFT JOIN categorie c ON l.id_categorie = c.id_categorie
       LEFT JOIN utilisateur u ON l.id_proprietaire = u.id_utilisateur
       WHERE l.id_livre = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Livre introuvable.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// Catégorie choisie dans la liste, ou nouvelle catégorie saisie par l'étudiant (option « Autre »)
const MAX_CATEGORIES = 60;
async function resoudreCategorie(id_categorie, nouvelle) {
  if (String(id_categorie) !== 'autre') return { id: id_categorie ? parseInt(id_categorie, 10) || null : null };
  let nom = String(nouvelle || '').replace(/\s+/g, ' ').trim();
  if (nom.length < 2 || nom.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} '’&.\-]*$/u.test(nom)) {
    return { erreur: 'Précisez le nom de la catégorie (2 à 40 caractères : lettres, chiffres, espaces).' };
  }
  nom = nom.charAt(0).toUpperCase() + nom.slice(1);
  const [existe] = await pool.execute('SELECT id_categorie FROM categorie WHERE LOWER(nom_categorie) = LOWER(?) LIMIT 1', [nom]);
  if (existe.length) return { id: existe[0].id_categorie };
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM categorie');
  if (total >= MAX_CATEGORIES) return { erreur: 'Le nombre maximum de catégories est atteint. Choisissez-en une dans la liste.' };
  const [r] = await pool.execute('INSERT INTO categorie (nom_categorie) VALUES (?)', [nom]);
  return { id: r.insertId };
}

// POST /api/livres (propriétaire)
async function publier(req, res) {
  try {
    const { titre, auteur, etat_livre, description } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : null;

    if (!titre) return res.status(400).json({ message: 'Le titre est obligatoire.' });
    const cat = await resoudreCategorie(req.body.id_categorie, req.body.nouvelle_categorie);
    if (cat.erreur) return res.status(400).json({ message: cat.erreur });

    const [result] = await pool.execute(
      `INSERT INTO livre (titre, auteur, id_categorie, id_proprietaire, etat_livre, description, image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [titre, auteur || null, cat.id || null, req.utilisateur.id_utilisateur, etat_livre || 'bon_etat', description || null, image]
    );

    res.status(201).json({ message: 'Livre publié avec succès.', id_livre: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// GET /api/livres/mes-livres (propriétaire connecté)
async function mesLivres(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT id_livre, titre, auteur, id_categorie, etat_livre, description, image, disponibilite, date_ajout
       FROM livre WHERE id_proprietaire = ? ORDER BY date_ajout DESC`,
      [req.utilisateur.id_utilisateur]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// Vérifie que le livre existe et appartient bien à l'utilisateur connecté
async function verifierProprietaireLivre(idLivre, idUtilisateur) {
  const [rows] = await pool.execute('SELECT * FROM livre WHERE id_livre = ?', [idLivre]);
  if (rows.length === 0 || rows[0].id_proprietaire !== idUtilisateur) return null;
  return rows[0];
}

// PUT /api/livres/:id (propriétaire uniquement)
async function modifier(req, res) {
  try {
    const livre = await verifierProprietaireLivre(req.params.id, req.utilisateur.id_utilisateur);
    if (!livre) return res.status(403).json({ message: "Vous ne pouvez modifier que vos propres livres." });

    if (livre.disponibilite !== 'disponible') {
      return res.status(409).json({ message: "Impossible de modifier un livre actuellement emprunté." });
    }

    const { titre, auteur, etat_livre, description } = req.body;
    if (!titre) return res.status(400).json({ message: 'Le titre est obligatoire.' });
    const cat = await resoudreCategorie(req.body.id_categorie, req.body.nouvelle_categorie);
    if (cat.erreur) return res.status(400).json({ message: cat.erreur });

    const image = req.file ? `/uploads/${req.file.filename}` : livre.image;

    await pool.execute(
      `UPDATE livre SET titre = ?, auteur = ?, id_categorie = ?, etat_livre = ?, description = ?, image = ?
       WHERE id_livre = ?`,
      [titre, auteur || null, cat.id || null, etat_livre || 'bon_etat', description || null, image, req.params.id]
    );

    res.json({ message: 'Livre modifié avec succès.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

// DELETE /api/livres/:id (propriétaire uniquement)
async function supprimer(req, res) {
  try {
    const livre = await verifierProprietaireLivre(req.params.id, req.utilisateur.id_utilisateur);
    if (!livre) return res.status(403).json({ message: "Vous ne pouvez supprimer que vos propres livres." });

    if (livre.disponibilite !== 'disponible') {
      return res.status(409).json({ message: "Impossible de supprimer un livre actuellement emprunté." });
    }

    await pool.execute('DELETE FROM livre WHERE id_livre = ?', [req.params.id]);
    res.json({ message: 'Livre supprimé.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { rechercher, obtenirDetail, publier, mesLivres, modifier, supprimer };
