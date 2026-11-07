require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const os = require('os');
const moment = require('moment-timezone');
const chalk = require('chalk');
const { exec, execSync } = require('child_process');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';
const WRAPPER_PORT       = 4002;
const GATEWAY_PORT       = process.env.PORT || 4003;
const API_URL            = `http://localhost:${WRAPPER_PORT}`;
const GATEWAY_URL        = `http://localhost:${GATEWAY_PORT}`;
const NOTIF_PREFIX       = 'SHOPEE RULZZ';
const API_KEY            = process.env.API_KEY || 'shopee-secret-key-2026';
const ENV_PATH           = path.join(__dirname, '.env');
const DB_ADMIN_PATH      = path.join(__dirname, 'admin.json');
const BACKUP_DIR         = path.join(__dirname, 'backup');
const MAX_BACKUP_FILES   = 7;
const POLL_INTERVAL_MS   = 5000;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function getAdmins() { try { return JSON.parse(fs.readFileSync(DB_ADMIN_PATH, 'utf8')); } catch { return []; } }
function saveAdmins(data) { fs.writeFileSync(DB_ADMIN_PATH, JSON.stringify(data, null, 2)); }

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const isOwner = (id) => String(id) === String(TELEGRAM_CHAT_ID);
const isAdmin = (id) => isOwner(id) || getAdmins().includes(String(id)); 
const nowUnix = () => Math.floor(Date.now() / 1000);
const rupiah = (n) => Number(n || 0).toLocaleString('id-ID');
const wibNow = () => moment().tz('Asia/Jakarta').format('DD-MM-YYYY HH:mm:ss');
const wibNowLog = () => moment().tz('Asia/Jakarta').format('DD MMMM YYYY - HH:mm:ss');

function sendNotif(text, options = {}) {
  return bot.telegram.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML', ...options })
    .catch(e => console.error(`[${NOTIF_PREFIX}] Notif error:`, e.message));
}

// ============================================================
//  FITUR BARU 1: AUTO-BACKUP JAM 3 PAGI
// ============================================================
cron.schedule('0 3 * * *', () => {
  console.log(`[${NOTIF_PREFIX}] Menjalankan Auto-Backup Jam 3 Pagi...`);
  createBackupZip().then(async ({ zipPath, zipName, size }) => {
    cleanOldBackups();
    const cap = `📦 <b>${NOTIF_PREFIX} AUTO-BACKUP</b>\n\n<blockquote>📁 File: <code>${zipName}</code>\n📦 Size: ${(size / 1024 / 1024).toFixed(2)} MB\n🕐 ${wibNow()} WIB</blockquote>`;
    await bot.telegram.sendDocument(TELEGRAM_CHAT_ID, { source: fs.createReadStream(zipPath), filename: zipName }, { caption: cap, parse_mode: "HTML" });
    try { fs.unlinkSync(zipPath); } catch {}
  }).catch(e => console.error("Auto Backup Error:", e.message));
}, { timeZone: 'Asia/Jakarta' });

// ============================================================
//  FITUR BARU 2: PING GATEWAY (CEK MATI ATAU IDUP)
// ============================================================
let isGatewayDown = false;
setInterval(async () => {
  try {
    await axios.get(`${API_URL}/summary`, { timeout: 5000 });
    if (isGatewayDown) {
        sendNotif(`✅ <b>[${NOTIF_PREFIX}] GATEWAY KEMBALI NORMAL</b>\n\n<blockquote>Koneksi ke Gateway (port 4003) sudah pulih.</blockquote>`);
        isGatewayDown = false;
    }
  } catch (e) {
    if (!isGatewayDown) {
        sendNotif(`🚨 <b>[${NOTIF_PREFIX}] GATEWAY MATI!</b>\n\n<blockquote>Bot tidak bisa konek ke Gateway (port 4003).\n\n⚠️ Segera restart server atau cek VPS!</blockquote>`);
        isGatewayDown = true;
    }
  }
}, 5 * 60 * 1000); // Cek tiap 5 menit

// ============================================================
//  HELPER: FETCH REALTIME (FIX BYPASS TANGGAL WIB)
// ============================================================
async function fetchRealtimeFromGateway() {
  try {
    const startTime = nowUnix() - (30 * 86400); 
    const res = await axios.get(`${GATEWAY_URL}/transactions?startTime=${startTime}&endTime=${nowUnix()}&pageSize=100`, { headers: { 'X-API-Key': API_KEY }, timeout: 30000 });
    const txs = res.data?.data?.transactions || [];
    const todayStr = moment().tz('Asia/Jakarta').format('YYYY-MM-DD');
    const monthStr = moment().tz('Asia/Jakarta').format('YYYY-MM');

    let todayTotal = 0, todayCount = 0, monthTotal = 0, monthCount = 0;
    const todayIssuers = {}; const monthIssuers = {};

    txs.forEach(t => {
      const rawTime = t.time || t.created_at || t.transaction_time || t.date;
      if (!rawTime) return;
      let m = moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');
      if (!m.isValid()) m = moment.tz(rawTime, 'Asia/Jakarta');

      if (m.isValid()) {
        const txDate = m.format('YYYY-MM-DD');
        const txMonth = m.format('YYYY-MM');
        const amt = Number(t.amount || t.total || 0);
        const k = t.issuer || 'QRIS';

        if (txDate === todayStr) {
          todayTotal += amt; todayCount++;
          todayIssuers[k] ??= { amount: 0, count: 0 };
          todayIssuers[k].amount += amt; todayIssuers[k].count++;
        }
        if (txMonth === monthStr) {
          monthTotal += amt; monthCount++;
          monthIssuers[k] ??= { amount: 0, count: 0 };
          monthIssuers[k].amount += amt; monthIssuers[k].count++;
        }
      }
    });
    return { today: { total: todayTotal, count: todayCount, issuers: todayIssuers }, month: { total: monthTotal, count: monthCount, issuers: monthIssuers } };
  } catch (e) { console.error("Fetch error:", e.message); return null; }
}

