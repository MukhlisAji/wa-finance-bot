const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const { jalankanOtomatisasi } = require('./cron');
require('dotenv').config();

const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function pastikanTabTersedia(spreadsheetId, namaTab) {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === namaTab);
        
        if (!sheetExists) {
            console.log(`[Google Sheet]: Membuat tab baru bernama "${namaTab}"...`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: { properties: { title: namaTab } }
                    }]
                }
            });
            // Tambahkan Header otomatis di baris pertama tab baru
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${namaTab}!A1:E1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [["Tanggal", "Kategori", "Nominal", "Keterangan", "Tipe"]]
                }
            });
        }
    } catch (err) {
        console.error('Gagal memverifikasi/membuat tab:', err.message);
    }
}

// Fungsi pembantu untuk menghitung daftar tab yang valid (maksimal 3 bulan terakhir)
function dapatkanDaftarBulanValid() {
    const hasil = [];
    const sekarang = new Date();
    for (let i = 0; i < 3; i++) {
        const d = new Date(sekarang.getFullYear(), sekarang.getMonth() - i, 1);
        hasil.push(d.toISOString().substring(0, 7)); // Format: YYYY-MM
    }
    return hasil;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './auth_session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process'
        ]
    }
});

client.on('ready', () => {
    console.log('\n--- SYSTEM BIBLE V5.1: MODULAR CORE ENGINE ONLINE ---\n');
    
    // Mengeksekusi modul otomatisasi waktu dengan melemparkan dependensi yang dibutuhkan
    jalankanOtomatisasi(client, sheets, ai, pastikanTabTersedia);
});

