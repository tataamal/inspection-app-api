// File: index.js
const express = require('express');
const cors = require('cors');
const noderfc = require('node-rfc');
const db = require('./db');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Agar bisa terima base64 besar
app.use(express.urlencoded({ extended: true }));

// --- LOGGING CONFIGURATION ---
function log(level, endpoint, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level,
        endpoint,
        message,
        data: data ? (typeof data === 'object' ? JSON.stringify(data) : data) : null
    };
    
    console.log(`[${timestamp}] [${level}] [${endpoint}] ${message}`, data ? data : '');
    
    // Juga tulis ke file log (opsional)
    const logFile = path.join(__dirname, 'app.log');
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
}

// --- HELPER FUNCTIONS ---

// Folder upload (mirip logic Python)
const UPLOAD_FOLDER = path.join(__dirname, 'static/images');
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER, { recursive: true });
    log('INFO', 'INIT', 'Created upload folder', UPLOAD_FOLDER);
}

// Helper untuk SAP Connection
function createSapClient(username, password) {
    log('DEBUG', 'SAP_CLIENT', 'Creating SAP client', { username, ashost: process.env.SAP_HOST });
    return new noderfc.Client({
        user: username,
        passwd: password,
        ashost: process.env.SAP_HOST,
        sysnr: process.env.SAP_SYSNR,
        client: process.env.SAP_CLIENT,
        lang: process.env.SAP_LANG
    });
}

// Format tanggal SAP (YYYYMMDD) ke MySQL (YYYY-MM-DD)
function parseDate(dateStr) {
    if (!dateStr || dateStr === '00000000') return null;
    const y = dateStr.substring(0, 4);
    const m = dateStr.substring(4, 6);
    const d = dateStr.substring(6, 8);
    return `${y}-${m}-${d}`;
}

