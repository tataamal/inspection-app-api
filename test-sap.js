try {
    const noderfc = require('node-rfc');
    console.log("✅ SUKSES! Library SAP Node-RFC berhasil dimuat.");
    console.log("Versi Client:", noderfc.Client.version);
} catch (err) {
    console.error("❌ ERROR: Tidak bisa memuat node-rfc.");
    console.error("Kemungkinan file SDK SAP (.dll) belum ada di PATH Windows atau versi Node.js tidak cocok.");
    console.error(err.message);
}