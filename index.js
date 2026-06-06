import express from 'express';
import bodyParser from 'body-parser';
import mysql from 'mysql2/promise';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
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

// ================= DATABASE CONNECTION =================
// const db = await mysql.createPool({
//     host: 'localhost',
//     user: 'frytoday',
//     password: 'dwOVz&1jES',
//     database: 'frytoday'
// });
// ================= DATABASE CONNECTION =================
import dotenv from 'dotenv';
dotenv.config();

const db = await mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

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

            // ───── 2. TEXT + IMAGE(S) → caption ─────
            else {
                for (const f of files) {
                    const { fileName, imageType, imageData } = f;

                    // Strip data-uri prefix
                    const base64 = imageData.replace(/^data:.*;base64,/, '');
                    const buffer = Buffer.from(base64, 'base64');

                    const ext = imageType.toLowerCase();
                    const safeName = fileName || `file.${ext}`;

                    const payload = {
                        image: buffer,
                        mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                        fileName: safeName,
                        caption: greeting               // <-- TEXT becomes caption
                    };

                    await sock.sendMessage(jid, payload);
                    console.log(`Image (caption) → ${c.phoneNumber} – ${safeName}`);
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

        const ids = labelIds.map(id => parseInt(id)).join(',');
        const [rows] = await db.query(`
            SELECT phoneNumber, fullName, Desigination 
            FROM tbl_employee 
            WHERE Desigination IN (${ids}) AND phoneNumber IS NOT NULL
        `);

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