async function getRealtimeData(forceRefresh = false) {
  for (let i = 0; i < 3; i++) {
    const data = await fetchRealtimeFromGateway();
    if (data) {
        if (data.today.count === 0 && data.month.count === 0 && i < 2) {
            await new Promise(r => setTimeout(r, 2000)); continue; 
        }
        return data;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { today: { total: 0, count: 0, issuers: {} }, month: { total: 0, count: 0, issuers: {} } };
}

// ============================================================
//  TOKEN STATUS (STRICT VALIDATION)
// ============================================================
let lastTokenStatus = null;
let isTokenInvalidNoticeSent = false; // Biar gak nyepam notif maintenance

async function checkTokenStatus(isStartup = false) {
  try {
    const r = await axios.get(`${GATEWAY_URL}/token-status`, { headers: { 'X-API-Key': API_KEY }, timeout: 15000 });
    const gatewayStatus = r.data?.data?.token_status || 'unknown';
    let finalStatus = gatewayStatus;
    if (gatewayStatus === 'valid') {
      try {
        await axios.get(`${GATEWAY_URL}/transactions?startTime=${nowUnix() - 86400}&endTime=${nowUnix()}&pageSize=1`, { headers: { 'X-API-Key': API_KEY }, timeout: 10000 });
        finalStatus = 'valid';
      } catch (err) { finalStatus = 'invalid'; }
    }

    if (!isStartup && finalStatus !== lastTokenStatus) {
      if (finalStatus === 'valid') {
        sendNotif(`✅ <b>[${NOTIF_PREFIX}] TOKEN VALID</b>\n\n<blockquote>🔑 Token Shopee aktif & bekerja.</blockquote>`);
        isTokenInvalidNoticeSent = false;
      } else if (finalStatus === 'invalid') {
        sendNotif(`⚠️ <b>[${NOTIF_PREFIX}] TOKEN INVALID!</b>\n\n<blockquote>❌ Token palsu/expired.\n🔧 Update via tombol Update Token.</blockquote>`);
        isTokenInvalidNoticeSent = true;
      }
    }
    lastTokenStatus = finalStatus;
    return finalStatus;
  } catch (e) {
    if (!isStartup && lastTokenStatus !== 'error') { sendNotif(`❌ <b>[${NOTIF_PREFIX}] GAGAL CEK TOKEN</b>\n\n<blockquote>⚠️ ${e.message}</blockquote>`); lastTokenStatus = 'error'; }
    return 'error';
  }
}

function getCurrentTokenFromEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return 'Tidak ditemukan';
    const env = fs.readFileSync(ENV_PATH, 'utf8');
    const m = env.match(/SHOPEE_TOKEN=["']?(.*?)["']?(\r?\n|$)/);
    return (m && m[1]) ? m[1] : 'Kosong';
  } catch { return 'Error baca .env'; }
}
function updateEnvToken(newToken) {
  try {
    if (!fs.existsSync(ENV_PATH)) return false;
    let c = fs.readFileSync(ENV_PATH, 'utf8');
    if (c.includes('SHOPEE_TOKEN=')) c = c.replace(/SHOPEE_TOKEN=.*/g, `SHOPEE_TOKEN="${newToken}"`);
    else c += `\nSHOPEE_TOKEN="${newToken}"\n`;
    fs.writeFileSync(ENV_PATH, c); return true;
  } catch { return false; }
}

// ============================================================
//  EXPRESS PROXY (FIX MAINTENANCE MODE & NOTIF)
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Shopee-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/summary', async (req, res) => { res.json({ success: true, data: await getRealtimeData() }); });

app.all('*', async (req, res) => {
  // Fitur Baru: Tolak QRIS kalau token invalid
  if (req.path === '/create-qris' && lastTokenStatus === 'invalid') {
      return res.status(503).json({ success: false, error: "Server dalam mode Maintenance (Token Invalid). Harap hubungi admin." });
  }

  try {
    const response = await axios({
      method: req.method, url: `${GATEWAY_URL}${req.originalUrl}`, data: req.body,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json', 'X-API-Key': req.headers['x-api-key'] || '', 'X-Shopee-Token': req.headers['x-shopee-token'] || '', 'Host': req.headers['host'] || '' },
      validateStatus: () => true, responseType: 'arraybuffer', maxRedirects: 0,
    });
    for (const [k, v] of Object.entries(response.headers)) {
      const lk = k.toLowerCase();
      if (lk !== 'content-encoding' && lk !== 'transfer-encoding') res.set(k, v);
    }
    const ct = response.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      const bodyStr = Buffer.from(response.data).toString('utf8');
      let body;
      try { body = JSON.parse(bodyStr); } catch { return res.status(response.status).send(bodyStr); }
      if (req.path === '/create-qris' && body?.success && body.data) {
        const txId = body.data.transactionId || body.data.id || body.data.qris_url?.split('/').pop() || '-';
        sendNotif(`🛒 <b>PEMBAYARAN QRIS BARU DIBUAT</b>\n\n<blockquote>💰 Nominal: <b>Rp ${rupiah(body.data.amount)}</b>\n🧾 TrxID: <code>${txId}</code>\n⏰ Expires: ${body.data.expires_at || '-'}</blockquote>\n<blockquote>🔗 <code>${body.data.qris_url || '-'}</code></blockquote>`);
      }
      if (req.path === '/check-payment' && body?.paid) {
        const tx = body.transaction || {}; const amount = Number(tx.amount || tx.total || 0); const issuer = tx.issuer || 'QRIS';
        const txId = tx.transactionId || tx.id || tx.trx_id || '-';
        sendNotif(`✅ <b>PEMBAYARAN QRIS BERHASIL</b>\n\n<blockquote><b>「 DETAIL PEMBAYARAN 」</b>\n💰 Nominal: <b>Rp ${rupiah(amount)}</b>\n💳 Metode: ${issuer}\n🧾 TrxID: <code>${txId}</code>\n🕐 Waktu: ${wibNow()} WIB</blockquote>`);
      }
      return res.status(response.status).json(body);
    }
    res.status(response.status).send(Buffer.from(response.data));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(WRAPPER_PORT, () => { console.log(chalk.bold.green(`[${NOTIF_PREFIX}] Express proxy listening on ${WRAPPER_PORT} ➡️ ${GATEWAY_PORT}`)); });

// ============================================================
//  CRON & NOTIF RAM
// ============================================================
cron.schedule('59 16 * * *', async () => {
  try {
    const rt = await getRealtimeData(true); 
    if (rt.today.count === 0 && rt.month.count === 0) return; 
    const entries = Object.entries(rt.today.issuers).sort((a, b) => b[1].amount - a[1].amount);
    const rincian = entries.length ? entries.map(([n, d]) => `  • ${n}: Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") : '  • Belum ada transaksi';
    sendNotif(
      `📝 <b>[${NOTIF_PREFIX}] LAPORAN HARIAN</b>\n\n` +
      `<blockquote>📅 Tanggal: ${moment().tz('Asia/Jakarta').format('DD-MM-YYYY')}\n💰 Total: Rp ${rupiah(rt.today.total)}\n📈 Transaksi: ${rt.today.count}</blockquote>\n` +
      `<blockquote>💳 Rincian:\n${rincian}</blockquote>\n\n` +
      `<i>📊 Total Bulan Ini: Rp ${rupiah(rt.month.total)} (${rt.month.count} tx)</i>`
    );
  } catch (err) { console.error("Cron Laporan Error:", err.message); }
});

setInterval(() => {
  const totalMem = os.totalmem(); const freeMem = os.freemem();
  const percentFree = (freeMem / totalMem) * 100;
  if (percentFree < 15) {
    sendNotif(`⚠️ <b>[${NOTIF_PREFIX}] PERINGATAN RAM VPS!</b>\n\n<blockquote>Sisa RAM VPS tinggal <b>${percentFree.toFixed(1)}%</b>.\nSegera restart service atau hapus file yang gak perlu biar gak crash!</blockquote>`);
  }
}, 60 * 60 * 1000);

// ============================================================
//  BACKUP HELPER
// ============================================================
function createBackupZip() {
  return new Promise((resolve, reject) => {
    const ts = moment().tz('Asia/Jakarta').format('YYYY-MM-DD-HH-mm-ss');
    const zipName = `backup-shopee2-${ts}.zip`;
    const zipPath = path.join(BACKUP_DIR, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve({ zipPath, zipName, size: archive.pointer() }));
    archive.on('error', reject); archive.pipe(output);
    if (fs.existsSync(ENV_PATH)) archive.file(ENV_PATH, { name: '.env' });
    if (fs.existsSync(DB_ADMIN_PATH)) archive.file(DB_ADMIN_PATH, { name: 'admin.json' });
    archive.glob('**/*', { cwd: __dirname, ignore: ['node_modules/**', 'backup/**', '.git/**', 'package-lock.json'] });
    archive.finalize();
  });
}
function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-') && f.endsWith('.zip')).map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.time - a.time);
    if (files.length > MAX_BACKUP_FILES) files.slice(MAX_BACKUP_FILES).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch {} });
  } catch {}
}

// ============================================================
//  STARTUP (READY)
// ============================================================
(async () => {
  console.log(chalk.bold.yellow(`[${NOTIF_PREFIX}] Booting...`));
  sendNotif(`🔄 <b>[${NOTIF_PREFIX}] WRAPPER STARTING</b>\n\n<blockquote expandable>Sedang memuat data dan memeriksa token...\nMohon tunggu sebentar.</blockquote>`);
  await new Promise(r => setTimeout(r, 10000));
  const status = await checkTokenStatus(true);
  const isValid = status === 'valid';
  let rt = null;
  if (isValid) {
    for (let i = 0; i < 3; i++) {
      rt = await getRealtimeData(true);
      if (rt && (rt.today.count > 0 || rt.month.count > 0)) break;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  let laporan = `🚀 <b>[${NOTIF_PREFIX}] SYSTEM READY</b>\n\n<blockquote>🌐 Proxy: <code>${WRAPPER_PORT}</code> ➡️ Gateway: <code>${GATEWAY_PORT}</code>\n🔑 Token: ${isValid ? '✅ VALID' : '❌ INVALID'}</blockquote>\n\n`;
  if (isValid && rt) {
    laporan += `📅 <b>LAPORAN HARI INI</b>\n<blockquote>💵 Total: <b>Rp ${rupiah(rt.today.total)}</b>\n📈 Transaksi: ${rt.today.count}</blockquote>\n\n📊 <b>LAPORAN BULAN INI</b>\n<blockquote>💵 Total: <b>Rp ${rupiah(rt.month.total)}</b>\n📈 Transaksi: ${rt.month.count}</blockquote>\n\n`;
  }
  laporan += `<i>🕐 ${wibNow()} WIB</i>`;
  sendNotif(laporan);
})();

setInterval(() => checkTokenStatus(false), 5 * 60 * 1000);

// ============================================================
//  UI MENU
// ============================================================
const menuCaption = (ctx) => {
  const name = ((ctx.from.first_name || '') + (ctx.from.last_name ? ' ' + ctx.from.last_name : '')).trim() || 'User';
  return `
<b>🛍️ ${NOTIF_PREFIX}</b>
<blockquote>⎨ Bot : ${NOTIF_PREFIX}
⎨ Mode : Gateway Proxy Shopeepay
⎨ Status : Online 🟢</blockquote>

<b>👤 INFORMASI USER</b>
<blockquote>⎨ Name : ${name}
⎨ ID : <code>${ctx.from.id}</code>
⎨ Chat : ${ctx.chat.type === 'private' ? 'Private' : 'Group'}</blockquote>

<i>Silakan pilih menu di bawah 👇</i>
`;
};

const mainKeyboard = [
  [{ text: "📈 Laporan", callback_data: "sh_laporan", style: "primary" }, { text: "🧾 Transaksi", callback_data: "sh_hist", style: "primary" }],
  [{ text: "💳 Bikin QRIS", callback_data: "sh_qr_menu", style: "success" }, { text: "🔍 Cek Payment", callback_data: "sh_cekpayment_menu", style: "primary" }],
  [{ text: "🔧 Update Token", callback_data: "sh_update_token_menu", style: "danger" }, { text: "🔄 Restart", callback_data: "sh_restart_menu", style: "danger" }],
  [{ text: "👑 Admin Menu", callback_data: "sh_admin_menu", style: "primary" }, { text: "💻 Sysinfo", callback_data: "sh_sysinfo", style: "primary" }],
  [{ text: "📦 Backup", callback_data: "sh_backup", style: "success" }, { text: "🏓 Ping", callback_data: "sh_ping", style: "primary" }],
  [{ text: "📜 Logs PM2", callback_data: "sh_logs", style: "danger" }, { text: "🔑 Cek Token", callback_data: "sh_token", style: "primary" }],
  [{ text: "📤 Update File", callback_data: "sh_update_file_menu", style: "danger" }],
  [{ text: "🗑️ Kelola Backup", callback_data: "sh_manage_backup", style: "danger" }],
  [{ text: "👨‍💻 Developer", url: "https://t.me/rulzz2nd", style: "primary" }]
];

function checkAccess(ctx, ownerOnly = false) {
  if (ownerOnly && !isOwner(ctx.from.id)) { ctx.answerCbQuery("❌ Fitur ini khusus Owner!", { show_alert: true }).catch(() => {}); return false; }
  if (!ownerOnly && !isAdmin(ctx.from.id)) { ctx.answerCbQuery("❌ Akses Ditolak! Anda bukan Admin.", { show_alert: true }).catch(() => {}); return false; }
  return true;
}

bot.start(async (ctx) => { return ctx.reply(menuCaption(ctx), { parse_mode: "HTML", reply_markup: { inline_keyboard: mainKeyboard } }); });
bot.action("mainmenu", (ctx) => { ctx.answerCbQuery().catch(() => {}); ctx.editMessageText(menuCaption(ctx), { parse_mode: "HTML", reply_markup: { inline_keyboard: mainKeyboard } }).catch(() => {}); });

bot.action("sh_laporan", (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText("📈 <b>MENU LAPORAN</b>\n\n<blockquote>Pilih laporan yang mau dilihat:</blockquote>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📊 Laporan Lengkap (Real-time & 7 Hari)", callback_data: "sh_all_reports", style: "primary" }],
      [{ text: "🗓️ Rekap Bulanan", callback_data: "sh_rekap", style: "success" }],
      [{ text: "📥 Export CSV", callback_data: "sh_export_menu", style: "success" }],
      [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "danger" }]
    ] },
  }).catch(() => {});
});

// ============================================================
//  FITUR BARU 3: BROADCAST (KHUSUS OWNER)
// ============================================================
bot.command("broadcast", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya Owner.");
  const msg = ctx.message.text.split(" ").slice(1).join(" ");
  if (!msg) return ctx.reply("Format: /broadcast Pesan Anda");
  
  const admins = getAdmins();
  let success = 0;
  for (const id of admins) {
    try { await bot.telegram.sendMessage(id, `📢 <b>PENGUMUMAN DARI OWNER</b>\n\n<blockquote>${msg}</blockquote>`, { parse_mode: "HTML" }); success++; } catch (e) {}
  }
  ctx.reply(`✅ Broadcast terkirim ke ${success} admin.`);
});

// ============================================================
//  FITUR UPDATE FILE (MANUAL PILIH FOLDER)
// ============================================================
const waitingForFileUpdate = new Set();
const pendingNewFile = new Map();
const pendingUploadFile = new Map();
const pendingRenameFile = new Map();
const pendingOverwrite = new Map();
const fileToServiceMap = { 'wrapper.js': 'wrapper-shopee', 'server.js': 'shopee-2' };

bot.action("sh_update_file_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  waitingForFileUpdate.add(String(ctx.from.id));
  ctx.editMessageText(`📤 <b>UPDATE FILE PROJECT</b>\n\n<blockquote>Silakan kirim file <code>.js</code> atau <code>.json</code> ke chat ini.\n\nSistem akan otomatis me-restart PM2 setelah update.</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel_update_file", style: "danger" }]] }
  }).catch(() => {});
});

bot.action("cancel_update_file", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  waitingForFileUpdate.delete(String(ctx.from.id));
  ctx.editMessageText("❌ <b>UPDATE FILE DIBATALKAN</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
});

bot.on('document', async (ctx) => {
  const userId = String(ctx.from.id);
  if (waitingForFileUpdate.has(userId)) {
    const doc = ctx.message.document; const fileName = doc.file_name;
    pendingUploadFile.set(userId, { file_id: doc.file_id, file_name: fileName });
    waitingForFileUpdate.delete(userId); 
    ctx.reply(`📁 <b>PILIH FOLDER TUJUAN</b>\n\n<blockquote>File: <code>${fileName}</code></blockquote>`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "🏠 Root (Folder Utama)", callback_data: "up_to_root", style: "primary" }],
        [{ text: "🌐 Public", callback_data: "up_to_public", style: "success" }, { text: "⚙️ Src", callback_data: "up_to_src", style: "primary" }],
        [{ text: "✍️ Custom Folder / Rename", callback_data: "up_custom", style: "danger" }],
        [{ text: "❌ Batal", callback_data: "cancel_update_file", style: "danger" }]
      ] }
    });
    return;
  }
});

