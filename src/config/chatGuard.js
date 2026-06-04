// DATABASE MEMORI LOKAL SEMENTARA
const pembatasObrolan = {};

/**
 * Helper untuk mereset hitungan jika user sudah mendiamkan bot lebih dari 15 menit
 */
function bersihkanCacheLama(nomor) {
    if (pembatasObrolan[nomor]) {
        const waktuSekarang = Date.now();
        const selisihMenit = (waktuSekarang - pembatasObrolan[nomor].lastChat) / (1000 * 60);
        if (selisihMenit > 15) { 
            pembatasObrolan[nomor].hitung = 0; // Reset kembali ke 0
        }
    }
}

/**
 * Memeriksa apakah nomor pengirim sudah melebihi batas kuota obrolan luar konteks
 * @return {Object} { terkenaBlokir: boolean, hitungKe: number }
 */
function periksaBatasObrolan(nomor) {
    // Inisialisasi jika nomor baru pertama kali chat luar konteks
    if (!pembatasObrolan[nomor]) {
        pembatasObrolan[nomor] = { hitung: 0, lastChat: Date.now() };
    }

    // Jalankan pengecekan durasi 15 menit
    bersihkanCacheLama(nomor);

    // Update data aktivitas terbaru
    pembatasObrolan[nomor].lastChat = Date.now();
    pembatasObrolan[nomor].hitung += 1;

    const jumlahHitung = pembatasObrolan[nomor].hitung;

    return {
        terkenaBlokir: jumlahHitung > 3, // True jika sudah ketikan ke-4 dan seterusnya
        hitungKe: jumlahHitung
    };
}

/**
 * Mereset ulang hitungan nomor ke 0 jika mereka kembali ke konteks keuangan yang benar
 */
function resetBatasObrolan(nomor) {
    if (pembatasObrolan[nomor]) {
        pembatasObrolan[nomor].hitung = 0;
        pembatasObrolan[nomor].lastChat = Date.now();
    }
}

module.exports = {
    periksaBatasObrolan,
    resetBatasObrolan
};