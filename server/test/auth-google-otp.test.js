import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'test-secret-yang-cukup-panjang-32-karakter';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { setGoogleTokenVerifier, verifyGoogleIdToken, clearGoogleJwksCache } = await import('../src/services/googleAuth.js');
const { setMailSender } = await import('../src/services/mailer.js');
const { tokenTransactions, users } = await import('../src/repositories/index.js');

const app = createApp();

const uniqueEmail = (prefix = 'user') => `${prefix}${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;

test('login Google: 503 bila GOOGLE_CLIENT_ID belum dikonfigurasi, lalu berhasil membuat & menautkan akun bila dikonfigurasi', async () => {
  const prevClientId = config.google.clientId;
  const prevConfigured = config.google.configured;
  const prevEnvClientId = process.env.GOOGLE_CLIENT_ID;
  config.google.clientId = '';
  config.google.configured = false;
  delete process.env.GOOGLE_CLIENT_ID;

  try {
    const noCfg = await request(app).post('/api/auth/google').send({ credential: 'fake-token' });
    assert.equal(noCfg.status, 503);
    assert.equal(noCfg.body.code, 'GOOGLE_NOT_CONFIGURED');

    config.google.clientId = 'test-google-client-id.apps.googleusercontent.com';
    config.google.configured = true;

    const gEmail = uniqueEmail('google');
    setGoogleTokenVerifier(async (token) => {
      if (token === 'valid-google-token') {
        return {
          sub: 'google-sub-12345',
          email: gEmail,
          email_verified: true,
          name: 'Pengguna Google',
          aud: config.google.clientId,
          iss: 'https://accounts.google.com',
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
      }
      if (token === 'wrong-aud-token') {
        return {
          sub: 'google-sub-999',
          email: gEmail,
          email_verified: true,
          aud: 'other-app.apps.googleusercontent.com',
          iss: 'https://accounts.google.com',
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
      }
      return {
        sub: 'google-sub-unverified',
        email: gEmail,
        email_verified: false,
        aud: config.google.clientId,
        iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    // Token dengan aud salah ditolak
    const wrongAud = await request(app).post('/api/auth/google').send({ credential: 'wrong-aud-token' });
    assert.equal(wrongAud.status, 401);
    assert.equal(wrongAud.body.code, 'GOOGLE_AUD_MISMATCH');

    // Token dengan email belum terverifikasi ditolak
    const unverified = await request(app).post('/api/auth/google').send({ credential: 'unverified' });
    assert.equal(unverified.status, 401);
    assert.equal(unverified.body.code, 'GOOGLE_EMAIL_UNVERIFIED');

    // Login Google sah -> buat akun baru & terbitkan sesi
    const agent = request.agent(app);
    const ok = await agent.post('/api/auth/google').send({ credential: 'valid-google-token' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.accessToken);
    assert.equal(ok.body.user.email, gEmail);
    assert.equal(ok.body.user.email_verified, true);
    assert.equal(ok.body.user.auth_provider, 'google');
    assert.equal(ok.body.user.has_password, false);

    // Tambah saldo token, lalu login ulang via Google harus mempertahankan akun & saldo yang sama
    await tokenTransactions.credit({
      user_id: ok.body.user.id,
      amount: 5,
      type: 'purchase',
      description: 'Uji Google',
      reference_type: 'test',
      reference_id: `GT-${Date.now()}`,
    });

    const loginAgain = await agent.post('/api/auth/google').send({ credential: 'valid-google-token' });
    assert.equal(loginAgain.status, 200);
    assert.equal(loginAgain.body.user.id, ok.body.user.id);
    assert.equal(loginAgain.body.user.token_balance, 5);

    // Login dengan password pada akun Google-only ditolak dengan pesan jelas
    const pwLogin = await agent.post('/api/auth/login').send({ email: gEmail, password: 'Password123!' });
    assert.equal(pwLogin.status, 401);
    assert.match(pwLogin.body.error, /Google/i);
  } finally {
    setGoogleTokenVerifier(null);
    config.google.clientId = prevClientId;
    config.google.configured = prevConfigured;
    if (prevEnvClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevEnvClientId;
  }
});

test('registrasi OTP via email, batas percobaan OTP, verifikasi OTP, dan lupa password via OTP', async () => {
  const prevMail = config.mail.configured;
  const sentMails = [];
  config.mail.configured = true;
  setMailSender(async (mail) => {
    sentMails.push(mail);
    return { messageId: 'test-msg-id' };
  });

  try {
    const email = uniqueEmail('otp');
    const agent = request.agent(app);

    // 1. Registrasi mengirim OTP dan tidak langsung memberi accessToken
    const reg = await agent.post('/api/auth/register').send({
      name: 'User OTP',
      email,
      password: 'Password123!',
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.requires_verification, true);
    assert.equal(reg.body.accessToken, undefined);
    assert.equal(sentMails.length, 1);
    const otpMatch = sentMails[0].text.match(/\b(\d{6})\b/);
    assert.ok(otpMatch, 'email harus memuat 6 digit kode OTP');
    const otpCode = otpMatch[1];

    // 2. Login sebelum verifikasi OTP ditolak 403 EMAIL_NOT_VERIFIED
    const preLogin = await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
    assert.equal(preLogin.status, 403);
    assert.equal(preLogin.body.code, 'EMAIL_NOT_VERIFIED');

    // 3. OTP salah ditolak
    const wrongOtp = await agent.post('/api/auth/verify-otp').send({ email, otp: '000000' });
    assert.equal(wrongOtp.status, 400);

    // 4. OTP benar memverifikasi akun & menerbitkan sesi
    const verified = await agent.post('/api/auth/verify-otp').send({ email, otp: otpCode });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.accessToken);
    assert.equal(verified.body.user.email_verified, true);

    // 5. Lupa password mengirim OTP & tautan reset
    const forgot = await agent.post('/api/auth/forgot-password').send({ email });
    assert.equal(forgot.status, 200);
    assert.equal(sentMails.length, 2);
    const resetOtpMatch = sentMails[1].text.match(/\b(\d{6})\b/);
    assert.ok(resetOtpMatch, 'email lupa password harus memuat 6 digit OTP');
    const resetOtp = resetOtpMatch[1];

    // 6. Reset password dengan OTP salah gagal
    const badReset = await agent.post('/api/auth/reset-password').send({
      email,
      otp: '999999',
      password: 'NewPassword123!',
    });
    assert.equal(badReset.status, 400);

    // 7. Reset password dengan OTP benar berhasil & refresh token lama dicabut
    const goodReset = await agent.post('/api/auth/reset-password').send({
      email,
      otp: resetOtp,
      password: 'NewPassword123!',
    });
    assert.equal(goodReset.status, 200);

    const refreshAfterReset = await agent.post('/api/auth/refresh');
    assert.equal(refreshAfterReset.status, 401);

    // 8. Login dengan sandi baru berhasil, sandi lama ditolak
    await agent.post('/api/auth/login').send({ email, password: 'Password123!' }).expect(401);
    const newLogin = await agent.post('/api/auth/login').send({ email, password: 'NewPassword123!' });
    assert.equal(newLogin.status, 200);
    assert.ok(newLogin.body.accessToken);
  } finally {
    setMailSender(null);
    config.mail.configured = prevMail;
  }
});

function signTestJwt(header, payload, privateKey) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

test('verifikasi kriptografis JWKS Google ID token (RS256): valid, tanda tangan palsu, kedaluwarsa, dan issuer salah', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-kid-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  const prevFetch = globalThis.fetch;
  clearGoogleJwksCache();
  setGoogleTokenVerifier(null);

  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://www.googleapis.com/oauth2/v3/certs');
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    });
  };

  try {
    const clientId = 'jwks-test-client.apps.googleusercontent.com';
    const nowSec = Math.floor(Date.now() / 1000);
    const validJwt = signTestJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'test-kid-1' },
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-jwks-sub-1',
        email: 'JWKS.User@Gmail.com',
        email_verified: true,
        name: 'JWKS User',
        exp: nowSec + 3600,
      },
      privateKey,
    );

    const profile = await verifyGoogleIdToken(validJwt, clientId);
    assert.equal(profile.googleId, 'google-jwks-sub-1');
    assert.equal(profile.email, 'jwks.user@gmail.com');

    // Tampered payload/signature
    const parts = validJwt.split('.');
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId, sub: 'hacker', email: 'hacker@gmail.com', email_verified: true, exp: nowSec + 3600 })).toString('base64url')}.${parts[2]}`;
    await assert.rejects(() => verifyGoogleIdToken(tampered, clientId), (e) => e.status === 401 && e.code === 'GOOGLE_TOKEN_INVALID');

    // Expired JWT
    const expiredJwt = signTestJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'test-kid-1' },
      { iss: 'https://accounts.google.com', aud: clientId, sub: 's1', email: 'a@gmail.com', email_verified: true, exp: nowSec - 120 },
      privateKey,
    );
    await assert.rejects(() => verifyGoogleIdToken(expiredJwt, clientId), (e) => e.status === 401 && e.code === 'GOOGLE_TOKEN_EXPIRED');

    // Wrong issuer
    const badIssJwt = signTestJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'test-kid-1' },
      { iss: 'https://evil.example.com', aud: clientId, sub: 's1', email: 'a@gmail.com', email_verified: true, exp: nowSec + 3600 },
      privateKey,
    );
    await assert.rejects(() => verifyGoogleIdToken(badIssJwt, clientId), (e) => e.status === 401 && e.code === 'GOOGLE_ISS_INVALID');
  } finally {
    globalThis.fetch = prevFetch;
    clearGoogleJwksCache();
  }
});