bot.action(/^up_to_(root|public|src)$/, async (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id); const folder = ctx.match[1]; const pending = pendingUploadFile.get(userId);
  if (!pending) return ctx.editMessageText("❌ Sesi habis, kirim ulang file-nya.").catch(() => {});
  let targetDir = __dirname;
  if (folder === 'public') targetDir = path.join(__dirname, 'public');
  if (folder === 'src') targetDir = path.join(__dirname, 'src');
  await saveFileToDir(ctx, pending.file_id, pending.file_name, targetDir);
  pendingUploadFile.delete(userId);
});

bot.action("up_custom", async (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id); const pending = pendingUploadFile.get(userId);
  if (!pending) return ctx.editMessageText("❌ Sesi habis, kirim ulang file-nya.").catch(() => {});
  pendingRenameFile.set(userId, pending); pendingUploadFile.delete(userId);
  ctx.editMessageText(`✍️ <b>CUSTOM FOLDER / RENAME</b>\n\n<blockquote>Ketik nama folder beserta nama file.\nContoh: <code>public/index.html</code></blockquote>`, { parse_mode: "HTML" }).catch(() => {});
});

async function saveFileToDir(ctx, fileId, fileName, targetDir) {
  const userId = String(ctx.from.id); const targetPath = path.join(targetDir, fileName);
  if (fs.existsSync(targetPath)) {
    pendingOverwrite.set(userId, { fileId, fileName, targetDir, targetPath });
    return ctx.reply(`⚠️ <b>FILE SUDAH ADA!</b>\n\n<blockquote>File <code>${fileName}</code> sudah ada.\nYakin ingin <b>MENIMPA</b>?</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✅ Ya, Timpa File", callback_data: "overwrite_yes", style: "danger" }], [{ text: "❌ Batal", callback_data: "overwrite_no", style: "primary" }]] }
    });
  }
  await doSaveFile(ctx, fileId, fileName, targetDir, targetPath);
}

bot.action("overwrite_yes", async (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id); const pending = pendingOverwrite.get(userId);
  if (!pending) return ctx.editMessageText("❌ Sesi habis.").catch(() => {});
  pendingOverwrite.delete(userId); ctx.deleteMessage().catch(() => {});
  await doSaveFile(ctx, pending.fileId, pending.fileName, pending.targetDir, pending.targetPath);
});

bot.action("overwrite_no", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  pendingOverwrite.delete(String(ctx.from.id));
  ctx.editMessageText("❌ <b>PENIMPAAN DIBATALKAN</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
});

async function doSaveFile(ctx, fileId, fileName, targetDir, targetPath) {
  const loadingMsg = await ctx.reply(`⏳ <i>Menyimpan file...</i>`, { parse_mode: "HTML" });
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
    if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, `${targetPath}_backup_${Date.now()}`);
    const writer = fs.createWriteStream(targetPath); response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    let isRestart = false; let targetService = '-';
    if (fileName.endsWith('.js')) { targetService = fileToServiceMap[fileName] || 'wrapper-shopee'; isRestart = true; }
    let successMsg = `✅ <b>FILE BERHASIL DISIMPAN!</b>\n\n<blockquote>📁 Lokasi: <code>${targetDir.replace(__dirname, '') || '/'}</code>\n`;
    if (isRestart) successMsg += `🔄 Merestart service <code>${targetService}</code>...</blockquote>`;
    else successMsg += `🔄 File statis diganti.</blockquote>`;
    await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, successMsg, { parse_mode: "HTML" }).catch(() => {});
    if (isRestart) {
        await ctx.reply(`🚀 <b>SUKSES!</b>\n\n<blockquote>File <code>${fileName}</code> berjalan.\nService <code>${targetService}</code> restart...</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
        const { spawn } = require('child_process'); const child = spawn('pm2', ['restart', targetService], { detached: true, stdio: 'ignore' }); child.unref();
    }
  } catch (error) {
    ctx.reply(`❌ <b>GAGAL SIMPAN FILE</b>\n\n<blockquote>${error.message}</blockquote>`, { parse_mode: "HTML" });
  }
}

