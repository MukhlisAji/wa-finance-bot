const cron = require('node-cron');

function jalankanOtomatisasi(client, sheets, ai, pastikanTabTersedia) {
    console.log('--- [Module Cron]: Scheduler Berhasil Dimuat (Mode Multi-Private Chat) ---');

    // Ambil variabel model secara terpusat dari .env (dengan fallback aman)
    const TARGET_MODEL = process.env.DEFAULT_MODEL || 'gemini-1.5-flash';
    const TIMEZONE_CONFIG = process.env.SYSTEM_TIMEZONE || 'Asia/Jakarta';

    // Helper function untuk mengambil daftar nomor tujuan privat dari .env
    const dapatkanTargetNomor = () => {
        return process.env.WHITELIST_NUMBERS 
            ? process.env.WHITELIST_NUMBERS.split(',').map(num => num.trim()) 
            : [];
    };

    // =========================================================================
    // SCHEDULE 1: Reminder & Apresiasi Malam
    // Untuk tes harian instan silakan sesuaikan angkanya (Contoh: '25 15 * * *')
    // =========================================================================
    const jadwalReminder = process.env.CRON_JADWAL_REMINDER;
    cron.schedule(jadwalReminder, async () => {
        console.log('[Cron Job]: Mengecek catatan harian untuk evaluasi malam...');
        const stringHariIni = new Date().toISOString().split('T')[0];
        const bulanBerjalan = stringHariIni.substring(0, 7);
        const targetNomorArray = dapatkanTargetNomor();

        if (targetNomorArray.length === 0) {
            console.log('[Cron Job]: Gagal mengirim reminder, WHITELIST_NUMBERS kosong di .env');
            return;
        }

        try {
            await pastikanTabTersedia(process.env.SPREADSHEET_ID, bulanBerjalan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${bulanBerjalan}!A:E`,
            });

            const rows = response.data.values;
            let sudahCatatHariIni = false;

            if (rows && rows.length > 1) {
                sudahCatatHariIni = rows.some(row => row[0] === stringHariIni);
            }

            // KONDISI A: JIKA BELUM MENCATAT TRANSAKSI SAMA SEKALI HARI INI
            if (!sudahCatatHariIni) {
                const PROMPT_REMINDER = "Anda adalah asisten keuangan keluarga yang kasual, lucu, dan agak cerewet. Ingatkan pasangan dengan pesan singkat bahwa hari ini pencatatan keuangan keluarga masih kosong/belum ada yang dicatat. Gunakan emoji yang relevan.";
                const aiResponse = await ai.models.generateContent({
                    model: TARGET_MODEL,
                    contents: "Buat pesan pengingat malam pendek karena belum mencatat uang",
                    config: { systemInstruction: PROMPT_REMINDER, temperature: 0.8 }
                });

                // Kirim pesan privat ke masing-masing nomor di whitelist
                for (const nomorTujuan of targetNomorArray) {
                    await client.sendMessage(nomorTujuan, `🔔 *PENGINGAT MALAM KELUARGA*\n\n${aiResponse.text}`);
                    console.log(`[Cron Job]: Pesan reminder harian terkirim ke: ${nomorTujuan}`);
                }
            
            // KONDISI B: JIKA SUDAH DISIPLIN MENCATAT HARI INI
            } else {
                const PROMPT_APRESIASI = "Anda adalah asisten keuangan keluarga yang sangat suportif, hangat, dan tahu cara menghargai kedisiplinan. Berikan ucapan terima kasih yang tulus karena hari ini tim keluarga sudah tertib mencatat transaksi ke dalam sistem. Gunakan emoji yang manis.";
                const aiResponse = await ai.models.generateContent({
                    model: TARGET_MODEL,
                    contents: "Buat ucapan terima kasih apresiatif karena sudah mencatat keuangan hari ini",
                    config: { systemInstruction: PROMPT_APRESIASI, temperature: 0.8 }
                });

                // Kirim pesan privat ke masing-masing nomor di whitelist
                for (const nomorTujuan of targetNomorArray) {
                    await client.sendMessage(nomorTujuan, `💖 *APRESIASI DISIPLIN KEUANGAN*\n\n${aiResponse.text}`);
                    console.log(`[Cron Job]: Pesan apresiasi harian terkirim ke: ${nomorTujuan}`);
                }
            }
        } catch (error) {
            console.error('Gagal mengeksekusi Cron Reminder/Apresiasi:', error.message);
        }
    }, {
        scheduled: true,
        timezone: TIMEZONE_CONFIG
    });

    // =========================================================================
    // SCHEDULE 2: Auto Push Report Bulanan
    // Untuk tes bulanan instan silakan sesuaikan angkanya (Contoh: '25 15 * * *')
    // =========================================================================
    const jadwalReport = process.env.CRON_JADWAL_REPORT;
    cron.schedule(jadwalReport, async () => {
        console.log('[Cron Job]: Mengecek data untuk laporan bulanan otomatis...');
        const stringHariIni = new Date().toISOString().split('T')[0];
        const targetBulan = stringHariIni.substring(0, 7);
        const targetNomorArray = dapatkanTargetNomor();

        if (targetNomorArray.length === 0) return;

        try {
            await pastikanTabTersedia(process.env.SPREADSHEET_ID, targetBulan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                console.log(`[Cron Job]: Tab ${targetBulan} ditemukan tetapi belum memiliki data.`);
                for (const nomorTujuan of targetNomorArray) {
                    await client.sendMessage(nomorTujuan, `📊 *LAPORAN BULANAN OTOMATIS (${targetBulan})*\n\nSistem berhasil memeriksa lembar tab bulan ini, namun belum ada transaksi terekam yang bisa dievaluasi.`);
                }
                return;
            }

            let totalPengeluaran = 0;
            let totalPemasukan = 0;
            let daftarTransaksi = [];

            for (let i = 1; i < rows.length; i++) {
                const [tanggal, kategori, nominal, keterangan, tipe] = rows[i];
                const cleanNominal = parseInt(String(nominal).replace(/[^0-9]/g, '')) || 0;
                if (tipe === 'Pengeluaran') totalPengeluaran += cleanNominal;
                if (tipe === 'Pemasukan') totalPemasukan += cleanNominal;
                daftarTransaksi.push(`- [${tanggal}] ${kategori} | ${keterangan}: Rp ${cleanNominal.toLocaleString('id-ID')}`);
            }

            const RANGKUMAN_PROMPT = `Anda adalah penasihat keuangan pribadi yang jujur, objektif, dan strategis. Berikan evaluasi tajam, ringkas, dan mendalam untuk penutupan laporan bulan ${targetBulan}.\n\nDATA TRANSAKSI:\nTotal Pemasukan: Rp ${totalPemasukan.toLocaleString('id-ID')}\nTotal Pengeluaran: Rp ${totalPengeluaran.toLocaleString('id-ID')}\nDetail:\n${daftarTransaksi.join('\n')}`;
            
            const aiResponse = await ai.models.generateContent({
                model: TARGET_MODEL,
                contents: RANGKUMAN_PROMPT,
                config: { temperature: 0.7 }
            });

            const headerLaporan = `📊 *LAPORAN BULANAN OTOMATIS (${targetBulan})*\n\n💰 *Pemasukan:* Rp ${totalPemasukan.toLocaleString('id-ID')}\n💸 *Pengeluaran:* Rp ${totalPengeluaran.toLocaleString('id-ID')}\n📉 *Sisa Saldo:* Rp ${(totalPemasukan - totalPengeluaran).toLocaleString('id-ID')}\n\n`;
            
            // Kirim laporan bulanan ke masing-masing nomor di whitelist via private chat
            for (const nomorTujuan of targetNomorArray) {
                await client.sendMessage(nomorTujuan, headerLaporan + aiResponse.text);
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