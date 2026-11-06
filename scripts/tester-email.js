// Teste la configuration e-mail (.env) et envoie un message de test.
// Utilisation :  node scripts/tester-email.js [adresse_destinataire]
require('dotenv').config();
const nodemailer = require('nodemailer');

const user = process.env.EMAIL_USER || '';
const pass = String(process.env.EMAIL_PASSWORD || '').replace(/\s+/g, '');
const dest = process.argv[2] || user;

if (!process.env.EMAIL_HOST || !user || user.startsWith('votre')) {
  console.log('✗ Le .env ne contient pas encore EMAIL_HOST / EMAIL_USER / EMAIL_PASSWORD réels.');
  console.log('  Remplissez-les (voir .env.example), puis relancez ce test.');
  process.exit(1);
}
if (pass.length !== 16) console.log('⚠ Un mot de passe d\'application Gmail fait 16 lettres (sans espaces). Le vôtre en fait ' + pass.length + '.');

const t = nodemailer.createTransport({
  host: process.env.EMAIL_HOST, port: Number(process.env.EMAIL_PORT) || 587,
  secure: Number(process.env.EMAIL_PORT) === 465, auth: { user, pass }
});

(async () => {
  try {
    await t.verify();
    console.log('✓ Connexion au serveur e-mail réussie.');
    await t.sendMail({ from: process.env.EMAIL_FROM || user, to: dest, subject: 'IndramBoky – test e-mail', text: 'Si vous lisez ce message, l\'envoi d\'e-mails fonctionne.' });
    console.log('✓ E-mail de test envoyé à ' + dest + '. Vérifiez la boîte (et les spams).');
  } catch (e) {
    console.log('✗ Échec : ' + e.message);
    if (/535|Invalid login|Username and Password/i.test(e.message)) console.log('  → Utilisez un MOT DE PASSE D\'APPLICATION Gmail (validation en 2 étapes requise), pas votre mot de passe habituel.');
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(e.message)) console.log('  → Problème de connexion Internet ou de pare-feu (port 587).');
    process.exit(1);
  }
})();