// ============================================================
//  EXPORT CSV & REKAP
// ============================================================
bot.action("sh_export_menu", (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  const now = moment().tz('Asia/Jakarta'); const opts = [];
  for (let i = 0; i < 6; i++) { const m = now.clone().subtract(i, 'months'); opts.push([{ text: m.format('MMMM YYYY'), callback_data: `export_${m.format('MM-YYYY')}`, style: "primary" }]); }
  opts.push([{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "danger" }]);
  ctx.editMessageText("📥 <b>PILIH BULAN UNTUK EXPORT CSV</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: opts } }).catch(() => {});
});

bot.action(/^export_(\d{2}-\d{4})$/, (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery("⏳ Menyiapkan CSV...").catch(() => {});
  const match = ctx.match[1].split('-'); const month = match[0]; const year = match[1];
  ctx.reply(`⏳ <i>Mengambil data transaksi bulan ${month}-${year}...</i>`, { parse_mode: "HTML" }).then(loading => {
    const startUnix = moment(`${year}-${month}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').startOf('month').unix();
    const endUnix = moment(`${year}-${month}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').endOf('month').unix();
    axios.get(`${GATEWAY_URL}/transactions?startTime=${startUnix}&endTime=${endUnix}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } })
      .then(res => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const txs = res.data?.data?.transactions || [];
        if (!txs.length) return ctx.reply(`Belum ada transaksi di bulan ${month}-${year}.`);
        let csv = "Tanggal,TrxID,Issuer,Nominal,Status\n";
        txs.forEach((t, i) => {
          const rawTgl = t.time || t.created_at || t.transaction_time || t.date || moment().format('YYYY-MM-DD HH:mm:ss');
          const tgl = moment(rawTgl).format('YYYY-MM-DD HH:mm:ss');
          const trxId = t.transactionId || t.trx_id || t.id || t.reference_id || t.order_id || t.invoice_number || `TRX-${moment().format('YYYYMMDD')}-${i + 1}`;
          const issuer = t.issuer || t.payment_method || "QRIS"; const nominal = t.amount || t.total || 0; const status = "Success"; 
          csv += `"${tgl}","${trxId}","${issuer}",${nominal},"${status}"\n`;
        });
        const filePath = path.join(BACKUP_DIR, `export-${month}-${year}.csv`); fs.writeFileSync(filePath, csv);
        ctx.replyWithDocument({ source: fs.createReadStream(filePath), filename: `Rekap_${month}_${year}.csv` }, {
          caption: `📊 <b>EXPORT CSV BULAN ${month}-${year}</b>\n\n<blockquote>Total: ${txs.length} Transaksi\n🕐 ${wibNow()} WIB</blockquote>`,
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_export_menu", style: "primary" }]] }
        }).catch(() => {});
        setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 10000);
      }).catch(e => { ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {}); ctx.reply("❌ Gagal export data: " + e.message); });
  }).catch(() => {});
});

bot.action("sh_all_reports", (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  ctx.reply("⏳ <i>Mengambil semua data laporan...</i>", { parse_mode: "HTML" }).then(loading => {
    const startUnix = moment().tz('Asia/Jakarta').subtract(6, 'days').startOf('day').unix();
    Promise.all([ getRealtimeData(true), axios.get(`${GATEWAY_URL}/transactions?startTime=${startUnix}&endTime=${nowUnix()}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } }) ])
    .then(([rt, res7Hari]) => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const rH = Object.entries(rt.today.issuers).sort((a, b) => b[1].amount - a[1].amount).map(([n, d]) => `  • ${n}: Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") || "  • Belum ada transaksi";
        const rB = Object.entries(rt.month.issuers).sort((a, b) => b[1].amount - a[1].amount).map(([n, d]) => `  • ${n}: Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") || "  • Belum ada transaksi";
        let out = `\n<b>📊 STATS REAL-TIME</b>\n<b>📅 HARI INI</b>\n<blockquote>💵 Total: <b>Rp ${rupiah(rt.today.total)}</b>\n📈 Transaksi: ${rt.today.count}\n💳 Rincian:\n${rH}</blockquote>\n\n<b>📊 BULAN INI</b>\n<blockquote expandable>💵 Total: <b>Rp ${rupiah(rt.month.total)}</b>\n📈 Transaksi: ${rt.month.count}\n💳 Rincian:\n${rB}</blockquote>\n`;
        const fmtTop = (arr) => arr.length ? arr.map(([n, d], i) => `${i + 1}. <b>${n}</b> — Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") : "Belum ada transaksi";
        const topToday = Object.entries(rt.today.issuers).sort((a, b) => b[1].amount - a[1].amount); const topMonth = Object.entries(rt.month.issuers).sort((a, b) => b[1].amount - a[1].amount);
        out += `\n<b>💳 TOP ISSUER</b>\n<b>📅 HARI INI</b>\n<blockquote expandable>${fmtTop(topToday)}</blockquote>\n<b>📊 BULAN INI</b>\n<blockquote expandable>${fmtTop(topMonth)}</blockquote>\n`;
        const txs = res7Hari.data?.data?.transactions || []; const days = {};
        for (let i = 6; i >= 0; i--) { const d = moment().tz('Asia/Jakarta').subtract(i, 'days').format('YYYY-MM-DD'); days[d] = 0; }
        txs.forEach(t => {
          try {
            const rawTime = t.time || t.created_at || t.transaction_time || t.date || t.timestamp || t.createdAt; if (!rawTime) return;
            let m = moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta'); if (!m.isValid()) m = moment.tz(rawTime, 'Asia/Jakarta');
            if (m.isValid()) { const d = m.format('YYYY-MM-DD'); if (days[d] !== undefined) days[d] += Number(t.amount || t.total || 0); }
          } catch (err) {}
        });
        out += `\n<b>📈 STATS 7 HARI TERAKHIR</b>\n<blockquote expandable>`;
        Object.entries(days).forEach(([d, total]) => { out += `📅 ${moment(d).format('DD-MM')} : Rp ${rupiah(total)}\n`; });
        out += `</blockquote>\n\n<i>🕐 ${wibNow()} WIB</i>`;
        ctx.reply(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]] } });
    }).catch(() => { ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {}); ctx.reply("❌ Gagal mengambil data laporan."); });
  }).catch(() => {});
});

bot.action("sh_rekap", (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  const now = moment().tz('Asia/Jakarta'); const opts = [];
  for (let i = 0; i < 6; i++) { const m = now.clone().subtract(i, 'months'); opts.push([{ text: m.format('MMMM YYYY'), callback_data: `rekap_${m.format('MM-YYYY')}` }]); }
  opts.push([{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]);
  ctx.editMessageText("📅 <b>PILIH BULAN UNTUK REKAP</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: opts } }).catch(() => {});
});

bot.action(/^rekap_(\d{2}-\d{4})$/, (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  const match = ctx.match[1].split('-'); const month = match[0]; const year = match[1];
  ctx.deleteMessage().catch(() => {});
  ctx.reply("⏳ <i>Mengambil data rekap...</i>", { parse_mode: "HTML" }).then(loading => {
    const startUnix = moment(`${year}-${month}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').startOf('month').unix();
    const endUnix = moment(`${year}-${month}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').endOf('month').unix();
    axios.get(`${GATEWAY_URL}/transactions?startTime=${startUnix}&endTime=${endUnix}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } })
      .then(res => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const txs = res.data?.data?.transactions || []; let total = 0; const issuers = {};
        txs.forEach(t => { const amt = Number(t.amount || t.total || 0); total += amt; const k = t.issuer || t.payment_method || 'Unknown'; issuers[k] ??= { amount: 0, count: 0 }; issuers[k].amount += amt; issuers[k].count++; });
        const rB = Object.entries(issuers).sort((a, b) => b[1].amount - a[1].amount).map(([n, d]) => `  • ${n}: Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") || "  • Belum ada transaksi";
        const out = `\n<b>📅 REKAP BULAN ${moment(`${year}-${month}-01`).format('MMMM YYYY').toUpperCase()}</b>\n<blockquote>💵 Total: <b>Rp ${rupiah(total)}</b>\n📈 Transaksi: ${txs.length}\n💳 Rincian:\n${rB}</blockquote>\n`;
        ctx.reply(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_rekap", style: "primary" }]] } });
      }).catch(() => { ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {}); ctx.reply("❌ Gagal mengambil data rekap.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]] } }); });
  }).catch(() => {});
});

// ============================================================
//  TRANSAKSI (PAGINATION)
// ============================================================
let allTxCache = [];
function renderHistoryPage(txs, page) {
  const perPage = 10; const slice = txs.slice(page * perPage, page * perPage + perPage);
  let out = `<b>🧾 RIWAYAT TRANSAKSI</b>\n\n`;
  if (slice.length === 0) { out += `<i>Belum ada transaksi di halaman ini.</i>`; } 
  else {
    slice.forEach((t, i) => {
      const idx = (page * perPage) + i + 1;
      const trxId = t.transactionId || t.trx_id || t.id || t.reference_id || t.order_id || t.invoice_number || `TRX-${moment().format('YYYYMMDD')}-${idx}`;
      const timeStr = t.time || t.created_at || t.transaction_time || t.date || '-';
      out += `<blockquote>${idx}. Rp ${rupiah(t.amount || t.total || 0)} | ${t.issuer || t.payment_method || 'QRIS'}\n🕐 ${timeStr}\n🧾 <code>${trxId}</code></blockquote>\n`;
    });
  }
  out += `\n<i>Halaman ${page + 1} / ${Math.ceil(txs.length / perPage) || 1}</i>`;
  return out;
}
function buildHistoryKeyboard(page, totalPages) {
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️ Sebelumnya", callback_data: `hist_${page - 1}`, style: "primary" });
  if (page < totalPages - 1) nav.push({ text: "Lanjut ➡️", callback_data: `hist_${page + 1}`, style: "primary" });
  const rows = []; if (nav.length) rows.push(nav);
  rows.push([{ text: "⬅️ Kembali ke Menu", callback_data: "mainmenu", style: "danger" }]);
  return rows;
}
bot.action("sh_hist", (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  ctx.reply("⏳ <i>Mengambil data dari server...</i>", { parse_mode: "HTML" }).then(loading => {
    const startTime = nowUnix() - 30 * 86400;
    axios.get(`${GATEWAY_URL}/transactions?startTime=${startTime}&endTime=${nowUnix()}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } })
      .then(res => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const txs = res.data?.data?.transactions || [];
        if (!txs.length) return ctx.reply("Belum ada transaksi.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } });
        allTxCache = txs; const totalPages = Math.ceil(txs.length / 10); const text = renderHistoryPage(txs, 0); const kb = { inline_keyboard: buildHistoryKeyboard(0, totalPages) };
        ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }).catch(() => {});
  }).catch(() => {});
});
bot.action(/^hist_(\d+)$/, (ctx) => {
  if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {});
  const page = parseInt(ctx.match[1]); const txs = allTxCache;
  if (!txs || txs.length === 0) return ctx.answerCbQuery("⚠️ Sesi habis, klik Transaksi lagi", { show_alert: true });
  const totalPages = Math.ceil(txs.length / 10); const text = renderHistoryPage(txs, page); const kb = { inline_keyboard: buildHistoryKeyboard(page, totalPages) };
  ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
});

