/**
 * CONSTRUCTOR COMERCIAL POS (COMPILACIÓN BINARIA BYTENODE .JSC + OFUSCACIÓN FRONTEND)
 * Requisito único en tu PC de desarrollo:
 *   npm install bytenode javascript-obfuscator
 * Uso:
 *   node empaquetar.js
 */

const fs = require('fs');
const path = require('path');

let bytenode = null;
try {
  bytenode = require('bytenode');
} catch (e) {
  console.error("\n=============================================================");
  console.error("❌ FALTA INSTALAR LA LIBRERÍA DE COMPILACIÓN 'bytenode'");
  console.error("=============================================================");
  console.error("Ejecuta este comando una sola vez en tu consola y vuelve a intentar:\n");
  console.error("   npm install bytenode javascript-obfuscator\n");
  console.error("=============================================================\n");
  process.exit(1);
}

let JavaScriptObfuscator = null;
try {
  JavaScriptObfuscator = require('javascript-obfuscator');
} catch (e) {
  console.warn("⚠️ Aviso: 'javascript-obfuscator' no está instalado. Ejecuta: npm install bytenode javascript-obfuscator para máxima ofuscación frontend.");
}

console.log("\n=============================================================");
console.log("📦 CONSTRUYENDO VERSIÓN COMERCIAL PROTEGIDA (dist_cliente)");
console.log("=============================================================");

const dirComercial = path.join(__dirname, 'dist_cliente');
const dirPublicCliente = path.join(dirComercial, 'public');
const dirFotosCliente = path.join(dirPublicCliente, 'fotos');
const dirLibsCliente = path.join(dirPublicCliente, 'libs');
const dirBackupsCliente = path.join(dirComercial, 'backups');
const dirCertsCliente = path.join(dirComercial, 'certs');

[dirComercial, dirPublicCliente, dirFotosCliente, dirLibsCliente, dirBackupsCliente, dirCertsCliente].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// 1. Procesar carpeta /public (HTML, CSS, ofuscación de archivos .js y copia de /public/libs)
const dirPublicOrigen = path.join(__dirname, 'public');
const archivosPublic = fs.readdirSync(dirPublicOrigen);

for (const archivo of archivosPublic) {
  const rutaOrigen = path.join(dirPublicOrigen, archivo);
  const rutaDestino = path.join(dirPublicCliente, archivo);

  if (fs.lstatSync(rutaOrigen).isDirectory()) {
    // Copiar subcarpeta /public/libs para garantizar el Modo 100% Offline en el cliente
    if (archivo === 'libs') {
      const archivosLibs = fs.readdirSync(rutaOrigen);
      for (const libFile of archivosLibs) {
        const origenLib = path.join(rutaOrigen, libFile);
        const destinoLib = path.join(dirLibsCliente, libFile);
        if (!fs.lstatSync(origenLib).isDirectory()) {
          console.log(`📚 Copiando librería Offline: public/libs/${libFile}`);
          fs.copyFileSync(origenLib, destinoLib);
        }
      }
    }
    continue;
  }

  if (archivo.endsWith('.js') && JavaScriptObfuscator) {
    console.log(`🔒 Ofuscando código frontend: public/${archivo}`);
    const codigoOriginal = fs.readFileSync(rutaOrigen, 'utf8');
    const resultadoOfuscado = JavaScriptObfuscator.obfuscate(codigoOriginal, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.5,
      numbersToExpressions: true,
      simplify: true,
      stringArray: true,
      stringArrayEncoding: ['rc4'],
      stringArrayThreshold: 0.75,
      splitStrings: true,
      splitStringsChunkLength: 8,
      unicodeEscapeSequence: false
    });
    fs.writeFileSync(rutaDestino, resultadoOfuscado.getObfuscatedCode(), 'utf8');
  } else {
    console.log(`📄 Copiando recurso: public/${archivo}`);
    fs.copyFileSync(rutaOrigen, rutaDestino);
  }
}

// 1.5 Copiar únicamente la Llave Pública Ed25519 (si existe) para verificación de licencias
const rutaPubEdOrigen = path.join(__dirname, 'certs', 'pos_ed25519_pub.pem');
const rutaPubEdDestino = path.join(dirCertsCliente, 'pos_ed25519_pub.pem');
if (fs.existsSync(rutaPubEdOrigen)) {
  console.log(`🔑 Copiando llave pública de verificación: certs/pos_ed25519_pub.pem`);
  fs.copyFileSync(rutaPubEdOrigen, rutaPubEdDestino);
}

// 2. Compilar database.js y server.js a código máquina V8 (.jsc)
console.log("⚙️  Compilando database.js -> database.jsc (Binario V8)...");
bytenode.compileFile({
  filename: path.join(__dirname, 'database.js'),
  output: path.join(dirComercial, 'database.jsc')
});

console.log("⚙️  Compilando server.js   -> server.jsc   (Binario V8)...");
bytenode.compileFile({
  filename: path.join(__dirname, 'server.js'),
  output: path.join(dirComercial, 'server.jsc')
});

// Asegurar que NUNCA queden archivos .js de código fuente ni llaves privadas en dist_cliente
[
  'database.js',
  'server.js',
  'generador_licencias.js',
  'empaquetar.js',
  'llave_privada_ed25519.pem'
].forEach(f => {
  const rutaBorrar = path.join(dirComercial, f);
  if (fs.existsSync(rutaBorrar)) fs.unlinkSync(rutaBorrar);
});

// 3. Crear el cargador binario main.js
const codigoMain = `'use strict';
require('bytenode');
require('./database.jsc');
require('./server.jsc');
`;
fs.writeFileSync(path.join(dirComercial, 'main.js'), codigoMain, 'utf8');

// 4. Crear package.json limpio de producción para el cliente
const packageCliente = {
  name: "sistema-pos-comercial",
  version: "3.6.0",
  private: true,
  main: "main.js",
  scripts: {
    start: "node main.js"
  },
  dependencies: {
    "better-sqlite3": "^11.0.0",
    "bytenode": "^1.5.7",
    "express": "^4.19.2"
  }
};
fs.writeFileSync(path.join(dirComercial, 'package.json'), JSON.stringify(packageCliente, null, 2), 'utf8');

// 5. Crear acceso directo ejecutable para Windows (INICIAR_POS.bat)
const contenidoBat = `@echo off
title SERVIDOR POS - CONTROL INTERNO
cd /d "%~dp0"
echo Iniciando Servidor POS...
node main.js
pause
`;
fs.writeFileSync(path.join(dirComercial, 'INICIAR_POS.bat'), contenidoBat, 'utf8');

console.log("-------------------------------------------------------------");
console.log("✅ ¡CONSTRUCCIÓN FINALIZADA CON ÉXITO!");
console.log(`📁 Carpeta comercial lista en: ${dirComercial}`);
console.log("🛡️  Tu código fuente y llave privada NO existen dentro de 'dist_cliente' (solo binarios .jsc).");
console.log("=============================================================\n");