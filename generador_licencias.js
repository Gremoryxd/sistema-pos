/**
 * GENERADOR MAESTRO DE LICENCIAS Y SUSCRIPCIONES POS (EXCLUSIVO PARA EL DUEÑO / DESARROLLADOR)
 * Soporta Firma Criptográfica Híbrida (HMAC-SHA256 + Llave Asimétrica Ed25519)
 * y registro automático en el Panel de Control de Suscripciones.
 *
 * Formas de uso:
 * 1) Interactivo: node generador_licencias.js
 * 2) Directo:     node generador_licencias.js POS-SV-4F2A-91C0-B7E3 2026-11-25 "Tienda El Sol" [ID_CLIENTE_OPCIONAL]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SECRETO_MAESTRO_LICENCIA_SV = 'POS_MASTER_SV_FERNANDO_2026_ULTRA_SECRET_KEY_9981';
const dirCerts = path.join(__dirname, 'certs');
const rutaLlavePrivadaEd25519 = path.join(__dirname, 'llave_privada_ed25519.pem');
const rutaLlavePublicaEd25519 = path.join(dirCerts, 'pos_ed25519_pub.pem');

function asegurarLlavesEd25519() {
  try {
    if (!fs.existsSync(dirCerts)) {
      fs.mkdirSync(dirCerts, { recursive: true });
    }

    if (fs.existsSync(rutaLlavePrivadaEd25519)) {
      const privPem = fs.readFileSync(rutaLlavePrivadaEd25519, 'utf8');
      if (!fs.existsSync(rutaLlavePublicaEd25519)) {
        const pubObj = crypto.createPublicKey(privPem);
        const pubPem = pubObj.export({ type: 'spki', format: 'pem' });
        fs.writeFileSync(rutaLlavePublicaEd25519, pubPem, 'utf8');
      }
      return {
        privateKeyPem: privPem,
        publicKeyPem: fs.readFileSync(rutaLlavePublicaEd25519, 'utf8')
      };
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    fs.writeFileSync(rutaLlavePrivadaEd25519, privateKey, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(rutaLlavePublicaEd25519, publicKey, 'utf8');

    return { privateKeyPem: privateKey, publicKeyPem: publicKey };
  } catch (e) {
    return { privateKeyPem: null, publicKeyPem: null };
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

  const llaves = asegurarLlavesEd25519();
  if (llaves && llaves.privateKeyPem) {
    try {
      const firmaEd25519 = crypto.sign(null, Buffer.from(base64Payload, 'utf8'), llaves.privateKeyPem).toString('base64url');
      return `POSLIC-${base64Payload}.${firmaHex}.${firmaEd25519}`;
    } catch (e) {}
  }

  return `POSLIC-${base64Payload}.${firmaHex}`;
}

function registrarEnBaseDatosLocalSiExiste(hwid, fechaVenc, cliente, tipo, token, idClienteManual) {
  try {
    const rutaDbModulo = path.join(__dirname, 'database.js');
    if (!fs.existsSync(rutaDbModulo)) return null;

    const db = require('./database');
    const hwidUpper = hwid.toUpperCase();
    const existente = db.prepare('SELECT id_cliente, monto_mensual FROM suscripciones_clientes WHERE UPPER(hardware_id) = ?').get(hwidUpper);
    const idClienteFinal = idClienteManual
      ? String(idClienteManual).trim().toUpperCase()
      : (existente ? existente.id_cliente : `CLI-${hwidUpper.replace(/^POS-SV-/, '').slice(0, 9)}`);

    const montoMensual = existente ? (parseFloat(existente.monto_mensual) || 25) : 25;

    db.prepare(`
      INSERT OR REPLACE INTO suscripciones_clientes
      (id_cliente, nombre_negocio, hardware_id, estado_manual, fecha_vencimiento, plan, monto_mensual, motivo_suspension, token_licencia, ultima_conexion)
      VALUES (?, ?, ?, 'ACTIVO', ?, ?, ?, '', ?, ?)
    `).run(
      idClienteFinal,
      cliente,
      hwidUpper,
      fechaVenc,
      tipo,
      montoMensual,
      token,
      new Date().toISOString()
    );

    if (typeof db.registrarAuditoria === 'function') {
      db.registrarAuditoria(
        'LICENCIA_EMITIDA',
        `Licencia ${tipo} generada para ${cliente} (${hwidUpper}) vence ${fechaVenc}`,
        'Generador Maestro',
        'local',
        'INFO'
      );
    }

    return idClienteFinal;
  } catch (e) {
    return null;
  }
}

function mostrarResultado(hwid, fechaVenc, cliente, idClienteOpcional) {
  const tipo = fechaVenc.startsWith('2099') ? 'PERMANENTE' : 'MENSUAL';
  const token = firmarPayloadLicencia({
    hwid: hwid,
    cliente: cliente,
    vencimiento: fechaVenc,
    tipo: tipo,
    idCliente: idClienteOpcional
  });

  const idRegistrado = registrarEnBaseDatosLocalSiExiste(hwid, fechaVenc, cliente, tipo, token, idClienteOpcional);

  console.log("\n=============================================================");
  console.log("✅ ¡LICENCIA COMERCIAL GENERADA CON ÉXITO! (HMAC + Ed25519)");
  console.log("=============================================================");
  console.log("Cliente / Negocio : " + cliente);
  console.log("Hardware ID       : " + hwid.toUpperCase());
  if (idRegistrado) {
    console.log("ID Suscripción BD : " + idRegistrado + " (Sincronizado en Panel de Suscripciones)");
  }
  console.log("Modalidad         : " + tipo);
  console.log("Fecha Vencimiento : " + fechaVenc + " (El aviso saldrá 5 días antes)");
  console.log("-------------------------------------------------------------");
  console.log("CÓDIGO DE ACTIVACIÓN (Copia y envía por WhatsApp al cliente):\n");
  console.log(token);
  console.log("\n=============================================================\n");
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length >= 2) {
    const hwidArg = args[0].trim().toUpperCase();
    const fechaArg = args[1].trim();
    const clienteArg = args[2] ? args[2].trim() : "Cliente Comercial POS";
    const idCliArg = args[3] ? args[3].trim() : "";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaArg)) {
      console.error("❌ Error: La fecha de vencimiento debe tener formato YYYY-MM-DD (Ej. 2026-11-25 o 2099-12-31).");
      process.exit(1);
    }
    mostrarResultado(hwidArg, fechaArg, clienteArg, idCliArg);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n=============================================================");
    console.log("🔑 GENERADOR INTERACTIVO DE LICENCIAS Y SUSCRIPCIONES POS");
    console.log("=============================================================");

    rl.question("1. Pega el Hardware ID del cliente (Ej. POS-SV-XXXX-XXXX-XXXX): ", (hwid) => {
      const hwidLimpio = (hwid || '').trim().toUpperCase();
      if (!hwidLimpio) {
        console.error("❌ El Hardware ID es obligatorio.");
        rl.close();
        return;
      }

      const sugerenciaMes = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const y = sugerenciaMes.getFullYear();
      const m = String(sugerenciaMes.getMonth() + 1).padStart(2, '0');
      const d = String(sugerenciaMes.getDate()).padStart(2, '0');
      const fechaSugerida = `${y}-${m}-${d}`;

      rl.question(`2. Fecha de vencimiento YYYY-MM-DD [Enter para +30 días: ${fechaSugerida}, o escribe 2099-12-31 para Permanente]: `, (fecha) => {
        const fechaFinal = (fecha || '').trim() || fechaSugerida;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaFinal)) {
          console.error("❌ Formato de fecha inválido. Usa YYYY-MM-DD.");
          rl.close();
          return;
        }

        rl.question("3. Nombre del Negocio / Cliente: ", (cliente) => {
          const clienteFinal = (cliente || '').trim() || "Cliente Comercial POS";
          mostrarResultado(hwidLimpio, fechaFinal, clienteFinal, "");
          rl.close();
        });
      });
    });
  }
}

module.exports = {
  firmarPayloadLicencia,
  asegurarLlavesEd25519
};