// ============================================================
//  CEK TOKEN (FIX BUG SESSION)
// ============================================================
bot.action("sh_token", (ctx) => { 
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {}); 
  ctx.editMessageText("⏳ <i>Mengecek token...</i>", { parse_mode: "HTML" }).then(() => {
    setTimeout(() => {
      checkTokenStatus(false).then(status => {
        const token = getCurrentTokenFromEnv();
        let out = ""; let kb = [];
        if (status === "valid") {
          out = `✅ <b>Token VALID</b>\n\n<blockquote>TOKEN ANDA :</blockquote>\n<tg-spoiler>${token}</tg-spoiler>`;
          kb = [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]];
        } else {
          out = `❌ <b>Token INVALID</b>\n\n<blockquote>TOKEN ANDA :</blockquote>\n<tg-spoiler>${token}</tg-spoiler>\n\n<i>Segera update token agar bot berfungsi normal.</i>`;
          kb = [[{ text: "🔧 Update Token Sekarang", callback_data: "sh_update_token_menu", style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]];
        }
        ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }).catch(() => {});
      });
    }, 1000);
  }).catch(() => {});
});

// ============================================================
//  PING & SYSINFO
// ============================================================
bot.action("sh_ping", (ctx) => {
  ctx.answerCbQuery().catch(() => {}); 
  let sec = Math.floor(process.uptime()); const days = Math.floor(sec / 86400); sec %= 86400; const hrs = Math.floor(sec / 3600); sec %= 3600; const mins = Math.floor(sec / 60); sec %= 60;
  ctx.editMessageText(`🏓 <b>Pong!</b>\n\n<blockquote>Bot aktif & terhubung ke server.\nRuntime: ${days} Hari, ${hrs} Jam, ${mins} Menit, ${sec} Detik</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
});

bot.action("sh_sysinfo", (ctx) => {
  ctx.answerCbQuery().catch(() => {}); 
  const used = process.memoryUsage(); const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2); const ram = (used.heapUsed / 1024 / 1024).toFixed(2); const cpus = os.cpus();
  let sec = Math.floor(process.uptime()); const days = Math.floor(sec / 86400); sec %= 86400; const hrs = Math.floor(sec / 3600); sec %= 3600; const mins = Math.floor(sec / 60); sec %= 60;
  const uptimeStr = `${days} Hari, ${hrs} Jam, ${mins} Menit, ${sec} Detik`;
  const out = `💻 <b>SYSINFO VPS DETAIL</b>\n<blockquote>⏱️ <b>Uptime</b>: ${uptimeStr}\n🧠 <b>RAM Bot</b>: ${ram} MB\n💾 <b>RAM VPS</b>: ${freeMem} GB / ${totalMem} GB (Free/Total)\n🖥️ <b>OS</b>: ${os.type()} ${os.release()} (${os.arch()})\n⚙️ <b>CPU</b>: ${cpus[0].model}\n🔢 <b>Cores</b>: ${cpus.length}\n🌐 <b>IP</b>: ${Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address || '-'}\n📦 <b>Node.js</b>: ${process.version}</blockquote>`;
  ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🧠 Cek RAM", callback_data: "sh_cekram", style: "primary" }, { text: "🔄 Refresh", callback_data: "sh_sysinfo", style: "success" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }] ] } }).catch(() => {});
});

bot.action("sh_cekram", (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const used = process.memoryUsage(); const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2); const percentFree = ((os.freemem() / os.totalmem()) * 100).toFixed(1); const cpus = os.cpus(); const cpuLoad = os.loadavg()[0].toFixed(2);
  let diskStats = { total: "0", free: "0", percent: "0" }; let net = "N/A";
  exec('df -h / | tail -1', (err, stdout) => {
    if (!err) { const df = stdout.trim().split(/\s+/); diskStats = { total: df[1], free: df[3], percent: df[4] }; }
    exec('cat /proc/net/dev | tail -n +3', (err2, stdout2) => {
        if (!err2) { let rx = 0, tx = 0; stdout2.trim().split('\n').forEach(line => { const parts = line.trim().split(/\s+/); rx += parseInt(parts[1]); tx += parseInt(parts[9]); }); net = `Network In: ${(rx / 1024 / 1024).toFixed(2)} MB\nNetwork Out: ${(tx / 1024 / 1024).toFixed(2)} MB`; }
        const out = `🧠 <b>STATISTIK VPS</b>\n<blockquote>💾 <b>RAM</b>: ${freeMem} GB / ${totalMem} GB (Sisa ${percentFree}%)\n🤖 <b>RAM Bot</b>: ${(used.heapUsed / 1024 / 1024).toFixed(2)} MB\n⚙️ <b>CPU Load</b>: ${cpuLoad} (${cpus.length} Cores)\n💽 <b>Disk</b>: ${diskStats.percent} (Sisa ${diskStats.free})\n🌐 <b>Traffic</b>: \n${net}</blockquote>`;
        ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🔄 Refresh", callback_data: "sh_cekram", style: "success" }], [{ text: "⬅️ Kembali", callback_data: "sh_sysinfo", style: "primary" }] ] } }).catch(() => {});
    });
  });
});

// ============================================================
//  QRIS (FIX BUG EXPIRED, SESSION, & POLLING)
// ============================================================
const qrTemp = new Map(); let activeQrInterval = null; let activeQrMsgId = null; let activeQrAmount = 0; let activeQrExpiry = 0; let activeQrChatId = null; const waitingForQrAmount = new Set(); let isCheckingQr = false;
function clearQrInterval() { if (activeQrInterval) { clearInterval(activeQrInterval); activeQrInterval = null; } }

bot.action("sh_qr_menu", (ctx) => {
  ctx.answerCbQuery().catch(() => {}); 
  ctx.editMessageText(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>Ketik command <code>/qr 5000</code>\n\nAtau pilih nominal di bawah, atau klik "Nominal Bebas".</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "💰 Rp 1.000", callback_data: "qr_quick_1000" }, { text: "💰 Rp 5.000", callback_data: "qr_quick_5000" }], [{ text: "💰 Rp 10.000", callback_data: "qr_quick_10000" }, { text: "💰 Rp 20.000", callback_data: "qr_quick_20000" }], [{ text: "✍️ Nominal Bebas", callback_data: "qr_custom_amount", style: "success" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }] ] } }).catch(() => {});
});

bot.command("qr", async (ctx) => {
  const baseAmount = parseInt(ctx.message.text.split(" ")[1]); if (!baseAmount) return ctx.reply("❌ Format: /qr 5000");
  qrTemp.set(String(ctx.from.id), { baseAmount });
  await ctx.reply(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>💰 Nominal Dasar: <b>Rp ${rupiah(baseAmount)}</b>\n\nPilih tipe nominal:</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[ { text: "✅ Tanpa Fee", callback_data: "qr_nofee", style: "success" }, { text: "🎲 Pakai Fee Unik", callback_data: "qr_fee", style: "primary" } ], [{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] } });
});

bot.action(/^qr_quick_(\d+)$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {}); 
  const baseAmount = parseInt(ctx.match[1]); qrTemp.set(String(ctx.from.id), { baseAmount });
  ctx.editMessageText(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>💰 Nominal Dasar: <b>Rp ${rupiah(baseAmount)}</b>\n\nPilih tipe nominal:</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[ { text: "✅ Tanpa Fee", callback_data: "qr_nofee", style: "success" }, { text: "🎲 Pakai Fee Unik", callback_data: "qr_fee", style: "primary" } ], [{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] } }).catch(() => {});
});

bot.action("qr_custom_amount", (ctx) => {
  ctx.answerCbQuery().catch(() => {}); waitingForQrAmount.add(String(ctx.from.id));
  ctx.editMessageText("✍️ <b>NOMINAL BEBAS</b>\n\n<blockquote>Silakan ketik nominal angka QRIS yang diinginkan (tanpa titik/koma).\n\nContoh: <code>15000</code>\n\n<i>Ketik /cancel untuk membatalkan.</i></blockquote>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] } }).catch(() => {});
});

bot.action(/^qr_(nofee|fee|cancel)$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const key = String(ctx.from.id); const temp = qrTemp.get(key);
  if (ctx.match[1] === "cancel") { qrTemp.delete(key); return ctx.editMessageText("❌ <b>PEMBUATAN QRIS DIBATALKAN</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }
  if (!temp) return ctx.editMessageText("⚠️ Sesi habis. Buka menu QRIS lagi.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
  let finalAmount = temp.baseAmount; let uniqueCode = 0;
  if (ctx.match[1] === "fee") { uniqueCode = Math.floor(Math.random() * 30) + 1; finalAmount += uniqueCode; }
  qrTemp.delete(key); clearQrInterval();
  ctx.editMessageText("⏳ <i>Membuat QRIS...</i>", { parse_mode: "HTML" }).then(() => {
    axios.post(`${API_URL}/create-qris`, { amount: finalAmount }, { headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } })
      .then(async res => {
        if (!res.data.success) return ctx.editMessageText("❌ Gagal: " + res.data.error).catch(() => {});
        const qrId = res.data.data.qris_url.split("/").pop(); const imgRes = await axios.get(`${GATEWAY_URL}/qr/${qrId}`, { responseType: "arraybuffer" }); const imgBuffer = Buffer.from(imgRes.data, "binary");
        const expAtRaw = res.data.data.expires_at; const expAt = moment.tz(expAtRaw, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');
        activeQrAmount = finalAmount; activeQrExpiry = expAt.valueOf(); activeQrChatId = ctx.chat.id;
        await ctx.deleteMessage(ctx.callbackQuery.message.message_id).catch(() => {});
        const sentMsg = await ctx.replyWithPhoto({ source: imgBuffer }, { caption: `🛒 <b>PEMBAYARAN QRIS BARU DIBUAT</b>\n\n<blockquote>💰 Nominal: <b>Rp ${rupiah(temp.baseAmount)}</b>\n${uniqueCode > 0 ? `🎲 Kode Unik: <b>+${uniqueCode}</b>\n` : ''}💵 Total Bayar: <b>Rp ${rupiah(finalAmount)}</b>\n⏰ Expires: ${expAt.format('DD-MM-YYYY HH:mm:ss')} WIB\n\n<i>Menunggu pembayaran...</i></blockquote>`, parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🔄 Cek Status", callback_data: `qr_cek_${finalAmount}`, style: "primary" }], [{ text: "❌ Batalkan QRIS", callback_data: `qr_cancel_${finalAmount}`, style: "danger" }] ] } });
        activeQrMsgId = sentMsg.message_id; let isProcessing = false;
        activeQrInterval = setInterval(async () => {
          if (isProcessing) return; isProcessing = true;
          if (Date.now() > activeQrExpiry) { clearQrInterval(); bot.telegram.deleteMessage(activeQrChatId, activeQrMsgId).catch(() => {}); bot.telegram.sendMessage(activeQrChatId, `⌛ <b>PEMBAYARAN EXPIRED</b>\n\n<blockquote>QRIS untuk nominal <b>Rp ${rupiah(activeQrAmount)}</b> sudah melewati batas waktu.</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); return; }
          try {
            const check = await axios.post(`${API_URL}/check-payment`, { amount: activeQrAmount, startTime: nowUnix() - 3600 }, { headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } });
            if (check.data.success && check.data.paid) { clearQrInterval(); bot.telegram.deleteMessage(activeQrChatId, activeQrMsgId).catch(() => {}); bot.telegram.sendMessage(activeQrChatId, `✅ <b>PEMBAYARAN QRIS BERHASIL</b>\n\n<blockquote><b>「 DETAIL PEMBAYARAN 」</b>\n💰 Nominal: <b>Rp ${rupiah(activeQrAmount)}</b>\n💳 Metode: ${check.data.transaction.issuer || "QRIS"}\n🧾 TrxID: <code>${check.data.transaction.transactionId || '-'}</code>\n🕐 Waktu: ${wibNow()} WIB</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }
          } catch (err) {} isProcessing = false;
        }, POLL_INTERVAL_MS);
      }).catch(e => ctx.editMessageText("❌ Error: " + e.message).catch(() => {}));
  }).catch(() => {});
});

bot.action(/^qr_cek_(\d+)$/, async (ctx) => {
  if (isCheckingQr) return ctx.answerCbQuery("⏳ Tunggu bentar bang, masih ngecek...", { show_alert: true });
  isCheckingQr = true; const amount = parseInt(ctx.match[1]); await ctx.answerCbQuery("⏳ Mengecek status...").catch(() => {});
  try {
      const res = await axios.post(`${API_URL}/check-payment`, { amount, startTime: nowUnix() - 3600 }, { headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } });
      if (res.data.success && res.data.paid) { clearQrInterval(); ctx.deleteMessage(ctx.callbackQuery.message.message_id).catch(() => {}); ctx.reply(`✅ <b>PEMBAYARAN QRIS BERHASIL</b>\n\n<blockquote><b>「 DETAIL PEMBAYARAN 」</b>\n💰 Nominal: <b>Rp ${rupiah(amount)}</b>\n💳 Metode: ${res.data.transaction.issuer || "QRIS"}\n🧾 TrxID: <code>${res.data.transaction.transactionId || '-'}</code>\n🕐 Waktu: ${wibNow()} WIB</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }); }
      else { ctx.reply(`⏳ Status: <b>Menunggu Pembayaran</b>\n\n<blockquote>Nominal: Rp ${rupiah(amount)}\nSilakan scan QRIS di atas.</blockquote>`, { parse_mode: "HTML" }); }
  } catch (e) { ctx.reply("❌ Gagal cek status."); } finally { setTimeout(() => { isCheckingQr = false; }, 3000); }
});