test('keamanan: cegah pre-hijacking akun Google, cooldown register ganda, batas 5x OTP, dan pencabutan access token saat reset password', async () => {
  const prevMail = config.mail.configured;
  const prevClientId = config.google.clientId;
  const prevGoogleCfg = config.google.configured;
  const sentMails = [];

  config.mail.configured = true;
  config.google.clientId = 'sec-test-client.apps.googleusercontent.com';
  config.google.configured = true;
  setMailSender(async (mail) => {
    sentMails.push(mail);
    return { messageId: 'sec-msg' };
  });

  try {
    const victimEmail = uniqueEmail('victim');

    // 1. Penyerang mendaftar dengan email korban (belum verifikasi OTP) dan kata sandi penyerang
    const attackerReg = await request(app).post('/api/auth/register').send({
      name: 'Attacker',
      email: victimEmail,
      password: 'AttackerPassword123!',
    });
    assert.equal(attackerReg.status, 201);

    // 2. Spam register ulang sebelum 60 detik ditolak 429 OTP_COOLDOWN
    const spamReg = await request(app).post('/api/auth/register').send({
      name: 'Attacker 2',
      email: victimEmail,
      password: 'AttackerPassword123!',
    });
    assert.equal(spamReg.status, 429);
    assert.equal(spamReg.body.code, 'OTP_COOLDOWN');

    // 3. Korban login dengan Google -> password_hash penyerang harus dihapus!
    setGoogleTokenVerifier(async () => ({
      sub: 'victim-google-sub',
      email: victimEmail,
      email_verified: true,
      name: 'Victim Real',
      aud: config.google.clientId,
      iss: 'https://accounts.google.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const victimGoogle = await request(app).post('/api/auth/google').send({ credential: 'victim-token' });
    assert.equal(victimGoogle.status, 200);
    assert.equal(victimGoogle.body.user.has_password, false);
    assert.equal(victimGoogle.body.user.auth_provider, 'google');

    // Penyerang tidak bisa login dengan password yang sempat didaftarkannya
    const attackerLogin = await request(app).post('/api/auth/login').send({
      email: victimEmail,
      password: 'AttackerPassword123!',
    });
    assert.equal(attackerLogin.status, 401);

    // 4. Akun Google dengan sub berbeda untuk email yang sama ditolak 409
    setGoogleTokenVerifier(async () => ({
      sub: 'other-google-sub',
      email: victimEmail,
      email_verified: true,
      aud: config.google.clientId,
      iss: 'https://accounts.google.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const mismatch = await request(app).post('/api/auth/google').send({ credential: 'other-token' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'GOOGLE_ACCOUNT_MISMATCH');

    // 5. Reset password mencabut access token lama (token_version) & menolak 5x OTP salah
    const oldAccessToken = victimGoogle.body.accessToken;
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldAccessToken}`).expect(200);

    const mailCountBefore = sentMails.length;
    await request(app).post('/api/auth/forgot-password').send({ email: victimEmail }).expect(200);
    assert.equal(sentMails.length, mailCountBefore + 1);
    const resetOtp = sentMails[sentMails.length - 1].text.match(/\b(\d{6})\b/)[1];

    // 5x salah -> ke-5 menghasilkan 429 dan OTP hangus
    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/auth/reset-password').send({ email: victimEmail, otp: '000000', password: 'NewPassword123!' }).expect(400);
    }
    await request(app).post('/api/auth/reset-password').send({ email: victimEmail, otp: '000000', password: 'NewPassword123!' }).expect(429);
    // OTP lama yang tadinya benar kini hangus
    await request(app).post('/api/auth/reset-password').send({ email: victimEmail, otp: resetOtp, password: 'NewPassword123!' }).expect(400);

    // Simulasikan cooldown lewat agar bisa minta OTP baru, lalu reset dan cek oldAccessToken dicabut
    const u = await users.findByEmail(victimEmail);
    await users.update(u.id, { otp_sent_at: new Date(Date.now() - 120000).toISOString() });
    await request(app).post('/api/auth/forgot-password').send({ email: victimEmail }).expect(200);
    const freshOtp = sentMails[sentMails.length - 1].text.match(/\b(\d{6})\b/)[1];
    await request(app).post('/api/auth/reset-password').send({ email: victimEmail, otp: freshOtp, password: 'NewPassword123!' }).expect(200);

    const meAfterReset = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldAccessToken}`);
    assert.equal(meAfterReset.status, 401);
    assert.equal(meAfterReset.body.code, 'TOKEN_REVOKED');

    // 6. Type confusion / payload non-string ditolak
    await request(app).post('/api/auth/verify-otp').send({ email: victimEmail, otp: ['123456'] }).expect(400);
    await request(app).post('/api/auth/google').send({ credential: { token: 'x' } }).expect(400);
  } finally {
    setGoogleTokenVerifier(null);
    setMailSender(null);
    config.mail.configured = prevMail;
    config.google.clientId = prevClientId;
    config.google.configured = prevGoogleCfg;
  }
});