// Helper tanggal hari ini YYYYMMDD
function getSapDateNow() {
    const d = new Date();
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Helper waktu hari ini HHMMSS
function getSapTimeNow() {
    const d = new Date();
    return d.toTimeString().split(' ')[0].replace(/:/g, '');
}

// --- API ENDPOINTS ---

// 1. API Login SAP (Check Connection)
app.post('/api/sap-login', async (req, res) => {
    const { username, password } = req.body;
    log('INFO', 'SAP_LOGIN', 'Login attempt started', { username });
    
    const client = createSapClient(username, password);

    try {
        log('DEBUG', 'SAP_LOGIN', 'Opening SAP connection');
        await client.open();
        
        log('DEBUG', 'SAP_LOGIN', 'Pinging SAP server');
        await client.ping();
        
        log('SUCCESS', 'SAP_LOGIN', 'User login successful', { username });
        
        res.json({
            status: 'connected',
            username: username,
            password: password
        });
        
    } catch (err) {
        log('ERROR', 'SAP_LOGIN', 'Login failed', { 
            username, 
            error: err.message 
        });
        res.status(401).json({ error: err.message });
    } finally {
        if (client.isOpen) {
            log('DEBUG', 'SAP_LOGIN', 'Closing SAP connection');
            await client.close();
        }
    }
});

app.get('/api/get_insp_lot', async (req, res) => {
    const { plant, username, password, dispo } = req.query;
    
    log('INFO', 'GET_INSP_LOT', 'Request received', { plant, username, dispo });

    if (!plant) {
        log('ERROR', 'GET_INSP_LOT', 'Missing required parameter', { missing: 'plant' });
        return res.status(400).json({ error: "Parameter 'plant' is required" });
    } 

    if (!dispo) {
        log('ERROR', 'GET_INSP_LOT', 'Missing required parameter', { missing: 'dispo' })
        return res.status(400).json({ error: "Parameter 'dispo' is required" });
    }

    const client = createSapClient(username, password);
    let conn;

    try {
        log('DEBUG', 'GET_INSP_LOT', 'Opening SAP connection');
        await client.open();

        const sapParams = {
            IV_WERKS: plant, 
            IV_DISPO: dispo
        };
        
        log('DEBUG', 'GET_INSP_LOT', 'Calling SAP function Z_RFC_GET_INSP_LOT_BY_DISPO', sapParams);
        const result = await client.call('Z_RFC_GET_INSP_LOT_BY_DISPO', sapParams);
        const data = result.ET_QALS || [];
        
        log('INFO', 'GET_INSP_LOT', 'SAP response received', { 
            recordCount: data.length,
            firstRecord: data[0] ? data[0].PRUEFLOS : 'none'
        });

        log('DEBUG', 'GET_INSP_LOT', 'Getting database connection');
        conn = await db.getConnection();
        
        // ✅ BUAT TABEL JIKA BELUM ADA
        await createTableIfNotExists(conn);

        log('DEBUG', 'GET_INSP_LOT', 'Starting database transaction');
        await conn.beginTransaction();

        log('DEBUG', 'GET_INSP_LOT', 'Deleting existing records for plant and dispo', { plant, dispo });
        await conn.query("DELETE FROM quality_inspection_lots WHERE WERK = ? AND DISPO = ?", [plant, dispo]);

        const sql = `
            INSERT INTO quality_inspection_lots (
                PRUEFLOS, WERK, ART, HERKUNFT, OBJNR, ENSTEHDAT, ENTSTEZEIT,
                AUFNR, DISPO, ARBPL, KTEXT, ARBID, KUNNR, LIFNR, HERSTELLER,
                EMATNR, MATNR, CHARG, LAGORTCHRG, KDAUF, KDPOS, EBELN, EBELP,
                BLART, MJAHR, MBLNR, ZEILE, BUDAT, BWART, WERKVORG, LAGORTVORG,
                LS_KDPOS, LS_VBELN, LS_POSNR, LS_ROUTE, LS_KUNAG, LS_VKORG,
                LS_KDMAT, SPRACHE, KTEXTMAT, LOSMENGE, MENGENEINH, LMENGE01,
                LMENGE04, LMENGE07, LMENGEZUB, STAT34, STAT35, KTEXTLOS,
                INSP_DOC_NUMBER, AUFPL, STATS
            ) VALUES ? 
            ON DUPLICATE KEY UPDATE 
            WERK=VALUES(WERK), STATS=VALUES(STATS)
        `;
        
        const values = data.map(lot => [
            lot.PRUEFLOS, lot.WERK, lot.ART, lot.HERKUNFT, lot.OBJNR, parseDate(lot.ENSTEHDAT), lot.ENTSTEZEIT,
            lot.AUFNR, lot.DISPO, lot.ARBPL, lot.KTEXT, lot.ARBID, lot.KUNNR, lot.LIFNR, lot.HERSTELLER,
            lot.EMATNR, lot.MATNR, lot.CHARG, lot.LAGORTCHRG, lot.KDAUF, lot.KDPOS, lot.EBELN, lot.EBELP,
            lot.BLART, lot.MJAHR, lot.MBLNR, lot.ZEILE, parseDate(lot.BUDAT), lot.BWART, lot.WERKVORG, lot.LAGORTVORG,
            lot.LS_KDPOS, lot.LS_VBELN, lot.LS_POSNR, lot.LS_ROUTE, lot.LS_KUNAG, lot.LS_VKORG,
            lot.LS_KDMAT, lot.SPRACHE, lot.KTEXTMAT, lot.LOSMENGE, lot.MENGENEINH, lot.LMENGE01,
            lot.LMENGE04, lot.LMENGE07, lot.LMENGEZUB, lot.STAT34, lot.STAT35, lot.KTEXTLOS,
            lot.INSP_DOC_NUMBER, lot.AUFPL, lot.STATS
        ]);

        if (values.length > 0) {
            log('DEBUG', 'GET_INSP_LOT', 'Inserting records to database', { recordCount: values.length });
            await conn.query(sql, [values]);
        } else {
            log('WARN', 'GET_INSP_LOT', 'No records to insert');
        }

        log('DEBUG', 'GET_INSP_LOT', 'Committing database transaction');
        await conn.commit();

        log('SUCCESS', 'GET_INSP_LOT', 'Process completed successfully', {
            totalRecords: data.length,
            dispo: dispo
        });

        res.json({ 
            message: `Sinkronisasi DB Selesai (${data.length} records) untuk Dispo ${dispo}.`,
            data: data
        });

    } catch (err) {
        log('ERROR', 'GET_INSP_LOT', 'Process failed', {
            error: err.message,
            stack: err.stack
        });
        
        if (conn) {
            log('DEBUG', 'GET_INSP_LOT', 'Rolling back database transaction');
            await conn.rollback();
        }
        res.status(500).json({ error: "Internal Server Error: " + err.message });
    } finally {
        if (client.isOpen) {
            log('DEBUG', 'GET_INSP_LOT', 'Closing SAP connection');
            await client.close();
        }
        if (conn) {
            log('DEBUG', 'GET_INSP_LOT', 'Releasing database connection');
            conn.release();
        }
    }
});

// ✅ FUNGSI UNTUK MEMBUAT TABEL JIKA BELUM ADA
async function createTableIfNotExists(connection) {
    try {
        log('DEBUG', 'CREATE_TABLE', 'Checking if table exists');
        
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS quality_inspection_lots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                PRUEFLOS VARCHAR(50) NOT NULL,
                WERK VARCHAR(10),
                ART VARCHAR(10),
                HERKUNFT VARCHAR(10),
                OBJNR VARCHAR(50),
                ENSTEHDAT DATE,
                ENTSTEZEIT VARCHAR(10),
                AUFNR VARCHAR(50),
                DISPO VARCHAR(50),
                ARBPL VARCHAR(50),
                KTEXT VARCHAR(255),
                ARBID VARCHAR(50),
                KUNNR VARCHAR(50),
                LIFNR VARCHAR(50),
                HERSTELLER VARCHAR(50),
                EMATNR VARCHAR(50),
                MATNR VARCHAR(50),
                CHARG VARCHAR(50),
                LAGORTCHRG VARCHAR(50),
                KDAUF VARCHAR(50),
                KDPOS VARCHAR(50),
                EBELN VARCHAR(50),
                EBELP VARCHAR(50),
                BLART VARCHAR(10),
                MJAHR VARCHAR(10),
                MBLNR VARCHAR(50),
                ZEILE VARCHAR(10),
                BUDAT DATE,
                BWART VARCHAR(10),
                WERKVORG VARCHAR(50),
                LAGORTVORG VARCHAR(50),
                LS_KDPOS VARCHAR(50),
                LS_VBELN VARCHAR(50),
                LS_POSNR VARCHAR(50),
                LS_ROUTE VARCHAR(50),
                LS_KUNAG VARCHAR(50),
                LS_VKORG VARCHAR(50),
                LS_KDMAT VARCHAR(50),
                SPRACHE VARCHAR(10),
                KTEXTMAT VARCHAR(255),
                LOSMENGE DECIMAL(15,3),
                MENGENEINH VARCHAR(10),
                LMENGE01 DECIMAL(15,3),
                LMENGE04 DECIMAL(15,3),
                LMENGE07 DECIMAL(15,3),
                LMENGEZUB DECIMAL(15,3),
                STAT34 VARCHAR(10),
                STAT35 VARCHAR(10),
                KTEXTLOS VARCHAR(255),
                INSP_DOC_NUMBER VARCHAR(50),
                AUFPL VARCHAR(50),
                STATS VARCHAR(10),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_prueflos (PRUEFLOS),
                INDEX idx_werk (WERK),
                INDEX idx_dispo (DISPO),
                INDEX idx_matnr (MATNR),
                INDEX idx_charg (CHARG)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `;
        
        await connection.query(createTableSQL);
        log('SUCCESS', 'CREATE_TABLE', 'Table checked/created successfully');
        
    } catch (err) {
        log('ERROR', 'CREATE_TABLE', 'Failed to create table', {
            error: err.message,
            stack: err.stack
        });
        throw err; // Re-throw agar error bisa ditangani di caller
    }
}

// ✅ JUGA TAMBAHKAN UNTUK TABEL INSPEKSI
async function createInspectionTableIfNotExists(connection) {
    try {
        log('DEBUG', 'CREATE_INSPECTION_TABLE', 'Checking if inspection table exists');
        
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS quality_inspections (
                id INT AUTO_INCREMENT PRIMARY KEY,
                prueflos VARCHAR(50) NOT NULL,
                charg VARCHAR(50),
                inspection_date DATE,
                unit VARCHAR(50),
                location VARCHAR(100),
                ktexmat VARCHAR(255),
                dispo VARCHAR(50),
                mengeneinh VARCHAR(10),
                lagortchrg VARCHAR(50),
                kdpos VARCHAR(50),
                kdauf VARCHAR(50),
                nik_qc VARCHAR(50),
                cause_effect TEXT,
                correction TEXT,
                aql_critical_found INT DEFAULT 0,
                aql_critical_allowed INT DEFAULT 0,
                aql_major_found INT DEFAULT 0,
                aql_major_allowed INT DEFAULT 0,
                aql_minor_found INT DEFAULT 0,
                aql_minor_allowed INT DEFAULT 0,
                inspection_items JSON,
                img_top_view LONGTEXT,
                img_bottom_view LONGTEXT,
                img_front_view LONGTEXT,
                img_back_view LONGTEXT,
                username VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_prueflos (prueflos),
                INDEX idx_charg (charg),
                INDEX idx_nik_qc (nik_qc),
                INDEX idx_inspection_date (inspection_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `;
        
        await connection.query(createTableSQL);
        log('SUCCESS', 'CREATE_INSPECTION_TABLE', 'Inspection table checked/created successfully');
        
    } catch (err) {
        log('ERROR', 'CREATE_INSPECTION_TABLE', 'Failed to create inspection table', {
            error: err.message,
            stack: err.stack
        });
        throw err;
    }
}

// ✅ UPDATE ENDPOINT SUBMIT-TO-SQL UNTUK CEK TABEL
app.post('/api/submit-to-sql', async (req, res) => {
    const inspection = req.body;
    
    log('INFO', 'SUBMIT_TO_SQL', 'Inspection submission received', {
        prueflos: inspection.prueflos,
        charg: inspection.charg,
        nik_qc: inspection.nik_qc,
        itemCount: inspection.inspection_items ? inspection.inspection_items.length : 0
    });

    let conn;
    try {
        log('DEBUG', 'SUBMIT_TO_SQL', 'Getting database connection');
        conn = await db.getConnection();
        
        // ✅ CEK DAN BUAT TABEL INSPEKSI JIKA BELUM ADA
        await createInspectionTableIfNotExists(conn);

        // Persiapan data
        const dataInsert = {
            prueflos: inspection.prueflos,
            charg: inspection.charg,
            inspection_date: inspection.inspection_date,
            unit: inspection.unit,
            location: inspection.location,
            ktexmat: inspection.ktexmat,
            dispo: inspection.dispo,
            mengeneinh: inspection.entry_uom,
            lagortchrg: inspection.stge_loc,
            kdpos: inspection.kdpos,
            kdauf: inspection.kdauf,
            nik_qc: inspection.nik_qc,
            cause_effect: inspection.cause_effect,
            correction: inspection.correction,
            aql_critical_found: parseInt(inspection.aql_critical_found || 0),
            aql_critical_allowed: parseInt(inspection.aql_critical_allowed || 0),
            aql_major_found: parseInt(inspection.aql_major_found || 0),
            aql_major_allowed: parseInt(inspection.aql_major_allowed || 0),
            aql_minor_found: parseInt(inspection.aql_minor_found || 0),
            aql_minor_allowed: parseInt(inspection.aql_minor_allowed || 0),
            inspection_items: JSON.stringify(inspection.inspection_items || []),
            img_top_view: inspection.img_top_view,
            img_bottom_view: inspection.img_bottom_view,
            img_front_view: inspection.img_front_view,
            img_back_view: inspection.img_back_view,
            username: inspection.username
        };

        log('DEBUG', 'SUBMIT_TO_SQL', 'Prepared data for insertion', {
            prueflos: dataInsert.prueflos,
            hasImages: {
                top: !!dataInsert.img_top_view,
                bottom: !!dataInsert.img_bottom_view,
                front: !!dataInsert.img_front_view,
                back: !!dataInsert.img_back_view
            }
        });

        const sql = `INSERT INTO quality_inspections SET ?`;
        
        log('DEBUG', 'SUBMIT_TO_SQL', 'Executing database insert');
        const [result] = await conn.query(sql, dataInsert);
        
        log('SUCCESS', 'SUBMIT_TO_SQL', 'Inspection data saved successfully', {
            insertId: result.insertId,
            prueflos: inspection.prueflos
        });

        res.json({ 
            message: "Data inspeksi berhasil disimpan", 
            status: "BERHASIL", 
            id: result.insertId 
        });

    } catch (err) {
        log('ERROR', 'SUBMIT_TO_SQL', 'Failed to save inspection data', {
            prueflos: inspection.prueflos,
            error: err.message,
            stack: err.stack
        });
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) {
            log('DEBUG', 'SUBMIT_TO_SQL', 'Releasing database connection');
            conn.release();
        }
    }
});

