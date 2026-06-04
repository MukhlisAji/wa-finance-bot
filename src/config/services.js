const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');

let sheetsInstance = null;
let aiInstance = null;

function inisialisasiServices() {
    try {
        console.log('[Services]: Memuat kredensial Google & Gemini...');
        
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        sheetsInstance = google.sheets({ version: 'v4', auth });
        aiInstance = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        console.log('[Services]: Kredensial berhasil dimuat sempurna.');
        return { sheets: sheetsInstance, ai: aiInstance };
    } catch (error) {
        console.error('[Services Fatal Error]: Gagal memuat modul eksternal:', error.message);
        throw error;
    }
}

function dapatkanServices() {
    if (!sheetsInstance || !aiInstance) {
        return inisialisasiServices();
    }
    return { sheets: sheetsInstance, ai: aiInstance };
}

module.exports = { inisialisasiServices, dapatkanServices };