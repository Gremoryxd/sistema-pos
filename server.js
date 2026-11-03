const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const db = require('./database');

const app = express();

// Ocultar huella del servidor Express
app.disable('x-powered-by');

// Contexto síncrono de IP y Token activos para auditoría en todas las funciones
let IP_CLIENTE_ACTUAL = 'local';
let TOKEN_SESION_ACTUAL = '';

// ============================================================================
// 1. CIBERSEGURIDAD: FIREWALL LAN/TAILSCALE, CSP, ANTI-DOS Y SANITIZACIÓN
// ============================================================================

function esIPAutorizadaRedPrivada(ipRaw) {
  if (!ipRaw) return false;
  const ip = ipRaw.replace(/^::ffff:/, '').trim();
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  const partes = ip.split('.').map(Number);
  if (partes.length !== 4 || partes.some(n => isNaN(n) || n < 0 || n > 255)) return false;

  // Redes locales privadas RFC 1918
  if (partes[0] === 10) return true;
  if (partes[0] === 192 && partes[1] === 168) return true;
  if (partes[0] === 172 && partes[1] >= 16 && partes[1] <= 31) return true;

  // Rango oficial de Tailscale (100.64.0.0/10 -> 100.64.x.x a 100.127.x.x)
  if (partes[0] === 100 && partes[1] >= 64 && partes[1] <= 127) return true;

  return false;
}

const traficoPorIP = new Map();
const VENTANA_RATE_MS = 60 * 1000;
const MAX_PETICIONES_POR_MINUTO = 300;

setInterval(() => {
  const ahora = Date.now();
  for (const [ip, datos] of traficoPorIP.entries()) {
    if (ahora > datos.reinicio) traficoPorIP.delete(ip);
  }
}, 60 * 1000).unref();

app.use((req, res, next) => {
  const ipCliente = (req.socket && req.socket.remoteAddress) || req.ip || '';

  if (!esIPAutorizadaRedPrivada(ipCliente)) {
    return res.status(403).end('Acceso denegado: Red no autorizada.');
  }

  const ahora = Date.now();
  const reg = traficoPorIP.get(ipCliente) || { conteo: 0, reinicio: ahora + VENTANA_RATE_MS };
  if (ahora > reg.reinicio) {
    reg.conteo = 0;
    reg.reinicio = ahora + VENTANA_RATE_MS;
  }
  reg.conteo += 1;
  traficoPorIP.set(ipCliente, reg);

  if (reg.conteo > MAX_PETICIONES_POR_MINUTO) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espere un momento.' });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none';"
  );

  const origin = req.headers.origin;
  if (origin) {
    try {
      const urlOrigin = new URL(origin);
      if (esIPAutorizadaRedPrivada(urlOrigin.hostname) || urlOrigin.hostname.endsWith('.ts.net')) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pos-pin');
      }
    } catch (e) {}
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const urlDecodificada = decodeURIComponent(req.path || '');
  if (urlDecodificada.includes('..') || urlDecodificada.includes('\0') || /\/\./.test(urlDecodificada)) {
    return res.status(400).end('Solicitud inválida.');
  }

  next();
});

app.use(express.json({ limit: '15mb', strict: true }));

function limpiarObjetoInyeccion(obj, profundidad = 0) {
  if (profundidad > 6 || !obj || typeof obj !== 'object') return;
  const clavesPeligrosas = ['__proto__', 'constructor', 'prototype'];
  for (const clave of Object.keys(obj)) {
    if (clavesPeligrosas.includes(clave)) {
      delete obj[clave];
    } else if (typeof obj[clave] === 'object' && obj[clave] !== null) {
      limpiarObjetoInyeccion(obj[clave], profundidad + 1);
    }
  }
}

function sanitizarTextoSeguro(str, maxLen = 150) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLen);
}

function validarBase64ImagenSegura(base64Str) {
  if (!base64Str || typeof base64Str !== 'string') return false;
  if (!base64Str.startsWith('data:image/')) return false;
  if (base64Str.length > 7 * 1024 * 1024) return false;

  const partes = base64Str.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!partes || partes.length !== 3) return false;

  try {
    const headerBuf = Buffer.from(partes[2].slice(0, 32), 'base64');
    if (headerBuf.length < 4) return false;

    const esJPEG = headerBuf[0] === 0xFF && headerBuf[1] === 0xD8 && headerBuf[2] === 0xFF;
    const esPNG = headerBuf[0] === 0x89 && headerBuf[1] === 0x50 && headerBuf[2] === 0x4E && headerBuf[3] === 0x47;
    const esWEBP = headerBuf.slice(0, 4).toString('ascii') === 'RIFF' && headerBuf.slice(8, 12).toString('ascii') === 'WEBP';

    return esJPEG || esPNG || esWEBP;
  } catch (e) {
    return false;
  }
}

// Servir archivos estáticos evitando que el navegador guarde versiones viejas de .js, .css o .html
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ============================================================================
// 1.5 AUTO-CACHE DE LIBRERÍAS JS EN /public/libs/ PARA MODO 100% OFFLINE
// ============================================================================
function descargarArchivoHTTPS(url, destino) {
  return new Promise((resolve) => {
    try {
      if (fs.existsSync(destino) && fs.statSync(destino).size > 1000) {
        return resolve(true);
      }
      const req = https.get(url, { timeout: 8000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          return resolve(descargarArchivoHTTPS(redirectUrl, destino));
        }
        if (res.statusCode !== 200) return resolve(false);
        const fileStream = fs.createWriteStream(destino);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => resolve(true));
        });
        fileStream.on('error', () => {
          try { fs.unlinkSync(destino); } catch (e) {}
          resolve(false);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (e) {
      resolve(false);
    }
  });
}

async function asegurarLibreriasOfflineEnDisco() {
  const dirLibs = db.dirLibsOffline || path.join(__dirname, 'public', 'libs');
  if (!fs.existsSync(dirLibs)) {
    fs.mkdirSync(dirLibs, { recursive: true });
  }
  const recursos = [
    {
      url: 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
      archivo: path.join(dirLibs, 'JsBarcode.all.min.js')
    },
    {
      url: 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
      archivo: path.join(dirLibs, 'html5-qrcode.min.js')
    }
  ];
  for (const item of recursos) {
    await descargarArchivoHTTPS(item.url, item.archivo);
  }
}

setTimeout(() => { asegurarLibreriasOfflineEnDisco(); }, 1500);

// ============================================================================
// 2. SISTEMA DE LICENCIAMIENTO COMERCIAL Y ENLACE CON PROGRAMA EXTERNO
// ============================================================================
const SECRETO_MAESTRO_LICENCIA_SV = 'POS_MASTER_SV_FERNANDO_2026_ULTRA_SECRET_KEY_9981';
const DIAS_AVISO_RENOVACION = 5;
const rutaArchivoLicencia = path.join(__dirname, 'licencia.lic');
const rutaMarcadorHardwareOculto = path.join(os.homedir(), '.pos_sv_node_lock.dat');
const rutaLlavePrivadaEd25519 = path.join(__dirname, 'llave_privada_ed25519.pem');
const rutaLlavePublicaEd25519 = path.join(db.dirCerts || path.join(__dirname, 'certs'), 'pos_ed25519_pub.pem');
let HARDWARE_ID_ACTUAL_CACHE = null;

function registrarEventoAuditoria(evento, detalle, usuario, ip, nivel = 'INFO') {
  if (typeof db.registrarAuditoria === 'function') {
    db.registrarAuditoria(evento, detalle, usuario, ip || IP_CLIENTE_ACTUAL || 'local', nivel);
  }
}

function obtenerHardwareIDMaquina() {
  if (HARDWARE_ID_ACTUAL_CACHE) return HARDWARE_ID_ACTUAL_CACHE;

  const piezas = [];
  const plataforma = os.platform();

  try {
    if (plataforma === 'win32') {
      try {
        const uuidOut = execSync(
          'powershell -NoProfile -Command "(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID"',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3500 }
        ).trim();
        if (uuidOut && uuidOut.length > 5 && !uuidOut.includes('FFFF')) {
          piezas.push(uuidOut);
        }
      } catch (e) {
        try {
          const wmicOut = execSync('wmic csproduct get uuid', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000
          });
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
        try {
          if (fs.existsSync(p)) {
            const val = fs.readFileSync(p, 'utf8').trim();
            if (val) { piezas.push(val); break; }
          }
        } catch (e) {}
      }
    } else if (plataforma === 'darwin') {
      try {
        const macOut = execSync("ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID", {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000
        }).trim();
        if (macOut) piezas.push(macOut);
      } catch (e) {}
    }
  } catch (e) {}

  const cpus = os.cpus() || [];
  const modeloCpu = cpus.length > 0 ? cpus[0].model : 'CPU_STD';
  piezas.push(`${os.arch()}|${plataforma}|${modeloCpu}|${cpus.length}`);

  const hashCompleto = crypto
    .createHash('sha256')
    .update(`HWID_SV_SALT_2026::${piezas.join('::')}`)
    .digest('hex')
    .toUpperCase();

  HARDWARE_ID_ACTUAL_CACHE = `POS-SV-${hashCompleto.slice(0, 4)}-${hashCompleto.slice(4, 8)}-${hashCompleto.slice(8, 12)}`;
  return HARDWARE_ID_ACTUAL_CACHE;
}

function firmarPayloadLicencia(payloadObj) {
  const objetoCanonico = {
    hwid: String(payloadObj.hwid || '').trim().toUpperCase(),
    cliente: String(payloadObj.cliente || 'Cliente POS').trim(),
    vencimiento: String(payloadObj.vencimiento || '').trim(),
    tipo: String(payloadObj.tipo || 'MENSUAL').trim().toUpperCase()
  };
  if (payloadObj.idCliente) {
    objetoCanonico.idCliente = String(payloadObj.idCliente).trim().toUpperCase();
  }

  const jsonCanonico = JSON.stringify(objetoCanonico);
  const base64Payload = Buffer.from(jsonCanonico, 'utf8').toString('base64url');
  const claveDerivada = crypto.scryptSync(SECRETO_MAESTRO_LICENCIA_SV, 'SALT_FIRMA_COMERCIAL_SV_2026', 64);
  const firmaHex = crypto.createHmac('sha256', claveDerivada).update(base64Payload).digest('hex').toUpperCase().slice(0, 40);

  if (fs.existsSync(rutaLlavePrivadaEd25519)) {
    try {
      const privPem = fs.readFileSync(rutaLlavePrivadaEd25519, 'utf8');
      const firmaEd = crypto.sign(null, Buffer.from(base64Payload, 'utf8'), privPem).toString('base64url');
      return `POSLIC-${base64Payload}.${firmaHex}.${firmaEd}`;
    } catch (e) {}
  }

  return `POSLIC-${base64Payload}.${firmaHex}`;
}

function verificarTokenLicencia(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') {
    return { valida: false, motivo: 'Sin licencia instalada en este equipo.' };
  }

  const limpio = tokenStr.trim();
  if (!limpio.startsWith('POSLIC-') || !limpio.includes('.')) {
    return { valida: false, motivo: 'Formato de código de licencia inválido.' };
  }

  try {
    const sinPrefijo = limpio.slice(7);
    const segmentos = sinPrefijo.split('.');
    const base64Payload = segmentos[0];
    const firmaRecibida = segmentos[1];
    const firmaEd25519Recibida = segmentos[2] || '';

    if (!base64Payload || !firmaRecibida) {
      return { valida: false, motivo: 'Estructura de licencia incompleta.' };
    }

    const claveDerivada = crypto.scryptSync(SECRETO_MAESTRO_LICENCIA_SV, 'SALT_FIRMA_COMERCIAL_SV_2026', 64);
    const firmaEsperada = crypto.createHmac('sha256', claveDerivada).update(base64Payload).digest('hex').toUpperCase().slice(0, 40);

    const bufA = Buffer.from(firmaRecibida.toUpperCase(), 'utf8');
    const bufB = Buffer.from(firmaEsperada, 'utf8');
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      return { valida: false, motivo: 'Firma criptográfica inválida (Licencia alterada).' };
    }

    if (firmaEd25519Recibida && fs.existsSync(rutaLlavePublicaEd25519)) {
      try {
        const pubPem = fs.readFileSync(rutaLlavePublicaEd25519, 'utf8');
        const esValidaEd = crypto.verify(
          null,
          Buffer.from(base64Payload, 'utf8'),
          pubPem,
          Buffer.from(firmaEd25519Recibida, 'base64url')
        );
        if (!esValidaEd) {
          return { valida: false, motivo: 'Firma asimétrica Ed25519 inválida.' };
        }
      } catch (e) {
        return { valida: false, motivo: 'Error verificando firma asimétrica Ed25519.' };
      }
    }

    const datos = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf8'));
    const hwidActual = obtenerHardwareIDMaquina();

    if (datos.hwid !== hwidActual && datos.hwid !== 'POS-SV-UNIVERSAL-MASTER') {
      return {
        valida: false,
        motivo: `Esta licencia pertenece a otra computadora (${datos.hwid}). El Hardware ID de este equipo es ${hwidActual}.`
      };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.vencimiento)) {
      return { valida: false, motivo: 'Fecha de vencimiento corrupta en la licencia.' };
    }

    return {
      valida: true,
      hwid: datos.hwid,
      idCliente: datos.idCliente || '',
      cliente: datos.cliente || 'Licencia Comercial Activa',
      vencimiento: datos.vencimiento,
      tipo: datos.tipo || 'MENSUAL'
    };
  } catch (err) {
    return { valida: false, motivo: 'No se pudo verificar la licencia: ' + err.message };
  }
}

function verificarIntegridadRelojSistema() {
  const ahoraMs = Date.now();
  const TOLERANCIA_MS = 15 * 60 * 1000;
  let maxTimestampRegistrado = 0;

  try {
    const filaTs = db.prepare("SELECT valor FROM configuracion WHERE clave = 'ULTIMO_USO_FIRMADO'").get();
    if (filaTs && filaTs.valor) {
      const [tsStr, hmacGuardado] = String(filaTs.valor).split('|');
      const tsNum = parseInt(tsStr, 10);
      const hmacCalculado = crypto.createHmac('sha256', SECRETO_MAESTRO_LICENCIA_SV).update(String(tsNum)).digest('hex').slice(0, 24);
      if (!isNaN(tsNum) && hmacGuardado === hmacCalculado) {
        maxTimestampRegistrado = Math.max(maxTimestampRegistrado, tsNum);
      }
    }

    const ultVenta = db.prepare('SELECT MAX(fecha) as maxF FROM ventas').get();
    if (ultVenta && ultVenta.maxF) {
      const tV = new Date(ultVenta.maxF).getTime();
      if (!isNaN(tV)) maxTimestampRegistrado = Math.max(maxTimestampRegistrado, tV);
    }

    const ultKardex = db.prepare('SELECT MAX(fecha) as maxF FROM kardex').get();
    if (ultKardex && ultKardex.maxF) {
      const tK = new Date(ultKardex.maxF).getTime();
      if (!isNaN(tK)) maxTimestampRegistrado = Math.max(maxTimestampRegistrado, tK);
    }

    if (fs.existsSync(rutaMarcadorHardwareOculto)) {
      const ocultoRaw = fs.readFileSync(rutaMarcadorHardwareOculto, 'utf8').trim();
      const partes = ocultoRaw.split('|');
      if (partes.length >= 2) {
        const tsOculto = parseInt(partes[1], 10);
        if (!isNaN(tsOculto)) maxTimestampRegistrado = Math.max(maxTimestampRegistrado, tsOculto);
      }
    }
  } catch (e) {}

  if (maxTimestampRegistrado > 0 && (ahoraMs + TOLERANCIA_MS) < maxTimestampRegistrado) {
    const fechaMinima = new Date(maxTimestampRegistrado).toLocaleString();
    return {
      relojValido: false,
      mensaje: `Se detectó que el reloj o fecha de esta PC fue atrasado. La última operación registrada tiene fecha ${fechaMinima}. Corrija la fecha y hora de Windows para desbloquear el sistema.`
    };
  }

  if (ahoraMs >= maxTimestampRegistrado) {
    try {
      const hmacNuevo = crypto.createHmac('sha256', SECRETO_MAESTRO_LICENCIA_SV).update(String(ahoraMs)).digest('hex').slice(0, 24);
      db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('ULTIMO_USO_FIRMADO', ?)")
        .run(`${ahoraMs}|${hmacNuevo}`);
    } catch (e) {}
  }

  return { relojValido: true, mensaje: '' };
}

