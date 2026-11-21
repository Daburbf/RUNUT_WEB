import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporter = null;
let customSender = null;

export function setMailSender(fn) {
  customSender = typeof fn === 'function' ? fn : null;
}

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  if (customSender) {
    return customSender({ from: config.mail.from, to, subject, text, html });
  }
  if (!config.mail.configured) {
    throw new Error('SMTP belum dikonfigurasi (MAIL_HOST/MAIL_USER/MAIL_PASS).');
  }
  return getTransporter().sendMail({ from: config.mail.from, to, subject, text, html });
}
