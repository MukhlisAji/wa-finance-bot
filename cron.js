const cron = require('node-cron');

function jalankanOtomatisasi(client, sheets, ai, pastikanTabTersedia) {
    console.log('--- [Module Cron]: Scheduler Berhasil Dimuat (Mode Multi-Private Chat) ---');

    const TARGET_MODEL = process.env.DEFAULT_MODEL || 'gemini-1.5-flash';
    const TIMEZONE_CONFIG = process.env.SYSTEM_TIMEZONE || 'Asia/Jakarta';

    const dapatkanTargetNomor = () => {
    return process.env.WHITELIST_NUMBERS 
        ? process.env.WHITELIST_NUMBERS.split(',').map(num => num.trim().replace(/[^0-9]/g, '')) 
        : [];
    };

    // =========================================================================
    // SCHEDULE 1: Reminder & Apresiasi Malam
    // =========================================================================
    const jadwalReminder = process.env.CRON_JADWAL_REMINDER;
    cron.schedule(jadwalReminder, async () => {
        console.log('[Cron Job]: Mengecek catatan harian untuk evaluasi malam...');
        
        // Menggunakan penanggalan zona waktu lokal agar sinkron dengan Google Sheet
        const stringHariIni = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE_CONFIG });
        const bulanBerjalan = stringHariIni.substring(0, 7);
        const targetNomorArray = dapatkanTargetNomor();

        if (targetNomorArray.length === 0) {
            console.log('[Cron Job]: Gagal mengirim reminder, WHITELIST_NUMBERS kosong di .env');
            return;
        }

        try {
            // 1. Persiapan Tab Spreadsheet
            await pastikanTabTersedia(sheets, process.env.SPREADSHEET_ID, bulanBerjalan);
            
            // 2. Ambil data dari Spreadsheet
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${bulanBerjalan}!A:E`,
            });

            const rows = response.data.values;
            const sudahCatatHariIni = rows && rows.length > 1 && rows.some(row => row === stringHariIni);

            // Penentuan Prompt berdasarkan kondisi (A/B)
            const systemInstruction = sudahCatatHariIni 
                ? `Anda adalah asisten keuangan keluarga yang praktis dan suportif. 
                  Tugas Anda adalah memberikan ucapan terima kasih karena hari ini user sudah tertib mencatat transaksi.
                  
                  ATURAN KETAT:
                  1. Tulis HANYA dalam max 2 kalimat yang langsung ke tujuan.
                  2. Gunakan emoji yg sesuai dan proper, jangan berlebihan.
                  3. Jangan bertele-tele, jangan membuat analogi panjang, dan jangan kaku seperti robot.`
                : `Anda adalah asisten keuangan keluarga yang praktis dan efisien. 
                  Tugas Anda adalah mengirimkan pengingat malam singkat kepada user untuk mencatat pengeluaran hari ini jika ada yang belum terekam.

                  ATURAN KETAT:
                  1. Tulis HANYA dalam max 2 kalimat yang langsung ke tujuan.
                  2. Gunakan emoji yg sesuai dan proper, jangan berlebihan.
                  3. Jangan bertele-tele, jangan membuat analogi panjang, dan jangan kaku seperti robot.`;   

            const headerPesan = sudahCatatHariIni ? "💖 *APRESIASI DISIPLIN*" : "🔔 *PENGINGAT MALAM*";

            // 3. Panggil AI Gemini (FIXED STRUCTURE)
            console.log('[Cron Trace]: Memanggil Gemini AI...');
            
            const aiResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: "EKSEKUSI SEKARANG: Tuliskan 1 pesan pengingat malam langsung untuk saya sesuai aturan. JANGAN berikan pilihan, JANGAN berikan pengantar, langsung muntahkan pesannya saja.",
                config: { 
                    systemInstruction: systemInstruction,
                    temperature: 0.8 
                }
            });

            // EKSTRAKSI YANG BENAR UNTUK SDK @google/genai:
            // Langsung ambil properti .text (tanpa .response, dan tanpa tanda kurung ()!)
            let pesanAi = aiResponse.text ? aiResponse.text.trim() : "";

            if (!pesanAi) {
                console.warn("[Warning]: Teks AI kosong, menggunakan fallback.");
                pesanAi = "Ayo disiplin catat pengeluaran harimu! 💰";
            }

            console.log(`[Cron Trace]: Hasil AI berhasil ditarik (${pesanAi.length} karakter).`);

            // 4. Kirim Pesan via WhatsApp
            for (const nomorMurni of targetNomorArray) {
                const targetJid = nomorMurni.includes('@c.us') ? nomorMurni : `${nomorMurni}@c.us`; 
                
                try {
                    await client.sendMessage(targetJid, `${headerPesan}\n\n${pesanAi}`);
                    console.log(`[Cron Job]: Pesan berhasil dikirim ke: ${targetJid}`);
                } catch (err) {
                    console.error(`[Cron Error]: Gagal kirim ke ${targetJid}:`, err.message);
                }
            }
        } catch (error) {
            // Standard error logging
            console.error('CRITICAL ERROR Cron Reminder/Apresiasi:', error);
        }
    }, {
        scheduled: true,
        timezone: TIMEZONE_CONFIG
    });

    // =========================================================================
    // SCHEDULE 2: Auto Push Report Bulanan
    // =========================================================================
    const jadwalReport = process.env.CRON_JADWAL_REPORT;
    cron.schedule(jadwalReport, async () => {
        console.log('[Cron Job]: Mengecek data untuk laporan bulanan otomatis...');
        const stringHariIni = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE_CONFIG });
        const targetBulan = stringHariIni.substring(0, 7);
        const targetNomorArray = dapatkanTargetNomor();
    
        if (targetNomorArray.length === 0) return;
    
        try {
            // FIX: Menambahkan parameter 'sheets' sebagai argumen pertama
            await pastikanTabTersedia(sheets, process.env.SPREADSHEET_ID, targetBulan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${targetBulan}!A:E`,
            });
    
            const rows = response.data.values;
            
            if (!rows || rows.length <= 1) {
                for (const nomorTujuan of targetNomorArray) {
                    await client.sendMessage(nomorTujuan, `📊 *Laporan Keuangan [${targetBulan}]*:\n\nBelum ada catatan data transaksi apa pun di lembar tab bulan ini.`);
                }
                return;
            }
    
            let totalPengeluaran = 0;
            const dataMentahSheet = rows.slice(1).map(r => {
                const nominal = parseInt(String(r[2]).replace(/[^0-9]/g, '')) || 0;
                const tipe = String(r[4]).toLowerCase();
                
                if (tipe === 'pengeluaran') {
                    totalPengeluaran += nominal;
                }
                return `- [${r[0]}] ${r[1]} | ${r[3]}: Rp ${nominal.toLocaleString('id-ID')} (${r[4]})`;
            }).join('\n');
    
            const RANGKUMAN_PROMPT = `Anda adalah penasihat keuangan pribadi yang jujur, brutal, dan sangat ringkas. User meminta laporan untuk periode bulan ${targetBulan}. 
    
    Tugas Anda:
    Buat analisis berupa maksimal 2-3 poin kritik yang sangat singkat, padat, keras, dan langsung menusuk ke akar masalah pemborosan berdasarkan data mentah yang diberikan. Jangan gunakan paragraf panjang.
    
    DATA MENTAH TAB ${targetBulan}:
    ${dataMentahSheet}
    
    Gunakan format output WAJIB seperti ini (tampilkan hanya bagian evaluasinya saja):
    💡 *Evaluasi Singkat:*
    • [Kritik/Poin 1 langsung to the point]
    • [Kritik/Poin 2 langsung to the point]`;
    
            // FIX: Menggeser RANGKUMAN_PROMPT ke systemInstruction agar konsistensi format terjaga ketat
            console.log(`[Cron Trace]: Memanggil Gemini AI untuk analisis laporan ${targetBulan}...`);
            
            // BENAR: systemInstruction wajib berada DI DALAM objek config
            const aiResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: "Bongkar semua data keuangan saya bulan lalu secara objektif. Tembak langsung ke akar masalah, jangan menghibur, jangan pakai kalimat pembuka/penutup, langsung muntahkan hasil analisisnya.",
                config: { 
                    systemInstruction: RANGKUMAN_PROMPT,
                    temperature: 0.5 
                }
            });

            // Ekstraksi teks secara aman dan berikan fallback jika AI gagal merespons
            const hasilAnalisis = aiResponse.text ? aiResponse.text.trim() : "💡 *Evaluasi Singkat:* Data bulanan telah direkap, namun AI gagal menghasilkan analisis rinci saat ini.";

            const isiLaporanFinal = `📊 *LAPORAN BULANAN OTOMATIS (${targetBulan})*\n\n💸 *Total Pengeluaran:* Rp ${totalPengeluaran.toLocaleString('id-ID')}\n\n${hasilAnalisis}`;
            
            // BENAR: Selalu sanitasi JID sebelum dikirim ke WWebJS
            for (const nomorMurni of targetNomorArray) {
                const targetJid = nomorMurni.includes('@c.us') ? nomorMurni : `${nomorMurni}@c.us`;
                
                try {
                    await client.sendMessage(targetJid, isiLaporanFinal);
                    console.log(`[Cron Job]: Laporan bulanan otomatis berhasil terkirim ke: ${targetJid}`);
                } catch (err) {
                    console.error(`[Cron Error]: Gagal mengirim laporan bulanan ke ${targetJid}:`, err.message);
                }
            }
        } catch (error) {
            console.error('Gagal mengeksekusi Cron Push Report:', error.message);
        }
    }, {
        scheduled: true,
        timezone: TIMEZONE_CONFIG
    });
}

module.exports = { jalankanOtomatisasi };