function inicializarLicenciaPrimeraVezSiCorresponde() {
  try {
    if (fs.existsSync(rutaArchivoLicencia)) return;
    const filaDb = db.prepare("SELECT valor FROM configuracion WHERE clave = 'LICENCIA_COMERCIAL_TOKEN'").get();
    if (filaDb && filaDb.valor) return;
    if (fs.existsSync(rutaMarcadorHardwareOculto)) return;

    const hwid = obtenerHardwareIDMaquina();
    const fechaVenc = new Date(Date.now() + (DIAS_AVISO_RENOVACION * 24 * 60 * 60 * 1000));
    const y = fechaVenc.getFullYear();
    const m = String(fechaVenc.getMonth() + 1).padStart(2, '0');
    const d = String(fechaVenc.getDate()).padStart(2, '0');
    const fechaYMD = `${y}-${m}-${d}`;

    const tokenInicial = firmarPayloadLicencia({
      hwid: hwid,
      cliente: 'Licencia Inicial de Activación',
      vencimiento: fechaYMD,
      tipo: 'INICIAL'
    });

    db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('LICENCIA_COMERCIAL_TOKEN', ?)")
      .run(tokenInicial);
    fs.writeFileSync(rutaArchivoLicencia, tokenInicial, 'utf8');
    try {
      fs.writeFileSync(rutaMarcadorHardwareOculto, `${hwid}|${Date.now()}`, 'utf8');
    } catch (e) {}
  } catch (err) {
    console.error('Aviso inicializando licencia base:', err.message);
  }
}

inicializarLicenciaPrimeraVezSiCorresponde();

function evaluarEstadoLicenciaActual() {
  const hwid = obtenerHardwareIDMaquina();
  const estadoReloj = verificarIntegridadRelojSistema();

  if (!estadoReloj.relojValido) {
    return {
      activa: false,
      bloqueado: true,
      motivoBloqueo: 'RELOJ_ALTERADO',
      mensaje: estadoReloj.mensaje,
      hardwareId: hwid,
      cliente: '',
      fechaVencimiento: '',
      diasRestantes: 0,
      mostrarAviso5Dias: false
    };
  }

  // Priorizar el token de la base de datos si fue actualizado por el programa externo de suscripciones
  let token = '';
  try {
    const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'LICENCIA_COMERCIAL_TOKEN'").get();
    if (fila && fila.valor) {
      token = fila.valor.trim();
    } else if (fs.existsSync(rutaArchivoLicencia)) {
      token = fs.readFileSync(rutaArchivoLicencia, 'utf8').trim();
    }
  } catch (e) {}

  const verif = verificarTokenLicencia(token);

  // Verificar orden de suspensión aplicada desde el Programa Externo Independiente (`panel_suscripciones.js`)
  try {
    const idClienteAsignado = verif.idCliente || '';
    const subLocal = db.prepare(`
      SELECT * FROM suscripciones_clientes
      WHERE UPPER(hardware_id) = UPPER(?) OR (id_cliente != '' AND UPPER(id_cliente) = UPPER(?))
      ORDER BY rowid DESC LIMIT 1
    `).get(hwid, idClienteAsignado);

    if (subLocal) {
      db.prepare('UPDATE suscripciones_clientes SET ultima_conexion = ? WHERE id_cliente = ?')
        .run(new Date().toISOString(), subLocal.id_cliente);

      if ((subLocal.estado_manual || '').toUpperCase() === 'SUSPENDIDO') {
        const motivoTexto = subLocal.motivo_suspension
          ? `Motivo: ${subLocal.motivo_suspension}`
          : 'Suscripción mensual pendiente de pago.';
        return {
          activa: false,
          bloqueado: true,
          motivoBloqueo: 'SUSPENDIDA_FALTA_PAGO',
          mensaje: `⛔ ACCESO SUSPENDIDO POR FALTA DE PAGO (${subLocal.nombre_negocio}). ${motivoTexto} Comuníquese con el proveedor del sistema para reactivar su servicio.`,
          hardwareId: hwid,
          cliente: subLocal.nombre_negocio,
          fechaVencimiento: subLocal.fecha_vencimiento || verif.vencimiento || '',
          diasRestantes: 0,
          mostrarAviso5Dias: false
        };
      }
    }

    const filaRemota = db.prepare("SELECT valor FROM configuracion WHERE clave = 'ESTADO_REMOTO_SUSCRIPCION_JSON'").get();
    if (filaRemota && filaRemota.valor) {
      const rem = JSON.parse(filaRemota.valor);
      if ((rem.estadoManual || '').toUpperCase() === 'SUSPENDIDO') {
        return {
          activa: false,
          bloqueado: true,
          motivoBloqueo: 'SUSPENDIDA_FALTA_PAGO',
          mensaje: `⛔ SERVICIO SUSPENDIDO POR FALTA DE PAGO. ${rem.motivoSuspension || 'Comuníquese con el proveedor del sistema POS para reactivar su suscripción.'}`,
          hardwareId: hwid,
          cliente: verif.cliente || 'Cliente POS',
          fechaVencimiento: rem.fechaVencimiento || verif.vencimiento || '',
          diasRestantes: 0,
          mostrarAviso5Dias: false
        };
      }
    }
  } catch (e) {}

  if (!verif.valida) {
    return {
      activa: false,
      bloqueado: true,
      motivoBloqueo: 'LICENCIA_INVALIDA',
      mensaje: verif.motivo,
      hardwareId: hwid,
      cliente: '',
      fechaVencimiento: '',
      diasRestantes: 0,
      mostrarAviso5Dias: false
    };
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const finDiaVenc = new Date(`${verif.vencimiento}T23:59:59`);
  const diffMs = finDiaVenc.getTime() - hoy.getTime();
  const diasRestantes = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    return {
      activa: false,
      bloqueado: true,
      motivoBloqueo: 'LICENCIA_VENCIDA',
      mensaje: `La suscripción mensual del sistema venció el ${verif.vencimiento}. Ingrese su nuevo código de renovación para desbloquear la terminal.`,
      hardwareId: hwid,
      cliente: verif.cliente,
      fechaVencimiento: verif.vencimiento,
      diasRestantes: diasRestantes,
      mostrarAviso5Dias: false
    };
  }

  const esPermanente = verif.vencimiento.startsWith('2099') || verif.tipo === 'PERMANENTE';
  const mostrarAviso5Dias = !esPermanente && diasRestantes <= DIAS_AVISO_RENOVACION;

  return {
    activa: true,
    bloqueado: false,
    motivoBloqueo: '',
    mensaje: mostrarAviso5Dias
      ? (diasRestantes === 0
          ? `⚠️ Tu suscripción del sistema POS vence HOY (${verif.vencimiento}). Contacta a soporte técnico para renovar tu mes.`
          : `⚠️ Aviso: Tu licencia mensual del sistema POS vence en ${diasRestantes} día(s) (${verif.vencimiento}).`)
      : 'Licencia activa y verificada.',
    hardwareId: hwid,
    cliente: verif.cliente,
    tipo: esPermanente ? 'PERMANENTE' : verif.tipo,
    fechaVencimiento: verif.vencimiento,
    diasRestantes: diasRestantes,
    mostrarAviso5Dias: mostrarAviso5Dias
  };
}

// ============================================================================
// 3. SEGURIDAD: SESIONES CON IP ESTRICTA, ANTI-FUERZA BRUTA, ADMIN Y BÓVEDA
// ============================================================================
const sesionesActivas = new Map();
const EXPIRACION_SESION_MS = 12 * 60 * 60 * 1000;

setInterval(() => {
  const ahora = Date.now();
  for (const [token, datos] of sesionesActivas.entries()) {
    if (ahora - datos.ultimaActividad > EXPIRACION_SESION_MS) {
      sesionesActivas.delete(token);
    }
  }
}, 5 * 60 * 1000).unref();

const intentosFallidosPorIP = new Map();
const MAX_INTENTOS_PIN = 5;
const TIEMPO_BLOQUEO_MS = 3 * 60 * 1000;

function normalizarIP(ipRaw) {
  return (ipRaw || 'local').toString().replace(/^::ffff:/, '').trim();
}

function verificarBloqueoIP(ip) {
  const clave = normalizarIP(ip || IP_CLIENTE_ACTUAL);
  const registro = intentosFallidosPorIP.get(clave);
  if (!registro) return { bloqueado: false, segundosRestantes: 0 };

  if (registro.bloqueadoHasta && Date.now() < registro.bloqueadoHasta) {
    const seg = Math.ceil((registro.bloqueadoHasta - Date.now()) / 1000);
    return { bloqueado: true, segundosRestantes: seg };
  }

  if (registro.bloqueadoHasta && Date.now() >= registro.bloqueadoHasta) {
    intentosFallidosPorIP.delete(clave);
  }
  return { bloqueado: false, segundosRestantes: 0 };
}

function registrarIntentoPin(ip, fueExitoso, detalleEvento = '') {
  const clave = normalizarIP(ip || IP_CLIENTE_ACTUAL);
  if (fueExitoso) {
    intentosFallidosPorIP.delete(clave);
    return;
  }
  const actual = intentosFallidosPorIP.get(clave) || { intentos: 0, bloqueadoHasta: 0 };
  actual.intentos += 1;
  if (actual.intentos >= MAX_INTENTOS_PIN) {
    actual.bloqueadoHasta = Date.now() + TIEMPO_BLOQUEO_MS;
    registrarEventoAuditoria(
      'BLOQUEO_FUERZA_BRUTA',
      `IP bloqueada por 3 minutos tras ${actual.intentos} intentos fallidos de PIN. ${detalleEvento}`,
      'Seguridad',
      clave,
      'CRITICO'
    );
  } else {
    registrarEventoAuditoria(
      'PIN_INCORRECTO',
      `Intento fallido de PIN (${actual.intentos}/${MAX_INTENTOS_PIN}). ${detalleEvento}`,
      'Desconocido',
      clave,
      'ALERTA'
    );
  }
  intentosFallidosPorIP.set(clave, actual);
}

function compararHashSeguro(pinIngresado, hashGuardado) {
  if (!pinIngresado || !hashGuardado) return false;
  if (typeof db.compararPinSeguro === 'function') {
    return db.compararPinSeguro(pinIngresado, hashGuardado);
  }
  const hashCalculado = db.hashearPin(pinIngresado);
  try {
    const bufA = Buffer.from(hashCalculado, 'hex');
    const bufB = Buffer.from(hashGuardado.trim(), 'hex');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

function esUsuarioRolAdmin(u) {
  if (!u) return false;
  const rol = (u.rol || '').toLowerCase();
  const nom = (u.nombre || '').toLowerCase();
  return rol === 'admin' || rol === 'administrador' || nom.includes('admin') || nom.includes('dueño');
}

function buscarUsuarioPorPinSeguro(pinLimpio) {
  if (!pinLimpio || /^ID-USR-/i.test(pinLimpio)) return null;
  const usuarios = db.prepare('SELECT rowid, nombre, rol, pin, pin_hash FROM usuarios ORDER BY rowid ASC').all();
  for (const u of usuarios) {
    if (u.pin_hash && compararHashSeguro(pinLimpio, u.pin_hash)) {
      try {
        const hashScryptActual = db.hashearPin(pinLimpio);
        if (u.pin_hash !== hashScryptActual) {
          db.prepare('UPDATE usuarios SET pin_hash = ? WHERE rowid = ?').run(hashScryptActual, u.rowid);
        }
      } catch (e) {}
      return u;
    }
    if (!u.pin_hash && u.pin && !/^ID-USR-/i.test(u.pin) && u.pin === pinLimpio) {
      return u;
    }
  }
  return null;
}

function verificarCredencialMasterConfig(pinLimpio) {
  const maestro = db.prepare("SELECT valor FROM configuracion WHERE clave = 'PIN_MAESTRO'").get();
  if (maestro && maestro.valor && maestro.valor.trim() !== '') {
    const val = maestro.valor.trim();
    if (/^[a-f0-9]{64}$/i.test(val)) {
      return compararHashSeguro(pinLimpio, val);
    }
    return pinLimpio === val || compararHashSeguro(pinLimpio, val);
  }
  return false;
}

function obtenerSesionValidaPorTokenEIP(tokenStr, ipCliente) {
  if (!tokenStr || !sesionesActivas.has(tokenStr)) return null;
  const ses = sesionesActivas.get(tokenStr);
  const ipActual = normalizarIP(ipCliente || IP_CLIENTE_ACTUAL);

  if (Date.now() - ses.ultimaActividad > EXPIRACION_SESION_MS) {
    sesionesActivas.delete(tokenStr);
    return null;
  }

  if (ses.ip && ses.ip !== ipActual) {
    registrarEventoAuditoria(
      'ALERTA_IP_TOKEN_DISTINTA',
      `Se rechazó uso de token de '${ses.nombreCajero}' desde IP ${ipActual} (IP original: ${ses.ip})`,
      ses.nombreCajero,
      ipActual,
      'CRITICO'
    );
    return null;
  }

  ses.ultimaActividad = Date.now();
  return ses;
}

function tienePermisoAdminSilencioso(pinOToken) {
  if (!pinOToken) return false;
  const limpio = pinOToken.toString().trim();
  if (!limpio) return false;

  const sesion = obtenerSesionValidaPorTokenEIP(limpio, IP_CLIENTE_ACTUAL);
  if (sesion) {
    return esUsuarioRolAdmin({ rol: sesion.rol, nombre: sesion.nombreCajero });
  }

  if (limpio.length > 32) return false;
  const u = buscarUsuarioPorPinSeguro(limpio);
  if (u && esUsuarioRolAdmin(u)) return true;
  if (verificarCredencialMasterConfig(limpio)) return true;
  return false;
}

function validarSuperAdminUnico(pinIngresado, ipCliente) {
  const ipEfectiva = normalizarIP(ipCliente || IP_CLIENTE_ACTUAL);
  const estadoIP = verificarBloqueoIP(ipEfectiva);
  if (estadoIP.bloqueado || !pinIngresado) return false;

  const entradaLimpia = pinIngresado.toString().trim();
  if (!entradaLimpia) return false;

  const ses = obtenerSesionValidaPorTokenEIP(entradaLimpia, ipEfectiva);
  if (ses) {
    if (esUsuarioRolAdmin({ rol: ses.rol, nombre: ses.nombreCajero })) {
      registrarIntentoPin(ipEfectiva, true);
      return true;
    }
    return false;
  }

  const pinLimpio = entradaLimpia.slice(0, 32);
  const u = buscarUsuarioPorPinSeguro(pinLimpio);
  if (u && esUsuarioRolAdmin(u)) {
    registrarIntentoPin(ipEfectiva, true);
    return true;
  }

  if (verificarCredencialMasterConfig(pinLimpio)) {
    registrarIntentoPin(ipEfectiva, true);
    return true;
  }

  registrarIntentoPin(ipEfectiva, false, 'Intento de acceso a Bóveda/SuperAdmin');
  return false;
}

function cifrarDatosBovedaAES(objetoDatos, claveSecreta) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(claveSecreta), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const textoPlano = JSON.stringify(objetoDatos);
  const cifrado = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    formato: 'POS_BOVEDA_AES256GCM_V1',
    fechaExportacion: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    payload: cifrado.toString('base64')
  });
}

