const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: Number(process.env.EMAIL_PORT) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: String(process.env.EMAIL_PASSWORD || '').replace(/\s+/g, '')
  }
});

// L'envoi réel n'est possible que si un serveur SMTP est configuré dans .env
// (valeurs d'exemple "votre_user_mailtrap" = non configuré).
function smtpConfigure() {
  const u = process.env.EMAIL_USER || '';
  return Boolean(process.env.EMAIL_HOST && u && !u.startsWith('votre_'));
}

const path = require('path');
const LOGO = { filename: 'logo-indramboky.png', path: path.join(__dirname, '..', '..', 'frontend', 'images', 'logo-email.png'), cid: 'logo-indramboky' };

function echapperHtml(t) { return String(t || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Gabarit commun à tous les e-mails (logo en en-tête, bonjour personnalisé, pied de page)
function gabarit({ titre, salutation, intro, centre, note, pied }) {
  return `<!doctype html><html lang="fr"><body style="margin:0;padding:0;background:#F6F7FB;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#22262B;">
        <tr><td align="center" style="padding:22px 24px 14px;background:#ffffff;"><img src="cid:${LOGO.cid}" width="260" alt="IndramBoky" style="display:block;width:260px;max-width:100%;height:auto;border:0;"></td></tr>
        <tr><td style="height:4px;background:#1D6FE5;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:26px 26px 8px;">
          <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#0B2D5C;">${salutation}</p>
          <h1 style="margin:0 0 12px;font-size:20px;">${titre}</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#5B6270;">${intro}</p>
          <div style="margin:0 0 22px;text-align:center;">${centre}</div>
          ${note}
        </td></tr>
        <tr><td style="padding:14px 26px 22px;border-top:1px solid #E4E7EF;font-size:12px;color:#8C96A3;">${pied}<br><br>IndramBoky · Prêt et partage de livres universitaires entre étudiants</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function bonjour(nomComplet) { return nomComplet ? `Bonjour ${echapperHtml(nomComplet)},` : 'Bonjour,'; }

async function envoyerEmailReinitialisation(destinataire, token, nomComplet) {
  const base = process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3000}`;
  const lien = `${base}/reset-password.html?token=${token}`;

  // Mode local (sans SMTP) : le lien est affiché dans la console du serveur
  if (!smtpConfigure()) {
    console.log('\n[Mot de passe oublié] SMTP non configuré — lien de réinitialisation pour ' + destinataire + ' :\n' + lien + '\n');
    return { simule: true };
  }

  const texte = `${nomComplet ? 'Bonjour ' + nomComplet + ',' : 'Bonjour,'}

Vous avez demandé la réinitialisation de votre mot de passe sur IndramBoky.
Ouvrez ce lien pour choisir un nouveau mot de passe (valable 1 heure) :
${lien}

Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.`;

  const html = gabarit({
    salutation: bonjour(nomComplet),
    titre: 'Réinitialiser votre mot de passe',
    intro: 'Vous avez demandé à changer votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.',
    centre: `<a href="${lien}" style="display:inline-block;background:#1D6FE5;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 28px;border-radius:10px;">Choisir un nouveau mot de passe</a>`,
    note: `<p style="margin:0 0 6px;font-size:13px;color:#5B6270;">Ce lien est valable <strong>1 heure</strong> et ne peut servir qu'une fois.</p>
          <p style="margin:0 0 20px;font-size:13px;color:#5B6270;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;color:#1D6FE5;">${lien}</span></p>`,
    pied: "Vous n'êtes pas à l'origine de cette demande ? Ignorez ce message, votre mot de passe reste inchangé."
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: destinataire,
    subject: 'IndramBoky – Réinitialisation de votre mot de passe',
    text: texte,
    html,
    attachments: [LOGO]
  });
}

// Code de vérification (OTP) envoyé lors de l'inscription
async function envoyerCodeVerification(destinataire, code, nomComplet) {
  if (!smtpConfigure()) {
    console.log('\n[Inscription] SMTP non configuré — code de vérification pour ' + destinataire + ' : ' + code + '\n');
    return { simule: true };
  }

  const texte = `${nomComplet ? 'Bonjour ' + nomComplet + ',' : 'Bonjour,'}

Votre code de vérification IndramBoky est : ${code}

Il est valable 10 minutes. Si vous n'avez pas demandé à créer un compte, ignorez ce message.`;

  const html = gabarit({
    salutation: bonjour(nomComplet),
    titre: 'Confirmez votre inscription',
    intro: "Bienvenue sur IndramBoky ! Saisissez ce code sur la page d'inscription pour valider votre adresse e-mail.",
    centre: `<span style="display:inline-block;background:#E3EEFF;color:#0B2D5C;font-weight:bold;font-size:32px;letter-spacing:8px;padding:14px 26px;border-radius:12px;">${code}</span>`,
    note: '<p style="margin:0 0 20px;font-size:13px;color:#5B6270;">Ce code est valable <strong>10 minutes</strong>. Ne le communiquez à personne.</p>',
    pied: "Vous n'avez pas demandé ce code ? Ignorez ce message."
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: destinataire,
    subject: 'IndramBoky – Votre code de vérification : ' + code,
    text: texte,
    html,
    attachments: [LOGO]
  });
  return { simule: false };
}

// Invitation d'un membre du personnel (administrateur / scolarité) : lien pour choisir son mot de passe
async function envoyerEmailInvitation(destinataire, token, nomComplet, libelleRole) {
  const base = process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3000}`;
  const lien = `${base}/reset-password.html?token=${token}`;
  if (!smtpConfigure()) {
    console.log('\n[Invitation] SMTP non configuré — lien pour ' + destinataire + ' :\n' + lien + '\n');
    return { simule: true, lien };
  }
  const texte = `${nomComplet ? 'Bonjour ' + nomComplet + ',' : 'Bonjour,'}

Un compte « ${libelleRole} » vient d'être créé pour vous sur IndramBoky.
Ouvrez ce lien pour choisir votre mot de passe (valable 48 heures) :
${lien}

Ensuite, connectez-vous avec cette adresse e-mail.`;
  const html = gabarit({
    salutation: bonjour(nomComplet),
    titre: 'Votre compte IndramBoky est prêt',
    intro: `Un compte <strong>${echapperHtml(libelleRole)}</strong> a été créé pour vous. Cliquez sur le bouton ci-dessous pour choisir votre mot de passe.`,
    centre: `<a href="${lien}" style="display:inline-block;background:#1D6FE5;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 28px;border-radius:10px;">Choisir mon mot de passe</a>`,
    note: `<p style="margin:0 0 6px;font-size:13px;color:#5B6270;">Ce lien est valable <strong>48 heures</strong> et ne peut servir qu'une fois. Ensuite, connectez-vous avec cette adresse e-mail.</p>
          <p style="margin:0 0 20px;font-size:13px;color:#5B6270;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;color:#1D6FE5;">${lien}</span></p>`,
    pied: "Vous n'attendiez pas ce message ? Ignorez-le : rien ne se passera sans votre action."
  });
  await transporter.sendMail({ from: process.env.EMAIL_FROM, to: destinataire, subject: 'IndramBoky – Votre compte est prêt', text: texte, html, attachments: [LOGO] });
  return { simule: false, lien };
}

module.exports = { envoyerEmailInvitation, envoyerEmailReinitialisation, envoyerCodeVerification, smtpConfigure };
