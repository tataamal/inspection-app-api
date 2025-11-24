// File: migrate.js
const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
    console.log("🔄 Memulai proses migrasi database...");

    let conn;
    try {
        // Buat koneksi
        conn = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        });

        console.log("✅ Terhubung ke Database.");

        // SQL untuk membuat tabel quality_inspection_lots
        // Ini disesuaikan dengan field yang ada di kode index.js kamu sebelumnya
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS quality_inspection_lots (
                PRUEFLOS VARCHAR(20) PRIMARY KEY,
                WERK VARCHAR(10),
                ART VARCHAR(10),
                HERKUNFT VARCHAR(10),
                OBJNR VARCHAR(30),
                ENSTEHDAT DATE,
                ENTSTEZEIT VARCHAR(10),
                AUFNR VARCHAR(20),
                DISPO VARCHAR(10),
                ARBPL VARCHAR(20),
                KTEXT VARCHAR(100),
                ARBID VARCHAR(20),
                KUNNR VARCHAR(20),
                LIFNR VARCHAR(20),
                HERSTELLER VARCHAR(20),
                EMATNR VARCHAR(40),
                MATNR VARCHAR(40),
                CHARG VARCHAR(20),
                LAGORTCHRG VARCHAR(10),
                KDAUF VARCHAR(20),
                KDPOS VARCHAR(10),
                EBELN VARCHAR(20),
                EBELP VARCHAR(10),
                BLART VARCHAR(10),
                MJAHR VARCHAR(10),
                MBLNR VARCHAR(20),
                ZEILE VARCHAR(10),
                BUDAT DATE,
                BWART VARCHAR(10),
                WERKVORG VARCHAR(10),
                LAGORTVORG VARCHAR(10),
                LS_KDPOS VARCHAR(10),
                LS_VBELN VARCHAR(20),
                LS_POSNR VARCHAR(10),
                LS_ROUTE VARCHAR(20),
                LS_KUNAG VARCHAR(20),
                LS_VKORG VARCHAR(10),
                LS_KDMAT VARCHAR(40),
                SPRACHE VARCHAR(5),
                KTEXTMAT VARCHAR(255),
                LOSMENGE DECIMAL(15,3),
                MENGENEINH VARCHAR(5),
                LMENGE01 DECIMAL(15,3),
                LMENGE04 DECIMAL(15,3),
                LMENGE07 DECIMAL(15,3),
                LMENGEZUB DECIMAL(15,3),
                STAT34 VARCHAR(10),
                STAT35 VARCHAR(10),
                KTEXTLOS VARCHAR(255),
                INSP_DOC_NUMBER VARCHAR(30),
                AUFPL VARCHAR(20),
                STATS VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_werk (WERK),
                INDEX idx_dispo (DISPO),
                INDEX idx_matnr (MATNR)
            ) ENGINE=InnoDB;
        `;

        await conn.query(createTableQuery);
        console.log("✅ Tabel 'quality_inspection_lots' berhasil dibuat (atau sudah ada).");

    } catch (err) {
        console.error("❌ Gagal Migrasi:", err.message);
    } finally {
        if (conn) await conn.end();
        console.log("🏁 Proses selesai.");
    }
}

runMigration();