const cron = require('node-cron');

function jalankanOtomatisasi(client, sheets, ai, MY_TARGET_ID, pastikanTabTersedia) {
    console.log('--- [Module Cron]: Scheduler Berhasil Dimuat (WIB Lock dengan Fitur Apresiasi) ---');

    // TEST 1: Reminder & Apresiasi Malam (Diset jam 15:25 WIB / 17:25 JST untuk tes instan harian)
    // Silakan ganti kembali ke '0 21 * * *' (Jam 21:00 WIB) jika tes ini sudah berhasil.
    cron.schedule('25 15 * * *', async () => {
        console.log('[Cron Job]: Mengecek catatan harian untuk evaluasi malam...');
        const stringHariIni = new Date().toISOString().split('T')[0];
        const bulanBerjalan = stringHariIni.substring(0, 7);

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
                const PROMPT_REMINDER = "Anda adalah asisten keuangan keluarga yang kasual, lucu, dan agak cerewet. Ingatkan pasangan (Ayah/Bunda) dengan pesan singkat bahwa mereka belum mencatat satu pun pengeluaran hari ini. Gunakan emoji yang relevan.";
                const aiResponse = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: "Buat pesan pengingat malam karena belum mencatat uang",
                    config: { systemInstruction: PROMPT_REMINDER, temperature: 0.8 }
                });

                await client.sendMessage(MY_TARGET_ID, `🔔 *PENGINGAT MALAM COY*\n\n${aiResponse.text}`);
                console.log('[Cron Job]: Pesan reminder harian berhasil terkirim.');
            
            // KONDISI B: JIKA SUDAH DISIPLIN MENCATAT HARI INI (FITUR BARU)
            } else {
                const PROMPT_APRESIASI = "Anda adalah asisten keuangan keluarga yang sangat suportif, hangat, dan tahu cara menghargai kedisiplinan. Berikan ucapan terima kasih yang tulus dan sedikit pujian kreatif karena mereka sudah tertib mencatat transaksi hari ini. Gunakan emoji yang manis.";
                const aiResponse = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: "Buat ucapan terima kasih apresiatif karena sudah mencatat keuangan hari ini",
                    config: { systemInstruction: PROMPT_APRESIASI, temperature: 0.8 }
                });

                await client.sendMessage(MY_TARGET_ID, `💖 *APRESIASI DISIPLIN KEUANGAN*\n\n${aiResponse.text}`);
                console.log('[Cron Job]: Pesan apresiasi berhasil terkirim karena user sudah mencatat.');
            }
        } catch (error) {
            console.error('Gagal mengeksekusi Cron Reminder/Apresiasi:', error.message);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Jakarta"
    });

    // TEST 2: Auto Push Report Bulanan (Diset jam 15:25 WIB / 17:25 JST untuk tes instan bulanan)
    // Silakan ganti kembali ke '0 8 1 * *' (Tanggal 1 jam 08:00 Pagi WIB) jika tes ini sudah berhasil.
    cron.schedule('25 15 * * *', async () => {
        console.log('[Cron Job]: Mengecek data untuk laporan bulanan otomatis...');
        const stringHariIni = new Date().toISOString().split('T')[0];
        const targetBulan = stringHariIni.substring(0, 7);

        try {
            await pastikanTabTersedia(process.env.SPREADSHEET_ID, targetBulan);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${targetBulan}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                console.log(`[Cron Job]: Tab ${targetBulan} ditemukan tetapi belum memiliki data.`);
                await client.sendMessage(MY_TARGET_ID, `📊 *LAPORAN BULANAN OTOMATIS (${targetBulan})*\n\nSistem berhasil memeriksa sub-tab bulan ini, namun belum ada transaksi terekam yang bisa dievaluasi.`);
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

            const RANGKUMAN_PROMPT = `Anda adalah penasihat keuangan pribadi yang brutal, jujur, dan strategis. Berikan evaluasi tajam dan mendalam untuk penutupan laporan bulan ${targetBulan}.\n\nDATA TRANSAKSI:\nTotal Pemasukan: Rp ${totalPemasukan.toLocaleString('id-ID')}\nTotal Pengeluaran: Rp ${totalPengeluaran.toLocaleString('id-ID')}\nDetail:\n${daftarTransaksi.join('\n')}`;
            
            const aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: RANGKUMAN_PROMPT,
                config: { temperature: 0.7 }
            });

            const headerLaporan = `📊 *LAPORAN BULANAN OTOMATIS (${targetBulan})*\n\n💰 *Pemasukan:* Rp ${totalPemasukan.toLocaleString('id-ID')}\n💸 *Pengeluaran:* Rp ${totalPengeluaran.toLocaleString('id-ID')}\n📉 *Sisa Saldo:* Rp ${(totalPemasukan - totalPengeluaran).toLocaleString('id-ID')}\n\n`;
            
            await client.sendMessage(MY_TARGET_ID, headerLaporan + aiResponse.text);
            console.log('[Cron Job]: Laporan bulanan otomatis berhasil dikirim.');
        } catch (error) {
            console.error('Gagal mengeksekusi Cron Push Report:', error.message);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Jakarta"
    });
}

module.exports = { jalankanOtomatisasi };
root@vps151820-bwu:~/bot# 