// 3. API Good Movement (344)
app.post('/api/good_movement_344', async (req, res) => {
    const data = req.body;
    
    log('INFO', 'GOOD_MOVEMENT_344', 'Good movement request received', {
        material: data.material,
        charg: data.charg,
        plant: '3000',
        stge_loc: data.stge_loc
    });

    const client = createSapClient(data.username, data.password);

    try {
        log('DEBUG', 'GOOD_MOVEMENT_344', 'Opening SAP connection');
        await client.open();

        const sapParams = {
            IV_MATERIAL: data.material,
            IV_PLANT: '3000',
            IV_STGE_LOC: data.stge_loc,
            IV_BATCH: data.charg,
            IV_MOVE_TYPE: '344',
            IV_SALES_ORD: data.kdauf || '',
            IV_S_ORD_ITEM: data.kdpos,
            IV_ENTRY_QTY_CHAR: data.reject || 0,
            IV_ENTRY_UOM: data.entry_uom,
            IV_REF_DOC_NO: '',
            IV_POST_DATE: getSapDateNow(),
            IV_DOC_DATE: getSapDateNow()
        };

        log('DEBUG', 'GOOD_MOVEMENT_344', 'Calling SAP function Z_RFC_GOODSMVT_PYCHAR', sapParams);
        const tpResponse = await client.call('Z_RFC_GOODSMVT_PYCHAR', sapParams);

        log('DEBUG', 'GOOD_MOVEMENT_344', 'Committing SAP transaction');
        await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });

        log('SUCCESS', 'GOOD_MOVEMENT_344', 'Good movement completed successfully', {
            material_doc: tpResponse.EV_MATERIAL_DOC,
            message: tpResponse.EV_MESSAGE
        });

        res.json({
            status: "success",
            material_doc: tpResponse.EV_MATERIAL_DOC,
            message: tpResponse.EV_MESSAGE
        });

    } catch (err) {
        log('ERROR', 'GOOD_MOVEMENT_344', 'Good movement failed', {
            material: data.material,
            charg: data.charg,
            error: err.message,
            stack: err.stack
        });
        res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (client.isOpen) {
            log('DEBUG', 'GOOD_MOVEMENT_344', 'Closing SAP connection');
            await client.close();
        }
    }
});

