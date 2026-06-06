import express from 'express';
import bodyParser from 'body-parser';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import https from 'https';
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const app = express();


const allowedOrigins = [
    'http://localhost:5173', // Local Vite
    'http://localhost:5174', // Local Vite (alternate port)
    'https://frytoday.zerame.com' // Production
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');

    // Preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.use(bodyParser.json({ limit: '50mb' }));

// ================= CONTACTS API (PHP backend) =================
// The PHP backend runs on the same server as MySQL and reaches it via localhost.
// Railway cannot connect to MySQL directly (host firewall blocks port 3306), so
// we fetch contacts over HTTPS from the PHP endpoint instead.
import dotenv from 'dotenv';
dotenv.config();

const PHP_API_BASE = process.env.PHP_API_BASE || 'https://frytoday.zerame.com/api';
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || '';
// The PHP server currently uses a self-signed SSL certificate, which Node rejects.
// Set ALLOW_INSECURE_TLS=true on Railway to accept it (ONLY this call is affected).
// Once a valid/trusted certificate is installed, remove this env var.
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === 'true';

// Minimal HTTPS POST helper so we can control certificate validation per-request
// (the global fetch() can't accept a self-signed cert without weakening TLS app-wide).
function postJson(urlString, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = JSON.stringify(body);
        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                rejectUnauthorized: !ALLOW_INSECURE_TLS,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...headers
                }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function fetchContacts(labelIds) {
    const { status, body } = await postJson(
        `${PHP_API_BASE}/whatsapp_contacts.php`,
        { labelIds },
        { 'X-Api-Key': WHATSAPP_API_KEY }
    );

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Contacts API returned non-JSON (${status}): ${body.slice(0, 200)}`);
    }

    if (status < 200 || status >= 300 || !data.success) {
        throw new Error(data.message || `Contacts API failed (${status})`);
    }

    return data.contacts || [];
}

// Download a file (e.g. an attachment image) into a Buffer. Honours the same
// self-signed-cert setting and follows one level of redirect.
function downloadBuffer(urlString, redirects = 0) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'GET',
                rejectUnauthorized: !ALLOW_INSECURE_TLS
            },
            (res) => {
                // Follow a redirect (max 3)
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                    res.resume();
                    return downloadBuffer(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Download failed (${res.statusCode}) for ${urlString}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

// ================= WHATSAPP CONNECTION =================
let sock;
let currentQR = null; // 🔹 store QR temporarily

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['Chrome (Windows)', 'Desktop', '10.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr; // 🔹 save QR for API
            console.log('📲 Scan this QR Code in WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');
            currentQR = null; // clear stored QR once connected
        } else if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startWhatsApp();
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

await startWhatsApp();

app.get('/logout-whatsapp', async (req, res) => {
    try {
        // 1️⃣ Close current connection if active
        if (sock) {
            await sock.logout();
            sock.end();
            sock = null;
        }

        // 2️⃣ Remove saved session folder
        const authPath = path.join(process.cwd(), 'auth_info_baileys');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('🧹 Deleted saved session data.');
        }

        // 3️⃣ Clear any stored QR
        currentQR = null;

        // 4️⃣ Restart WhatsApp socket (optional)
        await startWhatsApp();

        return res.json({
            success: true,
            message: '✅ WhatsApp logged out successfully. Please scan QR again to reconnect.'
        });
    } catch (err) {
        console.error('❌ Logout error:', err);
        return res.status(500).json({
            success: false,
            message: 'Failed to logout from WhatsApp',
            error: err.message
        });
    }
});
app.get('/get-qr', async (req, res) => {
    try {
        if (!currentQR) {
            return res.json({
                success: false,
                message: 'No QR available or already connected'
            });
        }

        // Generate a base64 QR code image
        const qrDataURL = await QRCode.toDataURL(currentQR);

        res.json({
            success: true,
            connected: !!sock?.user,          // <-- new
            message: 'Scan this QR to login to WhatsApp',
            qr: currentQR,
            qrImage: qrDataURL
        });
    } catch (err) {
        console.error('❌ QR Generation Error:', err);
        res.status(500).json({
            success: false,
            message: 'Error generating QR',
            error: err.message
        });
    }
});

/**
 * Send bulk WhatsApp messages.
 * @param {Object} sock        Baileys socket (connected)
 * @param {Array}  contacts    [{fullName, phoneNumber, ...}]
 * @param {string} text        Message body (will be used as caption when files exist)
 * @param {Array}  attachments Optional: [{fileName, imageType, imageData}]
 */
async function sendBulkMessages(sock, contacts, text, attachments = []) {
    console.log(`Sending to ${contacts.length} contacts…`);

    // Normalise attachments → always an array
    const files = Array.isArray(attachments) ? attachments : (attachments ? [attachments] : []);

    for (const c of contacts) {
        const jid = `91${c.phoneNumber}@s.whatsapp.net`;
        // const greeting = `Dear ${c.fullName},\n\n${text}\n\nBest regards,\nFryToday`;
        const greeting = `${text}\n`;


        try {
            // ───── 1. TEXT ONLY ─────
            if (files.length === 0) {
                await sock.sendMessage(jid, { text: greeting });
                console.log(`Text → ${c.phoneNumber}`);
            }

            // ───── 2. TEXT + FILE(S) → caption ─────
            else {
                for (const f of files) {
                    const fileName = f.fileName || 'file';
                    // Extension comes from the file name (template attachments are URLs),
                    // falling back to a provided imageType for legacy base64 payloads.
                    const ext = ((fileName.split('.').pop() || f.imageType || '').toLowerCase()).replace(/[^a-z0-9]/g, '');

                    // Get the file bytes: from a URL (template attachments) or base64 (legacy)
                    let buffer;
                    if (f.url) {
                        buffer = await downloadBuffer(f.url);
                    } else if (f.imageData) {
                        buffer = Buffer.from(f.imageData.replace(/^data:.*;base64,/, ''), 'base64');
                    } else {
                        console.warn(`Attachment for ${c.phoneNumber} has no url/imageData, skipping`);
                        continue;
                    }

                    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
                    const videoExts = ['mp4', '3gp', 'mov'];

                    let payload;
                    if (imageExts.includes(ext)) {
                        payload = {
                            image: buffer,
                            mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                            caption: greeting               // <-- TEXT becomes caption
                        };
                    } else if (videoExts.includes(ext)) {
                        payload = {
                            video: buffer,
                            mimetype: 'video/mp4',
                            caption: greeting
                        };
                    } else {
                        // pdf / docs / anything else → send as a document
                        payload = {
                            document: buffer,
                            mimetype: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                            fileName,
                            caption: greeting
                        };
                    }

                    await sock.sendMessage(jid, payload);
                    console.log(`File (caption) → ${c.phoneNumber} – ${fileName}`);
                }
            }

            // Respect WhatsApp rate limits
            await new Promise(r => setTimeout(r, 3000));   // 3 sec between contacts
        } catch (e) {
            console.error(`Failed for ${c.phoneNumber}:`, e);
        }
    }

    console.log('All done!');
}

const BATCH_LIMIT = 2;

app.post('/send-whatsapp', async (req, res) => {
    try {
        if (!sock?.user) {
            return res.status(400).json({ success: false, message: 'WhatsApp not connected' });
        }

        const { labelIds, content, attachments, startIndex = 0 } = req.body;

        if (!Array.isArray(labelIds) || !labelIds.length) {
            return res.status(400).json({ success: false, message: 'labelIds required' });
        }
        if (!content) {
            return res.status(400).json({ success: false, message: 'content required' });
        }

        const rows = await fetchContacts(labelIds);

        if (!rows?.length) {
            return res.status(404).json({ success: false, message: 'No contacts found' });
        }

        // 🔹 Split contacts into batches
        const total = rows.length;
        const start = parseInt(startIndex) || 0;
        const end = Math.min(start + BATCH_LIMIT, total);
        const batch = rows.slice(start, end);

        console.log(`📦 Sending batch ${start + 1}-${end} of ${total}`);

        await sendBulkMessages(sock, batch, content, attachments);

        const remaining = total - end;

        return res.json({
            success: true,
            message: `✅ Sent ${batch.length} messages successfully.`,
            sentCount: batch.length,
            remaining,
            nextStartIndex: remaining > 0 ? end : null
        });

    } catch (error) {
        console.error('❌ Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ================= START SERVER =================
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 API server running at http://localhost:${PORT}`);
});
