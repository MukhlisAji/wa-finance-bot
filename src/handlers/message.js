const { dapatkanServices } = require('../config/services');

async function pastikanTabTersedia(sheets, spreadsheetId, namaTab) {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === namaTab);
        
        if (!sheetExists) {
            console.log(`[Google Sheet]: Membuat tab baru bernama "${namaTab}"...`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{ addSheet: { properties: { title: namaTab } } }]
                }
            });
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

function dapatkanDaftarBulanValid() {
    const hasil = [];
    const sekarang = new Date();
    for (let i = 0; i < 3; i++) {
        const d = new Date(sekarang.getFullYear(), sekarang.getMonth() - i, 1);
        hasil.push(d.toISOString().substring(0, 7));
    }
    return hasil;
}

async function handleIncomingMessage(client, msg) {
    // Ambil service secara lazy-loading
    const { sheets, ai } = dapatkanServices();
    if (!sheets || !ai) return;

    console.log('\n=================== RAW DATA START ===================');
    console.log(`[Raw Type]: ${typeof msg}`);
    console.log(`[Raw Event Timestamp]: ${new Date().toISOString()}`);
    console.log('[Raw Payload Object]:');
    
    // console.dir dengan depth null akan membongkar seluruh object sampai ke anak cucunya
    console.dir(msg, { depth: 3, colors: true }); 
    
    console.log('=================== RAW DATA END ===================\n');

    const pengirimId = msg.from;
    const daftarWhitelist = process.env.WHITELIST_NUMBERS 
        ? process.env.WHITELIST_NUMBERS.split(',').map(num => num.trim()) 
        : [];

    if (!daftarWhitelist.includes(pengirimId)) {
        console.log(`[Security Alert]: Chat dari nomor tidak dikenal diabaikan: ${pengirimId}`);
        return; 
    }

    const userMessage = msg.body ? msg.body.trim() : '';
    if (!userMessage) return;

    console.log(`[Bot Engine]: Memproses chat sah dari: ${pengirimId}`);
    const chat = await msg.getChat();
    await chat.sendStateTyping();

    const stringHariIni = new Date().toLocaleDateString('en-CA', { 
        timeZone: process.env.SYSTEM_TIMEZONE || 'Asia/Jakarta' 
    });
    const bulanBerjalan = stringHariIni.substring(0, 7);

    const TARGET_MODEL = process.env.DEFAULT_MODEL || 'gemini-1.5-flash';
    const TARGET_SPREADSHEET = process.env.SPREADSHEET_ID;

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
        console.log(`[Intent Detected]: ${intentResult.intent}`);

        // ============= JALUR A: DILUAR KONTEKS (SILENT MODE FIXED) =============
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

            if (!daftarBulanValid.includes(targetBulan)) {
                await msg.reply(`🙅‍♂️ *Akses Ditolak!* Permintaan data untuk bulan *${targetBulan}* sudah kadaluwarsa (di luar batas maksimal 3 bulan terakhir sistem WhatsApp).\n\nSilakan buka laptop dan cek datanya secara manual langsung di Google Sheet ya! 💻📊`);
                await chat.clearState();
                return;
            }

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
                systemAnalystPrompt = `Anda adalah penasihat keuangan pribadi yang jujur, brutal, dan sangat ringkas. User meminta laporan untuk periode bulan ${targetBulan}. 

Tugas Anda:
1. Hitung TOTAL PENGELUARAN saja berdasarkan data mentah.
2. Buat analisis berupa maksimal 2-3 poin kritik yang sangat singkat, padat, keras, dan langsung menusuk ke akar masalah pemborosan. Jangan gunakan paragraf panjang.

DATA MENTAH TAB ${targetBulan}:\n${dataMentahSheet}\n\nGunakan format output WAJIB seperti ini:
📊 *ANALISIS KEUANGAN PERIODE ${targetBulan}*

💸 *Total Pengeluaran Bulan Ini:* Rp ...

💡 *Evaluasi Singkat:*
• [Kritik/Poin 1 langsung to the point]
• [Kritik/Poin 2 langsung to the point]`;
            } else {
                systemAnalystPrompt = `Anda adalah asisten keuangan keluarga yang cerdas. User bertanya seputar riwayat transaksi masa lalu pada bulan ${targetBulan}. Cari dan urai jawabannya secara tepat dari data berikut.\n\nDATA MENTAH TAB ${targetBulan}:\n${dataMentahSheet}\n\nPERTANYAAN USER: "${userMessage}"`;
            }

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

            const targetTabTransaksi = dataJson.tanggal.substring(0, 7);
            await pastikanTabTersedia(TARGET_SPREADSHEET, targetTabTransaksi);

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
            return; // Ditambahkan return agar tertutup rapi
        }

        // ============= JALUR D: HAPUS TRANSAKSI =============
        if (intentResult.intent === 'HAPUS') {
            const targetBulan = intentResult.target_bulan || bulanBerjalan;
            
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                await msg.reply(`⚠️ *Gagal Hapus:* Tidak ada data transaksi yang bisa dihapus di lembar tab bulan *${targetBulan}*.`);
                await chat.clearState();
                return;
            }

            const barisTerakhirIdx = rows.length;
            const dataTerhapus = rows[rows.length - 1];

            const sheetMetaData = await sheets.spreadsheets.get({ spreadsheetId: TARGET_SPREADSHEET });
            const targetSheetObject = sheetMetaData.data.sheets.find(s => s.properties.title === targetBulan);
            
            if (!targetSheetObject) {
                throw new Error(`Tab ${targetBulan} tidak ditemukan saat mencoba menghapus.`);
            }
            
            const internalSheetId = targetSheetObject.properties.sheetId;

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: TARGET_SPREADSHEET,
                requestBody: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: internalSheetId,
                                dimension: "ROWS",
                                startIndex: barisTerakhirIdx - 1,
                                endIndex: barisTerakhirIdx
                            }
                        }
                    }]
                }
            });

            const nominalFormatted = parseInt(String(dataTerhapus[2]).replace(/[^0-9]/g, '')) || 0;
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

            if (prm.mode === 'BARUSAN') {
                barisTargetIdx = rows.length;
            } else {
                const kataKunciCari = prm.kata_kunci ? prm.kata_kunci.toLowerCase() : '';
                for (let i = rows.length - 1; i >= 1; i--) {
                    const [tanggal, kategori, nominal, keterangan, tipe] = rows[i];
                    
                    const cocokTanggal = prm.target_tanggal ? (tanggal === prm.target_tanggal) : true;
                    const cocokKataKunci = kataKunciCari ? (
                        kategori.toLowerCase().includes(kataKunciCari) || 
                        keterangan.toLowerCase().includes(kataKunciCari)
                    ) : true;

                    if (cocokTanggal && cocokKataKunci) {
                        barisTargetIdx = i + 1;
                        break;
                    }
                }
            }

            if (barisTargetIdx === -1) {
                await msg.reply(`🙅‍♂️ *Data Tidak Ditemukan!* Sistem tidak berhasil menemukan transaksi ${prm.target_tanggal || ''} yang cocok dengan kata kunci *"${prm.kata_kunci || ''}"* di tab ${targetBulan}.`);
                await chat.clearState();
                return;
            }

            const dataLama = rows[barisTargetIdx - 1];
            const nominalLama = parseInt(String(dataLama[2]).replace(/[^0-9]/g, '')) || 0;

            await sheets.spreadsheets.values.update({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!C${barisTargetIdx}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[nominalBaru]]
                }
            });

            const editSuccessText = `📝 *Koreksi Data Berhasil!*\n\nSistem menemukan data yang cocok pada baris ke-${barisTargetIdx} dan telah memperbaruinya:\n\n📅 Tanggal: ${dataLama[0]}\n🗂️ Kategori: ${dataLama[1]}\n📝 Keterangan: ${dataLama[3]}\n\n💰 *Nominal Lama:* Rp ${nominalLama.toLocaleString('id-ID')}\n🔥 *Nominal Baru:* Rp ${nominalBaru.toLocaleString('id-ID')}`;
            
            await msg.reply(editSuccessText);
            await chat.clearState();
            return;
        }

    } catch (error) {
        console.error('System Catch Error:', error.message);
        await msg.reply('⚠️ *Waduh!* Pemrosesan datanya agak tersendat di server. Coba lagi ya!');
        await chat.clearState();
    }
}

module.exports = { handleIncomingMessage, pastikanTabTersedia };