bot.action(/^qr_cancel_(\d+)$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {}); const amt = ctx.match[1]; clearQrInterval(); ctx.deleteMessage(ctx.callbackQuery.message.message_id).catch(() => {});
  ctx.reply(`❌ <b>PEMBAYARAN DIBATALKAN</b>\n\n<blockquote>QRIS <b>Rp ${rupiah(amt)}</b> berhasil dibatalkan.</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } });
});

// ============================================================
//  ADMIN, CEK PAYMENT, UPDATE TOKEN
// ============================================================
bot.action("sh_admin_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  const admins = getAdmins(); let out = `👑 <b>MENU ADMIN</b>\n\n<blockquote>Ketik command berikut:\n<code>/addadmin [ID/Reply]</code> - Tambah Admin\n<code>/deladmin [ID/Reply]</code> - Hapus Admin</blockquote>\n\n<b>List Admin Saat Ini:</b>\n`;
  if (!admins.length) out += `- Belum ada admin tambahan.\n`; else admins.forEach(a => out += `- <code>${a}</code>\n`);
  ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
});
bot.command("addadmin", (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("❌ Khusus Owner."); let targetId = ctx.message.reply_to_message?.from?.id || ctx.message.text.split(" ")[1]; if (!targetId) return ctx.reply("Format: /addadmin [ID] atau reply pesan.");
  targetId = String(targetId).replace(/[^0-9]/g, ''); const admins = getAdmins(); if (admins.includes(targetId)) return ctx.reply("⚠️ ID sudah jadi admin."); admins.push(targetId); saveAdmins(admins);
  ctx.reply(`✅ <code>${targetId}</code> berhasil ditambahkan sebagai Admin.`, { parse_mode: "HTML" });
});
bot.command("deladmin", (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("❌ Khusus Owner."); let targetId = ctx.message.reply_to_message?.from?.id || ctx.message.text.split(" ")[1]; if (!targetId) return ctx.reply("Format: /deladmin [ID] atau reply pesan.");
  targetId = String(targetId).replace(/[^0-9]/g, ''); let admins = getAdmins(); if (!admins.includes(targetId)) return ctx.reply("⚠️ ID bukan admin."); admins = admins.filter(id => id !== targetId); saveAdmins(admins);
  ctx.reply(`✅ <code>${targetId}</code> dihapus dari Admin.`, { parse_mode: "HTML" });
});
bot.command("listadmin", (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("❌ Akses Ditolak."); const admins = getAdmins(); let out = `👑 <b>LIST ADMIN</b>\n\n<b>Owner:</b>\n- <code>${TELEGRAM_CHAT_ID}</code>\n\n<b>Admin Tambahan:</b>\n`;
  if (!admins.length) out += `- Belum ada admin tambahan.\n`; else admins.forEach(a => out += `- <code>${a}</code>\n`); ctx.reply(out, { parse_mode: "HTML" });
});

bot.action("sh_cekpayment_menu", (ctx) => {
  ctx.answerCbQuery().catch(() => {}); ctx.editMessageText(`🔍 <b>CEK PAYMENT</b>\n\n<blockquote>Ketik command:\n<code>/cekpayment 2027</code></blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
});
bot.command("cekpayment", (ctx) => {
  const amount = parseInt(ctx.message.text.split(" ")[1]); if (!amount) return ctx.reply("❌ Format: /cekpayment 2027");
  ctx.reply("⏳ <i>Mengecek pembayaran...</i>", { parse_mode: "HTML" }).then(loading => {
    axios.post(`${API_URL}/check-payment`, { amount, startTime: nowUnix() - 86400 }, { headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } })
      .then(res => { ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {}); const out = res.data.success && res.data.paid ? `✅ <b>PEMBAYARAN DITEMUKAN</b>\n\n<blockquote>💰 Nominal: Rp ${rupiah(amount)}\n💳 Metode: ${res.data.transaction.issuer || "QRIS"}</blockquote>` : `❌ <b>BELUM DIBAYAR</b>\n\n<blockquote>Tidak ada pembayaran Rp ${rupiah(amount)} dalam 24 jam terakhir.</blockquote>`; ctx.reply(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }); })
      .catch(e => { ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {}); ctx.reply("❌ Error: " + e.message); });
  }).catch(() => {});
});