function descifrarDatosBovedaAES(contenidoArchivoStr, claveSecreta) {
  const sobre = JSON.parse(contenidoArchivoStr);
  if (!sobre || sobre.formato !== 'POS_BOVEDA_AES256GCM_V1') {
    throw new Error('El archivo seleccionado no es un respaldo válido de la Bóveda POS.');
  }

  const salt = Buffer.from(sobre.salt, 'base64');
  const iv = Buffer.from(sobre.iv, 'base64');
  const authTag = Buffer.from(sobre.tag, 'base64');
  const cifrado = Buffer.from(sobre.payload, 'base64');

  const key = crypto.scryptSync(String(claveSecreta), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const descifrado = Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
  const datos = JSON.parse(descifrado);
  datos._fechaExportacion = sobre.fechaExportacion || '';
  return datos;
}

// ============================================================================
// 4. FUNCIONES AUXILIARES DE FECHAS, CÓDIGOS CORTOS, PRECIOS Y PAGOS MIXTOS
// ============================================================================
function obtenerFechaYMD(fechaInput) {
  const d = fechaInput ? new Date(fechaInput) : new Date();
  if (isNaN(d.getTime())) return String(fechaInput).split(' ')[0];
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function generarIdTicketCortoUnico() {
  const stmt = db.prepare('SELECT id_venta FROM ventas WHERE id_venta = ?');
  for (let i = 0; i < 50; i++) {
    const num6 = crypto.randomInt(100000, 999999);
    const candidato = `TICKET-${num6}`;
    if (!stmt.get(candidato)) {
      return candidato;
    }
  }
  return `TICKET-${String(Date.now()).slice(-6)}`;
}

function calcularPrecioProductoServidor(prod) {
  const precioNormal = parseFloat(prod.precio) || 0;
  let precioFinal = precioNormal;
  const descValor = parseFloat(prod.desc_valor) || 0;
  const descTipo = (prod.desc_tipo || '%').trim();
  const fechaLimite = prod.fecha_limite;

  if (descValor > 0 && fechaLimite) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const caducidad = new Date(fechaLimite + 'T23:59:59');
    if (hoy <= caducidad) {
      if (descTipo === '%') {
        precioFinal = precioNormal - (precioNormal * (descValor / 100));
      } else {
        precioFinal = precioNormal - descValor;
      }
      if (precioFinal < 0) precioFinal = 0;
    }
  }
  return {
    precioOriginal: Number(precioNormal.toFixed(2)),
    precioFinal: Number(precioFinal.toFixed(2))
  };
}

function sumarSegunMetodo(corte, textoMetodo, monto) {
  const raw = (textoMetodo || '').toString();
  const m = raw.toLowerCase();

  const matchMixto = raw.match(/efectivo:\s*\$([0-9.]+)\s*\|\s*([^:\]]+):\s*\$([0-9.]+)/i);
  if (matchMixto) {
    const parteEfectivo = parseFloat(matchMixto[1]) || 0;
    const nombreBanco = (matchMixto[2] || '').toLowerCase();
    const parteBanco = parseFloat(matchMixto[3]) || 0;

    corte.efectivo += parteEfectivo;
    if (nombreBanco.includes('agrícola') || nombreBanco.includes('agricola')) {
      corte.agricola += parteBanco;
    } else if (nombreBanco.includes('cuscatlán') || nombreBanco.includes('cuscatlan')) {
      corte.cuscatlan += parteBanco;
    } else {
      corte.efectivo += parteBanco;
    }
    return;
  }

  if (m.includes('agrícola') || m.includes('agricola')) {
    corte.agricola += monto;
  } else if (m.includes('cuscatlán') || m.includes('cuscatlan')) {
    corte.cuscatlan += monto;
  } else {
    corte.efectivo += monto;
  }
}

function autenticarPinOToken(credencial, ipCliente, emitirNuevoToken) {
  const ipEfectiva = normalizarIP(ipCliente || IP_CLIENTE_ACTUAL);
  const estadoIP = verificarBloqueoIP(ipEfectiva);
  if (estadoIP.bloqueado) {
    return {
      valido: false,
      nombreCajero: "",
      bloqueado: true,
      mensaje: `Demasiados intentos fallidos. Espere ${estadoIP.segundosRestantes} segundos.`
    };
  }

  if (!credencial || (typeof credencial !== 'string' && typeof credencial !== 'number')) {
    return { valido: false, nombreCajero: "" };
  }

  const limpio = credencial.toString().trim();
  if (!limpio) return { valido: false, nombreCajero: "" };

  const ses = obtenerSesionValidaPorTokenEIP(limpio, ipEfectiva);
  if (ses) {
    return {
      valido: true,
      nombreCajero: ses.nombreCajero,
      rol: ses.rol,
      tokenSesion: limpio,
      licencia: evaluarEstadoLicenciaActual()
    };
  }

  if (limpio.length === 64 && /^[a-f0-9]{64}$/i.test(limpio)) {
    return { valido: false, nombreCajero: "" };
  }

  const pinCorto = limpio.slice(0, 32);
  const user = buscarUsuarioPorPinSeguro(pinCorto);

  if (user) {
    registrarIntentoPin(ipEfectiva, true);
    const rolNormalizado = (user.rol || 'cajero').toLowerCase();
    let tokenGenerado = '';

    if (emitirNuevoToken) {
      tokenGenerado = crypto.randomBytes(32).toString('hex');
      sesionesActivas.set(tokenGenerado, {
        nombreCajero: user.nombre,
        rol: rolNormalizado,
        ultimaActividad: Date.now(),
        ip: ipEfectiva
      });
      registrarEventoAuditoria(
        'INICIO_SESION',
        `Operador '${user.nombre}' (${rolNormalizado}) desbloqueó la terminal.`,
        user.nombre,
        ipEfectiva,
        'INFO'
      );
    }

    return {
      valido: true,
      nombreCajero: user.nombre,
      rol: rolNormalizado,
      tokenSesion: tokenGenerado,
      licencia: evaluarEstadoLicenciaActual()
    };
  }

  registrarIntentoPin(ipEfectiva, false, 'Desbloqueo de terminal');
  return { valido: false, nombreCajero: "" };
}

function calcularResumenFinancieroInterno(fechaSeleccionada, cajeroFiltro) {
  const fecha = (fechaSeleccionada || obtenerFechaYMD(new Date())).toString().trim();
  const filtro = (cajeroFiltro || 'Todos').toString().trim();
  const esGlobal = (filtro === 'Todos' || filtro === '');
  const cajeroKey = filtro.toLowerCase();

  let fondoInicial = 0;
  const filaDiaria = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(`FONDO_DIARIO_${fecha}`);

  if (filaDiaria && parseFloat(filaDiaria.valor) > 0) {
    fondoInicial = parseFloat(filaDiaria.valor);
  } else {
    const filaDirecta = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(`FONDO_${fecha}_${cajeroKey}`);
    if (filaDirecta && parseFloat(filaDirecta.valor) > 0) {
      fondoInicial = parseFloat(filaDirecta.valor);
    } else {
      const filasFecha = db.prepare('SELECT valor FROM configuracion WHERE clave LIKE ?').all(`FONDO_${fecha}_%`);
      for (const f of filasFecha) {
        const v = parseFloat(f.valor) || 0;
        if (v > fondoInicial) fondoInicial = v;
      }
    }
    if (fondoInicial > 0) {
      db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)').run(`FONDO_DIARIO_${fecha}`, fondoInicial.toFixed(2));
    }
  }

  const corte = {
    totalVendido: 0,
    efectivo: 0,
    agricola: 0,
    cuscatlan: 0,
    contraentrega: 0,
    gastos: 0,
    apartados: 0,
    tickets: 0,
    envios: 0,
    fondoInicial: fondoInicial,
    fondoBloqueado: fondoInicial > 0,
    efectivoNeto: 0,
    totalEnCajon: 0,
    costoMercaderia: 0,
    gananciaBruta: 0,
    gananciaNetaReal: 0,
    margenPorcentaje: 0,
    arqueosCiegosHoy: []
  };

  const stmtCostoVenta = db.prepare(`
    SELECT d.cantidad, COALESCE(p.costo, 0) as costo
    FROM detalle_ventas d
    LEFT JOIN productos p ON d.id_producto = p.id
    WHERE d.id_venta = ?
  `);

  const ventas = db.prepare('SELECT * FROM ventas').all();
  for (const v of ventas) {
    const estadoRaw = (v.estado || 'Pagado').toString().trim();
    const estado = estadoRaw.toLowerCase();
    const metodo = (v.metodo_pago || 'Efectivo').toLowerCase();

    if (estado === 'anulada' || estado === 'cortesía' || metodo.includes('cortesía')) continue;

    const fechaTicketStr = obtenerFechaYMD(v.fecha);
    const total = parseFloat(v.total) || 0;
    const cajeroCreador = (v.cajero || 'Desconocido').trim();
    const anticipo = parseFloat(v.anticipo) || 0;
    const tarifaEnvio = parseFloat(v.tarifa) || 0;

    let fechaLiquidacionStr = "";
    let cajeroLiquidador = cajeroCreador;
    if (estado.includes('liquidado') && estadoRaw.includes('|')) {
      const partesLiq = estadoRaw.split('|');
      fechaLiquidacionStr = partesLiq[1].replace(')', '').trim();
      if (partesLiq.length > 2) cajeroLiquidador = partesLiq[2].replace(')', '').trim();
    }

    const creadoHoy = (fechaTicketStr === fecha);
    const liquidadoHoy = (fechaLiquidacionStr !== "" && fechaLiquidacionStr === fecha);
    const coincideCreador = (esGlobal || cajeroCreador.toLowerCase() === cajeroKey);
    const coincideLiquidador = (esGlobal || cajeroLiquidador.toLowerCase() === cajeroKey);

    if (creadoHoy && coincideCreador) {
      corte.totalVendido += total;
      corte.envios += tarifaEnvio;
      corte.tickets += 1;

      const itemsVenta = stmtCostoVenta.all(v.id_venta);
      for (const it of itemsVenta) {
        corte.costoMercaderia += (parseFloat(it.cantidad) || 0) * (parseFloat(it.costo) || 0);
      }

      if (metodo.includes('apartado')) {
        corte.apartados += anticipo;
        sumarSegunMetodo(corte, v.metodo_pago, anticipo);
      } else if (metodo.includes('contraentrega') || estado === 'pendiente') {
        if (!estado.includes('liquidado')) corte.contraentrega += total;
      } else {
        sumarSegunMetodo(corte, v.metodo_pago, total);
      }
    }

    const seLiquidoHoy = estado.includes('liquidado') && ((fechaLiquidacionStr === "" && creadoHoy) || liquidadoHoy);
    if (seLiquidoHoy && coincideLiquidador) {
      if (metodo.includes('apartado')) {
        sumarSegunMetodo(corte, estadoRaw, Math.max(0, total - anticipo));
      } else if (metodo.includes('contraentrega')) {
        sumarSegunMetodo(corte, estadoRaw, total);
      }
    }
  }

  const gastos = db.prepare('SELECT * FROM gastos').all();
  for (const g of gastos) {
    const fechaGastoStr = obtenerFechaYMD(g.fecha);
    const cajeroGasto = (g.cajero || 'Desconocido').trim();
    if (fechaGastoStr === fecha && (esGlobal || cajeroGasto.toLowerCase() === cajeroKey)) {
      corte.gastos += (parseFloat(g.monto) || 0);
    }
  }

  const ventasSinEnvio = Math.max(0, corte.totalVendido - corte.envios);
  corte.gananciaBruta = Math.max(0, ventasSinEnvio - corte.costoMercaderia);
  corte.gananciaNetaReal = corte.gananciaBruta - corte.gastos;
  corte.margenPorcentaje = ventasSinEnvio > 0 ? Number(((corte.gananciaBruta / ventasSinEnvio) * 100).toFixed(1)) : 0;

  corte.efectivoNeto = Math.max(0, corte.efectivo - corte.gastos);
  corte.totalEnCajon = Math.max(0, corte.fondoInicial + corte.efectivo - corte.gastos);

  try {
    const arqueos = db.prepare('SELECT * FROM arqueos_ciegos WHERE fecha_ymd = ? ORDER BY id DESC').all(fecha);
    corte.arqueosCiegosHoy = arqueos.map(a => ({
      id: a.id,
      hora: a.fecha ? new Date(a.fecha).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      cajero: a.cajero,
      declarado: Number((parseFloat(a.efectivo_declarado) || 0).toFixed(2)),
      esperado: Number((parseFloat(a.efectivo_esperado) || 0).toFixed(2)),
      diferencia: Number((parseFloat(a.diferencia) || 0).toFixed(2)),
      estadoCuadre: a.estado_cuadre || '',
      notas: a.notas || ''
    }));
  } catch (e) {}

  return corte;
}

