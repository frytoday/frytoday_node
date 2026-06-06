import express from 'express';
import bodyParser from 'body-parser';
import mysql from 'mysql2/promise';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const app = express();
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
            console.log('📲 Scan this QR Code in WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');
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

// ================= SEND BULK MESSAGES FUNCTION =================
async function sendBulkMessages(sock, contacts, messageText, attachments) {
    console.log(`📤 Sending messages to ${contacts.length} contacts...`);

    for (const contact of contacts) {
        const jid = '91' + contact.phoneNumber + '@s.whatsapp.net';
        const personalizedMsg = `Dear ${contact.fullName},\n\n${messageText}\n\nBest regards,\nCheran Machines`;

        try {
            // 1️⃣ Send text message
            await sock.sendMessage(jid, { text: personalizedMsg });
            console.log(`✅ Text sent to ${contact.phoneNumber}`);

            // 2️⃣ If there are attachments, send each
            if (Array.isArray(attachments) && attachments.length > 0) {
                for (const file of attachments) {
                    const { fileName, imageType, imageData } = file;

                    // Decode base64
                    const buffer = Buffer.from(imageData, 'base64');

                    let messagePayload = null;

                    switch (imageType.toLowerCase()) {
                        case 'jpg':
                        case 'jpeg':
                        case 'png':
                            messagePayload = {
                                image: buffer,
                                caption: fileName || '📎 Attachment'
                            };
                            break;
                        case 'pdf':
                            messagePayload = {
                                document: buffer,
                                mimetype: 'application/pdf',
                                fileName: fileName || 'document.pdf',
                                caption: '📄 PDF Attachment'
                            };
                            break;
                        case 'mp4':
                            messagePayload = {
                                video: buffer,
                                caption: fileName || '🎥 Video Attachment'
                            };
                            break;
                        default:
                            messagePayload = {
                                document: buffer,
                                mimetype: 'application/octet-stream',
                                fileName: fileName || 'file'
                            };
                            break;
                    }

                    await sock.sendMessage(jid, messagePayload);
                    console.log(`📎 Attachment (${fileName}) sent to ${contact.phoneNumber}`);
                }
            }

        } catch (err) {
            console.error(`❌ Failed to send to ${contact.phoneNumber}:`, err);
        }

        // Delay between each contact to prevent rate limits
        await new Promise(resolve => setTimeout(resolve, 2500));
    }

    console.log('🎉 All messages processed!');
}

// ================= EXPRESS API =================
app.post('/send-whatsapp', async (req, res) => {
    try {
        const { labelIds, content, attachments } = req.body;

        if (!Array.isArray(labelIds) || labelIds.length === 0) {
            return res.status(400).json({ success: false, message: 'labelIds must be a non-empty array' });
        }

        if (!content) {
            return res.status(400).json({ success: false, message: 'content is required' });
        }

        const ids = labelIds.map(id => parseInt(id)).join(',');

        const [rows] = await db.query(
            `SELECT phoneNumber, fullName, Desigination 
             FROM tbl_employee 
             WHERE Desigination IN (${ids}) AND phoneNumber IS NOT NULL`
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No employees found for given labelIds' });
        }

        // Send messages (text + attachments)
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
// before showing qr code in UI