// 4. API Usage Decision
app.post('/api/send_usage_decision', async (req, res) => {
    const data = req.body;
    
    log('INFO', 'USAGE_DECISION', 'Usage decision request received', {
        prueflos: data.prueflos,
        username: data.username,
        plant: data.plant
    });

    const client = createSapClient(data.username, data.password);

    try {
        log('DEBUG', 'USAGE_DECISION', 'Opening SAP connection');
        await client.open();

        const udParams = {
            IV_NUMBER: data.prueflos,
            IV_UD_SELECTED_SET: data.ud_selected_set,
            IV_UD_PLANT: data.plant,
            IV_UD_CODE_GROUP: data.ud_code_group,
            IV_UD_CODE: data.ud_code,
            IV_RECORDED_BY_USER: data.username,
            IV_RECORDED_ON_DATE: getSapDateNow(),
            IV_RECORDED_AT_TIME: getSapTimeNow(),
            IV_STOCK_POSTING: data.stock_posting
        };

        log('DEBUG', 'USAGE_DECISION', 'Calling SAP function Z_RFC_UD_RECEIVE_PY', udParams);
        const udResponse = await client.call('Z_RFC_UD_RECEIVE_PY', udParams);

        log('DEBUG', 'USAGE_DECISION', 'Committing SAP transaction');
        await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });

        const udMsg = udResponse.EV_MESSAGE || "No message returned";
        const subrc = udResponse.EV_SUBRC;
        const success = (subrc == 0 || subrc == '0');

        log(success ? 'SUCCESS' : 'WARN', 'USAGE_DECISION', 'Usage decision completed', {
            prueflos: data.prueflos,
            success: success,
            subrc: subrc,
            message: udMsg
        });

        res.json({
            status: success ? "success" : "error",
            message: udMsg,
            usage_decision: {
                message: udMsg,
                subrc: subrc,
                success: success
            }
        });

    } catch (err) {
        log('ERROR', 'USAGE_DECISION', 'Usage decision failed', {
            prueflos: data.prueflos,
            error: err.message,
            stack: err.stack
        });
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        if (client.isOpen) {
            log('DEBUG', 'USAGE_DECISION', 'Closing SAP connection');
            await client.close();
        }
    }
});

