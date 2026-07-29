const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const axios = require('axios'); // Tambahkan import axios
const { SocksProxyAgent } = require('socks-proxy-agent'); // Tambahkan import SocksProxyAgent

let sheetsInstance = null;
let aiInstance = null;

// Fungsi untuk mendapatkan proxy agent jika variabel lingkungan proxy disetel
function getProxyAgent() {
    const proxyHost = process.env.SOCKS_PROXY_HOST;
    const proxyPort = process.env.SOCKS_PROXY_PORT;
    if (proxyHost && proxyPort) {
        const proxyUri = `socks5h://${proxyHost}:${proxyPort}`;
        console.log(`[Services]: Menggunakan proxy SOCKS5h: ${proxyUri}`);
        return new SocksProxyAgent(proxyUri);
    }
    return null;
}

function inisialisasiServices() {
    try {
        console.log('[Services]: Memuat kredensial Google & Gemini...');
        
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        sheetsInstance = google.sheets({ version: 'v4', auth });

        const agent = getProxyAgent();
        // const fetchOptions = agent ? { agent } : {}; // Tidak diperlukan secara langsung di sini

        // Inisialisasi GoogleGenerativeAI dengan proxy agent jika ada
        aiInstance = new GoogleGenerativeAI({
            apiKey: process.env.GEMINI_API_KEY,
            fetch: (url, options) => axios({
                method: options.method || 'GET',
                url,
                data: options.body,
                headers: options.headers,
                httpsAgent: agent, // Gunakan agent di sini
                proxy: false // Pastikan axios tidak menggunakan proxy global
            }).then(res => ({
                ok: res.status >= 200 && res.status < 300,
                status: res.status,
                statusText: res.statusText,
                headers: new Headers(res.headers.raw()),
                json: () => Promise.resolve(res.data),
                text: () => Promise.resolve(JSON.stringify(res.data)),
            }))
        });
        
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
