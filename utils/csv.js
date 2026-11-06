// Génère un CSV compatible Excel (séparateur « ; », UTF-8 avec BOM)
function formaterDate(d, avecHeure = true) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const p = (n) => String(n).padStart(2, '0');
  const jour = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  return avecHeure ? `${jour} ${p(dt.getHours())}:${p(dt.getMinutes())}` : jour;
}

function cellule(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise l'injection de formules (=, +, -, @) quand le CSV est ouvert dans Excel
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function versCsv(entetes, lignes) {
  const corps = [entetes, ...lignes].map(l => l.map(cellule).join(';')).join('\r\n');
  return '\uFEFF' + corps;
}

function envoyerCsv(res, nomFichier, entetes, lignes) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
  res.send(versCsv(entetes, lignes));
}

const LIBELLE_STATUT = { en_attente: 'En attente', acceptee: 'En cours', refusee: 'Refusée', retournee: 'Retournée' };

module.exports = { formaterDate, envoyerCsv, LIBELLE_STATUT };