const pendingTokenUpdate = new Map(); const waitingForTokenChat = new Set();
bot.action("sh_update_token_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); waitingForTokenChat.add(String(ctx.from.id));
  ctx.editMessageText(`🔧 <b>UPDATE TOKEN</b>\n\n<blockquote>Silakan <b>kirim pesan teks</b> berisi Token baru Anda sekarang.\n\nContoh:\n<code>B:xxxxxx</code>\n\n<i>Ketik /cancel untuk membatalkan.</i></blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel_update_token", style: "danger" }]] } }).catch(() => {});
});
bot.command("cancel", (ctx) => {
  if (waitingForTokenChat.has(String(ctx.from.id))) { waitingForTokenChat.delete(String(ctx.from.id)); return ctx.reply("❌ Update token dibatalkan."); }
  if (waitingForQrAmount.has(String(ctx.from.id))) { waitingForQrAmount.delete(String(ctx.from.id)); return ctx.reply("❌ Input nominal bebas dibatalkan."); }
  if (pendingTokenUpdate.has(String(ctx.from.id))) { pendingTokenUpdate.delete(String(ctx.from.id)); return ctx.reply("❌ Konfirmasi update token dibatalkan."); }
  if (waitingForFileUpdate.has(String(ctx.from.id))) { waitingForFileUpdate.delete(String(ctx.from.id)); return ctx.reply("❌ Update file dibatalkan."); }
});

bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  if (waitingForTokenChat.has(userId)) {
    if (!isOwner(ctx.from.id)) return; const newToken = ctx.message.text.trim(); if (!newToken || newToken.startsWith('/')) return;
    if (!newToken.startsWith('B:')) return ctx.reply("❌ <b>FORMAT SALAH!</b>\n\nToken Shopee harus diawali dengan <code>B:</code>\nContoh: <code>B:xxxxxxxx</code>", { parse_mode: "HTML" });
    waitingForTokenChat.delete(userId); pendingTokenUpdate.set(userId, newToken);
    await ctx.reply(`⚠️ <b>KONFIRMASI UPDATE TOKEN</b>\n\n<blockquote>Token Baru:\n<code>${newToken}</code></blockquote>\n\n<i>Yakin ganti token ini?</i>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[ { text: "✅ Yakin Update", callback_data: "confirm_update_token", style: "success" }, { text: "❌ Batal", callback_data: "cancel_update_token", style: "danger" } ]] } }); return; 
  }
  if (waitingForQrAmount.has(userId)) {
    const text = ctx.message.text.trim(); if (text.startsWith('/')) return; const amount = parseInt(text);
    if (isNaN(amount) || amount < 100) return ctx.reply("❌ Nominal tidak valid. Minimal Rp 100. Ketik angka saja (contoh: 15000).");
    waitingForQrAmount.delete(userId); qrTemp.set(userId, { baseAmount: amount });
    await ctx.reply(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>💰 Nominal Dasar: <b>Rp ${rupiah(amount)}</b>\n\nPilih tipe nominal:</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[ { text: "✅ Tanpa Fee", callback_data: "qr_nofee", style: "success" }, { text: "🎲 Pakai Fee Unik", callback_data: "qr_fee", style: "primary" } ], [{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] } }); return;
  }
  return next();
});

bot.action("confirm_update_token", async (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); const userId = String(ctx.from.id); const newToken = pendingTokenUpdate.get(userId);
  if (!newToken) return ctx.reply("Token expired, ulangi klik menu Update Token"); pendingTokenUpdate.delete(userId);
  await ctx.editMessageText("⏳ <i>Mengupdate token & apply...</i>", { parse_mode: "HTML" }).catch(() => {});
  try {
    const res = await axios.post(`${API_URL}/update-token`, { token: newToken }, { headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } });
    if (!res.data.success) return ctx.editMessageText(`❌ <b>GAGAL UPDATE</b>\n\n<blockquote>${res.data.error}</blockquote>`, { parse_mode: "HTML" }).catch(() => {});
    const saved = updateEnvToken(newToken);
    await ctx.editMessageText(`⏳ <b>TOKEN BERHASIL DI-UPDATE</b>\n\n<blockquote>File .env ${saved ? '✅ tersimpan' : '⚠️ gagal disimpan'}.\nSedang me-restart service & memvalidasi token (Mohon tunggu ±30 detik)...</blockquote>`, { parse_mode: "HTML" }).catch(() => {});
    exec("pm2 restart shopee-2 wrapper-shopee", (err) => {
      let attempts = 0; const maxAttempts = 5;
      const checkLoop = setInterval(async () => {
        attempts++; lastTokenStatus = null; const status = await checkTokenStatus(false);
        if (status === "valid") { clearInterval(checkLoop); ctx.reply(`✅ <b>SISTEM SIAP!</b>\n\n<blockquote>Token baru valid. Bot & Gateway sudah restart dan sinkron.</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }
        else if (attempts >= maxAttempts) { clearInterval(checkLoop); ctx.reply(`⚠️ <b>TOKEN TERSIMPAN, TAPI MASIH INVALID</b>\n\n<blockquote>Bot & Gateway sudah restart, tapi token masih belum valid setelah 50 detik.\n\nCoba cek ulang beberapa menit lagi atau pastikan token benar.</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🔑 Cek Token Lagi", callback_data: "sh_token", style: "primary" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }] ] } }).catch(() => {}); }
      }, 10000);
    });
  } catch (e) { ctx.editMessageText(`❌ <b>ERROR</b>\n\n<blockquote>${e.message}</blockquote>`, { parse_mode: "HTML" }).catch(() => {}); }
});
bot.action("cancel_update_token", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); waitingForTokenChat.delete(String(ctx.from.id)); pendingTokenUpdate.delete(String(ctx.from.id));
  ctx.editMessageText("❌ <b>UPDATE DIBATALKAN</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
});

