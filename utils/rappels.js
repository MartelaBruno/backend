const pool = require('../config/db');
const { notifier } = require('./notifier');

// Vérifie les prêts en cours : rappel la veille / le jour même, alerte en cas de retard.
// Chaque alerte n'est envoyée qu'une seule fois par prêt (colonnes rappel_envoye / retard_notifie).
async function verifierEcheances() {
  try {
    const [prets] = await pool.query(
      `SELECT d.id_demande, d.id_emprunteur, d.rappel_envoye, d.retard_notifie,
              DATEDIFF(d.date_prevue_retour, CURDATE()) AS jours,
              l.titre, l.id_proprietaire, u.prenom, u.nom
       FROM demande_pret d
       JOIN livre l ON l.id_livre = d.id_livre
       JOIN utilisateur u ON u.id_utilisateur = d.id_emprunteur
       WHERE d.statut = 'acceptee' AND d.date_prevue_retour IS NOT NULL
         AND DATEDIFF(d.date_prevue_retour, CURDATE()) <= 1`
    );

    for (const p of prets) {
      if (p.jours >= 0 && !p.rappel_envoye) {
        await pool.execute('UPDATE demande_pret SET rappel_envoye = 1 WHERE id_demande = ?', [p.id_demande]);
        const quand = p.jours === 0 ? "aujourd'hui" : 'demain';
        await notifier(p.id_emprunteur, { type: 'rappel', lien: '/mes-demandes.html', message: `Rappel : « ${p.titre} » est à rendre ${quand}.` });
      } else if (p.jours < 0 && !p.retard_notifie) {
        await pool.execute('UPDATE demande_pret SET retard_notifie = 1 WHERE id_demande = ?', [p.id_demande]);
        const retard = `${-p.jours} jour${-p.jours > 1 ? 's' : ''}`;
        await notifier(p.id_emprunteur, { type: 'retard', lien: '/mes-demandes.html', message: `« ${p.titre} » devait être rendu : retard de ${retard}.` });
        await notifier(p.id_proprietaire, { type: 'retard', lien: '/mes-livres.html', message: `${p.nom} ${p.prenom} n'a pas encore rendu « ${p.titre} » (retard de ${retard}).` });
      }
    }
  } catch (err) {
    // Typiquement : la migration sql_migration_rappels.sql n'a pas encore été exécutée
    const detail = err.message || err.code || (err.errors && err.errors.map(x => x.code).join(', ')) || String(err);
    console.error('Vérification des échéances impossible :', detail,
      /ECONNREFUSED|ETIMEDOUT/.test(detail) ? '(MySQL est-il démarré dans XAMPP ? Vérifiez DB_HOST/DB_PORT dans .env)' : '');
  }
}

function demarrerRappels() {
  setTimeout(verifierEcheances, 10 * 1000);          // peu après le démarrage
  setInterval(verifierEcheances, 60 * 60 * 1000);    // puis toutes les heures
}

module.exports = { demarrerRappels, verifierEcheances };
