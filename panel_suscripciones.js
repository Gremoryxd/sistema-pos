/**
 * PROGRAMA EXTERNO INDEPENDIENTE DE CONTROL DE SUSCRIPCIONES Y LICENCIAS POS
 * Exclusivo para el Dueño / Administrador en su PC Servidor.
 *
 * Uso:
 *   node panel_suscripciones.js
 * Panel Web Privado (Solo accesible desde esta PC):
 *   http://localhost:4500
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const db = require('./database');

const appPanel = express();
appPanel.disable('x-powered-by');
appPanel.use(express.json({ limit: '2mb' }));

const PUERTO_PANEL_DUENO = 4500;
const SECRETO_MAESTRO_LICENCIA_SV = 'POS_MASTER_SV_FERNANDO_2026_ULTRA_SECRET_KEY_9981';
const rutaArchivoLicencia = path.join(__dirname, 'licencia.lic');
const dirCerts = db.dirCerts || path.join(__dirname, 'certs');
const rutaLlavePrivadaEd25519 = path.join(__dirname, 'llave_privada_ed25519.pem');
const rutaLlavePublicaEd25519 = path.join(dirCerts, 'pos_ed25519_pub.pem');

// ============================================================================
// 1. CANDADO ESTRICTO LOCALHOST (PROHIBIDO EL ACCESO DESDE LAN O TAILSCALE)
// ============================================================================
const sesionesPanelDueno = new Map();

appPanel.use((req, res, next) => {
  const ip = ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').trim();
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== 'localhost') {
    return res.status(403).end('Acceso prohibido: Este panel solo puede abrirse directamente en la PC del Dueno (localhost).');
  }
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ============================================================================
// 2. UTILIDADES CRIPTOGRÁFICAS (HARDWARE ID, ED25519 + HMAC Y AUTENTICACIÓN)
// ============================================================================
function obtenerHardwareIDServidorLocal() {
  const piezas = [];
  const plataforma = os.platform();
  try {
    if (plataforma === 'win32') {
      try {
        const uuidOut = execSync(
          'powershell -NoProfile -Command "(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID"',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3500 }
        ).trim();
        if (uuidOut && uuidOut.length > 5 && !uuidOut.includes('FFFF')) piezas.push(uuidOut);
      } catch (e) {
        try {
          const wmicOut = execSync('wmic csproduct get uuid', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
          const lineas = wmicOut.split(/\r?\n/).map(l => l.trim()).filter(l => l && l.toUpperCase() !== 'UUID');
          if (lineas[0]) piezas.push(lineas[0]);
        } catch (err2) {}
      }
      try {
        const boardOut = execSync(
          'powershell -NoProfile -Command "(Get-CimInstance -Class Win32_BaseBoard).SerialNumber"',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }
        ).trim();
        if (boardOut) piezas.push(boardOut);
      } catch (e) {}
    } else if (plataforma === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id', '/sys/class/dmi/id/product_uuid']) {
        if (fs.existsSync(p)) {
          const val = fs.readFileSync(p, 'utf8').trim();
          if (val) { piezas.push(val); break; }
        }
      }
    }
  } catch (e) {}

  const cpus = os.cpus() || [];
  const modeloCpu = cpus.length > 0 ? cpus[0].model : 'CPU_STD';
  piezas.push(`${os.arch()}|${plataforma}|${modeloCpu}|${cpus.length}`);

  const hashCompleto = crypto.createHash('sha256').update(`HWID_SV_SALT_2026::${piezas.join('::')}`).digest('hex').toUpperCase();
  return `POS-SV-${hashCompleto.slice(0, 4)}-${hashCompleto.slice(4, 8)}-${hashCompleto.slice(8, 12)}`;
}

function obtenerIPsServidor() {
  const interfaces = os.networkInterfaces();
  let ipTailscale = '';
  let ipLan = '127.0.0.1';

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const partes = iface.address.split('.').map(Number);
        if (partes[0] === 100 && partes[1] >= 64 && partes[1] <= 127) {
          ipTailscale = iface.address;
        } else if (ipLan === '127.0.0.1') {
          ipLan = iface.address;
        }
      }
    }
  }
  return { ipTailscale: ipTailscale || ipLan, ipLan };
}

function asegurarLlavesEd25519() {
  try {
    if (!fs.existsSync(dirCerts)) fs.mkdirSync(dirCerts, { recursive: true });
    if (fs.existsSync(rutaLlavePrivadaEd25519)) {
      const privPem = fs.readFileSync(rutaLlavePrivadaEd25519, 'utf8');
      if (!fs.existsSync(rutaLlavePublicaEd25519)) {
        const pubObj = crypto.createPublicKey(privPem);
        fs.writeFileSync(rutaLlavePublicaEd25519, pubObj.export({ type: 'spki', format: 'pem' }), 'utf8');
      }
      return privPem;
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(rutaLlavePrivadaEd25519, privateKey, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(rutaLlavePublicaEd25519, publicKey, 'utf8');
    return privateKey;
  } catch (e) {
    return null;
  }
}

function firmarPayloadLicencia(payloadObj) {
  const objetoLimpio = {
    hwid: String(payloadObj.hwid || '').trim().toUpperCase(),
    cliente: String(payloadObj.cliente || 'Cliente POS').trim(),
    vencimiento: String(payloadObj.vencimiento || '').trim(),
    tipo: String(payloadObj.tipo || 'MENSUAL').trim().toUpperCase()
  };
  if (payloadObj.idCliente) {
    objetoLimpio.idCliente = String(payloadObj.idCliente).trim().toUpperCase();
  }

  const jsonCanonico = JSON.stringify(objetoLimpio);
  const base64Payload = Buffer.from(jsonCanonico, 'utf8').toString('base64url');
  const claveDerivada = crypto.scryptSync(SECRETO_MAESTRO_LICENCIA_SV, 'SALT_FIRMA_COMERCIAL_SV_2026', 64);
  const firmaHex = crypto.createHmac('sha256', claveDerivada).update(base64Payload).digest('hex').toUpperCase().slice(0, 40);

  const privKey = asegurarLlavesEd25519();
  if (privKey) {
    try {
      const firmaEd = crypto.sign(null, Buffer.from(base64Payload, 'utf8'), privKey).toString('base64url');
      return `POSLIC-${base64Payload}.${firmaHex}.${firmaEd}`;
    } catch (e) {}
  }
  return `POSLIC-${base64Payload}.${firmaHex}`;
}

function verificarPinSuperAdmin(pinIngresado) {
  if (!pinIngresado) return false;
  const limpio = String(pinIngresado).trim();
  const admins = db.prepare("SELECT rowid, nombre, rol, pin, pin_hash FROM usuarios ORDER BY rowid ASC").all();
  for (const u of admins) {
    const rol = (u.rol || '').toLowerCase();
    const nom = (u.nombre || '').toLowerCase();
    if (rol === 'admin' || rol === 'administrador' || nom.includes('admin') || nom.includes('dueño')) {
      if (u.pin_hash && db.compararPinSeguro(limpio, u.pin_hash)) return true;
      if (!u.pin_hash && u.pin === limpio) return true;
    }
  }
  return false;
}

function middlewareAuthDueno(req, res, next) {
  const token = (req.headers['x-panel-token'] || '').toString().trim();
  if (!token || !sesionesPanelDueno.has(token)) {
    return res.status(401).json({ error: 'Sesión expirada. Ingrese su PIN de Dueño.' });
  }
  next();
}

// ============================================================================
// 3. ENDPOINTS API DEL PROGRAMA EXTERNO DE SUSCRIPCIONES
// ============================================================================
appPanel.post('/api/login', (req, res) => {
  const { pin } = req.body || {};
  if (!verificarPinSuperAdmin(pin)) {
    return res.status(401).json({ exito: false, mensaje: 'PIN de Dueño / Super-Admin incorrecto.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sesionesPanelDueno.set(token, { creado: Date.now() });
  res.json({ exito: true, token });
});

appPanel.get('/api/datos-panel', middlewareAuthDueno, (req, res) => {
  const hwidServidor = obtenerHardwareIDServidorLocal();
  const ips = obtenerIPsServidor();
  const filas = db.prepare('SELECT * FROM suscripciones_clientes ORDER BY rowid DESC').all();

  let tokenInstalado = '';
  try {
    const fTok = db.prepare("SELECT valor FROM configuracion WHERE clave = 'LICENCIA_COMERCIAL_TOKEN'").get();
    if (fTok && fTok.valor) tokenInstalado = fTok.valor;
    else if (fs.existsSync(rutaArchivoLicencia)) tokenInstalado = fs.readFileSync(rutaArchivoLicencia, 'utf8').trim();
  } catch (e) {}

  res.json({
    exito: true,
    hardwareIdServidor: hwidServidor,
    ipTailscale: ips.ipTailscale,
    ipLan: ips.ipLan,
    tokenInstaladoEnServidor: tokenInstalado,
    clientes: filas.map(s => ({
      idCliente: s.id_cliente,
      nombreNegocio: s.nombre_negocio,
      hardwareId: s.hardware_id || hwidServidor,
      estadoManual: s.estado_manual || 'ACTIVO',
      fechaVencimiento: s.fecha_vencimiento || '',
      plan: s.plan || 'MENSUAL',
      montoMensual: parseFloat(s.monto_mensual) || 0,
      motivoSuspension: s.motivo_suspension || '',
      tokenLicencia: s.token_licencia || '',
      ultimaConexion: s.ultima_conexion ? new Date(s.ultima_conexion).toLocaleString() : 'Sin registro'
    }))
  });
});

appPanel.post('/api/guardar-cliente', middlewareAuthDueno, (req, res) => {
  const { idCliente, nombreNegocio, hardwareId, fechaVencimiento, montoMensual } = req.body || {};
  const hwidServidor = obtenerHardwareIDServidorLocal();
  const nombreLimpio = String(nombreNegocio || '').replace(/[<>]/g, '').trim().slice(0, 100);
  const hwidLimpio = String(hardwareId || hwidServidor).trim().toUpperCase();
  const fechaLimpia = String(fechaVencimiento || '').trim();
  const cuota = Math.max(0, parseFloat(montoMensual) || 25);

  if (!nombreLimpio || !/^\d{4}-\d{2}-\d{2}$/.test(fechaLimpia)) {
    return res.json({ exito: false, mensaje: 'Nombre del negocio y Fecha de Corte (YYYY-MM-DD) son obligatorios.' });
  }

  const idFinal = idCliente
    ? String(idCliente).trim().toUpperCase()
    : `CLI-${hwidLimpio.replace(/^POS-SV-/, '').slice(0, 9)}-${crypto.randomInt(10, 99)}`;

  const plan = fechaLimpia.startsWith('2099') ? 'PERMANENTE' : 'MENSUAL';
  const nuevoToken = firmarPayloadLicencia({
    hwid: hwidLimpio,
    idCliente: idFinal,
    cliente: nombreLimpio,
    vencimiento: fechaLimpia,
    tipo: plan
  });

  db.prepare(`
    INSERT OR REPLACE INTO suscripciones_clientes
    (id_cliente, nombre_negocio, hardware_id, estado_manual, fecha_vencimiento, plan, monto_mensual, motivo_suspension, token_licencia, ultima_conexion)
    VALUES (?, ?, ?, 'ACTIVO', ?, ?, ?, '', ?, ?)
  `).run(idFinal, nombreLimpio, hwidLimpio, fechaLimpia, plan, cuota, nuevoToken, new Date().toISOString());

  // Si el Hardware ID es el de este mismo servidor en casa, inyectar y activar la nueva llave automáticamente
  if (hwidLimpio === hwidServidor) {
    db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('LICENCIA_COMERCIAL_TOKEN', ?)").run(nuevoToken);
    db.prepare("DELETE FROM configuracion WHERE clave = 'ESTADO_REMOTO_SUSCRIPCION_JSON'").run();
    fs.writeFileSync(rutaArchivoLicencia, nuevoToken, 'utf8');
  }

  db.registrarAuditoria('PANEL_EXTERNO_LICENCIA', `Licencia emitida/actualizada para ${nombreLimpio} (Vence: ${fechaLimpia})`, 'Dueño (Panel Externo)', '127.0.0.1', 'INFO');

  res.json({
    exito: true,
    mensaje: hwidLimpio === hwidServidor
      ? `✅ Cliente '${nombreLimpio}' guardado y llave activada automáticamente en este servidor hasta el ${fechaLimpia}.`
      : `✅ Cliente '${nombreLimpio}' guardado y llave POSLIC generada.`,
    tokenLicencia: nuevoToken
  });
});

appPanel.post('/api/cambiar-estado', middlewareAuthDueno, (req, res) => {
  const { idCliente, nuevoEstado, motivo } = req.body || {};
  const sub = db.prepare('SELECT * FROM suscripciones_clientes WHERE id_cliente = ?').get(String(idCliente || '').trim());
  if (!sub) return res.json({ exito: false, mensaje: 'Cliente no encontrado.' });

  const estadoFinal = String(nuevoEstado || '').toUpperCase() === 'SUSPENDIDO' ? 'SUSPENDIDO' : 'ACTIVO';
  const motivoFinal = estadoFinal === 'SUSPENDIDO'
    ? String(motivo || 'Mensualidad vencida pendiente de pago.').replace(/[<>]/g, '').trim().slice(0, 160)
    : '';

  db.prepare('UPDATE suscripciones_clientes SET estado_manual = ?, motivo_suspension = ? WHERE id_cliente = ?')
    .run(estadoFinal, motivoFinal, sub.id_cliente);

  db.registrarAuditoria(
    estadoFinal === 'SUSPENDIDO' ? 'SUSPENSION_EXTERNA' : 'REACTIVACION_EXTERNA',
    `${sub.nombre_negocio} (${sub.hardware_id}) -> ${estadoFinal}. ${motivoFinal}`,
    'Dueño (Panel Externo)',
    '127.0.0.1',
    estadoFinal === 'SUSPENDIDO' ? 'ALERTA' : 'INFO'
  );

  res.json({
    exito: true,
    mensaje: estadoFinal === 'SUSPENDIDO'
      ? `⛔ Servicio SUSPENDIDO al instante para '${sub.nombre_negocio}' sin apagar el servidor.`
      : `✅ Servicio REACTIVADO al instante para '${sub.nombre_negocio}'.`
  });
});

appPanel.post('/api/renovar-30-dias', middlewareAuthDueno, (req, res) => {
  const { idCliente } = req.body || {};
  const sub = db.prepare('SELECT * FROM suscripciones_clientes WHERE id_cliente = ?').get(String(idCliente || '').trim());
  if (!sub) return res.json({ exito: false, mensaje: 'Cliente no encontrado.' });

  const hwidServidor = obtenerHardwareIDServidorLocal();
  const baseDate = (sub.fecha_vencimiento && new Date(sub.fecha_vencimiento) > new Date())
    ? new Date(sub.fecha_vencimiento + 'T12:00:00')
    : new Date();

  baseDate.setDate(baseDate.getDate() + 30);
  const y = baseDate.getFullYear();
  const m = String(baseDate.getMonth() + 1).padStart(2, '0');
  const d = String(baseDate.getDate()).padStart(2, '0');
  const nuevaFechaYMD = `${y}-${m}-${d}`;

  const nuevoToken = firmarPayloadLicencia({
    hwid: sub.hardware_id || hwidServidor,
    idCliente: sub.id_cliente,
    cliente: sub.nombre_negocio,
    vencimiento: nuevaFechaYMD,
    tipo: 'MENSUAL'
  });

  db.prepare(`
    UPDATE suscripciones_clientes
    SET estado_manual = 'ACTIVO', motivo_suspension = '', fecha_vencimiento = ?, token_licencia = ?
    WHERE id_cliente = ?
  `).run(nuevaFechaYMD, nuevoToken, sub.id_cliente);

  if ((sub.hardware_id || '').toUpperCase() === hwidServidor) {
    db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('LICENCIA_COMERCIAL_TOKEN', ?)").run(nuevoToken);
    db.prepare("DELETE FROM configuracion WHERE clave = 'ESTADO_REMOTO_SUSCRIPCION_JSON'").run();
    fs.writeFileSync(rutaArchivoLicencia, nuevoToken, 'utf8');
  }

  db.registrarAuditoria('RENOVACION_30_DIAS', `${sub.nombre_negocio} renovado hasta ${nuevaFechaYMD}`, 'Dueño (Panel Externo)', '127.0.0.1', 'INFO');

  res.json({
    exito: true,
    mensaje: `✅ Suscripción de '${sub.nombre_negocio}' reactivada y extendida +30 días (Nuevo corte: ${nuevaFechaYMD}). Llave aplicada automáticamente.`
  });
});

appPanel.post('/api/eliminar-cliente', middlewareAuthDueno, (req, res) => {
  const { idCliente } = req.body || {};
  db.prepare('DELETE FROM suscripciones_clientes WHERE id_cliente = ?').run(String(idCliente || '').trim());
  res.json({ exito: true, mensaje: 'Registro eliminado.' });
});

// ============================================================================
// 4. INTERFAZ WEB INDEPENDIENTE DEL DUEÑO (http://localhost:4500)
// ============================================================================
appPanel.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Panel Maestro del Dueño — Control de Suscripciones POS</title>
  <style>
    :root { --bg: #0b1120; --panel: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; }
    body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    .contenedor { max-width: 1100px; margin: 0 auto; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 18px; box-shadow: 0 10px 25px rgba(0,0,0,0.35); }
    h1, h2, h3 { margin-top: 0; }
    input, select { background: #0f172a; border: 1px solid var(--border); color: white; padding: 10px 12px; border-radius: 6px; font-size: 14px; outline: none; box-sizing: border-box; }
    input:focus { border-color: #38bdf8; }
    button { border: none; border-radius: 6px; padding: 10px 14px; font-weight: 800; font-size: 12px; cursor: pointer; text-transform: uppercase; color: white; transition: filter 0.15s; }
    button:hover { filter: brightness(1.12); }
    .btn-azul { background: #2563eb; }
    .btn-verde { background: #059669; }
    .btn-rojo { background: #dc2626; }
    .btn-ambar { background: #d97706; }
    .btn-gris { background: #475569; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13.5px; }
    th { background: #0f172a; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 900; display: inline-block; }
    .badge-activo { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #059669; }
    .badge-suspendido { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid #dc2626; }
    #vistaPanel { display: none; }
  </style>
</head>
<body>
  <div class="contenedor">
    <!-- LOGIN DEL DUEÑO -->
    <div id="vistaLogin" class="card" style="max-width: 400px; margin: 80px auto; text-align: center;">
      <div style="font-size: 38px; margin-bottom: 10px;">👑</div>
      <h2>Panel Externo de Suscripciones</h2>
      <p style="color: var(--muted); font-size: 13px; margin-bottom: 20px;">Acceso exclusivo en localhost para el Dueño del Sistema POS.</p>
      <input type="password" id="inputPinLogin" placeholder="PIN de Dueño / Super-Admin" style="width: 100%; text-align: center; font-size: 20px; letter-spacing: 6px; margin-bottom: 16px;" onkeypress="if(event.key==='Enter') iniciarSesion()">
      <button class="btn-azul" style="width: 100%; padding: 14px;" onclick="iniciarSesion()">Entrar al Panel de Control</button>
    </div>

    <!-- PANEL PRINCIPAL -->
    <div id="vistaPanel">
      <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <h2 style="margin:0; color:#38bdf8;">📡 Consola Maestra de Suscripciones y Licencias POS</h2>
          <span style="font-size:12.5px; color:var(--muted);">Suspende o reactiva el acceso de tus clientes en tiempo real sin apagar el servidor POS (:3000 / :3443).</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-ambar" onclick="descargarBatCliente()">📥 Descargar .BAT Acceso Cliente (Tailscale)</button>
          <button class="btn-gris" onclick="cargarDatos()">🔄 Actualizar</button>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; margin-bottom:18px;">
        <div class="card" style="margin:0;">
          <div style="font-size:11px; color:var(--muted); font-weight:800;">HARDWARE ID DE ESTE SERVIDOR</div>
          <div id="lblHwidServer" style="font-family:monospace; font-size:17px; font-weight:900; color:#38bdf8; margin-top:6px;">-</div>
        </div>
        <div class="card" style="margin:0;">
          <div style="font-size:11px; color:var(--muted); font-weight:800;">IP TAILSCALE DETECTADA (PARA CLIENTES)</div>
          <div id="lblIpTailscale" style="font-family:monospace; font-size:17px; font-weight:900; color:#10b981; margin-top:6px;">-</div>
        </div>
        <div class="card" style="margin:0;">
          <div style="font-size:11px; color:var(--muted); font-weight:800;">TERMINAL DE VENTAS LOCAL</div>
          <div style="margin-top:6px;"><a href="http://localhost:3000" target="_blank" style="color:#fbbf24; font-weight:800; font-size:14px;">🔗 Abrir POS (Puerto 3000)</a></div>
        </div>
      </div>

      <!-- FORMULARIO DE ALTA / RENOVACIÓN MANUAL -->
      <div class="card">
        <h3 style="font-size:14px; color:#38bdf8; text-transform:uppercase; margin-bottom:12px;">➕ Registrar Cliente / Cambiar Fecha de Corte y Aplicar Llave</h3>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
          <div style="flex:1.5; min-width:200px;">
            <label style="font-size:11px; color:var(--muted); font-weight:700; display:block; margin-bottom:4px;">Nombre del Negocio / Cliente</label>
            <input type="text" id="inpNombre" style="width:100%;" placeholder="Ej. Tienda El Sol">
          </div>
          <div style="flex:1.5; min-width:210px;">
            <label style="font-size:11px; color:var(--muted); font-weight:700; display:block; margin-bottom:4px;">Hardware ID (Por defecto este servidor)</label>
            <input type="text" id="inpHwid" style="width:100%; font-family:monospace;" placeholder="POS-SV-...">
          </div>
          <div style="flex:1; min-width:150px;">
            <label style="font-size:11px; color:var(--muted); font-weight:700; display:block; margin-bottom:4px;">Fecha de Corte (YYYY-MM-DD)</label>
            <input type="date" id="inpFecha" style="width:100%;">
          </div>
          <div style="width:110px;">
            <label style="font-size:11px; color:var(--muted); font-weight:700; display:block; margin-bottom:4px;">Mensualidad ($)</label>
            <input type="number" step="0.01" id="inpCuota" style="width:100%;" value="25.00">
          </div>
          <button class="btn-verde" style="height:39px; padding:0 18px;" onclick="guardarCliente()">✅ Guardar y Activar Llave</button>
        </div>
      </div>

      <!-- TABLA DE CLIENTES -->
      <div class="card">
        <h3 style="font-size:14px; text-transform:uppercase; margin-bottom:8px;">📋 Clientes y Estado del Servicio en Tiempo Real</h3>
        <table>
          <thead>
            <tr>
              <th>Cliente / ID</th>
              <th>Hardware ID</th>
              <th>Vencimiento / Cuota</th>
              <th>Última Actividad</th>
              <th style="text-align:center;">Estado Actual</th>
              <th style="text-align:right;">Acciones Instantáneas</th>
            </tr>
          </thead>
          <tbody id="tbodyClientes"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let TOKEN_DUENO = '';
    let IP_TAILSCALE_ACTUAL = '127.0.0.1';
    let HWID_SERVIDOR_ACTUAL = '';

    function esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    async function iniciarSesion() {
      const pin = document.getElementById('inputPinLogin').value.trim();
      if (!pin) return;
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const d = await r.json();
      if (!d.exito) {
        alert(d.mensaje || 'PIN incorrecto');
        return;
      }
      TOKEN_DUENO = d.token;
      document.getElementById('vistaLogin').style.display = 'none';
      document.getElementById('vistaPanel').style.display = 'block';

      const sug = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      document.getElementById('inpFecha').value = sug.toISOString().split('T')[0];
      cargarDatos();
    }

    async function cargarDatos() {
      const r = await fetch('/api/datos-panel', { headers: { 'x-panel-token': TOKEN_DUENO } });
      if (r.status === 401) { location.reload(); return; }
      const d = await r.json();
      HWID_SERVIDOR_ACTUAL = d.hardwareIdServidor;
      IP_TAILSCALE_ACTUAL = d.ipTailscale || d.ipLan || '127.0.0.1';

      document.getElementById('lblHwidServer').innerText = HWID_SERVIDOR_ACTUAL;
      document.getElementById('lblIpTailscale').innerText = IP_TAILSCALE_ACTUAL + ':3000';
      if (!document.getElementById('inpHwid').value) {
        document.getElementById('inpHwid').value = HWID_SERVIDOR_ACTUAL;
      }

      const tbody = document.getElementById('tbodyClientes');
      tbody.innerHTML = '';
      if (!d.clientes || d.clientes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#94a3b8;">Aún no hay suscripciones registradas. Registra tu primer cliente arriba.</td></tr>';
        return;
      }

      d.clientes.forEach(c => {
        const susp = c.estadoManual === 'SUSPENDIDO';
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><b>' + esc(c.nombreNegocio) + '</b><br><small style="color:#94a3b8; font-family:monospace;">' + esc(c.idCliente) + '</small></td>' +
          '<td style="font-family:monospace; font-size:12px;">' + esc(c.hardwareId) + '</td>' +
          '<td><b>' + esc(c.fechaVencimiento) + '</b><br><small style="color:#10b981;">$' + Number(c.montoMensual).toFixed(2) + '/mes</small></td>' +
          '<td style="font-size:12px; color:#94a3b8;">' + esc(c.ultimaConexion) + '</td>' +
          '<td style="text-align:center;">' +
            '<span class="badge ' + (susp ? 'badge-suspendido' : 'badge-activo') + '">' + esc(c.estadoManual) + '</span>' +
            (c.motivoSuspension ? '<br><small style="color:#fca5a5;">' + esc(c.motivoSuspension) + '</small>' : '') +
          '</td>' +
          '<td style="text-align:right; white-space:nowrap;">' +
            (susp
              ? '<button class="btn-verde" style="margin-right:6px;" onclick="cambiarEstado(\\'' + esc(c.idCliente) + '\\', \\'ACTIVO\\')">✅ Reactivar</button>'
              : '<button class="btn-rojo" style="margin-right:6px;" onclick="cambiarEstado(\\'' + esc(c.idCliente) + '\\', \\'SUSPENDIDO\\')">⛔ Suspender</button>') +
            '<button class="btn-azul" style="margin-right:6px;" onclick="renovar30Dias(\\'' + esc(c.idCliente) + '\\')">📅 +30 Días</button>' +
            '<button class="btn-gris" style="margin-right:6px;" onclick="copiarClave(\\'' + esc(c.tokenLicencia) + '\\')">📋 Clave</button>' +
            '<button class="btn-gris" style="background:#334155;" onclick="eliminarCliente(\\'' + esc(c.idCliente) + '\\')">✕</button>' +
          '</td>';
        tbody.appendChild(tr);
      });
    }

    async function guardarCliente() {
      const body = {
        nombreNegocio: document.getElementById('inpNombre').value.trim(),
        hardwareId: document.getElementById('inpHwid').value.trim() || HWID_SERVIDOR_ACTUAL,
        fechaVencimiento: document.getElementById('inpFecha').value.trim(),
        montoMensual: document.getElementById('inpCuota').value
      };
      const r = await fetch('/api/guardar-cliente', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN_DUENO },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      alert(d.mensaje);
      if (d.exito) {
        document.getElementById('inpNombre').value = '';
        cargarDatos();
      }
    }

    async function cambiarEstado(idCliente, nuevoEstado) {
      let motivo = '';
      if (nuevoEstado === 'SUSPENDIDO') {
        motivo = prompt('Motivo de suspensión que verá el cliente en pantalla:', 'Mensualidad vencida pendiente de pago.');
        if (motivo === null) return;
      }
      const r = await fetch('/api/cambiar-estado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN_DUENO },
        body: JSON.stringify({ idCliente, nuevoEstado, motivo })
      });
      const d = await r.json();
      alert(d.mensaje);
      cargarDatos();
    }

    async function renovar30Dias(idCliente) {
      if (!confirm('¿Extender suscripción +30 días, reactivar acceso e inyectar nueva llave automáticamente?')) return;
      const r = await fetch('/api/renovar-30-dias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN_DUENO },
        body: JSON.stringify({ idCliente })
      });
      const d = await r.json();
      alert(d.mensaje);
      cargarDatos();
    }

    async function eliminarCliente(idCliente) {
      if (!confirm('¿Eliminar este registro del panel?')) return;
      await fetch('/api/eliminar-cliente', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN_DUENO },
        body: JSON.stringify({ idCliente })
      });
      cargarDatos();
    }

    function copiarClave(token) {
      if (!token) return;
      navigator.clipboard.writeText(token).then(() => alert('Clave POSLIC copiada al portapapeles.')).catch(() => prompt('Copia la clave:', token));
    }

    function descargarBatCliente() {
      const ip = prompt('Confirma la IP de Tailscale de tu servidor a la que se conectará el cliente:', IP_TAILSCALE_ACTUAL);
      if (!ip) return;
      const contenidoBat = [
        '@echo off',
        'title TERMINAL PUNTO DE VENTA',
        'echo Conectando con el Servidor POS...',
        'start "" chrome.exe --app=http://' + ip.trim() + ':3000',
        'if %errorlevel% neq 0 start "" msedge.exe --app=http://' + ip.trim() + ':3000',
        'exit'
      ].join('\\r\\n');

      const blob = new Blob([contenidoBat], { type: 'application/bat;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ABRIR_CAJA_POS.bat';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  </script>
</body>
</html>`);
});

appPanel.listen(PUERTO_PANEL_DUENO, '127.0.0.1', () => {
  console.log(`\n=============================================================`);
  console.log(`👑 PANEL EXTERNO DEL DUEÑO ACTIVO (SOLO LOCALHOST)`);
  console.log(`🔒 Abre en tu navegador: http://localhost:${PUERTO_PANEL_DUENO}`);
  console.log(`🛡️  Inaccesible para clientes externos (Blindado en 127.0.0.1)`);
  console.log(`=============================================================\n`);
});