// ============================================================
//  LOGS, RESTART, BACKUP, KELOLA BACKUP
// ============================================================
bot.action("sh_logs", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText("📜 <b>PILIH LOGS YANG MAU DILIHAT</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🤖 Logs Wrapper", callback_data: "log_wrapper", style: "primary" }], [{ text: "🌐 Logs Gateway", callback_data: "log_gateway", style: "success" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "danger" }] ] } }).catch(() => {});
});
function sendLogMessage(ctx, serviceName, title) {
  const logPath = path.join(process.env.HOME || '/root', '.pm2', 'logs', `${serviceName}-out.log`);
  fs.readFile(logPath, 'utf8', (err, data) => {
    if (err) {
        const errPath = path.join(process.env.HOME || '/root', '.pm2', 'logs', `${serviceName}-error.log`);
        return fs.readFile(errPath, 'utf8', (err2, data2) => {
            if (err2) return ctx.editMessageText(`❌ <b>Gagal baca log ${title}:</b>\n<code>${err.message}</code>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }]] } }).catch(() => {});
            const cleanLogs = data2.replace(/\x1B\[[0-9;]*[mGK]/g, '') || "Tidak ada log error."; const text = `<b>📜 LOGS ERROR ${title}</b>\n\n<blockquote expandable><code>${cleanLogs.slice(-3500)}</code></blockquote>`;
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: `🗑️ Clear Logs ${title}`, callback_data: `clear_${serviceName}`, style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }] ] } }).catch(() => {});
        });
    }
    const cleanLogs = data.replace(/\x1B\[[0-9;]*[mGK]/g, '') || "Tidak ada log."; const text = `<b>📜 LOGS ${title}</b>\n\n<blockquote expandable><code>${cleanLogs.slice(-3500)}</code></blockquote>`;
    ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: `🗑️ Clear Logs ${title}`, callback_data: `clear_${serviceName}`, style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }] ] } }).catch(() => {});
  });
}
bot.action("log_wrapper", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery("⏳ Membaca log wrapper...").catch(() => {}); sendLogMessage(ctx, "wrapper-shopee", "WRAPPER"); });
bot.action("log_gateway", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery("⏳ Membaca log gateway...").catch(() => {}); sendLogMessage(ctx, "shopee-2", "GATEWAY"); });
bot.action(/^clear_(.+)$/, (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery("⏳ Menghapus log...").catch(() => {}); const serviceName = ctx.match[1];
  exec(`pm2 flush ${serviceName}`, (err) => { if (err) return ctx.editMessageText(`❌ <b>Gagal clear log:</b>\n<code>${err.message}</code>`, { parse_mode: "HTML" }).catch(() => {}); ctx.editMessageText(`✅ <b>LOGS ${serviceName.toUpperCase()} BERHASIL DI-CLEAR</b>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali ke Logs", callback_data: "sh_logs", style: "primary" }]] } }).catch(() => {}); });
});

bot.action("sh_restart_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); 
  ctx.editMessageText("🔄 <b>PILIH JENIS RESTART</b>\n\n<blockquote>• <b>Restart Gateway</b>: Merestart API Shopee (port 4003).\n• <b>Restart Bot</b>: Merestart koneksi Telegram bot.\n• <b>Restart Semua</b>: Merestart Gateway + Bot (TIDAK nyentuh bot lain).</blockquote>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🔌 Restart Gateway", callback_data: "do_restart_gateway", style: "success" }], [{ text: "🤖 Restart Bot", callback_data: "do_restart_bot", style: "primary" }], [{ text: "♻️ Restart Semua", callback_data: "do_restart_all", style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }] ] } }).catch(() => {});
});
bot.action("do_restart_gateway", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); ctx.editMessageText("⏳ <i>Merestart Gateway...</i>", { parse_mode: "HTML" }).then(() => { exec("pm2 restart shopee-2", (err) => { setTimeout(() => { if (err) return ctx.editMessageText("❌ Gagal restart gateway: " + err.message).catch(() => {}); ctx.editMessageText("✅ <b>GATEWAY BERHASIL DI-RESTART!</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }, 500); }); }).catch(() => {}); });
bot.action("do_restart_bot", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); ctx.editMessageText("⏳ <i>Merestart Bot...</i>", { parse_mode: "HTML" }).then(() => { exec("pm2 restart wrapper-shopee", (err) => { setTimeout(() => { if (err) return ctx.editMessageText("❌ Gagal restart bot: " + err.message).catch(() => {}); ctx.editMessageText("✅ <b>BOT BERHASIL DI-RESTART!</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }, 500); }); }).catch(() => {}); });
bot.action("do_restart_all", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {}); ctx.editMessageText("⏳ <i>Merestart Gateway & Bot...</i>", { parse_mode: "HTML" }).then(() => { exec("pm2 restart shopee-2 wrapper-shopee", (err) => { setTimeout(() => { if (err) return ctx.editMessageText("❌ Gagal restart: " + err.message).catch(() => {}); ctx.editMessageText("✅ <b>GATEWAY & BOT BERHASIL DI-RESTART!</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }, 500); }); }).catch(() => {}); });

function doBackup(ctx) {
  ctx.reply("⏳ <i>Membuat backup...</i>", { parse_mode: "HTML" }).then(loadingMsg => {
    setTimeout(() => {
      createBackupZip().then(async ({ zipPath, zipName, size }) => {
        ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {}); cleanOldBackups();
        const cap = `📦 <b>${NOTIF_PREFIX} BACKUP MANUAL</b>\n\n<blockquote>📁 File: <code>${zipName}</code>\n📦 Size: ${(size / 1024 / 1024).toFixed(2)} MB\n🕐 ${wibNow()} WIB</blockquote>`;
        await ctx.replyWithDocument({ source: fs.createReadStream(zipPath), filename: zipName }, { caption: cap, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } });
        try { fs.unlinkSync(zipPath); } catch {}
      }).catch(e => { ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {}); ctx.reply(`❌ <b>BACKUP GAGAL</b>\n\n<blockquote>${e.message}</blockquote>`, { parse_mode: "HTML" }); });
    }, 2000);
  }).catch(() => {});
}
bot.command("backup", (ctx) => { if (!checkAccess(ctx)) return; doBackup(ctx); });
bot.action("sh_backup", (ctx) => { if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {}); doBackup(ctx); });

bot.action("sh_manage_backup", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  const files = fs.readdirSync(__dirname).filter(f => f.includes('_backup_') || f.includes('backup-'));
  if (files.length === 0) return ctx.editMessageText("📂 <b>DAFTAR BACKUP</b>\n\n<blockquote>Belum ada file backup.</blockquote>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
  let totalSize = 0; let listText = "";
  files.forEach((f, i) => { const stats = fs.statSync(path.join(__dirname, f)); totalSize += stats.size; const sizeMb = (stats.size / 1024 / 1024).toFixed(2); if (i < 10) listText += `  ${i + 1}. <code>${f}</code> (${sizeMb} MB)\n`; });
  if (files.length > 10) listText += `  <i>... dan ${files.length - 10} file lainnya</i>\n`;
  const totalMb = (totalSize / 1024 / 1024).toFixed(2);
  ctx.editMessageText(`📂 <b>DAFTAR BACKUP FILE</b>\n\n<blockquote>Total File: <b>${files.length}</b> file\nTotal Ukuran: <b>${totalMb} MB</b>\n\n${listText}</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "🗑️ Hapus Semua Backup", callback_data: "sh_clear_backup_yes", style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }] ] } }).catch(() => {});
});
bot.action("sh_clear_backup_yes", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText("⚠️ <b>KONFIRMASI HAPUS</b>\n\n<blockquote>Yakin mau menghapus <b>SEMUA</b> file backup?</blockquote>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [ [{ text: "✅ Ya, Hapus Semua", callback_data: "sh_do_clear_backup", style: "danger" }], [{ text: "❌ Batal", callback_data: "sh_manage_backup", style: "primary" }] ] } }).catch(() => {});
});
bot.action("sh_do_clear_backup", (ctx) => {
  if (!checkAccess(ctx, true)) return; ctx.answerCbQuery("⏳ Menghapus...").catch(() => {});
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.includes('_backup_') || f.includes('backup-')); let deletedCount = 0;
    files.forEach(f => { try { fs.unlinkSync(path.join(__dirname, f)); deletedCount++; } catch (err) {} });
    ctx.editMessageText(`✅ <b>BERHASIL DIHAPUS!</b>\n\n<blockquote>Sebanyak <b>${deletedCount}</b> file backup telah dihapus.</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
  } catch (e) { ctx.editMessageText(`❌ <b>GAGAL MENGHAPUS</b>\n\n<blockquote>${e.message}</blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {}); }
});

// ============================================================
//  ERROR + LAUNCH
// ============================================================
bot.catch((err, ctx) => { console.error("Bot error:", err.message); });

bot.launch().then(() => {
  console.log(chalk.bold.green(`\n╔══════════════════════════════════════════════╗\n║  ✅ ${NOTIF_PREFIX} BOT + PROXY ONLINE 🟢\n║  🕐 ${wibNowLog()} WIB\n╚══════════════════════════════════════════════╝\n`));
}).catch((e) => console.error("\x1b[31m❌ Gagal:\x1b[0m", e.message));

let lastErrorNotif = 0;
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (Date.now() - lastErrorNotif > 60000) {
    lastErrorNotif = Date.now();
    sendNotif(`⚠️ <b>SYSTEM ERROR</b>\n\n<blockquote>Bot mengalami error internal, tapi tetap berjalan.\n\n<code>${reason.message || reason}</code></blockquote>`);
  }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));