// ============================================================================
// 5. LÓGICA DE NEGOCIO DEL POS
// ============================================================================
const funcionesPOS = {

  obtenerEstadoLicencia: () => {
    return evaluarEstadoLicenciaActual();
  },

  activarLicenciaSistema: (codigoLicenciaNuevo) => {
    const limpio = (codigoLicenciaNuevo || '').toString().trim();
    if (!limpio) {
      return { exito: false, mensaje: 'Pegue el código de licencia proporcionado por el proveedor.' };
    }

    const verif = verificarTokenLicencia(limpio);
    if (!verif.valida) {
      registrarEventoAuditoria('LICENCIA_RECHAZADA', verif.motivo, 'Sistema', IP_CLIENTE_ACTUAL, 'ALERTA');
      return { exito: false, mensaje: verif.motivo };
    }

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const finDiaVenc = new Date(`${verif.vencimiento}T23:59:59`);
    if (finDiaVenc.getTime() < hoy.getTime()) {
      return {
        exito: false,
        mensaje: `El código ingresado corresponde a una licencia que ya venció el ${verif.vencimiento}. Solicite un código vigente.`
      };
    }

    try {
      db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('LICENCIA_COMERCIAL_TOKEN', ?)")
        .run(limpio);
      fs.writeFileSync(rutaArchivoLicencia, limpio, 'utf8');
      try {
        fs.writeFileSync(rutaMarcadorHardwareOculto, `${obtenerHardwareIDMaquina()}|${Date.now()}`, 'utf8');
      } catch (e) {}

      db.prepare("DELETE FROM configuracion WHERE clave = 'ESTADO_REMOTO_SUSCRIPCION_JSON'").run();
      db.prepare("UPDATE suscripciones_clientes SET estado_manual = 'ACTIVO', fecha_vencimiento = ?, token_licencia = ?, motivo_suspension = '' WHERE UPPER(hardware_id) = UPPER(?)")
        .run(verif.vencimiento, limpio, obtenerHardwareIDMaquina());

      registrarEventoAuditoria(
        'LICENCIA_ACTIVADA',
        `Titular: ${verif.cliente} | Vence: ${verif.vencimiento}`,
        'Administrador',
        IP_CLIENTE_ACTUAL,
        'INFO'
      );

      const estadoActualizado = evaluarEstadoLicenciaActual();
      return {
        exito: true,
        mensaje: `¡Licencia activada con éxito para '${verif.cliente}'! Vigente hasta: ${verif.vencimiento}.`,
        estado: estadoActualizado
      };
    } catch (err) {
      return { exito: false, mensaje: 'Error guardando la licencia: ' + err.message };
    }
  },

  validarPinAcceso: (pinIngresado, ipCliente) => {
    return autenticarPinOToken(pinIngresado, ipCliente, true);
  },

  cerrarSesionToken: (tokenActiva) => {
    const t1 = (tokenActiva || '').toString().trim();
    const t2 = (TOKEN_SESION_ACTUAL || '').toString().trim();
    if (t1 && sesionesActivas.has(t1)) sesionesActivas.delete(t1);
    if (t2 && sesionesActivas.has(t2)) sesionesActivas.delete(t2);
    return { exito: true };
  },

  validarPin: (pinIngresado, ipCliente) => {
    const ipEfectiva = normalizarIP(ipCliente || IP_CLIENTE_ACTUAL);
    const estadoIP = verificarBloqueoIP(ipEfectiva);
    if (estadoIP.bloqueado) return false;

    if (!pinIngresado) return false;
    const entradaLimpia = pinIngresado.toString().trim();
    if (!entradaLimpia) return false;

    const sesion = obtenerSesionValidaPorTokenEIP(entradaLimpia, ipEfectiva);
    if (sesion) {
      if (esUsuarioRolAdmin({ rol: sesion.rol, nombre: sesion.nombreCajero })) {
        registrarIntentoPin(ipEfectiva, true);
        return true;
      }
      return false;
    }

    if (entradaLimpia.length === 64 && /^[a-f0-9]{64}$/i.test(entradaLimpia)) {
      return false;
    }

    const pinLimpio = entradaLimpia.slice(0, 32);
    const user = buscarUsuarioPorPinSeguro(pinLimpio);

    if (user && esUsuarioRolAdmin(user)) {
      registrarIntentoPin(ipEfectiva, true);
      return true;
    }

    if (verificarCredencialMasterConfig(pinLimpio)) {
      registrarIntentoPin(ipEfectiva, true);
      return true;
    }

    registrarIntentoPin(ipEfectiva, false, 'Autorización de PIN Admin');
    return false;
  },

  obtenerListaCajeros: () => {
    const filas = db.prepare('SELECT DISTINCT nombre FROM usuarios WHERE nombre != ""').all();
    return filas.map(f => f.nombre);
  },

  generarCodigoProductoUnico: () => {
    const stmt = db.prepare('SELECT id FROM productos WHERE id = ?');
    for (let i = 0; i < 100; i++) {
      const codigo6 = String(crypto.randomInt(100000, 999999));
      if (!stmt.get(codigo6)) {
        return codigo6;
      }
    }
    return String(Date.now()).slice(-6);
  },

  sugerirProductos: (textoBusqueda) => {
    const q = (textoBusqueda || '').toString().trim().slice(0, 80);
    if (!q) return [];

    const filas = db.prepare(`
      SELECT * FROM productos
      WHERE LOWER(nombre) LIKE LOWER(?)
         OR LOWER(id) LIKE LOWER(?)
         OR LOWER(categoria) LIKE LOWER(?)
      ORDER BY
        CASE WHEN LOWER(id) = LOWER(?) THEN 0
             WHEN LOWER(nombre) LIKE LOWER(?) THEN 1
             ELSE 2 END,
        nombre ASC
      LIMIT 15
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, q, `${q}%`);

    return filas.map(prod => {
      const precios = calcularPrecioProductoServidor(prod);
      return {
        idProducto: prod.id,
        nombre: prod.nombre,
        categoria: prod.categoria || '',
        precioOriginal: precios.precioOriginal,
        precioFinal: precios.precioFinal,
        stock: parseFloat(prod.stock) || 0,
        foto: prod.foto || '',
        tieneOferta: precios.precioFinal < precios.precioOriginal
      };
    });
  },

  exportarBovedaDatos: (pinDueno, claveBoveda, ipCliente) => {
    if (!validarSuperAdminUnico(pinDueno, ipCliente)) {
      return {
        exito: false,
        mensaje: "Acceso Denegado: Solo el Dueño / Administrador Principal tiene permiso para exportar la Bóveda."
      };
    }

    const claveStr = (claveBoveda || '').toString().trim();
    if (claveStr.length < 6) {
      return {
        exito: false,
        mensaje: "Por seguridad, ingresa una Contraseña de Cifrado de al menos 6 caracteres para proteger el archivo."
      };
    }

    try {
      const paqueteDatos = {
        productos: db.prepare('SELECT * FROM productos ORDER BY nombre ASC').all(),
        clientes: db.prepare('SELECT * FROM clientes ORDER BY nombre ASC').all(),
        ventas: db.prepare('SELECT * FROM ventas ORDER BY fecha DESC').all(),
        detalle_ventas: db.prepare('SELECT * FROM detalle_ventas').all(),
        gastos: db.prepare('SELECT * FROM gastos ORDER BY id DESC').all(),
        kardex: db.prepare('SELECT * FROM kardex ORDER BY id DESC').all(),
        configuracion: db.prepare("SELECT * FROM configuracion WHERE clave NOT IN ('PIN_MAESTRO', 'LICENCIA_COMERCIAL_TOKEN', 'ULTIMO_USO_FIRMADO')").all()
      };

      const contenidoCifrado = cifrarDatosBovedaAES(paqueteDatos, claveStr);
      const fechaHoy = obtenerFechaYMD(new Date());

      registrarEventoAuditoria(
        'BOVEDA_EXPORTADA',
        `Se descargó respaldo cifrado (.posbkp) con ${paqueteDatos.ventas.length} ventas y ${paqueteDatos.productos.length} productos.`,
        'Dueño / Admin',
        ipCliente || IP_CLIENTE_ACTUAL,
        'INFO'
      );

      return {
        exito: true,
        nombreArchivo: `BOVEDA_POS_${fechaHoy}_${Date.now().toString().slice(-4)}.posbkp`,
        contenidoCifrado: contenidoCifrado,
        resumen: {
          productos: paqueteDatos.productos.length,
          clientes: paqueteDatos.clientes.length,
          ventas: paqueteDatos.ventas.length,
          gastos: paqueteDatos.gastos.length,
          kardex: paqueteDatos.kardex.length
        },
        mensaje: "Respaldo mensual cifrado generado exitosamente (incluyendo el inventario completo de productos). Ahora tienes desbloqueada la opción de limpieza."
      };
    } catch (err) {
      return { exito: false, mensaje: "Error generando respaldo: " + err.message };
    }
  },

  limpiarBaseDatosMaestra: (pinDueno, claveBoveda, fraseConfirmacion, conservarProductos, ipCliente) => {
    if (!validarSuperAdminUnico(pinDueno, ipCliente)) {
      return {
        exito: false,
        mensaje: "Acceso Denegado: Solo el Dueño / Administrador Principal puede limpiar la base de datos."
      };
    }

    if ((fraseConfirmacion || '').toString().trim().toUpperCase() !== 'ELIMINAR DATOS') {
      return {
        exito: false,
        mensaje: "Debes escribir exactamente la frase ELIMINAR DATOS para confirmar."
      };
    }

    if (!claveBoveda || String(claveBoveda).trim().length < 6) {
      return {
        exito: false,
        mensaje: "Debes confirmar la Contraseña de Bóveda con la que descargaste tu respaldo."
      };
    }

    try {
      db.realizarRespaldoAutomatico();

      const ejecutarLimpieza = db.transaction(() => {
        db.prepare('DELETE FROM detalle_ventas').run();
        db.prepare('DELETE FROM ventas').run();
        db.prepare('DELETE FROM clientes').run();
        db.prepare('DELETE FROM gastos').run();
        db.prepare('DELETE FROM kardex').run();
        db.prepare('DELETE FROM arqueos_ciegos').run();
        db.prepare("DELETE FROM configuracion WHERE clave LIKE 'FONDO_%'").run();

        if (!conservarProductos) {
          db.prepare('DELETE FROM productos').run();
        }
      });

      ejecutarLimpieza();
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}

      registrarEventoAuditoria(
        'CIERRE_MES_LIMPIEZA_BD',
        `Limpieza mensual ejecutada (Conservar productos: ${Boolean(conservarProductos)})`,
        'Dueño / Admin',
        ipCliente || IP_CLIENTE_ACTUAL,
        'CRITICO'
      );

      return {
        exito: true,
        mensaje: conservarProductos
          ? "Cierre de mes completado: Ventas, clientes, gastos y bitácoras quedaron limpios para el nuevo mes (Se conservaron tus Productos, Cajeros y Diseño de Ticket)."
          : "Base de datos limpiada por completo (Se conservaron únicamente los Cajeros y el Diseño del Ticket). Todos tus productos quedaron guardados en el archivo .posbkp descargado."
      };
    } catch (err) {
      return { exito: false, mensaje: "Error al limpiar la base de datos: " + err.message };
    }
  },

  restaurarBovedaDatos: (contenidoArchivoCifrado, pinDueno, claveBoveda, ipCliente) => {
    if (!validarSuperAdminUnico(pinDueno, ipCliente)) {
      return {
        exito: false,
        mensaje: "Acceso Denegado: Solo el Dueño / Administrador Principal puede restaurar respaldos en el sistema."
      };
    }

    if (!contenidoArchivoCifrado || !claveBoveda) {
      return { exito: false, mensaje: "Selecciona el archivo .posbkp e ingresa su Contraseña de Cifrado." };
    }

    let datos;
    try {
      datos = descifrarDatosBovedaAES(contenidoArchivoCifrado, String(claveBoveda).trim());
    } catch (err) {
      return {
        exito: false,
        mensaje: "No se pudo abrir el archivo: Contraseña de Bóveda incorrecta o el archivo fue alterado."
      };
    }

    try {
      db.realizarRespaldoAutomatico();

      const transaccionRestaurar = db.transaction(() => {
        if (Array.isArray(datos.productos)) {
          const insProd = db.prepare(`
            INSERT OR REPLACE INTO productos (id, foto, nombre, categoria, precio, stock, costo, desc_valor, desc_tipo, fecha_limite)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const p of datos.productos) {
            insProd.run(p.id, p.foto || '', p.nombre, p.categoria || '', p.precio || 0, p.stock || 0, p.costo || 0, p.desc_valor || 0, p.desc_tipo || '%', p.fecha_limite || '');
          }
        }

        if (Array.isArray(datos.clientes)) {
          const insCli = db.prepare('INSERT OR REPLACE INTO clientes (telefono, nombre, direccion) VALUES (?, ?, ?)');
          for (const c of datos.clientes) {
            insCli.run(c.telefono, c.nombre || '', c.direccion || '');
          }
        }

        if (Array.isArray(datos.ventas)) {
          const insVen = db.prepare(`
            INSERT OR REPLACE INTO ventas (id_venta, fecha, total, cliente, telefono, direccion, metodo_pago, descuento, cajero, estado, repartidor, tarifa, anticipo, ref_fiscal, motivo_anulacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const v of datos.ventas) {
            insVen.run(
              v.id_venta,
              v.fecha,
              v.total || 0,
              v.cliente || '',
              v.telefono || '',
              v.direccion || '',
              v.metodo_pago || '',
              v.descuento || 0,
              v.cajero || '',
              v.estado || 'Pagado',
              v.repartidor || '',
              v.tarifa || 0,
              v.anticipo || 0,
              v.ref_fiscal || '',
              v.motivo_anulacion || ''
            );
          }
        }

        if (Array.isArray(datos.detalle_ventas)) {
          const insDet = db.prepare('INSERT OR REPLACE INTO detalle_ventas (id_detalle, id_venta, id_producto, cantidad, subtotal) VALUES (?, ?, ?, ?, ?)');
          for (const d of datos.detalle_ventas) {
            insDet.run(d.id_detalle, d.id_venta, d.id_producto, d.cantidad || 0, d.subtotal || 0);
          }
        }

        if (Array.isArray(datos.gastos)) {
          db.prepare('DELETE FROM gastos').run();
          const insGas = db.prepare('INSERT INTO gastos (id, fecha, concepto, monto, cajero) VALUES (?, ?, ?, ?, ?)');
          for (const g of datos.gastos) {
            insGas.run(g.id, g.fecha, g.concepto || '', g.monto || 0, g.cajero || '');
          }
        }

        if (Array.isArray(datos.kardex)) {
          db.prepare('DELETE FROM kardex').run();
          const insKar = db.prepare('INSERT INTO kardex (id, fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)');
          for (const k of datos.kardex) {
            insKar.run(k.id, k.fecha, k.id_producto, k.tipo_movimiento || '', k.cantidad || 0, k.cajero || '');
          }
        }

        if (Array.isArray(datos.configuracion)) {
          const insCfg = db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)');
          const clavesProtegidas = new Set(['PIN_MAESTRO', 'LICENCIA_COMERCIAL_TOKEN', 'ULTIMO_USO_FIRMADO']);
          for (const cfg of datos.configuracion) {
            if (!clavesProtegidas.has(cfg.clave)) {
              insCfg.run(cfg.clave, cfg.valor);
            }
          }
        }
      });

      transaccionRestaurar();

      registrarEventoAuditoria(
        'BOVEDA_RESTAURADA',
        `Se restauró archivo .posbkp (${datos.ventas ? datos.ventas.length : 0} ventas).`,
        'Dueño / Admin',
        ipCliente || IP_CLIENTE_ACTUAL,
        'CRITICO'
      );

      return {
        exito: true,
        mensaje: `Restauración completada con éxito: ${datos.ventas ? datos.ventas.length : 0} ventas, ${datos.clientes ? datos.clientes.length : 0} clientes y ${datos.productos ? datos.productos.length : 0} productos recuperados.`
      };
    } catch (err) {
      return { exito: false, mensaje: "Error restaurando base de datos: " + err.message };
    }
  },

  inspeccionarBovedaDatos: (contenidoArchivoCifrado, pinDueno, claveBoveda, ipCliente) => {
    if (!validarSuperAdminUnico(pinDueno, ipCliente)) {
      return {
        exito: false,
        mensaje: "Acceso Denegado: Solo el Dueño / Administrador Principal puede auditar archivos de la Bóveda."
      };
    }

    if (!contenidoArchivoCifrado || !claveBoveda) {
      return { exito: false, mensaje: "Selecciona el archivo .posbkp e ingresa su Contraseña Secreta de Cifrado." };
    }

    let datos;
    try {
      datos = descifrarDatosBovedaAES(contenidoArchivoCifrado, String(claveBoveda).trim());
    } catch (err) {
      return {
        exito: false,
        mensaje: "No se pudo abrir el archivo: Contraseña de Bóveda incorrecta o archivo inválido."
      };
    }

    try {
      const listaProductos = Array.isArray(datos.productos) ? datos.productos : [];
      const listaVentas = Array.isArray(datos.ventas) ? datos.ventas : [];
      const listaDetalles = Array.isArray(datos.detalle_ventas) ? datos.detalle_ventas : [];
      const listaGastos = Array.isArray(datos.gastos) ? datos.gastos : [];
      const listaKardex = Array.isArray(datos.kardex) ? datos.kardex : [];
      const listaClientes = Array.isArray(datos.clientes) ? datos.clientes : [];

      const mapaProductos = new Map();
      for (const p of listaProductos) {
        mapaProductos.set(String(p.id), p);
      }

      const mapaDetallesPorVenta = new Map();
      for (const d of listaDetalles) {
        const prodRef = mapaProductos.get(String(d.id_producto));
        const nombreProd = prodRef ? prodRef.nombre : `ID: ${d.id_producto}`;
        const costoUnit = prodRef ? (parseFloat(prodRef.costo) || 0) : 0;
        const cant = parseFloat(d.cantidad) || 0;
        const sub = parseFloat(d.subtotal) || 0;

        if (!mapaDetallesPorVenta.has(d.id_venta)) {
          mapaDetallesPorVenta.set(d.id_venta, []);
        }
        mapaDetallesPorVenta.get(d.id_venta).push({
          idProducto: d.id_producto,
          nombre: nombreProd,
          cantidad: cant,
          subtotal: sub,
          costoTotal: cant * costoUnit
        });
      }

      const metricas = {
        totalVendido: 0,
        efectivo: 0,
        agricola: 0,
        cuscatlan: 0,
        contraentrega: 0,
        gastos: 0,
        envios: 0,
        ticketsValidos: 0,
        costoMercaderia: 0,
        gananciaBruta: 0,
        gananciaNetaReal: 0,
        margenPorcentaje: 0
      };

      const ventasFormateadas = [];
      for (const v of listaVentas) {
        const estadoRaw = (v.estado || 'Pagado').toString().trim();
        const estado = estadoRaw.toLowerCase();
        const metodo = (v.metodo_pago || 'Efectivo').toLowerCase();
        const total = parseFloat(v.total) || 0;
        const anticipo = parseFloat(v.anticipo) || 0;
        const tarifaEnvio = parseFloat(v.tarifa) || 0;
        const itemsDeVenta = mapaDetallesPorVenta.get(v.id_venta) || [];

        if (estado !== 'anulada' && estado !== 'cortesía' && !metodo.includes('cortesía')) {
          metricas.totalVendido += total;
          metricas.envios += tarifaEnvio;
          metricas.ticketsValidos += 1;

          for (const it of itemsDeVenta) {
            metricas.costoMercaderia += it.costoTotal;
          }

          if (metodo.includes('apartado')) {
            sumarSegunMetodo(metricas, v.metodo_pago, anticipo);
            if (estado.includes('liquidado')) {
              sumarSegunMetodo(metricas, estadoRaw, Math.max(0, total - anticipo));
            }
          } else if (metodo.includes('contraentrega') || estado === 'pendiente') {
            if (estado.includes('liquidado')) {
              sumarSegunMetodo(metricas, estadoRaw, total);
            } else {
              metricas.contraentrega += total;
            }
          } else {
            sumarSegunMetodo(metricas, v.metodo_pago, total);
          }
        }

        const resumenArticulos = itemsDeVenta
          .map(it => `${it.cantidad}x ${it.nombre}`)
          .join(', ');

        ventasFormateadas.push({
          idVenta: v.id_venta,
          fecha: v.fecha ? new Date(v.fecha).toLocaleString() : '',
          fechaYMD: obtenerFechaYMD(v.fecha),
          cliente: v.cliente || 'Cliente Mostrador',
          telefono: v.telefono || 'N/A',
          metodo: v.metodo_pago || 'Efectivo',
          estado: estadoRaw,
          cajero: v.cajero || 'N/A',
          total: total,
          refFiscal: v.ref_fiscal || '',
          articulos: resumenArticulos || 'Sin desglose'
        });
      }

      const gastosFormateados = [];
      for (const g of listaGastos) {
        const mGasto = parseFloat(g.monto) || 0;
        metricas.gastos += mGasto;
        gastosFormateados.push({
          fecha: g.fecha ? new Date(g.fecha).toLocaleString() : '',
          concepto: g.concepto || '',
          monto: mGasto,
          cajero: g.cajero || 'N/A'
        });
      }

      const ventasSinEnvio = Math.max(0, metricas.totalVendido - metricas.envios);
      metricas.gananciaBruta = Math.max(0, ventasSinEnvio - metricas.costoMercaderia);
      metricas.gananciaNetaReal = metricas.gananciaBruta - metricas.gastos;
      metricas.margenPorcentaje = ventasSinEnvio > 0
        ? Number(((metricas.gananciaBruta / ventasSinEnvio) * 100).toFixed(1))
        : 0;

      const kardexFormateado = listaKardex.map(k => {
        const prodRef = mapaProductos.get(String(k.id_producto));
        return {
          fecha: k.fecha ? new Date(k.fecha).toLocaleString() : '',
          idProducto: k.id_producto,
          nombreProducto: prodRef ? prodRef.nombre : 'Producto Eliminado',
          tipo: k.tipo_movimiento || '',
          cantidad: parseFloat(k.cantidad) || 0,
          cajero: k.cajero || 'N/A'
        };
      });

      const inventarioFormateado = listaProductos.map(p => ({
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria || 'General',
        costo: parseFloat(p.costo) || 0,
        precio: parseFloat(p.precio) || 0,
        stock: parseFloat(p.stock) || 0
      }));

      return {
        exito: true,
        fechaExportacion: datos._fechaExportacion ? new Date(datos._fechaExportacion).toLocaleString() : 'Desconocida',
        metricas: metricas,
        ventas: ventasFormateadas,
        gastos: gastosFormateados,
        kardex: kardexFormateado,
        productos: inventarioFormateado,
        totalClientes: listaClientes.length
      };
    } catch (err) {
      return { exito: false, mensaje: "Error procesando datos del archivo: " + err.message };
    }
  },

  obtenerDisenoImpresion: () => {
    try {
      const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'DISENO_IMPRESION_JSON'").get();
      if (fila && fila.valor) {
        const guardado = JSON.parse(fila.valor);
        return Object.assign({}, db.DISENO_IMPRESION_DEFECTO, guardado);
      }
    } catch (e) {
      console.error("Error leyendo diseño de impresión:", e.message);
    }
    return Object.assign({}, db.DISENO_IMPRESION_DEFECTO);
  },

  guardarDisenoImpresion: (nuevoDiseno, pinIngresado) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      return { exito: false, mensaje: "Se requiere PIN de Administrador para modificar el diseño y textos legales." };
    }

    try {
      const actual = funcionesPOS.obtenerDisenoImpresion();
      const obj = Object.assign({}, actual, nuevoDiseno || {});

      if (obj.logoSuperior && obj.logoSuperior.startsWith('data:image')) {
        if (!validarBase64ImagenSegura(obj.logoSuperior)) {
          return { exito: false, mensaje: "Formato de imagen de logo inválido o corrupto." };
        }
        obj.logoSuperior = db.guardarImagenDisenoEnDisco('logo_tienda', obj.logoSuperior);
      }

      if (obj.watermark && obj.watermark.startsWith('data:image')) {
        if (!validarBase64ImagenSegura(obj.watermark)) {
          return { exito: false, mensaje: "Formato de imagen de marca de agua inválido o corrupto." };
        }
        obj.watermark = db.guardarImagenDisenoEnDisco('watermark_ticket', obj.watermark);
      }

      obj.opacidadWatermark = Math.min(0.5, Math.max(0.04, parseFloat(obj.opacidadWatermark) || 0.18));

      db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('DISENO_IMPRESION_JSON', ?)")
        .run(JSON.stringify(obj));

      return {
        exito: true,
        mensaje: "Diseño de Ticket, Textos Legales y Guías de Envío guardados y sincronizados en todos los equipos.",
        diseno: obj
      };
    } catch (err) {
      return { exito: false, mensaje: "Error guardando diseño: " + err.message };
    }
  },

  obtenerConfiguracionGlobal: () => {
    const v = db.prepare("SELECT valor FROM configuracion WHERE clave = 'descValor'").get();
    const t = db.prepare("SELECT valor FROM configuracion WHERE clave = 'descTipo'").get();
    return {
      descValor: v ? parseFloat(v.valor) || 0 : 0,
      descTipo: t ? t.valor : '%'
    };
  },

  guardarConfiguracionGlobal: (valor, tipo, pin) => {
    if (!funcionesPOS.validarPin(pin, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "PIN incorrecto o sin permisos de Admin." };
    const upsert = db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)');
    upsert.run('descValor', (parseFloat(valor) || 0).toString());
    upsert.run('descTipo', tipo === '$' ? '$' : '%');
    return { exito: true, mensaje: "Descuento configurado." };
  },

  configurarDescuentoProducto: (idProducto, valor, tipo, fecha, pin) => {
    if (!funcionesPOS.validarPin(pin, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "PIN incorrecto o sin permisos de Admin." };
    const info = db.prepare(`
      UPDATE productos SET desc_valor = ?, desc_tipo = ?, fecha_limite = ? WHERE id = ?
    `).run(Math.max(0, parseFloat(valor) || 0), tipo === '$' ? '$' : '%', (fecha || '').toString().trim(), (idProducto || '').toString().trim());
    if (info.changes > 0) return { exito: true, mensaje: "Oferta guardada exitosamente." };
    return { exito: false, mensaje: "Producto no encontrado." };
  },

  buscarClientePorTelefono: (telefonoBuscado) => {
    const tel = (telefonoBuscado || '').toString().trim().slice(0, 30);
    if (!tel) return { encontrado: false };

    const c = db.prepare('SELECT * FROM clientes WHERE telefono = ?').get(tel);
    const stats = db.prepare(`
      SELECT COUNT(*) as totalCompras, COALESCE(SUM(total), 0) as montoAcumulado, MAX(fecha) as ultimaFecha
      FROM ventas
      WHERE telefono = ? AND LOWER(estado) != 'anulada' AND LOWER(estado) != 'cortesía'
    `).get(tel);

    if (c) {
      return {
        encontrado: true,
        nombre: c.nombre,
        direccion: c.direccion,
        totalCompras: stats ? (stats.totalCompras || 0) : 0,
        montoAcumulado: stats ? Number((parseFloat(stats.montoAcumulado) || 0).toFixed(2)) : 0,
        ultimaCompra: (stats && stats.ultimaFecha) ? obtenerFechaYMD(stats.ultimaFecha) : ''
      };
    }
    return { encontrado: false };
  },

  buscarProducto: (codigoBuscado, pinAdminOpcional) => {
    const termino = (codigoBuscado || '').toString().trim().slice(0, 100);
    if (!termino) return { encontrado: false };

    let prod = db.prepare('SELECT * FROM productos WHERE LOWER(id) = LOWER(?)').get(termino);
    if (!prod) {
      const sinCeros = termino.replace(/^0+/, '');
      if (sinCeros && sinCeros !== termino) {
        prod = db.prepare('SELECT * FROM productos WHERE LOWER(id) = LOWER(?)').get(sinCeros);
      }
    }
    if (!prod) {
      prod = db.prepare('SELECT * FROM productos WHERE LOWER(nombre) LIKE LOWER(?)').get(`%${termino}%`);
    }
    if (!prod) return { encontrado: false };

    const precios = calcularPrecioProductoServidor(prod);
    const puedeVerCosto = Boolean(pinAdminOpcional && tienePermisoAdminSilencioso(pinAdminOpcional));

    return {
      encontrado: true,
      idProducto: prod.id,
      nombre: prod.nombre,
      categoria: prod.categoria || '',
      costo: puedeVerCosto ? (parseFloat(prod.costo) || 0) : 0,
      precioOriginal: precios.precioOriginal,
      precioFinal: precios.precioFinal,
      stock: parseFloat(prod.stock) || 0,
      foto: prod.foto || ''
    };
  },

  registrarGasto: (concepto, monto, cajero, pin) => {
    if (!funcionesPOS.validarPin(pin, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "PIN incorrecto o sin permisos de Admin." };
    const montoLimpio = parseFloat(monto) || 0;
    const conceptoLimpio = sanitizarTextoSeguro(concepto, 160);
    if (montoLimpio <= 0 || !conceptoLimpio) {
      return { exito: false, mensaje: "Concepto y monto válido son obligatorios." };
    }
    const cajeroLimpio = sanitizarTextoSeguro(cajero || 'Desconocido', 60);
    db.prepare('INSERT INTO gastos (fecha, concepto, monto, cajero) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), conceptoLimpio, montoLimpio, cajeroLimpio);

    registrarEventoAuditoria(
      'EGRESO_CAJA',
      `Concepto: ${conceptoLimpio} | Monto: -$${montoLimpio.toFixed(2)}`,
      cajeroLimpio,
      IP_CLIENTE_ACTUAL,
      'INFO'
    );

    return { exito: true, mensaje: "Gasto registrado, dinero restado de caja." };
  },

  registrarVenta: (carrito, totalClienteIgnorado, nombre, telefono, direccion, metodoPago, descuentoIgnorado, cajero, extraData, pinSesion) => {
    const transaccion = db.transaction(() => {
      const credencialSesion = pinSesion || TOKEN_SESION_ACTUAL;
      if (!credencialSesion) {
        throw new Error("Sesión no autorizada. Ingrese su PIN nuevamente.");
      }
      const sesion = autenticarPinOToken(credencialSesion, IP_CLIENTE_ACTUAL, false);
      if (!sesion.valido) {
        throw new Error("Sesión de cajero no válida. Desbloquee la caja nuevamente.");
      }
      cajero = sesion.nombreCajero;

      if (!carrito || !Array.isArray(carrito) || carrito.length === 0 || carrito.length > 200) {
        throw new Error("El carrito está vacío o excede el límite de artículos.");
      }

      let metodoStr = sanitizarTextoSeguro(metodoPago || 'Efectivo (Local)', 110);

      if (metodoStr.toLowerCase().includes("cortesía") || metodoStr.toLowerCase().includes("cortesia")) {
        const pinAdminAutorizador = (extraData && extraData.pinAdmin) ? extraData.pinAdmin : credencialSesion;
        if (!funcionesPOS.validarPin(pinAdminAutorizador, IP_CLIENTE_ACTUAL)) {
          throw new Error("Acceso Denegado: Se requiere autorización de Administrador para registrar una Cortesía ($0.00).");
        }
      }

      let subtotalBrutoServidor = 0;
      let descuentoTotalServidor = 0;
      let subtotalNetoProductos = 0;
      const itemsVerificados = [];

      for (const item of carrito) {
        const cant = parseFloat(item.cantidad) || 0;
        if (cant <= 0 || cant > 10000) throw new Error("Cantidad inválida en el carrito.");

        const idProd = (item.idProducto || '').toString().trim();
        const prod = db.prepare('SELECT * FROM productos WHERE id = ?').get(idProd);
        if (!prod) throw new Error(`El producto ${idProd} ya no existe en el inventario.`);
        if (prod.stock < cant) {
          throw new Error(`Stock insuficiente para '${prod.nombre}' (Disponible: ${prod.stock}).`);
        }

        const precios = calcularPrecioProductoServidor(prod);
        const subBrutoItem = precios.precioOriginal * cant;
        const subNetoItem = precios.precioFinal * cant;
        const descItem = Math.max(0, subBrutoItem - subNetoItem);

        subtotalBrutoServidor += subBrutoItem;
        descuentoTotalServidor += descItem;
        subtotalNetoProductos += subNetoItem;

        itemsVerificados.push({
          idProducto: prod.id,
          cantidad: cant,
          subtotalNeto: Number(subNetoItem.toFixed(2))
        });
      }

      const idVenta = generarIdTicketCortoUnico();
      const fechaISO = new Date().toISOString();
      let estadoCobro = "Pagado";
      let tipoKardex = "Salida (Venta)";

      const tarifaEnvio = metodoStr.includes("Envío") ? Math.max(0, parseFloat(extraData && extraData.tarifa) || 0) : 0;
      const anticipoRecibido = metodoStr.includes("Apartado") ? Math.max(0, parseFloat(extraData && extraData.anticipo) || 0) : 0;
      let totalRealServidor = Number((subtotalNetoProductos + tarifaEnvio).toFixed(2));
      let descuentoRealGuardar = Number(descuentoTotalServidor.toFixed(2));

      if (metodoStr.toLowerCase().includes("pago mixto") && extraData && extraData.mixtoEfectivo !== undefined) {
        const efMixto = Math.min(totalRealServidor, Math.max(0, parseFloat(extraData.mixtoEfectivo) || 0));
        const bancoMixto = Math.max(0, Number((totalRealServidor - efMixto).toFixed(2)));
        const nombreBancoMixto = sanitizarTextoSeguro(extraData.mixtoBanco || 'Agrícola', 20);
        const sufijoModalidad = metodoStr.includes("(Envío)") ? "(Envío)" : "(Local)";
        metodoStr = `Pago Mixto ${sufijoModalidad} [Efectivo:$${efMixto.toFixed(2)}|${nombreBancoMixto}:$${bancoMixto.toFixed(2)}]`;
      }

      if (metodoStr.includes("Contraentrega")) estadoCobro = "Pendiente";
      if (metodoStr.includes("Apartado")) estadoCobro = "Apartado";
      if (metodoStr.includes("Cortesía") || metodoStr.includes("Cortesia")) {
        estadoCobro = "Cortesía";
        totalRealServidor = 0;
        descuentoRealGuardar = Number(subtotalBrutoServidor.toFixed(2));
        tipoKardex = "Salida (Cortesía / Uso Propio)";
      }

      const nombreLimpio = sanitizarTextoSeguro(nombre || "Cliente Mostrador", 100);
      const telLimpio = sanitizarTextoSeguro(telefono || "N/A", 30);
      const dirLimpia = sanitizarTextoSeguro(direccion || "N/A", 200);
      const repLimpio = (extraData && extraData.repartidor) ? sanitizarTextoSeguro(extraData.repartidor, 80) : "";
      const refFiscalLimpia = (extraData && extraData.refFiscal) ? sanitizarTextoSeguro(extraData.refFiscal, 60) : "";

      db.prepare(`
        INSERT INTO ventas (id_venta, fecha, total, cliente, telefono, direccion, metodo_pago, descuento, cajero, estado, repartidor, tarifa, anticipo, ref_fiscal, motivo_anulacion)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
      `).run(
        idVenta,
        fechaISO,
        totalRealServidor,
        nombreLimpio,
        telLimpio,
        dirLimpia,
        metodoStr,
        descuentoRealGuardar,
        cajero || "Desconocido",
        estadoCobro,
        repLimpio,
        tarifaEnvio,
        anticipoRecibido,
        refFiscalLimpia
      );

      const insDetalle = db.prepare('INSERT INTO detalle_ventas (id_detalle, id_venta, id_producto, cantidad, subtotal) VALUES (?, ?, ?, ?, ?)');
      const updStock = db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?');
      const insKardex = db.prepare('INSERT INTO kardex (fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)');

      itemsVerificados.forEach((item, k) => {
        const idDetalle = `${idVenta}-${k}`;
        const subtotalGuardar = estadoCobro === "Cortesía" ? 0 : item.subtotalNeto;
        insDetalle.run(idDetalle, idVenta, item.idProducto, item.cantidad, subtotalGuardar);
        updStock.run(item.cantidad, item.idProducto);
        insKardex.run(fechaISO, item.idProducto, tipoKardex, -item.cantidad, cajero || "Desconocido");
      });

      if (telLimpio !== "" && telLimpio !== "N/A") {
        db.prepare('INSERT OR REPLACE INTO clientes (telefono, nombre, direccion) VALUES (?, ?, ?)')
          .run(telLimpio, nombreLimpio, dirLimpia);
      }

      if (estadoCobro === "Cortesía") {
        registrarEventoAuditoria(
          'CORTESIA_AUTORIZADA',
          `Vale ${idVenta} ($0.00) para '${nombreLimpio}'`,
          cajero || "Desconocido",
          IP_CLIENTE_ACTUAL,
          'ALERTA'
        );
      }

      return `Venta registrada exitosamente.|${idVenta}`;
    });

    try {
      return transaccion();
    } catch (e) {
      return "Error: " + e.message;
    }
  },

  obtenerHistorial: (fechaFiltro) => {
    const ventas = db.prepare('SELECT * FROM ventas ORDER BY fecha DESC').all();
    const historial = [];
    for (const v of ventas) {
      const fechaYMD = obtenerFechaYMD(v.fecha);
      if (fechaFiltro && fechaFiltro !== "Todos" && fechaYMD !== fechaFiltro) continue;

      historial.push({
        idVenta: v.id_venta,
        fecha: new Date(v.fecha).toLocaleString(),
        total: v.total,
        cliente: v.cliente,
        telefono: v.telefono,
        direccion: v.direccion,
        cajero: v.cajero || "N/A",
        metodo: v.metodo_pago || "Efectivo (Local)",
        estado: v.estado || "Pagado",
        repartidor: v.repartidor || "",
        tarifa: parseFloat(v.tarifa) || 0,
        anticipo: parseFloat(v.anticipo) || 0,
        refFiscal: v.ref_fiscal || "",
        motivoAnulacion: v.motivo_anulacion || ""
      });
      if ((!fechaFiltro || fechaFiltro === "Todos") && historial.length >= 200) break;
    }
    return historial;
  },

  obtenerTicketCompleto: (idVenta) => {
    const idBuscado = (idVenta || '').toString().trim().slice(0, 40);
    let v = db.prepare('SELECT * FROM ventas WHERE UPPER(id_venta) = UPPER(?)').get(idBuscado);
    if (!v && /^\d+$/.test(idBuscado)) {
      v = db.prepare('SELECT * FROM ventas WHERE UPPER(id_venta) = UPPER(?)').get(`TICKET-${idBuscado}`);
    }
    if (!v) return { encabezado: {}, detalles: [] };

    const encabezado = {
      idVenta: v.id_venta,
      fecha: new Date(v.fecha).toLocaleString(),
      total: v.total,
      cliente: v.cliente,
      telefono: v.telefono,
      direccion: v.direccion,
      metodoPago: v.metodo_pago || "Efectivo (Local)",
      descuento: parseFloat(v.descuento) || 0,
      cajero: v.cajero || "N/A",
      estado: v.estado || "Pagado",
      repartidor: v.repartidor || "",
      tarifa: parseFloat(v.tarifa) || 0,
      anticipo: parseFloat(v.anticipo) || 0,
      refFiscal: v.ref_fiscal || "",
      motivoAnulacion: v.motivo_anulacion || ""
    };

    const filasDetalle = db.prepare(`
      SELECT d.id_producto, d.cantidad, d.subtotal, p.nombre 
      FROM detalle_ventas d
      LEFT JOIN productos p ON d.id_producto = p.id
      WHERE d.id_venta = ?
    `).all(v.id_venta);

    const detalles = filasDetalle.map(d => ({
      idProducto: d.id_producto,
      cantidad: d.cantidad,
      nombre: d.nombre || "Producto Borrado",
      subtotal: d.subtotal
    }));

    return { encabezado, detalles };
  },

  liquidarTicketPendiente: (idVenta, metodoCobro, pinIngresado, cajeroQueLiquida) => {
    if (!funcionesPOS.validarPin(pinIngresado, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "PIN incorrecto o sin permisos de Admin." };
    const idBuscado = (idVenta || '').toString().trim();
    const v = db.prepare('SELECT estado FROM ventas WHERE id_venta = ?').get(idBuscado);
    if (!v) return { exito: false, mensaje: "No se encontró el ticket." };
    if ((v.estado || '').toLowerCase() === 'anulada') return { exito: false, mensaje: "No se puede liquidar un ticket anulado." };

    const hoyYMD = obtenerFechaYMD(new Date());
    const operador = sanitizarTextoSeguro(cajeroQueLiquida || "Desconocido", 50);
    const metodoLimpio = sanitizarTextoSeguro(metodoCobro || "Efectivo", 50);
    const nuevoEstado = `Liquidado (${metodoLimpio} | ${hoyYMD} | ${operador})`;

    db.prepare('UPDATE ventas SET estado = ? WHERE id_venta = ?').run(nuevoEstado, idBuscado);
    registrarEventoAuditoria('LIQUIDACION_TICKET', `Ticket ${idBuscado} liquidado vía ${metodoLimpio}`, operador, IP_CLIENTE_ACTUAL, 'INFO');

    return {
      exito: true,
      mensaje: "Ticket marcado como liquidado vía " + metodoLimpio,
      ticket: funcionesPOS.obtenerTicketCompleto(idBuscado)
    };
  },

  devolverProductoParcial: (idVenta, idProducto, cantDevolver, pinIngresado, cajeroActivo) => {
    if (!funcionesPOS.validarPin(pinIngresado, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "PIN incorrecto o sin permisos de Admin." };
    const transaccion = db.transaction(() => {
      const idVentaLimpio = (idVenta || '').toString().trim();
      const idProdLimpio = (idProducto || '').toString().trim();

      const ventaPadre = db.prepare('SELECT estado, metodo_pago FROM ventas WHERE id_venta = ?').get(idVentaLimpio);
      if (!ventaPadre) return { exito: false, mensaje: "No se encontró el comprobante de venta." };
      const est = (ventaPadre.estado || '').toLowerCase();
      const met = (ventaPadre.metodo_pago || '').toLowerCase();
      if (est === 'anulada') {
        return { exito: false, mensaje: "No se pueden devolver productos de un comprobante que ya está ANULADO." };
      }
      if (est === 'cortesía' || met.includes('cortesía')) {
        return { exito: false, mensaje: "Para reintegrar una cortesía, anule el vale completo desde el historial." };
      }

      const det = db.prepare('SELECT * FROM detalle_ventas WHERE id_venta = ? AND id_producto = ?')
                    .get(idVentaLimpio, idProdLimpio);
      if (!det) return { exito: false, mensaje: "Producto no encontrado en el ticket." };

      const cant = parseFloat(cantDevolver);
      if (cant <= 0 || cant > det.cantidad) return { exito: false, mensaje: "Cantidad inválida." };

      const precioUnitario = det.subtotal / det.cantidad;
      const montoADevolver = precioUnitario * cant;
      const operador = sanitizarTextoSeguro(cajeroActivo || "Desconocido", 50);

      if (cant >= det.cantidad) {
        db.prepare('DELETE FROM detalle_ventas WHERE id_detalle = ?').run(det.id_detalle);
      } else {
        db.prepare('UPDATE detalle_ventas SET cantidad = ?, subtotal = ? WHERE id_detalle = ?')
          .run(det.cantidad - cant, det.subtotal - montoADevolver, det.id_detalle);
      }

      db.prepare('UPDATE ventas SET total = MAX(0, total - ?) WHERE id_venta = ?').run(montoADevolver, idVentaLimpio);
      db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(cant, idProdLimpio);
      db.prepare('INSERT INTO kardex (fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), idProdLimpio, `Retorno Parcial (${idVentaLimpio})`, cant, operador);

      registrarEventoAuditoria(
        'DEVOLUCION_PARCIAL',
        `Ticket: ${idVentaLimpio} | Prod: ${idProdLimpio} (x${cant}) | Reembolso: $${montoADevolver.toFixed(2)}`,
        operador,
        IP_CLIENTE_ACTUAL,
        'ALERTA'
      );

      return { exito: true, mensaje: "Devolución exitosa. Reembolsar al cliente: $" + montoADevolver.toFixed(2) };
    });
    return transaccion();
  },

  anularVenta: (idVenta, pinIngresado, cajeroActivo, motivoOpcional) => {
    if (!funcionesPOS.validarPin(pinIngresado, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "PIN incorrecto o sin permisos de Admin." };
    const transaccion = db.transaction(() => {
      const idLimpio = (idVenta || '').toString().trim();
      const v = db.prepare('SELECT estado, total FROM ventas WHERE id_venta = ?').get(idLimpio);
      if (!v) return { exito: false, mensaje: "No se encontró el ticket." };
      if ((v.estado || '').toLowerCase() === 'anulada') return { exito: false, mensaje: "Este ticket ya fue anulado anteriormente." };

      const detalles = db.prepare('SELECT * FROM detalle_ventas WHERE id_venta = ?').all(idLimpio);
      const fechaAhora = new Date().toISOString();
      const operador = sanitizarTextoSeguro(cajeroActivo || "Desconocido", 50);
      const motivoFinal = sanitizarTextoSeguro(motivoOpcional || `Anulado por autorización Admin (${operador})`, 140);

      for (const d of detalles) {
        db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(d.cantidad, d.id_producto);
        db.prepare('INSERT INTO kardex (fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)')
          .run(fechaAhora, d.id_producto, `Retorno Completo (Anulación ${idLimpio})`, d.cantidad, operador);
      }

      db.prepare("UPDATE ventas SET estado = 'Anulada', motivo_anulacion = ? WHERE id_venta = ?").run(motivoFinal, idLimpio);

      registrarEventoAuditoria(
        'ANULACION_TICKET',
        `Ticket ${idLimpio} ($${(parseFloat(v.total) || 0).toFixed(2)}) anulado. Motivo: ${motivoFinal}`,
        operador,
        IP_CLIENTE_ACTUAL,
        'CRITICO'
      );

      return { exito: true, mensaje: "Operación marcada como Anulada. Inventario restaurado en Kardex." };
    });
    return transaccion();
  },

  obtenerInventarioVisual: (pinAdmin) => {
    const credencial = pinAdmin || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      return [];
    }

    const productos = db.prepare('SELECT * FROM productos ORDER BY nombre ASC').all();
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    return productos.map(p => {
      let ofertaActiva = false;
      if (p.desc_valor > 0 && p.fecha_limite) {
        const limite = new Date(p.fecha_limite + 'T23:59:59');
        if (hoy <= limite) ofertaActiva = true;
      }
      return {
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria || "",
        costo: p.costo || 0,
        precio: p.precio,
        stock: p.stock,
        foto: p.foto || "",
        oferta: ofertaActiva
      };
    });
  },

  actualizarStock: (idProducto, nuevoStock, cajeroActivo, pinIngresado) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "No autorizado. Se requiere PIN de Administrador." };
    const idLimpio = (idProducto || '').toString().trim();
    const p = db.prepare('SELECT stock FROM productos WHERE id = ?').get(idLimpio);
    if (!p) return { exito: false, mensaje: "No se encontró el producto." };

    const stockNuevo = Math.max(0, parseFloat(nuevoStock) || 0);
    const diferencia = stockNuevo - (parseFloat(p.stock) || 0);

    db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(stockNuevo, idLimpio);
    if (diferencia !== 0) {
      const tipo = diferencia > 0 ? "Ajuste (Entrada)" : "Ajuste (Salida/Merma)";
      db.prepare('INSERT INTO kardex (fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), idLimpio, tipo, diferencia, sanitizarTextoSeguro(cajeroActivo || "Desconocido", 50));
    }
    return { exito: true, mensaje: "El stock se actualizó correctamente." };
  },

  guardarFondoInicialCorte: (fechaSeleccionada, cajeroFiltro, montoFondo, cajeroActivo, pinAdmin) => {
    const credencial = pinAdmin || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      return {
        exito: false,
        mensaje: "Acceso Denegado: Se requiere autorización de Administrador para fijar el fondo inicial de caja.",
        fondoBloqueado: false
      };
    }

    const fecha = (fechaSeleccionada || obtenerFechaYMD(new Date())).toString().trim();
    const monto = parseFloat(montoFondo) || 0;

    if (monto <= 0) {
      return {
        exito: false,
        mensaje: "Ingrese un monto mayor a $0.00 para fijar el fondo inicial.",
        fondoBloqueado: false
      };
    }

    const transaccionFondo = db.transaction(() => {
      const claveDiariaUnica = `FONDO_DIARIO_${fecha}`;
      const claveTodosLegacy = `FONDO_${fecha}_todos`;

      const existenteDiario = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(claveDiariaUnica);
      const existenteLegacy = db.prepare('SELECT valor FROM configuracion WHERE clave LIKE ?').all(`FONDO_${fecha}_%`);

      let montoExistente = 0;
      if (existenteDiario && parseFloat(existenteDiario.valor) > 0) {
        montoExistente = parseFloat(existenteDiario.valor);
      } else if (existenteLegacy.length > 0) {
        for (const f of existenteLegacy) {
          const val = parseFloat(f.valor) || 0;
          if (val > montoExistente) montoExistente = val;
        }
      }

      if (montoExistente > 0) {
        return {
          exito: false,
          mensaje: `El fondo inicial del día ${fecha} ($${montoExistente.toFixed(2)}) ya fue registrado anteriormente. Solo se permite establecer una vez por día.`,
          monto: montoExistente,
          fondoBloqueado: true
        };
      }

      const upsert = db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)');
      upsert.run(claveDiariaUnica, monto.toFixed(2));
      upsert.run(claveTodosLegacy, monto.toFixed(2));

      if (cajeroActivo && cajeroActivo !== 'Desconocido') {
        upsert.run(`FONDO_${fecha}_${cajeroActivo.toString().trim().toLowerCase()}`, monto.toFixed(2));
      }

      return {
        exito: true,
        monto: monto,
        fondoBloqueado: true,
        mensaje: `Fondo inicial de $${monto.toFixed(2)} fijado para el día ${fecha}.`
      };
    });

    const resultado = transaccionFondo();
    if (resultado.exito) {
      db.realizarRespaldoAutomatico();
    }
    return resultado;
  },

  obtenerDatosCorteDeCaja: (fechaSeleccionada, cajeroFiltro, pinAdmin) => {
    const credencial = pinAdmin || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      throw new Error("Acceso Denegado: Se requiere autorización de Administrador para consultar el Corte Z.");
    }
    return calcularResumenFinancieroInterno(fechaSeleccionada, cajeroFiltro);
  },

  registrarArqueoCiegoTurno: (efectivoContadoFisico, notasOpcional, pinSesion) => {
    const credencial = pinSesion || TOKEN_SESION_ACTUAL;
    const sesion = autenticarPinOToken(credencial, IP_CLIENTE_ACTUAL, false);
    if (!sesion.valido) {
      return { exito: false, mensaje: "Sesión no autorizada. Desbloquee la caja nuevamente." };
    }

    const declarado = parseFloat(efectivoContadoFisico);
    if (isNaN(declarado) || declarado < 0) {
      return { exito: false, mensaje: "Ingrese un monto de efectivo físico válido (mayor o igual a $0.00)." };
    }

    const hoyYMD = obtenerFechaYMD(new Date());
    const resumenGlobalHoy = calcularResumenFinancieroInterno(hoyYMD, 'Todos');
    const esperadoEnCajon = Number((parseFloat(resumenGlobalHoy.totalEnCajon) || 0).toFixed(2));
    const declaradoRedondeado = Number(declarado.toFixed(2));
    const diferencia = Number((declaradoRedondeado - esperadoEnCajon).toFixed(2));

    let estadoCuadre = 'CUADRADO';
    if (Math.abs(diferencia) >= 0.01) {
      estadoCuadre = diferencia < 0 ? 'FALTANTE' : 'SOBRANTE';
    }

    const notasLimpias = sanitizarTextoSeguro(notasOpcional || '', 160);

    db.prepare(`
      INSERT INTO arqueos_ciegos (fecha, fecha_ymd, cajero, efectivo_declarado, efectivo_esperado, diferencia, estado_cuadre, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      hoyYMD,
      sesion.nombreCajero,
      declaradoRedondeado,
      esperadoEnCajon,
      diferencia,
      estadoCuadre,
      notasLimpias
    );

    registrarEventoAuditoria(
      'ARQUEO_CIEGO_TURNO',
      `Operador '${sesion.nombreCajero}' declaró $${declaradoRedondeado.toFixed(2)} (${estadoCuadre}: ${diferencia >= 0 ? '+' : ''}$${diferencia.toFixed(2)})`,
      sesion.nombreCajero,
      IP_CLIENTE_ACTUAL,
      estadoCuadre === 'FALTANTE' ? 'ALERTA' : 'INFO'
    );

    return {
      exito: true,
      mensaje: `Entrega de turno registrada exitosamente por $${declaradoRedondeado.toFixed(2)}.\nEl reporte de cuadre ha sido enviado al Corte Z del Administrador.`
    };
  },

  exportarReporteContableCSV: (fechaFiltro, pinAdmin) => {
    const credencial = pinAdmin || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      return { exito: false, mensaje: "Se requiere autorización de Administrador para exportar el reporte contable con costos y utilidades." };
    }

    const ventas = db.prepare('SELECT * FROM ventas ORDER BY fecha DESC').all();
    const stmtDetalles = db.prepare(`
      SELECT d.cantidad, d.subtotal, COALESCE(p.nombre, 'Producto') as nombre, COALESCE(p.costo, 0) as costo
      FROM detalle_ventas d
      LEFT JOIN productos p ON d.id_producto = p.id
      WHERE d.id_venta = ?
    `);

    const escaparCeldaCSV = (val) => {
      let str = (val === null || val === undefined) ? '' : String(val);
      if (/^[=+\-@]/.test(str)) str = "'" + str;
      str = str.replace(/"/g, '""');
      return `"${str}"`;
    };

    const encabezados = [
      'Ticket ID',
      'Fecha y Hora',
      'Cliente',
      'Telefono',
      'Ref. Factura / DTE',
      'Modalidad de Pago',
      'Estado',
      'Operador',
      'Articulos Vendidos',
      'Descuento ($)',
      'Cargo Envio ($)',
      'Total Venta ($)',
      'Costo Mercaderia ($)',
      'Utilidad Bruta ($)'
    ];

    const lineasCSV = [encabezados.map(escaparCeldaCSV).join(',')];
    let conteoExportadas = 0;

    for (const v of ventas) {
      const fYMD = obtenerFechaYMD(v.fecha);
      if (fechaFiltro && fechaFiltro !== 'Todos' && fYMD !== fechaFiltro.trim()) continue;

      const items = stmtDetalles.all(v.id_venta);
      let costoTotalVenta = 0;
      const descArticulos = items.map(it => {
        const cant = parseFloat(it.cantidad) || 0;
        const costoU = parseFloat(it.costo) || 0;
        costoTotalVenta += (cant * costoU);
        return `${cant}x ${it.nombre}`;
      }).join(' | ');

      const totalV = parseFloat(v.total) || 0;
      const tarifaEnv = parseFloat(v.tarifa) || 0;
      const descV = parseFloat(v.descuento) || 0;
      const estadoStr = (v.estado || 'Pagado').toString();
      const esAnuladaOCortesia = estadoStr.toLowerCase() === 'anulada' || estadoStr.toLowerCase() === 'cortesía';
      const ventaNetaSinEnvio = esAnuladaOCortesia ? 0 : Math.max(0, totalV - tarifaEnv);
      const utilidadBruta = esAnuladaOCortesia ? 0 : (ventaNetaSinEnvio - costoTotalVenta);

      lineasCSV.push([
        v.id_venta,
        new Date(v.fecha).toLocaleString(),
        v.cliente || 'Cliente Mostrador',
        v.telefono || 'N/A',
        v.ref_fiscal || '',
        v.metodo_pago || 'Efectivo',
        estadoStr,
        v.cajero || 'N/A',
        descArticulos,
        descV.toFixed(2),
        tarifaEnv.toFixed(2),
        totalV.toFixed(2),
        (esAnuladaOCortesia ? 0 : costoTotalVenta).toFixed(2),
        utilidadBruta.toFixed(2)
      ].map(escaparCeldaCSV).join(','));

      conteoExportadas++;
    }

    const etiquetaFecha = (fechaFiltro && fechaFiltro !== 'Todos') ? fechaFiltro : obtenerFechaYMD(new Date());
    return {
      exito: true,
      nombreArchivo: `REPORTE_CONTABLE_POS_${etiquetaFecha}.csv`,
      contenidoCSV: '\uFEFF' + lineasCSV.join('\r\n'),
      totalRegistros: conteoExportadas
    };
  },

  obtenerBitacoraAuditoria: (pinAdmin, fechaFiltro) => {
    const credencial = pinAdmin || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      return [];
    }

    const filas = db.prepare('SELECT * FROM auditoria_seguridad ORDER BY id DESC LIMIT 600').all();
    const filtrarDia = Boolean(fechaFiltro && fechaFiltro !== 'Todos' && fechaFiltro.trim() !== '');
    const resultado = [];

    for (const f of filas) {
      const fYMD = obtenerFechaYMD(f.fecha);
      if (filtrarDia && fYMD !== fechaFiltro.trim()) continue;
      resultado.push({
        id: f.id,
        fecha: f.fecha ? new Date(f.fecha).toLocaleString() : '',
        fechaYMD: fYMD,
        evento: f.evento || '',
        detalle: f.detalle || '',
        usuario: f.usuario || 'Sistema',
        ip: f.ip || 'local',
        nivel: f.nivel || 'INFO'
      });
    }
    return resultado;
  },

  guardarProductoMaster: (prod, pinIngresado, cajeroActivo) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) {
      return { exito: false, mensaje: "No autorizado. Se requiere PIN de Administrador." };
    }
    const id = sanitizarTextoSeguro(prod.id, 60);
    const nombre = sanitizarTextoSeguro(prod.nombre, 140);
    if (!id || !nombre) return { exito: false, mensaje: "El Código y el Nombre son obligatorios." };

    const existente = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    const precio = Math.max(0, parseFloat(prod.precio) || 0);
    const costo = Math.max(0, parseFloat(prod.costo) || 0);
    const stock = Math.max(0, parseFloat(prod.stock) || 0);
    const categoria = sanitizarTextoSeguro(prod.categoria || '', 80);

    let fotoFinal = existente ? existente.foto : "";
    if (prod.foto !== undefined && prod.foto !== "") {
      if (prod.foto.startsWith('data:image')) {
        if (!validarBase64ImagenSegura(prod.foto)) {
          return { exito: false, mensaje: "La imagen del producto no es válida." };
        }
        fotoFinal = db.guardarImagenProductoEnDisco(id, prod.foto);
      } else {
        fotoFinal = prod.foto;
      }
    } else if (prod.foto === "") {
      fotoFinal = "";
    }

    if (existente) {
      const diferencia = stock - (parseFloat(existente.stock) || 0);
      db.prepare(`
        UPDATE productos SET nombre = ?, categoria = ?, costo = ?, precio = ?, stock = ?, foto = ?
        WHERE id = ?
      `).run(nombre, categoria, costo, precio, stock, fotoFinal, id);

      if (diferencia !== 0) {
        const tipo = diferencia > 0 ? "Edición Ficha (Entrada)" : "Edición Ficha (Salida)";
        db.prepare('INSERT INTO kardex (fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)')
          .run(new Date().toISOString(), id, tipo, diferencia, sanitizarTextoSeguro(cajeroActivo || "Admin", 50));
      }
    } else {
      db.prepare(`
        INSERT INTO productos (id, foto, nombre, categoria, precio, stock, costo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, fotoFinal, nombre, categoria, precio, stock, costo);

      if (stock > 0) {
        db.prepare('INSERT INTO kardex (fecha, id_producto, tipo_movimiento, cantidad, cajero) VALUES (?, ?, ?, ?, ?)')
          .run(new Date().toISOString(), id, "Inventario Inicial (Alta)", stock, sanitizarTextoSeguro(cajeroActivo || "Admin", 50));
      }
    }
    return { exito: true, mensaje: "Producto guardado correctamente." };
  },

  eliminarProductoMaster: (idProducto, pinIngresado) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "Se requiere PIN de Administrador." };
    const idLimpio = (idProducto || '').toString().trim();
    db.prepare('DELETE FROM productos WHERE id = ?').run(idLimpio);
    registrarEventoAuditoria('PRODUCTO_ELIMINADO', `ID Producto eliminado: ${idLimpio}`, 'Admin', IP_CLIENTE_ACTUAL, 'ALERTA');
    return { exito: true, mensaje: "Producto eliminado del catálogo." };
  },

  obtenerUsuariosMaster: (pinIngresado) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) return [];
    const filas = db.prepare('SELECT rowid, nombre, rol FROM usuarios ORDER BY rowid ASC').all();
    return filas.map((u, idx) => ({
      nombre: u.nombre,
      pin: idx === 0 && u.rol === 'admin' ? '👑 Super-Admin' : '•••• (Hash scrypt)',
      rol: u.rol
    }));
  },

  guardarUsuarioMaster: (userObj, pinIngresado) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "Se requiere PIN de Administrador." };
    const nombre = sanitizarTextoSeguro(userObj.nombre, 60);
    const pin = (userObj.pin || '').toString().trim().slice(0, 32);
    const rol = (userObj.rol || 'cajero').toString().trim().toLowerCase() === 'admin' ? 'admin' : 'cajero';
    if (!nombre || !pin) return { exito: false, mensaje: "Nombre y PIN son obligatorios." };
    if (/^ID-USR-/i.test(pin)) return { exito: false, mensaje: "Formato de PIN no permitido." };

    const pinHash = db.hashearPin(pin);
    const existenteNombre = db.prepare('SELECT rowid, pin FROM usuarios WHERE LOWER(nombre) = LOWER(?)').get(nombre);
    const todosUsuarios = db.prepare('SELECT rowid, nombre, pin, pin_hash FROM usuarios').all();
    const existentePin = todosUsuarios.find(u =>
      (u.pin_hash && compararHashSeguro(pin, u.pin_hash)) ||
      (!u.pin_hash && u.pin === pin)
    );

    if (existentePin && (!existenteNombre || existentePin.rowid !== existenteNombre.rowid)) {
      return {
        exito: false,
        mensaje: `Ese código PIN ya está asignado a '${existentePin.nombre}'. Por seguridad, cada operador debe tener un PIN único.`
      };
    }

    if (existenteNombre) {
      const idOcultoConservar = /^ID-USR-/i.test(existenteNombre.pin || '')
        ? existenteNombre.pin
        : `ID-USR-${existenteNombre.rowid}`;
      db.prepare('UPDATE usuarios SET nombre = ?, pin = ?, rol = ?, pin_hash = ? WHERE rowid = ?')
        .run(nombre, idOcultoConservar, rol, pinHash, existenteNombre.rowid);
    } else {
      const maxRow = db.prepare('SELECT COALESCE(MAX(rowid), 0) as maxId FROM usuarios').get();
      let siguienteNum = (maxRow ? maxRow.maxId : 0) + 1;
      let idOcultoNuevo = `ID-USR-${siguienteNum}`;
      const stmtExisteId = db.prepare('SELECT rowid FROM usuarios WHERE pin = ?');
      while (stmtExisteId.get(idOcultoNuevo)) {
        siguienteNum += 1;
        idOcultoNuevo = `ID-USR-${siguienteNum}`;
      }
      db.prepare('INSERT INTO usuarios (nombre, pin, rol, pin_hash) VALUES (?, ?, ?, ?)')
        .run(nombre, idOcultoNuevo, rol, pinHash);
    }

    registrarEventoAuditoria('USUARIO_GUARDADO', `Operador '${nombre}' (${rol}) creado/actualizado.`, 'Admin', IP_CLIENTE_ACTUAL, 'INFO');
    return { exito: true, mensaje: "Usuario guardado correctamente." };
  },

  eliminarUsuarioMaster: (identificadorBorrar, pinIngresado) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) return { exito: false, mensaje: "Se requiere PIN de Administrador." };
    const idLimpio = (identificadorBorrar || '').toString().trim();
    const duenoPrincipal = db.prepare("SELECT rowid, nombre FROM usuarios WHERE LOWER(rol) = 'admin' ORDER BY rowid ASC LIMIT 1").get();
    const target = db.prepare('SELECT rowid, nombre, pin, rol FROM usuarios WHERE nombre = ? OR pin = ?').get(idLimpio, idLimpio);
    if (!target) return { exito: false, mensaje: "Usuario no encontrado." };

    if (duenoPrincipal && target.rowid === duenoPrincipal.rowid) {
      return { exito: false, mensaje: "No se puede eliminar al Dueño Principal (Super-Admin #1) del sistema." };
    }
    db.prepare('DELETE FROM usuarios WHERE rowid = ?').run(target.rowid);
    registrarEventoAuditoria('USUARIO_ELIMINADO', `Operador '${target.nombre}' eliminado.`, 'Admin', IP_CLIENTE_ACTUAL, 'ALERTA');
    return { exito: true, mensaje: "Usuario eliminado." };
  },

  obtenerKardex: (pinIngresado, fechaFiltro) => {
    const credencial = pinIngresado || TOKEN_SESION_ACTUAL;
    if (!funcionesPOS.validarPin(credencial, IP_CLIENTE_ACTUAL)) return [];

    const filas = db.prepare(`
      SELECT k.id, k.fecha, k.id_producto, p.nombre as nombre_producto, k.tipo_movimiento, k.cantidad, k.cajero
      FROM kardex k
      LEFT JOIN productos p ON k.id_producto = p.id
      ORDER BY k.id DESC
    `).all();

    const resultado = [];
    const filtrarPorDia = (fechaFiltro && fechaFiltro !== "Todos" && fechaFiltro.trim() !== "");

    for (const f of filas) {
      const fechaYMD = obtenerFechaYMD(f.fecha);
      if (filtrarPorDia && fechaYMD !== fechaFiltro.trim()) continue;

      resultado.push({
        id: f.id,
        fecha: new Date(f.fecha).toLocaleString(),
        fechaISO: f.fecha,
        fechaYMD: fechaYMD,
        idProducto: f.id_producto,
        nombreProducto: f.nombre_producto || "Producto Eliminado",
        tipo: f.tipo_movimiento,
        cantidad: f.cantidad,
        cajero: f.cajero || "Desconocido"
      });

      if (!filtrarPorDia && resultado.length >= 500) break;
    }

    return resultado;
  }
};

// ============================================================================
// 6. RUTAS EXPRESS, DESCARGA DE CERTIFICADO PARA IPHONE Y ESCUDO /api/ejecutar
// ============================================================================
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'Index.html'));
});

app.get('/instalar-certificado', (req, res) => {
  const dirCerts = db.dirCerts || path.join(__dirname, 'certs');
  const certPath = path.join(dirCerts, 'pos_server_v2.crt');
  if (!fs.existsSync(certPath)) {
    return res.status(404).send('Certificado aún no generado.');
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="POS-Local-Server.crt"');
  res.sendFile(certPath);
});

const FUNCIONES_PUBLICAS_PRE_LOGIN = new Set([
  'validarPinAcceso',
  'cerrarSesionToken',
  'obtenerDisenoImpresion',
  'obtenerEstadoLicencia',
  'activarLicenciaSistema'
]);

const FUNCIONES_PERMITIDAS_SIN_LICENCIA = new Set([
  'obtenerEstadoLicencia',
  'activarLicenciaSistema',
  'obtenerDisenoImpresion',
  'cerrarSesionToken'
]);

const FUNCIONES_PAYLOAD_GRANDE = new Set([
  'guardarProductoMaster',
  'guardarDisenoImpresion',
  'restaurarBovedaDatos',
  'inspeccionarBovedaDatos'
]);

const FUNCIONES_CON_IP_CLIENTE = new Set([
  'validarPinAcceso',
  'validarPin',
  'exportarBovedaDatos',
  'limpiarBaseDatosMaestra',
  'restaurarBovedaDatos',
  'inspeccionarBovedaDatos'
]);

app.post('/api/ejecutar', (req, res) => {
  limpiarObjetoInyeccion(req.body);

  const { funcion, argumentos } = req.body || {};
  const ipCliente = (req.socket && req.socket.remoteAddress) || req.ip || 'local';
  const pinHeader = (req.headers['x-pos-pin'] || '').toString().trim();
  IP_CLIENTE_ACTUAL = ipCliente;
  TOKEN_SESION_ACTUAL = pinHeader;

  try {
    if (!funcion || typeof funcion !== 'string' || !Object.prototype.hasOwnProperty.call(funcionesPOS, funcion)) {
      return res.status(400).json({ error: 'Operación no permitida.' });
    }

    const tamanoBody = parseInt(req.headers['content-length'] || '0', 10);
    if (tamanoBody > 102400 && !FUNCIONES_PAYLOAD_GRANDE.has(funcion)) {
      return res.status(413).json({ error: 'Tamaño de solicitud excedido.' });
    }

    if (!FUNCIONES_PERMITIDAS_SIN_LICENCIA.has(funcion)) {
      const estadoLic = evaluarEstadoLicenciaActual();
      if (estadoLic.bloqueado) {
        return res.status(402).json({
          error: estadoLic.mensaje || 'Licencia vencida o suspendida en este equipo.',
          licenciaBloqueada: true,
          estadoLicencia: estadoLic
        });
      }
    }

    if (!FUNCIONES_PUBLICAS_PRE_LOGIN.has(funcion)) {
      if (!pinHeader) {
        return res.status(401).json({ error: 'Sesión no autorizada. Ingrese su PIN.' });
      }
      const sesionActiva = autenticarPinOToken(pinHeader, ipCliente, false);
      if (!sesionActiva.valido) {
        return res.status(401).json({ error: 'Sesión expirada o no autorizada.' });
      }
    }

    const args = Array.isArray(argumentos) ? [...argumentos] : [];
    if (FUNCIONES_CON_IP_CLIENTE.has(funcion)) {
      args.push(ipCliente);
    }

    const resultado = funcionesPOS[funcion](...args);
    res.json({ resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 7. GESTOR INTELIGENTE DE CERTIFICADOS SSL (TAILSCALE OFICIAL + CA LOCAL FIJA)
// ============================================================================
function obtenerDireccionesIP() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips.length > 0 ? ips : ['127.0.0.1'];
}

function derLength(len) {
  if (len < 128) return Buffer.from([len]);
  const hex = len.toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  const bytes = Buffer.from(padded, 'hex');
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}

function derNode(tag, contentBuffer) {
  return Buffer.concat([Buffer.from([tag]), derLength(contentBuffer.length), contentBuffer]);
}

function derSeq(items) {
  return derNode(0x30, Buffer.concat(items));
}

function derSet(items) {
  return derNode(0x31, Buffer.concat(items));
}

function derInteger(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  while (b.length > 1 && b[0] === 0x00 && (b[1] & 0x80) === 0) {
    b = b.subarray(1);
  }
  if (b[0] & 0x80) {
    b = Buffer.concat([Buffer.from([0x00]), b]);
  }
  return derNode(0x02, b);
}

function derBitString(buf) {
  return derNode(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derOctetString(buf) {
  return derNode(0x04, buf);
}

function derOid(hexStr) {
  return derNode(0x06, Buffer.from(hexStr, 'hex'));
}

function derUtf8String(str) {
  return derNode(0x0c, Buffer.from(str, 'utf8'));
}

function derUtcTime(str) {
  return derNode(0x17, Buffer.from(str, 'ascii'));
}

function generarCertificadoNativoNode(listaIPs, dominioExtra) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const version = derNode(0xa0, derInteger(Buffer.from([0x02])));
  const serial = derInteger(crypto.randomBytes(12));
  const algId = derSeq([derOid('2a864886f70d01010b'), Buffer.from([0x05, 0x00])]);

  const issuer = derSeq([
    derSet([derSeq([derOid('550403'), derUtf8String('POS-Local-Server')])])
  ]);

  const validity = derSeq([
    derUtcTime('250101000000Z'),
    derUtcTime('361231235959Z')
  ]);

  const sanItems = [
    derNode(0x82, Buffer.from('localhost', 'ascii')),
    derNode(0x87, Buffer.from([127, 0, 0, 1]))
  ];

  if (dominioExtra) {
    sanItems.push(derNode(0x82, Buffer.from(dominioExtra, 'ascii')));
  }

  for (const ip of listaIPs) {
    const partes = ip.split('.').map(n => parseInt(n, 10));
    if (partes.length === 4 && partes.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
      sanItems.push(derNode(0x87, Buffer.from(partes)));
    }
  }

  const extBasicConstraints = derSeq([
    derOid('551d13'),
    Buffer.from([0x01, 0x01, 0xff]),
    derOctetString(derSeq([Buffer.from([0x01, 0x01, 0xff])]))
  ]);

  const extSubjectAltName = derSeq([
    derOid('551d11'),
    derOctetString(derSeq(sanItems))
  ]);

  const extensions = derNode(0xa3, derSeq([extBasicConstraints, extSubjectAltName]));

  const tbsCertificate = derSeq([
    version,
    serial,
    algId,
    issuer,
    validity,
    issuer,
    publicKey,
    extensions
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certDer = derSeq([tbsCertificate, algId, derBitString(signature)]);

  const base64Lines = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${base64Lines}\n-----END CERTIFICATE-----\n`;

  return { key: privateKey, cert: certPem };
}

function intentarObtenerCertificadoTailscale(dirCerts) {
  try {
    const salidaJson = execSync('tailscale status --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3500
    });
    const status = JSON.parse(salidaJson);
    let dnsName = (status && status.Self && status.Self.DNSName) ? status.Self.DNSName : '';
    if (dnsName.endsWith('.')) dnsName = dnsName.slice(0, -1);
    if (!dnsName) return null;

    const tsCertPath = path.join(dirCerts, `${dnsName}.crt`);
    const tsKeyPath = path.join(dirCerts, `${dnsName}.key`);

    if (!fs.existsSync(tsCertPath) || !fs.existsSync(tsKeyPath)) {
      execSync(`tailscale cert --cert-file "${tsCertPath}" --key-file "${tsKeyPath}" ${dnsName}`, {
        cwd: dirCerts,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 12000
      });
    }

    if (fs.existsSync(tsCertPath) && fs.existsSync(tsKeyPath)) {
      return {
        key: fs.readFileSync(tsKeyPath),
        cert: fs.readFileSync(tsCertPath),
        dominioTailscale: dnsName,
        esOficialTailscale: true
      };
    }
  } catch (e) {}

  try {
    const archivos = fs.readdirSync(dirCerts);
    const crtTs = archivos.find(f => f.endsWith('.ts.net.crt'));
    if (crtTs) {
      const base = crtTs.replace(/\.crt$/, '');
      const keyTs = `${base}.key`;
      if (fs.existsSync(path.join(dirCerts, keyTs))) {
        return {
          key: fs.readFileSync(path.join(dirCerts, keyTs)),
          cert: fs.readFileSync(path.join(dirCerts, crtTs)),
          dominioTailscale: base,
          esOficialTailscale: true
        };
      }
    }
  } catch (e) {}

  return null;
}