// 5. API Submit Inspection to SQL
app.post('/api/submit-to-sql', async (req, res) => {
    const inspection = req.body;
    
    log('INFO', 'SUBMIT_TO_SQL', 'Inspection submission received', {
        prueflos: inspection.prueflos,
        charg: inspection.charg,
        nik_qc: inspection.nik_qc,
        itemCount: inspection.inspection_items ? inspection.inspection_items.length : 0
    });

    try {
        // Persiapan data
        const dataInsert = {
            prueflos: inspection.prueflos,
            charg: inspection.charg,
            inspection_date: inspection.inspection_date,
            unit: inspection.unit,
            location: inspection.location,
            ktexmat: inspection.ktexmat,
            dispo: inspection.dispo,
            mengeneinh: inspection.entry_uom,
            lagortchrg: inspection.stge_loc,
            kdpos: inspection.kdpos,
            kdauf: inspection.kdauf,
            nik_qc: inspection.nik_qc,
            cause_effect: inspection.cause_effect,
            correction: inspection.correction,
            aql_critical_found: parseInt(inspection.aql_critical_found || 0),
            aql_critical_allowed: parseInt(inspection.aql_critical_allowed || 0),
            aql_major_found: parseInt(inspection.aql_major_found || 0),
            aql_major_allowed: parseInt(inspection.aql_major_allowed || 0),
            aql_minor_found: parseInt(inspection.aql_minor_found || 0),
            aql_minor_allowed: parseInt(inspection.aql_minor_allowed || 0),
            inspection_items: JSON.stringify(inspection.inspection_items || []),
            img_top_view: inspection.img_top_view,
            img_bottom_view: inspection.img_bottom_view,
            img_front_view: inspection.img_front_view,
            img_back_view: inspection.img_back_view,
            username: inspection.username
        };

        log('DEBUG', 'SUBMIT_TO_SQL', 'Prepared data for insertion', {
            prueflos: dataInsert.prueflos,
            hasImages: {
                top: !!dataInsert.img_top_view,
                bottom: !!dataInsert.img_bottom_view,
                front: !!dataInsert.img_front_view,
                back: !!dataInsert.img_back_view
            }
        });

        const sql = `INSERT INTO quality_inspections SET ?`;
        
        log('DEBUG', 'SUBMIT_TO_SQL', 'Executing database insert');
        const [result] = await db.query(sql, dataInsert);
        
        log('SUCCESS', 'SUBMIT_TO_SQL', 'Inspection data saved successfully', {
            insertId: result.insertId,
            prueflos: inspection.prueflos
        });

        res.json({ 
            message: "Data inspeksi berhasil disimpan", 
            status: "BERHASIL", 
            id: result.insertId 
        });

    } catch (err) {
        log('ERROR', 'SUBMIT_TO_SQL', 'Failed to save inspection data', {
            prueflos: inspection.prueflos,
            error: err.message,
            stack: err.stack
        });
        res.status(500).json({ error: err.message });
    }
});

// Health Check Endpoint
app.get('/health', (req, res) => {
    log('INFO', 'HEALTH', 'Health check requested');
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Quality Inspection API'
    });
});

const PORT = process.env.PORT || 4003;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    log('INFO', 'SERVER', 'Server started successfully', {
        host: HOST,
        port: PORT,
        environment: process.env.NODE_ENV || 'development'
    });
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`Bisa diakses dari LAN via IP Server Windows ini.`);
});