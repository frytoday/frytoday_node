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
    'https://mailcheranmachines.zerame.com' // Production
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
const db = await mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'cheranwp'
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
// ================= SEND BULK MESSAGES FUNCTION =================
// async function sendBulkMessages(sock, contacts, messageText, attachments) {
//     console.log(`📤 Sending messages to ${contacts.length} contacts...`);

//     for (const contact of contacts) {
//         const jid = '91' + contact.phoneNumber + '@s.whatsapp.net';
//         const personalizedMsg = `Dear ${contact.fullName},\n\n${messageText}\n\nBest regards,\nCheran Machines`;

//         try {
//             await sock.sendMessage(jid, { text: personalizedMsg });
//             console.log(`✅ Text sent to ${contact.phoneNumber}`);

//             if (Array.isArray(attachments) && attachments.length > 0) {
//                 for (const file of attachments) {
//                     const { fileName, imageType, imageData } = file;

//                     // 🔹 1. Strip data URI header if present
//                     const base64Data = imageData.replace(/^data:.*;base64,/, '');
//                     const buffer = Buffer.from(base64Data, 'base64');

//                     let messagePayload = null;
//                     console.log('imageType------------------------', imageType);

//                     switch (imageType.toLowerCase()) {
//                         case 'jpg':
//                         case 'jpeg':
//                         case 'png':
//                             messagePayload = {
//                                 image: buffer,
//                                 // mimetype: `image/${imageType.toLowerCase()}`,
//                                 mimetype: 'image/png',
//                                 fileName: fileName,
//                                 caption: fileName || '📎 Image Attachment'
//                                 //        document: fs.readFileSync(filePath),  // can use image: or video: etc.
//                                 // mimetype: 'image/png',
//                                 // fileName: 'testtt.png',
//                                 // caption: messageText
//                             };
//                             break;
//                         case 'pdf':
//                             messagePayload = {
//                                 document: buffer,
//                                 mimetype: 'application/pdf',
//                                 fileName: fileName || 'document.pdf',
//                                 caption: '📄 PDF Attachment'
//                             };
//                             break;
//                         case 'mp4':
//                             messagePayload = {
//                                 video: buffer,
//                                 mimetype: 'video/mp4',
//                                 fileName: fileName || 'video.mp4',
//                                 caption: '🎥 Video Attachment'
//                             };
//                             break;
//                         default:
//                             messagePayload = {
//                                 document: buffer,
//                                 mimetype: 'application/octet-stream',
//                                 fileName: fileName || 'file'
//                             };
//                             break;
//                     }

//                     // 🔹 2. Send message
//                     await sock.sendMessage(jid, messagePayload);
//                     console.log(`📎 Sent ${fileName} (${imageType}) to ${contact.phoneNumber}`);
//                 }
//             }


//         } catch (err) {
//             console.error(`❌ Failed to send to ${contact.phoneNumber}:`, err);
//         }

//         await new Promise(resolve => setTimeout(resolve, 2500));
//     }

//     console.log('🎉 All messages processed!');
// }

async function sendBulkMessages(sock, contacts, messageText, attachments) {
    console.log(`📤 Sending messages to ${contacts.length} contacts...`);
    console.log('🧩 Incoming attachments payload:', attachments);

    // 🔹 Normalize attachments: always array, even if single object or undefined
    const fileList = Array.isArray(attachments)
        ? attachments
        : attachments
            ? [attachments]
            : [];

    for (const contact of contacts) {
        const jid = '91' + contact.phoneNumber + '@s.whatsapp.net';
        const personalizedMsg = `Dear ${contact.fullName},\n\n${messageText}\n\nBest regards,\nCheran Machines`;

        try {
            // 🔹 1. Send text message first
            await sock.sendMessage(jid, { text: personalizedMsg });
            console.log(`✅ Text sent to ${contact.phoneNumber}`);

            // 🔹 2. Process attachments (if any)
            if (fileList.length > 0) {
                for (const file of fileList) {
                    const { fileName, imageType, imageData } = file || {};
                    console.log('📦 Processing file:', fileName, 'type:', imageType);

                    if (!imageData || !imageType) {
                        console.warn('⚠️ Missing imageData or imageType, skipping attachment for:', fileName);
                        continue;
                    }

                    // 3️⃣ Strip data URI prefix if present
                    const base64Data = imageData.replace(/^data:.*;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');

                    // 4️⃣ Normalize file details
                    const ext = imageType.toLowerCase();
                    const safeFileName = fileName || `file.${ext}`;
                    let messagePayload = null;

                    // 5️⃣ Choose correct message type
                    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
                        messagePayload = {
                            image: buffer,
                            mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                            fileName: safeFileName,
                            // caption: fileName || '📎 Image Attachment'
                        };
                    } else if (ext === 'pdf') {
                        messagePayload = {
                            document: buffer,
                            mimetype: 'application/pdf',
                            fileName: safeFileName,
                            // caption: '📄 PDF Attachment'
                        };
                    } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
                        messagePayload = {
                            video: buffer,
                            mimetype: 'video/mp4',
                            fileName: safeFileName,
                            // caption: '🎥 Video Attachment'
                        };
                    } else {
                        messagePayload = {
                            document: buffer,
                            mimetype: 'application/octet-stream',
                            fileName: safeFileName
                        };
                    }

                    // 6️⃣ Send attachment
                    await sock.sendMessage(jid, messagePayload);
                    console.log(`📎 Sent ${safeFileName} (${ext}) to ${contact.phoneNumber}`);
                }
            }

        } catch (err) {
            console.error(`❌ Failed to send to ${contact.phoneNumber}:`, err);
        }

        // 🔹 Delay between contacts to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 2500));
    }

    console.log('🎉 All messages processed!');
}


// ================= EXPRESS API =================
app.post('/send-whatsapp', async (req, res) => {
    try {
        if (!sock?.user) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp not connected. Please scan QR code first.',
            });
        }

        const { labelIds, content, attachments } = req.body;

        if (!Array.isArray(labelIds) || labelIds.length === 0)
            return res.status(400).json({ success: false, message: 'labelIds must be a non-empty array' });

        if (!content)
            return res.status(400).json({ success: false, message: 'content is required' });

        const ids = labelIds.map(id => parseInt(id)).join(',');

        const [rows] = await db.query(
            `SELECT phoneNumber, fullName, Desigination 
             FROM tbl_employee 
             WHERE Desigination IN (${ids}) AND phoneNumber IS NOT NULL`
        );

        if (!rows || rows.length === 0)
            return res.status(404).json({ success: false, message: 'No employees found for given labelIds' });

        await sendBulkMessages(sock, rows, content, attachments);

        return res.json({
            success: true,
            message: 'WhatsApp messages sent successfully',
            count: rows.length
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