function asegurarCertificadoSSL(listaIPs) {
  const dirCerts = db.dirCerts || path.join(__dirname, 'certs');
  if (!fs.existsSync(dirCerts)) {
    fs.mkdirSync(dirCerts, { recursive: true });
  }

  const certTailscale = intentarObtenerCertificadoTailscale(dirCerts);
  if (certTailscale) {
    return certTailscale;
  }

  const keyPath = path.join(dirCerts, 'pos_server_v2.key');
  const certPath = path.join(dirCerts, 'pos_server_v2.crt');
  const ipsPath = path.join(dirCerts, 'pos_ips.json');

  const firmaIPsActual = JSON.stringify(listaIPs.slice().sort());

  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(ipsPath)) {
      const firmaGuardada = fs.readFileSync(ipsPath, 'utf8');
      if (firmaGuardada === firmaIPsActual) {
        return {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
          dominioTailscale: null,
          esOficialTailscale: false
        };
      }
    }

    const generado = generarCertificadoNativoNode(listaIPs, null);
    fs.writeFileSync(keyPath, generado.key);
    fs.writeFileSync(certPath, generado.cert);
    fs.writeFileSync(ipsPath, firmaIPsActual);
    return {
      key: generado.key,
      cert: generado.cert,
      dominioTailscale: null,
      esOficialTailscale: false
    };
  } catch (err) {
    console.error("Error gestionando certificado SSL:", err.message);
    return null;
  }
}

