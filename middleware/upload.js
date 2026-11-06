const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Types d'images acceptés : type MIME -> extension sûre (l'extension envoyée par l'utilisateur n'est jamais réutilisée)
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Dossier des images (couvertures de livres, photos de profil)
const DOSSIER_PUBLIC = path.join(__dirname, '..', 'uploads');

function creerStorage(dossier) {
  return multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(dossier, { recursive: true }); cb(null, dossier); },
    filename: (req, file, cb) => {
      const suffixe = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, suffixe + (TYPES[file.mimetype] || '.jpg'));
    }
  });
}

const options = (dossier) => ({
  storage: creerStorage(dossier),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
  fileFilter: (req, file, cb) => {
    const extensionOk = EXTENSIONS.includes(path.extname(file.originalname).toLowerCase());
    if (extensionOk && TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('Seules les images JPEG, PNG ou WEBP sont autorisées.'));
  }
});

const multerBrut = multer(options(DOSSIER_PUBLIC));

// Vérifie le contenu réel du fichier (octets de début), pas seulement son nom ou son type annoncé
function signatureValide(chemin) {
  const fd = fs.openSync(chemin, 'r');
  const tampon = Buffer.alloc(12);
  fs.readSync(fd, tampon, 0, 12, 0);
  fs.closeSync(fd);
  const jpeg = tampon[0] === 0xFF && tampon[1] === 0xD8 && tampon[2] === 0xFF;
  const png = tampon.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const webp = tampon.slice(0, 4).toString('ascii') === 'RIFF' && tampon.slice(8, 12).toString('ascii') === 'WEBP';
  return jpeg || png || webp;
}

function fichiersRecus(req) {
  const liste = [];
  if (req.file) liste.push(req.file);
  if (Array.isArray(req.files)) liste.push(...req.files);
  else if (req.files) Object.values(req.files).forEach(l => liste.push(...l));
  return liste;
}

// Enchaîne multer puis la vérification du contenu ; un faux fichier est supprimé et la requête refusée
function avecVerification(middlewareMulter) {
  return (req, res, next) => {
    middlewareMulter(req, res, (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image trop lourde (5 Mo maximum).' : err.message;
        return res.status(400).json({ message });
      }
      const fichiers = fichiersRecus(req);
      if (fichiers.some(f => !signatureValide(f.path))) {
        fichiers.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ message: "Le fichier envoyé n'est pas une vraie image (JPEG, PNG ou WEBP)." });
      }
      next();
    });
  };
}

module.exports = {
  single: (nom) => avecVerification(multerBrut.single(nom)),
  fields: (champs) => avecVerification(multerBrut.fields(champs)),
  array: (nom, max) => avecVerification(multerBrut.array(nom, max))
};
