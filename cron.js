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
            // FIX: Menambahkan parameter 'sheets' sebagai argumen pertama
            await pastikanTabTersedia(sheets, process.env.SPREADSHEET_ID, bulanBerjalan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${bulanBerjalan}!A:E`,
            });

            const rows = response.data.values;
            let sudahCatatHariIni = false;

            if (rows && rows.length > 1) {
                // Memastikan stringHariIni cocok dengan kolom pertama di spreadsheet
                sudahCatatHariIni = rows.some(row => row[0] === stringHariIni);
            }

            // KONDISI A: JIKA BELUM MENCATAT TRANSAKSI SAMA SEKALI HARI INI
            if (!sudahCatatHariIni) {
                const promptReminder = `Anda adalah asisten keuangan keluarga yang praktis dan efisien. 
                Tugas Anda adalah mengirimkan pengingat malam singkat kepada user untuk mencatat pengeluaran hari ini jika ada yang belum terekam.

                ATURAN KETAT:
                1. Tulis HANYA dalam max 2 kalimat yang langsung ke tujuan.
                2. Gunakan emoji yg sesuai dan proper, jangan berlebihan.
                3. Jangan bertele-tele, jangan membuat analogi panjang, dan jangan kaku seperti robot.`;                
                
                // FIX: Memperbaiki referensi variabel dan struktur pemanggilan SDK Gemini (.response.text())
                const aiResponse = await ai.models.generateContent({
                    model: TARGET_MODEL,
                    contents: [{ role: 'user', parts: [{ text: "EKSEKUSI SEKARANG: Tuliskan 1 pesan pengingat malam langsung untuk saya sesuai aturan. JANGAN berikan pilihan, JANGAN berikan pengantar, langsung muntahkan pesannya saja." }] }],
                    systemInstruction: promptReminder,
                    generationConfig: { temperature: 0.8 }
                });

                // Mengambil teks hasil generate dengan benar
                const pesanAi = aiResponse.response.text();

                for (const nomorMurni of targetNomorArray) {
                    // KODE INI YANG MENJEMBATANI:
                    // Memastikan format JID benar (menghindari error 't' atau 'r')
                    const targetJid = nomorMurni.includes('@c.us') ? nomorMurni : `${nomorMurni}@c.us`; 
                    
                    try {
                        // Gunakan pesanAi (hasil .text()), bukan aiResponse.text
                        await client.sendMessage(targetJid, `🔔 *PENGINGAT MALAM KELUARGA*\n\n${pesanAi}`);
                        console.log(`[Cron Job]: Pesan reminder berhasil terkirim ke: ${targetJid}`);
                    } catch (err) {
                        console.error(`[Cron Error]: Gagal mengirim reminder ke ${targetJid}:`, err.message);
                    }
                }
            
            // KONDISI B: JIKA SUDAH DISIPLIN MENCATAT HARI INI
            } else {
                const promptApresiasi = `Anda adalah asisten keuangan keluarga yang praktis dan suportif. 
                Tugas Anda adalah memberikan ucapan terima kasih karena hari ini user sudah tertib mencatat transaksi.
                
                ATURAN KETAT:
                1. Tulis HANYA dalam max 2 kalimat yang langsung ke tujuan.
                2. Gunakan emoji yg sesuai dan proper, jangan berlebihan.
                3. Jangan bertele-tele, jangan membuat analogi panjang, dan jangan kaku seperti robot.`; 
                
                // FIX: Memperbaiki struktur pemanggilan SDK Gemini (.response.text())
                const aiResponse = await ai.models.generateContent({
                    model: TARGET_MODEL,
                    contents: [{ role: 'user', parts: [{ text: "Buat ucapan terima kasih apresiatif karena sudah mencatat keuangan hari ini" }] }],
                    systemInstruction: promptApresiasi,
                    generationConfig: { temperature: 0.8 }
                });

                const pesanApresiasiAi = aiResponse.response.text();

                for (const nomorMurni of targetNomorArray) {
                    // FIX: Pastikan nomor tujuan dikonversi ke JID @c.us
                    const targetJid = nomorMurni.includes('@c.us') ? nomorMurni : `${nomorMurni}@c.us`;

                    try {
                        await client.sendMessage(targetJid, `💖 *APRESIASI DISIPLIN KEUANGAN*\n\n${pesanApresiasiAi}`);
                        console.log(`[Cron Job]: Pesan apresiasi harian terkirim ke: ${targetJid}`);
                    } catch (err) {
                        console.error(`[Cron Error]: Gagal mengirim apresiasi ke ${targetJid}:`, err.message);
                    }
                }
            }
        } catch (error) {
            // Memberikan log yang lebih detail jika terjadi error internal (seperti Error: t)
            console.error('Gagal mengeksekusi Cron Reminder/Apresiasi:', error);
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
            const aiResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: "Bongkar semua data keuangan saya bulan lalu secara objektif. Tembak langsung ke akar masalah, jangan menghibur, jangan pakai kalimat pembuka/penutup, langsung muntahkan hasil analisisnya.",                systemInstruction: RANGKUMAN_PROMPT,
                config: { temperature: 0.5 }
            });
    
            const isiLaporanFinal = `📊 *LAPORAN BULANAN OTOMATIS (${targetBulan})*\n\n💸 *Total Pengeluaran:* Rp ${totalPengeluaran.toLocaleString('id-ID')}\n\n${aiResponse.text}`;
            
            for (const nomorTujuan of targetNomorArray) {
                await client.sendMessage(nomorTujuan, isiLaporanFinal);
                console.log(`[Cron Job]: Laporan bulanan otomatis berhasil terkirim ke privat chat: ${nomorTujuan}`);
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