const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'pos_tienda.db');
const db = new Database(dbPath);

// Optimización de concurrencia, tiempo de espera ante bloqueos y rendimiento en SQLite
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Crear carpetas para respaldos automáticos, fotos físicas, certificados SSL y librerías Offline
const dirBackups = path.join(__dirname, 'backups');
const dirFotos = path.join(__dirname, 'public', 'fotos');
const dirLibsOffline = path.join(__dirname, 'public', 'libs');
const dirCerts = path.join(__dirname, 'certs');

[dirBackups, dirFotos, dirLibsOffline, dirCerts].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Función legacy SHA-256 para migración transparente sin bloquear cuentas existentes
function hashearPinLegacySHA256(pinTexto) {
  const limpio = (pinTexto || '').toString().trim();
  return crypto.createHash('sha256').update(`POS_SALT_SV_${limpio}`).digest('hex');
}

// Función principal reforzada con derivación lenta scrypt (protección contra fuerza bruta offline)
function hashearPin(pinTexto) {
  const limpio = (pinTexto || '').toString().trim();
  return crypto.scryptSync(`POS_PEPPER_SV_2026_${limpio}`, 'POS_SCRYPT_SALT_SV_V2', 32).toString('hex');
}

// Comparación criptográfica en tiempo constante compatible con scrypt (actual) y SHA-256 (anterior)
function compararPinSeguro(pinTexto, hashAlmacenado) {
  if (!pinTexto || !hashAlmacenado || typeof hashAlmacenado !== 'string') return false;
  const hashLimpio = hashAlmacenado.trim();
  try {
    const bufAlmacenado = Buffer.from(hashLimpio, 'hex');
    if (bufAlmacenado.length === 0) return false;

    // 1. Probar con hash scrypt reforzado
    const hashScrypt = hashearPin(pinTexto);
    const bufScrypt = Buffer.from(hashScrypt, 'hex');
    if (bufScrypt.length === bufAlmacenado.length && crypto.timingSafeEqual(bufScrypt, bufAlmacenado)) {
      return true;
    }

    // 2. Fallback en tiempo constante para hashes SHA-256 previos antes de migrar
    const hashLegacy = hashearPinLegacySHA256(pinTexto);
    const bufLegacy = Buffer.from(hashLegacy, 'hex');
    if (bufLegacy.length === bufAlmacenado.length && crypto.timingSafeEqual(bufLegacy, bufAlmacenado)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Creación de tablas principales, auditoría, arqueo ciego y control de suscripciones
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    nombre TEXT,
    pin TEXT PRIMARY KEY,
    rol TEXT DEFAULT 'cajero',
    pin_hash TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS productos (
    id TEXT PRIMARY KEY,
    foto TEXT DEFAULT '',
    nombre TEXT NOT NULL,
    categoria TEXT DEFAULT '',
    precio REAL DEFAULT 0,
    stock REAL DEFAULT 0,
    costo REAL DEFAULT 0,
    desc_valor REAL DEFAULT 0,
    desc_tipo TEXT DEFAULT '%',
    fecha_limite TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS clientes (
    telefono TEXT PRIMARY KEY,
    nombre TEXT,
    direccion TEXT
  );

  CREATE TABLE IF NOT EXISTS ventas (
    id_venta TEXT PRIMARY KEY,
    fecha TEXT,
    total REAL,
    cliente TEXT,
    telefono TEXT,
    direccion TEXT,
    metodo_pago TEXT,
    descuento REAL,
    cajero TEXT,
    estado TEXT,
    repartidor TEXT,
    tarifa REAL,
    anticipo REAL,
    ref_fiscal TEXT DEFAULT '',
    motivo_anulacion TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS detalle_ventas (
    id_detalle TEXT PRIMARY KEY,
    id_venta TEXT,
    id_producto TEXT,
    cantidad REAL,
    subtotal REAL
  );

  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    concepto TEXT,
    monto REAL,
    cajero TEXT
  );

  CREATE TABLE IF NOT EXISTS kardex (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    id_producto TEXT,
    tipo_movimiento TEXT,
    cantidad REAL,
    cajero TEXT
  );

  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS auditoria_seguridad (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    evento TEXT,
    detalle TEXT,
    usuario TEXT,
    ip TEXT,
    nivel TEXT DEFAULT 'INFO'
  );

  CREATE TABLE IF NOT EXISTS arqueos_ciegos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    fecha_ymd TEXT,
    cajero TEXT,
    efectivo_declarado REAL DEFAULT 0,
    efectivo_esperado REAL DEFAULT 0,
    diferencia REAL DEFAULT 0,
    estado_cuadre TEXT DEFAULT '',
    notas TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS suscripciones_clientes (
    id_cliente TEXT PRIMARY KEY,
    nombre_negocio TEXT NOT NULL,
    hardware_id TEXT DEFAULT '',
    estado_manual TEXT DEFAULT 'ACTIVO',
    fecha_vencimiento TEXT DEFAULT '',
    plan TEXT DEFAULT 'MENSUAL',
    monto_mensual REAL DEFAULT 0,
    motivo_suspension TEXT DEFAULT '',
    token_licencia TEXT DEFAULT '',
    ultima_conexion TEXT DEFAULT ''
  );
`);

// Migración segura: agregar columna pin_hash si la tabla usuarios ya existía de antes
try {
  const columnasUsuarios = db.prepare("PRAGMA table_info(usuarios)").all();
  const tienePinHash = columnasUsuarios.some(c => c.name === 'pin_hash');
  if (!tienePinHash) {
    db.exec("ALTER TABLE usuarios ADD COLUMN pin_hash TEXT DEFAULT ''");
  }
} catch (e) {
  console.error("Error verificando columna pin_hash:", e.message);
}

// Migración segura: agregar columnas ref_fiscal y motivo_anulacion en ventas para blindaje legal en El Salvador
try {
  const columnasVentas = db.prepare("PRAGMA table_info(ventas)").all();
  const tieneRefFiscal = columnasVentas.some(c => c.name === 'ref_fiscal');
  if (!tieneRefFiscal) {
    db.exec("ALTER TABLE ventas ADD COLUMN ref_fiscal TEXT DEFAULT ''");
  }
  const tieneMotivoAnulacion = columnasVentas.some(c => c.name === 'motivo_anulacion');
  if (!tieneMotivoAnulacion) {
    db.exec("ALTER TABLE ventas ADD COLUMN motivo_anulacion TEXT DEFAULT ''");
  }
} catch (e) {
  console.error("Error verificando columnas legales en ventas:", e.message);
}

// Creación de índices para acelerar consultas por fecha, cajero, productos y auditoría
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_productos_nombre ON productos(nombre);
  CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
  CREATE INDEX IF NOT EXISTS idx_ventas_cajero ON ventas(cajero);
  CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado);
  CREATE INDEX IF NOT EXISTS idx_detalle_id_venta ON detalle_ventas(id_venta);
  CREATE INDEX IF NOT EXISTS idx_detalle_id_producto ON detalle_ventas(id_producto);
  CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
  CREATE INDEX IF NOT EXISTS idx_kardex_fecha ON kardex(fecha);
  CREATE INDEX IF NOT EXISTS idx_kardex_producto ON kardex(id_producto);
  CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria_seguridad(fecha);
  CREATE INDEX IF NOT EXISTS idx_arqueos_fecha_ymd ON arqueos_ciegos(fecha_ymd);
  CREATE INDEX IF NOT EXISTS idx_suscripciones_hwid ON suscripciones_clientes(hardware_id);
`);

// Insertar usuarios iniciales con scrypt sin PIN en texto plano o migrar automáticamente PINs existentes
const conteoUsuarios = db.prepare('SELECT COUNT(*) as total FROM usuarios').get();
if (conteoUsuarios.total === 0) {
  const insertarUser = db.prepare('INSERT INTO usuarios (nombre, pin, rol, pin_hash) VALUES (?, ?, ?, ?)');
  insertarUser.run('Admin / Dueño', 'ID-USR-1', 'admin', hashearPin('0000'));
  insertarUser.run('Empleado 1', 'ID-USR-2', 'cajero', hashearPin('1111'));
  insertarUser.run('Empleado 2', 'ID-USR-3', 'cajero', hashearPin('2222'));
} else {
  try {
    const todosUsuarios = db.prepare('SELECT rowid, nombre, pin, rol, pin_hash FROM usuarios ORDER BY rowid ASC').all();
    const stmtUpdUsuario = db.prepare('UPDATE usuarios SET pin = ?, pin_hash = ? WHERE rowid = ?');
    const stmtColisionId = db.prepare('SELECT rowid FROM usuarios WHERE pin = ? AND rowid != ?');

    const migrarUsuariosTx = db.transaction((lista) => {
      for (const u of lista) {
        const pinActual = (u.pin || '').toString().trim();
        const esIdentificadorOculto = /^ID-USR-\d+/i.test(pinActual);
        let hashFinal = (u.pin_hash || '').toString().trim();

        if (!hashFinal && !esIdentificadorOculto && pinActual) {
          hashFinal = hashearPin(pinActual);
        }

        if (!esIdentificadorOculto || !u.pin_hash) {
          let nuevoIdOculto = esIdentificadorOculto ? pinActual : `ID-USR-${u.rowid}`;
          if (stmtColisionId.get(nuevoIdOculto, u.rowid)) {
            nuevoIdOculto = `ID-USR-${u.rowid}-${crypto.randomInt(100, 999)}`;
          }
          stmtUpdUsuario.run(nuevoIdOculto, hashFinal, u.rowid);
        }
      }
    });

    migrarUsuariosTx(todosUsuarios);
  } catch (e) {
    console.error("Error en migración de seguridad de PINs:", e.message);
  }
}

// Función para registrar eventos en la Bitácora de Auditoría de Seguridad (mantiene máximo 2500 registros)
function registrarAuditoria(evento, detalle, usuario, ip, nivel = 'INFO') {
  try {
    db.prepare(`
      INSERT INTO auditoria_seguridad (fecha, evento, detalle, usuario, ip, nivel)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      String(evento || 'EVENTO').slice(0, 80),
      String(detalle || '').slice(0, 300),
      String(usuario || 'Sistema').slice(0, 60),
      String(ip || 'local').slice(0, 50),
      String(nivel || 'INFO').toUpperCase().slice(0, 20)
    );

    const conteo = db.prepare('SELECT COUNT(*) as c FROM auditoria_seguridad').get();
    if (conteo && conteo.c > 2500) {
      db.prepare(`
        DELETE FROM auditoria_seguridad
        WHERE id IN (SELECT id FROM auditoria_seguridad ORDER BY id ASC LIMIT 300)
      `).run();
    }
  } catch (e) {}
}

// Configuración por defecto para el Diseño de Ticket, Blindaje Legal (El Salvador) y Guías de Envío
const DISENO_IMPRESION_DEFECTO = {
  nombreTienda: "MI TIENDA",
  subtituloTienda: "Comprobante de Control Interno",
  nitTienda: "",
  telefonoTienda: "",
  direccionTienda: "",
  redesTienda: "",
  fraseTicket: "Gracias por su preferencia.",
  politicaTicket: "Cambios o reclamos únicamente presentando este comprobante.",
  leyendaLegalTicket: "DOCUMENTO EXCLUSIVO DE CONTROL INTERNO DE INVENTARIO. NO TIENE VALIDEZ FISCAL NI SUSTITUYE FACTURA O DOCUMENTO TRIBUTARIO ELECTRÓNICO (DTE).",
  notaLegalPieSistema: "Software de Control Interno Administrativo de Inventario y Caja. La emisión de DTE / Facturas oficiales ante el Ministerio de Hacienda es responsabilidad exclusiva del comercio usuario.",
  saludoFinalTicket: "¡GRACIAS POR SU COMPRA!",
  webTicket: "Conserve su comprobante de control interno",
  logoSuperior: "",
  watermark: "",
  opacidadWatermark: 0.18,
  mostrarCajeroTicket: true,
  mostrarClienteTicket: true,
  mostrarBarcodeTicket: true,
  mostrarLeyendaLegalTicket: true,
  mostrarCampoRefFiscal: true,

  remitenteGuia: "MI TIENDA",
  telefonoRemitenteGuia: "",
  direccionRemitenteGuia: "",
  tituloEtiquetaGuia: "ORDEN DE DESPACHO A DOMICILIO",
  notaGuia: "Favor llamar al cliente antes de llegar.",
  selloFragilGuia: "📦 MANEJAR CON CUIDADO",
  mostrarLogoEnGuia: true,
  mostrarRepartidorEnGuia: true
};

try {
  const disenoExistente = db.prepare("SELECT valor FROM configuracion WHERE clave = 'DISENO_IMPRESION_JSON'").get();
  if (!disenoExistente || !disenoExistente.valor) {
    db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('DISENO_IMPRESION_JSON', ?)")
      .run(JSON.stringify(DISENO_IMPRESION_DEFECTO));
  } else {
    const parseado = JSON.parse(disenoExistente.valor);
    const fusionado = Object.assign({}, DISENO_IMPRESION_DEFECTO, parseado);
    db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('DISENO_IMPRESION_JSON', ?)")
      .run(JSON.stringify(fusionado));
  }
} catch (e) {
  console.error("Error inicializando diseño de impresión:", e.message);
}

// Función para guardar imágenes Base64 de productos como archivos físicos en public/fotos/
function guardarImagenProductoEnDisco(idProducto, base64Data) {
  if (!base64Data || typeof base64Data !== 'string') return '';
  if (!base64Data.startsWith('data:image')) return base64Data;

  try {
    const coincidencias = base64Data.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!coincidencias || coincidencias.length !== 3) return base64Data;

    let ext = coincidencias[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!['jpg', 'png', 'webp'].includes(ext)) ext = 'jpg';

    const buffer = Buffer.from(coincidencias[2], 'base64');
    const idLimpio = path.basename((idProducto || 'item').toString()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const nombreArchivo = `prod_${idLimpio}_${Date.now()}.${ext}`;
    const rutaFisica = path.join(dirFotos, nombreArchivo);

    fs.writeFileSync(rutaFisica, buffer);
    return `/fotos/${nombreArchivo}`;
  } catch (err) {
    console.error("Error guardando imagen de producto en disco:", err.message);
    return base64Data;
  }
}

// Función para guardar imágenes de Diseño (Logo superior y Marca de agua) en public/fotos/
function guardarImagenDisenoEnDisco(prefijo, base64Data) {
  if (!base64Data || typeof base64Data !== 'string') return '';
  if (!base64Data.startsWith('data:image')) return base64Data;

  try {
    const coincidencias = base64Data.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!coincidencias || coincidencias.length !== 3) return base64Data;

    let ext = coincidencias[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!['jpg', 'png', 'webp'].includes(ext)) ext = 'png';

    const buffer = Buffer.from(coincidencias[2], 'base64');
    const prefijoLimpio = path.basename((prefijo || 'diseno').toString()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const nombreArchivo = `${prefijoLimpio}_${Date.now()}.${ext}`;
    const rutaFisica = path.join(dirFotos, nombreArchivo);

    fs.writeFileSync(rutaFisica, buffer);
    return `/fotos/${nombreArchivo}`;
  } catch (err) {
    console.error("Error guardando imagen de diseño en disco:", err.message);
    return base64Data;
  }
}

// Migración automática al iniciar: convierte fotos Base64 antiguas de SQLite en archivos físicos
(function migrarFotosBase64ADisco() {
  try {
    const productosConBase64 = db.prepare("SELECT id, foto FROM productos WHERE foto LIKE 'data:image%'").all();
    if (productosConBase64.length > 0) {
      const updFoto = db.prepare("UPDATE productos SET foto = ? WHERE id = ?");
      const transaccionMigracion = db.transaction((lista) => {
        for (const p of lista) {
          const nuevaRuta = guardarImagenProductoEnDisco(p.id, p.foto);
          if (nuevaRuta && nuevaRuta.startsWith('/fotos/')) {
            updFoto.run(nuevaRuta, p.id);
          }
        }
      });
      transaccionMigracion(productosConBase64);
      console.log(`🖼️ Migradas ${productosConBase64.length} foto(s) de Base64 a carpeta public/fotos/`);
    }
  } catch (e) {
    console.error("Aviso en migración de fotos:", e.message);
  }
})();

// Clave maestra interna para cifrado AES-256-GCM de respaldos automáticos en /backups/
const CLAVE_INTERNA_BACKUP_AUTO = 'POS_BACKUP_AUTO_AES256GCM_SV_KEY_2026_PROTECTED';

function cifrarBufferRespaldoDB(bufferPlano) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(CLAVE_INTERNA_BACKUP_AUTO, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const cifrado = Buffer.concat([cipher.update(bufferPlano), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const magicHeader = Buffer.from('POSDBENC1', 'ascii');
  return Buffer.concat([magicHeader, salt, iv, authTag, cifrado]);
}

function descifrarBufferRespaldoDB(bufferCifrado) {
  const magic = bufferCifrado.subarray(0, 9).toString('ascii');
  if (magic !== 'POSDBENC1') {
    throw new Error('Formato de respaldo automático cifrado no válido.');
  }
  const salt = bufferCifrado.subarray(9, 25);
  const iv = bufferCifrado.subarray(25, 37);
  const authTag = bufferCifrado.subarray(37, 53);
  const payload = bufferCifrado.subarray(53);
  const key = crypto.scryptSync(CLAVE_INTERNA_BACKUP_AUTO, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

// Función de respaldo automático diario cifrado con AES-256-GCM (.db.enc) (conserva los últimos 15 días)
async function realizarRespaldoAutomatico() {
  const rutaTemporalPlano = path.join(dirBackups, `.tmp_pos_${Date.now()}_${process.pid}.db`);
  try {
    const hoy = new Date();
    const y = hoy.getFullYear();
    const m = String(hoy.getMonth() + 1).padStart(2, '0');
    const d = String(hoy.getDate()).padStart(2, '0');
    const nombreBackupCifrado = `pos_tienda_${y}-${m}-${d}.db.enc`;
    const rutaDestinoCifrado = path.join(dirBackups, nombreBackupCifrado);

    await db.backup(rutaTemporalPlano);

    const bytesDbPlano = fs.readFileSync(rutaTemporalPlano);
    const bytesCifrados = cifrarBufferRespaldoDB(bytesDbPlano);
    fs.writeFileSync(rutaDestinoCifrado, bytesCifrados);

    if (fs.existsSync(rutaTemporalPlano)) {
      fs.unlinkSync(rutaTemporalPlano);
    }

    const archivosPlanosViejos = fs.readdirSync(dirBackups)
      .filter(f => (f.startsWith('pos_tienda_') || f.startsWith('.tmp_pos_')) && f.endsWith('.db'));
    for (const fPlano of archivosPlanosViejos) {
      try {
        fs.unlinkSync(path.join(dirBackups, fPlano));
      } catch (err) {}
    }

    const archivosCifrados = fs.readdirSync(dirBackups)
      .filter(f => f.startsWith('pos_tienda_') && f.endsWith('.db.enc'))
      .sort();

    while (archivosCifrados.length > 15) {
      const viejo = archivosCifrados.shift();
      try {
        fs.unlinkSync(path.join(dirBackups, viejo));
      } catch (err) {}
    }

    return { exito: true, archivo: nombreBackupCifrado };
  } catch (err) {
    console.error("Error creando respaldo automático cifrado:", err.message);
    return { exito: false, error: err.message };
  } finally {
    try {
      if (fs.existsSync(rutaTemporalPlano)) {
        fs.unlinkSync(rutaTemporalPlano);
      }
    } catch (e) {}
  }
}

// Ejecutar respaldo preventivo cifrado al iniciar el servidor
realizarRespaldoAutomatico();

db.hashearPin = hashearPin;
db.hashearPinLegacySHA256 = hashearPinLegacySHA256;
db.compararPinSeguro = compararPinSeguro;
db.registrarAuditoria = registrarAuditoria;
db.guardarImagenProductoEnDisco = guardarImagenProductoEnDisco;
db.guardarImagenDisenoEnDisco = guardarImagenDisenoEnDisco;
db.realizarRespaldoAutomatico = realizarRespaldoAutomatico;
db.descifrarBufferRespaldoDB = descifrarBufferRespaldoDB;
db.DISENO_IMPRESION_DEFECTO = DISENO_IMPRESION_DEFECTO;
db.dirCerts = dirCerts;
db.dirLibsOffline = dirLibsOffline;

module.exports = db;