function aplicarBlindajeTimeouts(servidor) {
  servidor.headersTimeout = 15000;
  servidor.requestTimeout = 20000;
  servidor.keepAliveTimeout = 5000;
  servidor.on('connection', (socket) => {
    const ipRemota = socket.remoteAddress || '';
    if (!esIPAutorizadaRedPrivada(ipRemota)) {
      socket.destroy();
    }
  });
}

const PUERTO_HTTP = 3000;
const PUERTO_HTTPS = 3443;
const listaIPsActivas = obtenerDireccionesIP();
const estadoLicenciaArranque = evaluarEstadoLicenciaActual();

const servidorHTTP = http.createServer(app);
aplicarBlindajeTimeouts(servidorHTTP);

servidorHTTP.listen(PUERTO_HTTP, '0.0.0.0', () => {
  console.log(`=============================================================`);
  console.log(`🛡️  PROGRAMA POS ACTIVO Y BLINDADO (FIREWALL LAN + TAILSCALE)`);
  console.log(`🔑 Hardware ID de este Equipo: ${estadoLicenciaArranque.hardwareId}`);
  console.log(`📅 Estado de Licencia:         ${estadoLicenciaArranque.activa ? 'ACTIVA (Vence: ' + estadoLicenciaArranque.fechaVencimiento + ')' : 'BLOQUEADA (' + estadoLicenciaArranque.motivoBloqueo + ')'}`);
  console.log(`💻 En esta PC:                 http://localhost:${PUERTO_HTTP}`);
  listaIPsActivas.forEach(ip => {
    console.log(`🌐 Red / Tailscale:            http://${ip}:${PUERTO_HTTP}`);
  });

  const credencialesSSL = asegurarCertificadoSSL(listaIPsActivas);
  if (credencialesSSL) {
    try {
      const servidorHTTPS = https.createServer({ key: credencialesSSL.key, cert: credencialesSSL.cert }, app);
      aplicarBlindajeTimeouts(servidorHTTPS);
      servidorHTTPS.listen(PUERTO_HTTPS, '0.0.0.0', () => {
        console.log(`-------------------------------------------------------------`);
        console.log(`📱 CÁMARA EN VIVO IPHONE (HTTPS ACTIVO EN PUERTO ${PUERTO_HTTPS}):`);
        if (credencialesSSL.dominioTailscale) {
          console.log(`✅ Dominio Oficial Tailscale (Sin aviso de seguridad):`);
          console.log(`🔒 En iPhone abre:             https://${credencialesSSL.dominioTailscale}:${PUERTO_HTTPS}`);
        }
        listaIPsActivas.forEach(ip => {
          console.log(`🔒 Por IP directa:             https://${ip}:${PUERTO_HTTPS}`);
        });
        console.log(`📲 Para quitar aviso en IP, abre una vez en iPhone: http://${listaIPsActivas[0]}:${PUERTO_HTTP}/instalar-certificado`);
        console.log(`=============================================================`);
      });
    } catch (err) {
      console.error("Error iniciando puerto HTTPS 3443:", err.message);
      console.log(`=============================================================`);
    }
  } else {
    console.log(`=============================================================`);
  }
});