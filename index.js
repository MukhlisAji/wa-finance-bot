const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { inisialisasiServices } = require('./src/config/services');
const { handleIncomingMessage, pastikanTabTersedia } = require('./src/handlers/message');
const { jalankanOtomatisasi } = require('./cron');
require('dotenv').config();

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './auth_session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run'
        ]
    }
});

// 1. Tampilkan QR Code (Aman & Instan seperti home.js)
client.on('qr', (qr) => {
    console.log('[Bot Engine]: QR Code berhasil di-generate! Silakan scan segera:');
    qrcode.generate(qr, { small: true });
});

// 2. Event Ready: Muat modul Google Sheets & Gemini secara asinkronus (Non-blocking)
client.on('ready', async () => {
    console.log('\n[Bot Status]: Terhubung ke WhatsApp! Mengaktifkan modul inti...');
    
    try {
        // Melakukan inisialisasi Google dan AI secara lazy
        const { sheets, ai } = inisialisasiServices();
        
        console.log('--- SYSTEM BIBLE V5.2: SOLID ARCHITECTURE ONLINE ---');
        console.log('[System]: Google Sheets Engine & Gemini Core siap digunakan.\n');
        
        // Jalankan Scheduler otomatisasi waktu
        jalankanOtomatisasi(client, sheets, ai, pastikanTabTersedia);
    } catch (error) {
        console.error('[Critical Error]: Gagal meluncurkan sub-modul sistem:', error.message);
    }
});

// 3. Serahkan penanganan pesan ke modul handler terpisah
client.on('message', async (msg) => {
    await handleIncomingMessage(client, msg);
});

console.log('[Debug]: Menembak perintah inisialisasi WhatsApp Client...');
client.initialize();