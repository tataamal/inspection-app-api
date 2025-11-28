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
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true }));

// --- LOGGING CONFIGURATION ---
function log(level, endpoint, message, data = null) {
    const timestamp = new Date().toISOString();
    // Jika data error object, ambil message dan stack-nya
    let logData = data;
    if (data instanceof Error) {
        logData = { message: data.message, stack: data.stack };
    } else if (typeof data === 'object' && data !== null) {
        try {
            logData = JSON.stringify(data);
        } catch (e) {
            logData = '[Circular/Complex Data]';
        }
    }

    const logEntry = `[${timestamp}] [${level}] [${endpoint}] ${message} ${logData ? '| ' + logData : ''}`;
    
    console.log(logEntry);
    
    // Tulis ke file log
    const logFile = path.join(__dirname, 'app.log');
    fs.appendFileSync(logFile, logEntry + '\n');
}

// --- HELPER FUNCTIONS ---

// Helper untuk SAP Connection
function createSapClient(username, password) {
    // Hindari log password di production
    log('DEBUG', 'SAP_CLIENT', 'Creating SAP client config', { username, host: process.env.SAP_HOST });
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
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// Helper waktu hari ini HHMMSS
function getSapTimeNow() {
    return new Date().toTimeString().split(' ')[0].replace(/:/g, '');
}

// --- API ENDPOINTS ---

// 1. API Login SAP
app.post('/api/sap-login', async (req, res) => {
    const { username, password } = req.body;
    log('INFO', 'SAP_LOGIN', 'Login attempt', { username });
    
    const client = createSapClient(username, password);

    try {
        await client.open();
        await client.ping();
        
        log('SUCCESS', 'SAP_LOGIN', 'Login successful', { username });
        res.status(200).json({
            status: 'connected',
            message: 'Login successful',
            username: username
        });
        
    } catch (err) {
        log('ERROR', 'SAP_LOGIN', 'Login failed', err);
        res.status(401).json({ error: "Authentication failed: " + err.message });
    } finally {
        if (client.isOpen) await client.close();
    }
});

// 2. API Get Inspection Lot (Sync SAP to DB)
app.get('/api/get_insp_lot', async (req, res) => {
    const { plant, username, password, dispo } = req.query;
    
    log('INFO', 'GET_INSP_LOT', 'Sync request started', { plant, username, dispo });

    if (!plant || !dispo) {
        log('WARN', 'GET_INSP_LOT', 'Missing parameters');
        return res.status(400).json({ error: "Parameters 'plant' and 'dispo' are required" });
    }

    // [FIX 1] Typo "x``" dihapus
    const client = createSapClient(username, password);
    let conn;

    try {
        // --- STEP 1: FETCH SAP DATA ---
        log('DEBUG', 'GET_INSP_LOT', 'Connecting to SAP...');
        await client.open();

        const sapParams = { IV_WERKS: plant, IV_DISPO: dispo };
        const result = await client.call('Z_RFC_GET_INSP_LOT_BY_DISPO', sapParams);
        
        const data = result.ET_QALS || [];
        const comp = result.T_DATA4 || [];
        
        log('INFO', 'GET_INSP_LOT', 'SAP Data Fetched', { 
            inspLots: data.length, 
            components: comp.length 
        });

        // --- STEP 2: DATABASE TRANSACTION ---
        log('DEBUG', 'GET_INSP_LOT', 'Starting DB Transaction');
        conn = await db.getConnection();
        await conn.beginTransaction();

        // A. DELETE & INSERT INSPECTION LOTS
        log('DEBUG', 'GET_INSP_LOT', 'Cleaning old Inspection Lots', { plant, dispo });
        await conn.query("DELETE FROM quality_inspection_lots WHERE WERK = ? AND DISPO = ?", [plant, dispo]);

        if (data.length > 0) {
            const sqlInsp = `
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
            
            const valuesInsp = data.map(lot => [
                lot.PRUEFLOS, lot.WERK, lot.ART, lot.HERKUNFT, lot.OBJNR, parseDate(lot.ENSTEHDAT), lot.ENTSTEZEIT,
                lot.AUFNR, lot.DISPO, lot.ARBPL, lot.KTEXT, lot.ARBID, lot.KUNNR, lot.LIFNR, lot.HERSTELLER,
                lot.EMATNR, lot.MATNR, lot.CHARG, lot.LAGORTCHRG, lot.KDAUF, lot.KDPOS, lot.EBELN, lot.EBELP,
                lot.BLART, lot.MJAHR, lot.MBLNR, lot.ZEILE, parseDate(lot.BUDAT), lot.BWART, lot.WERKVORG, lot.LAGORTVORG,
                lot.LS_KDPOS, lot.LS_VBELN, lot.LS_POSNR, lot.LS_ROUTE, lot.LS_KUNAG, lot.LS_VKORG,
                lot.LS_KDMAT, lot.SPRACHE, lot.KTEXTMAT, lot.LOSMENGE, lot.MENGENEINH, lot.LMENGE01,
                lot.LMENGE04, lot.LMENGE07, lot.LMENGEZUB, lot.STAT34, lot.STAT35, lot.KTEXTLOS,
                lot.INSP_DOC_NUMBER, lot.AUFPL, lot.STATS
            ]);

            await conn.query(sqlInsp, [valuesInsp]);
            log('DEBUG', 'GET_INSP_LOT', `Inserted ${valuesInsp.length} Inspection Lots`);
        }

        // B. DELETE & INSERT COMPONENTS (Based on AUFNR)
        const aufnrList = [...new Set(data.map(item => item.AUFNR).filter(id => id))];

        if (aufnrList.length > 0) {
            log('DEBUG', 'GET_INSP_LOT', 'Cleaning old Components by AUFNR', { count: aufnrList.length });
            const placeholders = aufnrList.map(() => '?').join(',');
            await conn.query(`DELETE FROM production_t_data4 WHERE AUFNR IN (${placeholders})`, aufnrList);
        }

        if (comp.length > 0) {
            const sqlComp = `
                INSERT INTO production_t_data4 (
                    MANDT, RSNUM, RSPOS, VORNR, WERKS, KDAUF, KDPOS, AUFNR, PLNUM, 
                    STATS, DISPO, MATNR, MAKTX, MEINS, BAUGR, WERKSX, BDMNG, KALAB, 
                    VMENG, SOBSL, BESKZ, LTEXT, LGORT, OUTSREQ, AUFNR2, CHARGX2, USRISP, created_at, updated_at
                ) VALUES ?
            `;

            const valuesComp = comp.map(c => [
                c.MANDT, c.RSNUM, c.RSPOS, c.VORNR, c.WERKS, c.KDAUF, c.KDPOS, c.AUFNR, c.PLNUM,
                c.STATS, c.DISPO, c.MATNR, c.MAKTX, c.MEINS, c.BAUGR, c.WERKSX, 
                c.BDMNG || 0, c.KALAB || 0, c.VMENG || 0, 
                c.SOBSL, c.BESKZ, c.LTEXT, c.LGORT, c.OUTSREQ, c.AUFNR2, c.CHARGX2, c.USRISP,
                new Date(), new Date()
            ]);

            await conn.query(sqlComp, [valuesComp]);
            log('DEBUG', 'GET_INSP_LOT', `Inserted ${valuesComp.length} Components`);
        }

        // --- STEP 3: COMMIT ---
        await conn.commit();
        log('SUCCESS', 'GET_INSP_LOT', 'Sync Completed Successfully');
        res.status(200).json({ 
            message: `Sinkronisasi Selesai. Inspection Lot: ${data.length}, Components: ${comp.length}`,
            data: data, // <-- INI YANG PENTING
            data_components: comp
        });

    } catch (err) {
        log('ERROR', 'GET_INSP_LOT', 'Process Failed', err);
        
        if (conn) {
            log('WARN', 'GET_INSP_LOT', 'Rolling back transaction');
            await conn.rollback();
        }
        res.status(500).json({ error: "Internal Server Error: " + err.message });
    } finally {
        if (client.isOpen) await client.close();
        if (conn) conn.release();
    }
});

// 3. API Submit Inspection to SQL (Single source of truth)
app.post('/api/submit-to-sql', async (req, res) => {
    const inspection = req.body;
    
    log('INFO', 'SUBMIT_TO_SQL', 'Saving inspection result', { prueflos: inspection.prueflos, user: inspection.username });

    // Validasi sederhana
    if (!inspection.prueflos) {
        return res.status(400).json({ error: "Prueflos (Inspection Lot) is required" });
    }

    let conn;
    try {
        conn = await db.getConnection();
        
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

        const sql = `INSERT INTO quality_inspections SET ?`;
        
        // Menggunakan conn (connection) bukan db (pool) agar konsisten jika ingin expand ke transaction
        const [result] = await conn.query(sql, dataInsert);
        
        log('SUCCESS', 'SUBMIT_TO_SQL', 'Saved successfully', { insertId: result.insertId });

        res.status(201).json({ 
            message: "Data inspeksi berhasil disimpan", 
            status: "BERHASIL", 
            id: result.insertId 
        });

    } catch (err) {
        log('ERROR', 'SUBMIT_TO_SQL', 'Database Insert Failed', err);
        res.status(500).json({ error: "Database error: " + err.message });
    } finally {
        if (conn) conn.release();
    }
});

// 4. API Good Movement (344)
app.post('/api/good_movement_344', async (req, res) => {
    const data = req.body;
    
    if(!data.material || !data.charg) {
        return res.status(400).json({ status: 'error', message: 'Missing material or charg' });
    }

    log('INFO', 'GOOD_MOVEMENT_344', 'Request received', { material: data.material, charg: data.charg });

    const client = createSapClient(data.username, data.password);

    try {
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

        const tpResponse = await client.call('Z_RFC_GOODSMVT_PYCHAR', sapParams);
        await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });

        log('SUCCESS', 'GOOD_MOVEMENT_344', 'SAP Transaction Done', { msg: tpResponse.EV_MESSAGE });

        res.status(200).json({
            status: "success",
            material_doc: tpResponse.EV_MATERIAL_DOC,
            message: tpResponse.EV_MESSAGE
        });

    } catch (err) {
        log('ERROR', 'GOOD_MOVEMENT_344', 'SAP Call Failed', err);
        res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (client.isOpen) await client.close();
    }
});

// 5. API Usage Decision
app.post('/api/send_usage_decision', async (req, res) => {
    const data = req.body;
    const logPrefix = `[UD ${data.prueflos}]`;
    log('INFO', 'USAGE_DECISION', `${logPrefix} Req received. Plant: ${data.plant}, NIK: ${data.nik}`);

    try {
        await db.query('SELECT 1'); 
    } catch (dbError) {
        log('ERROR', 'USAGE_DECISION', `${logPrefix} ABORTED. Local DB Connection Lost.`, dbError);
        return res.status(500).json({ 
            status: "error", 
            message: "CRITICAL: Koneksi database lokal terputus. Transaksi dibatalkan demi keamanan data." 
        });
    }
    const client = createSapClient(data.username, data.password);

    try {
        await client.open();
        const udParams = {
            IV_NUMBER: data.prueflos,
            IV_UD_SELECTED_SET: data.ud_selected_set,
            IV_UD_PLANT: data.plant,
            IV_UD_CODE_GROUP: data.ud_code_group,
            IV_UD_CODE: data.ud_code,
            IV_RECORDED_BY_USER: data.nik, 
            IV_RECORDED_ON_DATE: getSapDateNow(),
            IV_RECORDED_AT_TIME: getSapTimeNow(),
            IV_STOCK_POSTING:"X"
        };

        const udResponse = await client.call('Z_RFC_UD_RECEIVE_PY', udParams);
        
        // Commit transaksi di SAP
        await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });

        const udMsg = udResponse.EV_MSG || "No message returned";
        const subrc = udResponse.EV_SUBRC;
        const isSuccess = (subrc == 0 || subrc == '0');

        // Log Hasil Akhir
        log(isSuccess ? 'INFO' : 'WARN', 'USAGE_DECISION', `${logPrefix} Finished. Success: ${isSuccess}, Msg: ${udMsg}`);

        if (isSuccess) {
            res.status(200).json({ status: "success", message: udMsg });
        } else {
            res.status(400).json({ status: "error", message: udMsg, subrc: subrc });
        }

    } catch (err) {
        log('ERROR', 'USAGE_DECISION', `${logPrefix} System Error`, err.message);
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        if (client.isOpen) await client.close();
    }
});

// Health Check Endpoint
app.get('/health', (req, res) => {
    log('INFO', 'HEALTH', 'Check OK');
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4003;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    log('INFO', 'SERVER', `Server started on http://${HOST}:${PORT}`);
});