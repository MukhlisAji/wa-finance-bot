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
Klasifikasikan ke dalam: CATAT, LAPORAN_BULANAN, TANYA_HISTORI, HAPUS, EDIT, DILUAR_KONTEKS.
Hari ini tanggal: ${stringHariIni} (Bulan: ${bulanBerjalan})

Jawab HANYA dengan JSON mentah:
{
  "intent": "CATAT|LAPORAN_BULANAN|TANYA_HISTORI|HAPUS|EDIT|DILUAR_KONTEKS",
  "alasan": "string",
  "target_bulan": "${bulanBerjalan}",
  "edit_parameter": {
    "target_tanggal": "YYYY-MM-DD",
    "kata_kunci": "",
    "nominal_baru": 0,
    "mode": "BARUSAN|SPESIFIK"
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

        // Jalur A: DILUAR KONTEKS
        if (intentResult.intent === 'DILUAR_KONTEKS') {
            console.log(`[Bot Engine]: Obrolan luar konteks diabaikan secara senyap: "${userMessage}"`);
            await chat.clearState();
            return;
        }

        // Jalur B: LAPORAN / HISTORI
        if (intentResult.intent === 'LAPORAN_BULANAN' || intentResult.intent === 'TANYA_HISTORI') {
            const targetBulan = intentResult.target_bulan || bulanBerjalan;
            if (!dapatkanDaftarBulanValid().includes(targetBulan)) {
                await msg.reply(`🙅‍♂️ *Akses Ditolak!* Permintaan data bulan *${targetBulan}* sudah kadaluwarsa.`);
                await chat.clearState();
                return;
            }

            await pastikanTabTersedia(sheets, TARGET_SPREADSHEET, targetBulan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                await msg.reply(`📊 *Laporan [${targetBulan}]:* Belum ada data transaksi.`);
                await chat.clearState();
                return;
            }

            let dataMentahSheet = rows.slice(1).map(r => `- [${r[0]}] ${r[1]} | ${r[3]}: Rp ${parseInt(r[2]).toLocaleString('id-ID')} (${r[4]})`).join('\n');

            let systemAnalystPrompt = intentResult.intent === 'LAPORAN_BULANAN'
                ? `Anda adalah penasihat keuangan pribadi yang jujur, brutal, dan sangat ringkas. Laporan periode ${targetBulan}.\nTugas Anda:\n1. Hitung TOTAL PENGELUARAN saja.\n2. Buat analisis 2-3 poin kritik keras langsung menukik ke pemborosan.\n\nDATA MENTAH:\n${dataMentahSheet}\n\nFormat WAJIB:\n📊 *ANALISIS KEUANGAN PERIODE ${targetBulan}*\n\n💸 *Total Pengeluaran Bulan Ini:* Rp ...\n\n💡 *Evaluasi Singkat:*\n• [Kritik 1]\n• [Kritik 2]`
                : `Anda adalah asisten keuangan keluarga yang cerdas. Jawab riwayat transaksi dari data berikut.\n\nDATA:\n${dataMentahSheet}\n\nPertanyaan: "${userMessage}"`;

            const sheetAiResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: userMessage,
                config: { systemInstruction: systemAnalystPrompt, temperature: 0.3 }
            });

            await msg.reply(sheetAiResponse.text);
            await chat.clearState();
            return;
        }

        // Jalur C: CATAT TRANSAKSI
        if (intentResult.intent === 'CATAT') {
            const ACCOUNTANT_PROMPT = `Anda adalah AI Akuntan Presisi. Ekstrak menjadi JSON terstruktur.\nReferensi hari ini: ${stringHariIni}\nKategori: [Makanan, Transportasi, Skincare, Tagihan, Hiburan, Pendapatan, Lain-lain]\nTipe: [Pengeluaran] atau [Pemasukan]\n\nOutput JSON:\n{\n  "tanggal": "YYYY-MM-DD",\n  "nominal": 100000,\n  "kategori": "Makanan",\n  "keterangan": "keterangan",\n  "tipe": "Pengeluaran"\n}`;

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

            if (finalNominal <= 0) throw new Error("Nominal tidak valid.");

            const targetTabTransaksi = dataJson.tanggal.substring(0, 7);
            await pastikanTabTersedia(sheets, TARGET_SPREADSHEET, targetTabTransaksi);

            await sheets.spreadsheets.values.append({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetTabTransaksi}!A:E`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[dataJson.tanggal, dataJson.kategori, finalNominal, dataJson.keterangan, dataJson.tipe]] }
            });

            await msg.reply(`✅ *Pencatatan Berhasil!*\n\n📅 Tanggal: ${dataJson.tanggal}\n📂 Tab: *${targetTabTransaksi}*\n💰 Nominal: Rp ${finalNominal.toLocaleString('id-ID')}\n🗂 Kategori: ${dataJson.kategori}\n📝 Ket: ${dataJson.keterangan}\n📊 Tipe: ${dataJson.tipe}`);
            await chat.clearState();
            return;
        }

        // Jalur D: HAPUS TRANSAKSI
        if (intentResult.intent === 'HAPUS') {
            const targetBulan = intentResult.target_bulan || bulanBerjalan;
            const response = await sheets.spreadsheets.values.get({ spreadsheetId: TARGET_SPREADSHEET, range: `${targetBulan}!A:E` });
            const rows = response.data.values;

            if (!rows || rows.length <= 1) {
                await msg.reply(`⚠️ *Gagal Hapus:* Tidak ada data di tab bulan *${targetBulan}*.`);
                await chat.clearState();
                return;
            }

            const barisTerakhirIdx = rows.length;
            const dataTerhapus = rows[rows.length - 1];

            const sheetMetaData = await sheets.spreadsheets.get({ spreadsheetId: TARGET_SPREADSHEET });
            const targetSheetObject = sheetMetaData.data.sheets.find(s => s.properties.title === targetBulan);
            const internalSheetId = targetSheetObject.properties.sheetId;

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: TARGET_SPREADSHEET,
                requestBody: {
                    requests: [{ deleteDimension: { range: { sheetId: internalSheetId, dimension: "ROWS", startIndex: barisTerakhirIdx - 1, endIndex: barisTerakhirIdx } } }]
                }
            });

            const nominalFormatted = parseInt(String(dataTerhapus[2]).replace(/[^0-9]/g, '')) || 0;
            await msg.reply(`🗑️ *Penghapusan Berhasil!*\n\nTransaksi terakhir dicabut:\n📅 Tanggal: ${dataTerhapus[0]}\n💰 Nominal: Rp ${nominalFormatted.toLocaleString('id-ID')}\n📝 Keterangan: ${dataTerhapus[3]}`);
            await chat.clearState();
            return;
        }

        // Jalur F: EDIT TRANSAKSI
        if (intentResult.intent === 'EDIT') {
            const prm = intentResult.edit_parameter;
            const targetBulan = intentResult.target_bulan || bulanBerjalan;
            const nominalBaru = parseInt(prm.nominal_baru) || 0;

            if (nominalBaru <= 0) {
                await msg.reply(`⚠️ *Gagal Edit:* Nominal baru tidak valid.`);
                await chat.clearState();
                return;
            }

            await pastikanTabTersedia(sheets, TARGET_SPREADSHEET, targetBulan);
            const response = await sheets.spreadsheets.values.get({ spreadsheetId: TARGET_SPREADSHEET, range: `${targetBulan}!A:E` });
            const rows = response.data.values;

            if (!rows || rows.length <= 1) {
                await msg.reply(`⚠️ *Gagal Edit:* Tidak ada data di tab bulan *${targetBulan}*.`);
                await chat.clearState();
                return;
            }

            let barisTargetIdx = prm.mode === 'BARUSAN' ? rows.length : -1;

            if (prm.mode !== 'BARUSAN') {
                const kataKunciCari = prm.kata_kunci ? prm.kata_kunci.toLowerCase() : '';
                for (let i = rows.length - 1; i >= 1; i--) {
                    const [tanggal, kategori, nominal, keterangan] = rows[i];
                    const cocokTanggal = prm.target_tanggal ? (tanggal === prm.target_tanggal) : true;
                    const cocokKataKunci = kataKunciCari ? (kategori.toLowerCase().includes(kataKunciCari) || keterangan.toLowerCase().includes(kataKunciCari)) : true;

                    if (cocokTanggal && cocokKataKunci) {
                        barisTargetIdx = i + 1;
                        break;
                    }
                }
            }

            if (barisTargetIdx === -1) {
                await msg.reply(`🙅‍♂️ *Data Tidak Ditemukan!*`);
                await chat.clearState();
                return;
            }

            const dataLama = rows[barisTargetIdx - 1];
            const nominalLama = parseInt(String(dataLama[2]).replace(/[^0-9]/g, '')) || 0;

            await sheets.spreadsheets.values.update({
                spreadsheetId: TARGET_SPREADSHEET,
                range: `${targetBulan}!C${barisTargetIdx}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[nominalBaru]] }
            });

            await msg.reply(`📝 *Koreksi Data Berhasil!*\n\n📅 Tanggal: ${dataLama[0]}\n📝 Keterangan: ${dataLama[3]}\n💰 *Nominal Lama:* Rp ${nominalLama.toLocaleString('id-ID')}\n🔥 *Nominal Baru:* Rp ${nominalBaru.toLocaleString('id-ID')}`);
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