client.on('message', async (msg) => {
    const pengirimId = msg.from;

    // 1. Ambil daftar whitelist dari .env dan pecah menjadi Array bersih
    const daftarWhitelist = process.env.WHITELIST_NUMBERS 
        ? process.env.WHITELIST_NUMBERS.split(',').map(num => num.trim()) 
        : [];

    // 2. Validasi ketat apakah pengirim ada di dalam daftar whitelist
    const apakahUserSah = daftarWhitelist.includes(pengirimId);

    if (!apakahUserSah) {
        console.log(`[Security Alert]: Chat dari nomor tidak dikenal diabaikan: ${pengirimId}`);
        return; 
    }

    console.log(`[Bot Engine]: Memproses chat sah dari: ${pengirimId}`);
    
    // FIX ERROR: Gabungkan ekstraksi pesan dan sanitasi trim() dalam satu deklarasi tunggal
    const userMessage = msg.body ? msg.body.trim() : '';
    if (!userMessage) return;

    const chat = await msg.getChat();
    await chat.sendStateTyping();

    // const stringHariIni = new Date().toISOString().split('T')[0];
    const stringHariIni = new Date().toLocaleDateString('en-CA', { 
        timeZone: process.env.SYSTEM_TIMEZONE || 'Asia/Jakarta' 
    });
    const bulanBerjalan = stringHariIni.substring(0, 7); // Format: YYYY-MM

    // Tentukan model target secara dinamis dari file .env (dengan fallback aman)
    const TARGET_MODEL = process.env.DEFAULT_MODEL || 'gemini-1.5-flash';
    const TARGET_SPREADSHEET = process.env.SPREADSHEET_ID;

    // ==========================================
    // LAYER 1: INTENT CLASSIFICATION
    // ==========================================
   // ==========================================
    // LAYER 1: INTENT CLASSIFICATION
    // ==========================================
    const INTENT_PROMPT = `Anda adalah manajer gerbang utama untuk bot keuangan keluarga.
Tugas Anda adalah menganalisis pesan user dan mengklasifikasikannya ke dalam salah satu intent berikut:

1. CATAT : Jika user berniat mencatat transaksi keuangan (pemasukan atau pengeluaran). Contoh: "beli martabak 100k", "gaji masuk 10jt".
2. LAPORAN_BULANAN : Jika user meminta rekap, summary, total pengeluaran, baik bulan ini, bulan lalu, atau bulan tertentu yang spesifik. Contoh: "bantu kirimkan pengeluaran selama bulan ini", "minta summary bulan lalu dong", "rekap mei kemarin ada?".
3. TANYA_HISTORI : Jika user bertanya tentang histori atau apa yang dibeli di masa lalu. Contoh: "tanggal 18 kemarin aku beli apa aja ya".
4. HAPUS : Jika user ingin membatalkan atau menghapus transaksi terakhir. Contoh: "hapus transaksi tadi", "batalin dong".
5. EDIT : Jika user ingin mengubah atau merevisi nominal angka dari transaksi yang sudah dimasukkan (baik yang baru saja diinput atau yang lampau). Contoh: "edit dong, salah itu harusnya 75k", "tolong dong edit transaksi kemarin, yg buat beli sepatu, harusnya 500k", "revisi nilainya jadi 150000".
6. DILUAR_KONTEKS : Jika user menyapa atau mengobrol hal selain keuangan keluarga. Contoh: "hi chat", "halo robot".

Suntikan Informasi Konteks Kalender saat ini:
- Hari ini tanggal: ${stringHariIni} (Bulan berjalan: ${bulanBerjalan})

Anda WAJIB merespons HANYA dengan format JSON mentah ini tanpa teks lain:
{
  "intent": "CATAT|LAPORAN_BULANAN|TANYA_HISTORI|HAPUS|EDIT|DILUAR_KONTEKS",
  "alasan": "penjelasan singkat",
  "target_bulan": "${bulanBerjalan}",
  "edit_parameter": {
    "target_tanggal": "YYYY-MM-DD", (Kalkulasikan dengan tepat jika user menyebut konteks waktu seperti 'kemarin', '2 hari lalu', atau tanggal tertentu berdasarkan referensi hari ini: ${stringHariIni}. Jika user hanya bilang 'edit yang tadi/barusan' tanpa sebut waktu, isi "")
    "kata_kunci": "sepatu", (Ambil nama objek, kategori, atau keterangan barang yang ingin dicari untuk dikoreksi nilainya. Jika tidak ada atau hanya edit transaksi barusan, isi "")
    "nominal_baru": 500000, (Wajib berupa angka bulat hasil ekstraksi nominal baru yang diinginkan user. Contoh: 75k -> 75000, 500k -> 500000)
    "mode": "SPESIFIK|BARUSAN" (Set 'BARUSAN' jika user hanya bilang 'edit dong harusnya 75k' atau 'salah input tadi'. Set 'SPESIFIK' jika user menyebut nama barang atau waktu lampau seperti kemarin)
  }
}`;
    try {
        // REFAKTOR: Menggunakan model dari .env secara dinamis
        const intentResponse = await ai.models.generateContent({
            model: TARGET_MODEL,
            contents: userMessage,
            config: { systemInstruction: INTENT_PROMPT, temperature: 0.1 }
        });

        let rawIntentText = intentResponse.text.trim();
        if (rawIntentText.includes('```')) {
            const matches = rawIntentText.match(/\{[\s\S]*\}/);
            if (matches) rawIntentText = matches[0];
        }
        
        const intentResult = JSON.parse(rawIntentText);
        console.log(`[Intent Detected]: ${intentResult.intent} | Target Bulan: ${intentResult.target_bulan}`);

        // ============= JALUR A: DILUAR KONTEKS =============
        if (intentResult.intent === 'DILUAR_KONTEKS') {
            const REJECT_PROMPT = `Anda adalah robot akuntan keluarga yang tegas tapi lucu. Tolak pesan user karena tidak ada hubungannya dengan pencatatan keuangan keluarga. Berikan sindiran halus agar kembali fokus mencatat uang. Jangan kaku. Jawab dengan singkat (maksimal 3 kalimat).\n\nPESAN USER: "${userMessage}"`;
            // REFAKTOR: Menggunakan model dari .env secara dinamis
            const rejectResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: REJECT_PROMPT,
                config: { temperature: 0.7 }
            });
            await msg.reply(rejectResponse.text);
            await chat.clearState();
            return;
        }

        // ============= JALUR B: AMBIL DATA SHEET (LAPORAN & HISTORI) =============
        if (intentResult.intent === 'LAPORAN_BULANAN' || intentResult.intent === 'TANYA_HISTORI') {
            const targetBulan = intentResult.target_bulan || bulanBerjalan;
            const daftarBulanValid = dapatkanDaftarBulanValid();

            // Proteksi Hard-Limit: Cek apakah bulan yang dicari masuk dalam batas 3 bulan terakhir
            if (!daftarBulanValid.includes(targetBulan)) {
                await msg.reply(`🙅‍♂️ *Akses Ditolak!* Permintaan data untuk bulan *${targetBulan}* sudah kadaluwarsa (di luar batas maksimal 3 bulan terakhir sistem WhatsApp).\n\nSilakan buka laptop dan cek datanya secara manual langsung di Google Sheet ya! 💻📊`);
                await chat.clearState();
                return;
            }

            // Pastikan tabnya ada sebelum dibaca
            await pastikanTabTersedia(TARGET_SPREADSHEET, targetBulan);

            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                await msg.reply(`📊 *Laporan Keuangan [${targetBulan}]*:\n\nBelum ada catatan data transaksi apa pun di lembar tab bulan ini.`);
                await chat.clearState();
                return;
            }

            let dataMentahSheet = rows.slice(1).map(r => `- [${r[0]}] ${r[1]} | ${r[3]}: Rp ${parseInt(r[2]).toLocaleString('id-ID')} (${r[4]})`).join('\n');

            let systemAnalystPrompt = "";
            if (intentResult.intent === 'LAPORAN_BULANAN') {
                systemAnalystPrompt = `Anda adalah penasihat keuangan pribadi yang jujur, brutal, dan strategis. User meminta laporan untuk periode bulan ${targetBulan}. Hitung total pengeluaran dan pemasukan berdasarkan data mentah berikut, lalu buat analisis evaluasi yang tajam dan padat.\n\nDATA MENTAH TAB ${targetBulan}:\n${dataMentahSheet}\n\nGunakan format output:\n📊 *ANALISIS KEUANGAN PERIODE ${targetBulan}*\n💰 *Pemasukan:* Rp ...\n💸 *Pengeluaran:* Rp ...\n📉 *Sisa Saldo:* Rp ...\n\n💡 *Analisis Akuntan:* (berikan kritik tajam pola belanja mereka)`;
            } else {
                systemAnalystPrompt = `Anda adalah asisten keuangan keluarga yang cerdas. User bertanya seputar riwayat transaksi masa lalu pada bulan ${targetBulan}. Cari dan urai jawabannya secara tepat dari data berikut.\n\nDATA MENTAH TAB ${targetBulan}:\n${dataMentahSheet}\n\nPERTANYAAN USER: "${userMessage}"`;
            }

            // REFAKTOR: Menggunakan model dari .env secara dinamis
            const sheetAiResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: userMessage,
                config: { systemInstruction: systemAnalystPrompt, temperature: 0.3 }
            });

            await msg.reply(sheetAiResponse.text);
            await chat.clearState();
            return;
        }

        // ============= JALUR C: PENCATATAN TRANSAKSI BARU =============
        if (intentResult.intent === 'CATAT') {
            const ACCOUNTANT_PROMPT = `Anda adalah AI Akuntan Presisi. Ekstrak pesan menjadi JSON terstruktur.
REFERENSI WAKTU HARI INI: ${stringHariIni}

Aturan Tanggal: Jika ada kata "kemarin", hitung mundur tanggal dengan tepat (YYYY-MM-DD).
Nominal: Wajib nominal bersih angka bulat (integers), buang string/titik/koma.
Kategori: [Makanan, Transportasi, Skincare, Tagihan, Hiburan, Pendapatan, Lain-lain].
Tipe: [Pengeluaran] or [Pemasukan].

Output WAJIB berupa JSON mentah valid tanpa markdown:
{
  "tanggal": "YYYY-MM-DD",
  "nominal": 100000,
  "kategori": "Makanan",
  "keterangan": "Keterangan barang",
  "tipe": "Pengeluaran"
}`;

            // REFAKTOR: Menggunakan model dari .env secara dinamis
            const recordResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: userMessage,
                config: { systemInstruction: ACCOUNTANT_PROMPT, temperature: 0.1 }
            });

            let rawRecordText = recordResponse.text.trim();
            if (rawRecordText.includes('```')) {
                const matches = rawRecordText.match(/\{[\s\S]*\}/);
                if (matches) rawRecordText = matches[0];
            }

            const dataJson = JSON.parse(rawRecordText);
            const finalNominal = parseInt(String(dataJson.nominal).replace(/[^0-9]/g, '')) || 0;

            if (finalNominal <= 0) throw new Error("Nominal transaksi tidak valid.");

            // Tentukan target tab bulanan berdasarkan tanggal transaksi hasil kalkulasi Gemini
            const targetTabTransaksi = dataJson.tanggal.substring(0, 7);

            // Amankan gerbang: Pastikan tab bulanan yang dituju sudah dibuat di Google Sheet
            await pastikanTabTersedia(TARGET_SPREADSHEET, targetTabTransaksi);

            // Masukkan baris data ke dalam tab bulanan yang spesifik
            await sheets.spreadsheets.values.append({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetTabTransaksi}!A:E`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[dataJson.tanggal, dataJson.kategori, finalNominal, dataJson.keterangan, dataJson.tipe]]
                }
            });

            const replyText = `✅ *Pencatatan Berhasil!*\n\n📅 Tanggal Transaksi: ${dataJson.tanggal}\n📂 Disimpan di Tab: *${targetTabTransaksi}*\n💰 Nominal: Rp ${finalNominal.toLocaleString('id-ID')}\n🗂 Kategori: ${dataJson.kategori}\n📝 Ket: ${dataJson.keterangan}\n📊 Tipe: ${dataJson.tipe}`;
            await msg.reply(replyText);
            await chat.clearState();
        }

        if (intentResult.intent === 'HAPUS') {
            const targetBulan = bulanBerjalan; // Selalu targetkan bulan aktif saat ini
            
            // 1. Ambil seluruh data di tab bulan ini untuk mengetahui posisi baris terakhir
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            
            // Proteksi: Jika sheet kosong atau hanya berisi header (baris <= 1)
            if (!rows || rows.length <= 1) {
                await msg.reply(`⚠️ *Gagal Hapus:* Tidak ada data transaksi yang bisa dihapus di lembar tab bulan ini (*${targetBulan}*).`);
                await chat.clearState();
                return;
            }

            const barisTerakhirIdx = rows.length; // Posisi nomor baris asli di Google Sheet
            const dataTerhapus = rows[rows.length - 1]; // Mengambil array data baris paling bawah tersebut

            // 2. Ambil sheetId internal Google dari nama tab string (diperlukan untuk method deleteDimension)
            const sheetMetaData = await sheets.spreadsheets.get({ spreadsheetId: TARGET_SPREADSHEET });
            const targetSheetObject = sheetMetaData.data.sheets.find(s => s.properties.title === targetBulan);
            
            if (!targetSheetObject) {
                throw new Error(`Tab ${targetBulan} tidak ditemukan saat mencoba menghapus.`);
            }
            
            const internalSheetId = targetSheetObject.properties.sheetId;

            // 3. Eksekusi penghapusan baris paling bawah secara presisi menggunakan batchUpdate
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: TARGET_SPREADSHEET,
                requestBody: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: internalSheetId,
                                dimension: "ROWS",
                                startIndex: barisTerakhirIdx - 1, // Index dimulai dari 0 (inklusif)
                                endIndex: barisTerakhirIdx         // Batas akhir (eksklusif)
                            }
                        }
                    }]
                }
            });

            // 4. Format nominal lama untuk ditaruh di notifikasi konfirmasi
            const nominalFormatted = parseInt(String(dataTerhapus[2]).replace(/[^0-9]/g, '')) || 0;

            // 5. Kirim umpan balik sukses ke WhatsApp pengirim
            const deleteConfirmationText = `🗑️ *Penghapusan Berhasil!*\n\nTransaksi terakhir pada tab *${targetBulan}* telah dicabut dari Google Sheet:\n\n📅 Tanggal: ${dataTerhapus[0]}\n🗂️ Kategori: ${dataTerhapus[1]}\n💰 Nominal: Rp ${nominalFormatted.toLocaleString('id-ID')}\n📝 Keterangan: ${dataTerhapus[3]}\n📊 Tipe: ${dataTerhapus[4]}\n\n_Silakan ketik ulang transaksi yang benar jika ingin merevisi._`;
            
            await msg.reply(deleteConfirmationText);
            await chat.clearState();
            return;
        }
        
        // ============= JALUR F: EDIT TRANSAKSI DINAMIS (SEARCH-BASED) =============
        if (intentResult.intent === 'EDIT') {
            const prm = intentResult.edit_parameter;
            const targetBulan = intentResult.target_bulan || bulanBerjalan;
            const nominalBaru = parseInt(prm.nominal_baru) || 0;

            if (nominalBaru <= 0) {
                await msg.reply(`⚠️ *Gagal Edit:* Nominal baru tidak valid atau tidak terbaca.`);
                await chat.clearState();
                return;
            }

            // 1. Ambil semua data di sheet bulan tersebut
            await pastikanTabTersedia(TARGET_SPREADSHEET, targetBulan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                await msg.reply(`⚠️ *Gagal Edit:* Tidak ada data transaksi di tab bulan *${targetBulan}*.`);
                await chat.clearState();
                return;
            }

            let barisTargetIdx = -1;

            // ==========================================
            // KONDISI A: EDIT TRANSAKSI BARUSAN
            // ==========================================
            if (prm.mode === 'BARUSAN') {
                // Langsung ambil baris paling bawah
                barisTargetIdx = rows.length;
            } 
            // ==========================================
            // KONDISI B: CARI BERDASARKAN KONTEKS (SEPATU, KEMARIN, DLL)
            // ==========================================
            else {
                const kataKunciCari = prm.kata_kunci ? prm.kata_kunci.toLowerCase() : '';
                
                // Scan dari bawah ke atas (mencari data paling terbaru yang cocok)
                for (let i = rows.length - 1; i >= 1; i--) {
                    const [tanggal, kategori, nominal, keterangan, tipe] = rows[i];
                    
                    const cocokTanggal = prm.target_tanggal ? (tanggal === prm.target_tanggal) : true;
                    const cocokKataKunci = kataKunciCari ? (
                        kategori.toLowerCase().includes(kataKunciCari) || 
                        keterangan.toLowerCase().includes(kataKunciCari)
                    ) : true;

                    if (cocokTanggal && cocokKataKunci) {
                        barisTargetIdx = i + 1; // Konversi ke indeks baris asli Google Sheet (1-based)
                        break; // Stop loop begitu ketemu yang paling pas
                    }
                }
            }

            // Jika setelah di-scan tidak ada data yang cocok
            if (barisTargetIdx === -1) {
                await msg.reply(`🙅‍♂️ *Data Tidak Ditemukan!* Sistem tidak berhasil menemukan transaksi ${prm.target_tanggal || ''} yang cocok dengan kata kunci *"${prm.kata_kunci || ''}"* di tab ${targetBulan}.`);
                await chat.clearState();
                return;
            }

            // 2. Ambil data lama untuk konfirmasi notifikasi
            const dataLama = rows[barisTargetIdx - 1];
            const nominalLama = parseInt(String(dataLama[2]).replace(/[^0-9]/g, '')) || 0;

            // 3. Eksekusi Update ke Google Sheet pada Kolom C di baris yang ditemukan
            await sheets.spreadsheets.values.update({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!C${barisTargetIdx}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[nominalBaru]]
                }
            });

            // 4. Kirim Feedback Sukses ke WhatsApp
            const editSuccessText = `📝 *Koreksi Data Berhasil!*\n\nSistem menemukan data yang cocok pada baris ke-${barisTargetIdx} dan telah memperbaruinya:\n\n📅 Tanggal: ${dataLama[0]}\n🗂️ Kategori: ${dataLama[1]}\n📝 Keterangan: ${dataLama[3]}\n\n💰 *Nominal Lama:* Rp ${nominalLama.toLocaleString('id-ID')}\n🔥 *Nominal Baru:* Rp ${nominalBaru.toLocaleString('id-ID')}`;
            
            await msg.reply(editSuccessText);
            await chat.clearState();
            return;
        }

    } catch (error) {
        console.error('System Catch Error:', error.message);
        await msg.reply('⚠️ *Waduh!* Pemrosesan datanya agak tersendat di server. Coba kirim ulang transaksinya pelan-pelan ya!');
        await chat.clearState();
    }
});

client.initialize();