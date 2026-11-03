// ============================================================================
// MÓDULO ESPECIALIZADO DE ESCÁNER 1D (ZBAR-WASM + LENTES IPHONE + ZOOM)
// Y GENERADOR DE ETIQUETAS OPTIMIZADAS PARA PAPEL
// ============================================================================

var streamCamaraActiva = null;
var intervaloEscaneoWasm = null;
var zoomActualCamara = 1;
var linternaActiva = false;
var idDispositivoCamaraActual = "";
var canvasEscanerOffscreen = null;
var ctxEscanerOffscreen = null;

function escaparHTMLEscaner(texto) {
  if (texto === null || texto === undefined) return "";
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 1. GENERADOR DE CÓDIGOS CORTOS DE 6 DÍGITOS (CODE 128 SUBSET C PARA PAPEL)
function generarCodigoBarrasAutomatico() {
  var inputId = document.getElementById("prodInputId");
  inputId.placeholder = "Generando...";

  google.script.run
    .withSuccessHandler(function(codigoCorto) {
      if (codigoCorto) {
        inputId.value = String(codigoCorto).trim();
      } else {
        inputId.value = String(Math.floor(100000 + Math.random() * 900000));
      }
      actualizarPreviewBarcodeProd();
    })
    .withFailureHandler(function() {
      inputId.value = String(Math.floor(100000 + Math.random() * 900000));
      actualizarPreviewBarcodeProd();
    })
    .generarCodigoProductoUnico();
}

function actualizarPreviewBarcodeProd() {
  var val = document.getElementById("prodInputId").value.trim();
  var box = document.getElementById("contenedorBarcodePreview");
  if (!val) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  try {
    var formatoOptimo = (/^\d+$/.test(val) && val.length % 2 === 0) ? "CODE128C" : "CODE128";
    JsBarcode("#svgBarcodePreview", val, {
      format: formatoOptimo,
      width: 2.3,
      height: 50,
      fontSize: 14,
      textMargin: 4,
      margin: 10,
      background: "#ffffff",
      lineColor: "#000000"
    });
  } catch (e) {
    try {
      JsBarcode("#svgBarcodePreview", val, { format: "CODE128", width: 2.2, height: 50, fontSize: 14, margin: 10 });
    } catch (err) {}
  }
}

function renderizarBarcodeTicketInferior(codigoTicket) {
  var valor = (codigoTicket || ("TICKET-" + String(Date.now()).slice(-6))).toString().trim();
  try {
    JsBarcode("#ticket-barcode-svg", valor, {
      format: "CODE128",
      displayValue: true,
      fontSize: 11,
      textMargin: 2,
      width: 1.9,
      height: 38,
      margin: 8,
      background: "#ffffff",
      lineColor: "#000000"
    });
  } catch (e) {}
}

// 2. COLA DE IMPRESIÓN DE ETIQUETAS (CON ZONA MUDA BLANCA Y BARRAS GRUESAS)
function enviarProductoActualAColaEtiquetas() {
  var id = document.getElementById("prodInputId").value.trim();
  var nombre = document.getElementById("prodInputNombre").value.trim() || "Producto";
  var precio = parseFloat(document.getElementById("prodInputPrecio").value) || 0;
  if (!id) return;
  colaEtiquetas.push({ id: id, nombre: nombre, precio: precio, cantidad: 10 });
  actualizarUIColaEtiquetas();
  mostrarAviso("Agregado a Etiquetas", "Se agregaron 10 etiquetas de este código a la cola de impresión.", "exito");
}

function cerrarModalMenuEtiquetas() {
  if (typeof cerrarTodasLasSugerencias === "function") cerrarTodasLasSugerencias();
  document.getElementById("modalMenuEtiquetas").classList.remove("activo");
  if (typeof purgarPinAdminMemoria === "function") {
    purgarPinAdminMemoria();
  } else {
    PIN_ADMIN_INVENTARIO = "";
  }
  document.getElementById("codigo").focus();
}

function agregarEtiquetaALista() {
  var codigo = document.getElementById("inputCodigoEtiqueta").value.trim();
  var cantidad = parseInt(document.getElementById("inputCantidadEtiquetas").value) || 1;
  if (codigo === "") {
    mostrarAviso("Campo Vacío", "Ingrese un código o nombre de producto.", "alerta");
    return;
  }
  document.getElementById("btnAgregarEtiqueta").innerText = "Buscando...";
  document.getElementById("btnAgregarEtiqueta").disabled = true;

  google.script.run.withSuccessHandler(function(producto) {
    if (producto && producto.encontrado) {
      if (typeof reproducirBeepEscaner === "function") reproducirBeepEscaner();
      colaEtiquetas.push({
        id: producto.idProducto,
        nombre: producto.nombre,
        precio: producto.precioOriginal,
        cantidad: cantidad
      });
      actualizarUIColaEtiquetas();
      document.getElementById("inputCodigoEtiqueta").value = "";
      document.getElementById("inputCantidadEtiquetas").value = "10";
      document.getElementById("inputCodigoEtiqueta").focus();
    } else {
      mostrarAviso("No Encontrado", "El código no existe en el inventario.", "error");
    }
    document.getElementById("btnAgregarEtiqueta").innerText = "Agregar a la Cola";
    document.getElementById("btnAgregarEtiqueta").disabled = false;
  }).buscarProducto(codigo);
}

function actualizarUIColaEtiquetas() {
  var tbody = document.getElementById("listaColaEtiquetas");
  tbody.innerHTML = "";
  if (colaEtiquetas.length === 0) {
    tbody.innerHTML = "<tr><td style='text-align:center; color:var(--text-muted); font-size:13px; padding:18px;'>Sin etiquetas en cola.</td></tr>";
    return;
  }
  for (var i = 0; i < colaEtiquetas.length; i++) {
    var item = colaEtiquetas[i];
    var tr = document.createElement("tr");
    var nombreSeguro = escaparHTMLEscaner((item.nombre || "").substring(0, 26));
    var idSeguro = escaparHTMLEscaner(item.id || "");
    var cantSegura = parseInt(item.cantidad, 10) || 1;
    tr.innerHTML =
      "<td style='padding:10px; font-size:13px; border-bottom:1px solid var(--border-color);'>" + nombreSeguro + " <small style='color:var(--text-muted); font-family:monospace;'>(" + idSeguro + ")</small></td>" +
      "<td style='padding:10px; font-weight:bold; width:50px; text-align:center; border-bottom:1px solid var(--border-color);'>x" + cantSegura + "</td>" +
      "<td style='padding:10px; width:40px; text-align:center; border-bottom:1px solid var(--border-color);'><button class='btn-eliminar' style='padding:2px 7px;' onclick='removerDeColaEtiquetas(" + i + ")'>X</button></td>";
    tbody.appendChild(tr);
  }
}

function removerDeColaEtiquetas(index) {
  colaEtiquetas.splice(index, 1);
  actualizarUIColaEtiquetas();
}

function imprimirColaEtiquetas() {
  if (colaEtiquetas.length === 0) {
    mostrarAviso("Cola Vacía", "Agregue al menos un artículo antes de imprimir.", "alerta");
    return;
  }
  var contenedor = document.getElementById("gridEtiquetasContainer");
  contenedor.innerHTML = "";

  for (var i = 0; i < colaEtiquetas.length; i++) {
    var item = colaEtiquetas[i];
    var codigoStr = String(item.id).trim();
    var esParNumerico = (/^\d+$/.test(codigoStr) && codigoStr.length % 2 === 0);
    var formatoBarra = esParNumerico ? "CODE128C" : "CODE128";
    var grosorBarra = codigoStr.length <= 8 ? "2.3" : "1.8";
    var nombreSeguro = escaparHTMLEscaner(item.nombre || "Producto");
    var codigoAtributoSeguro = escaparHTMLEscaner(codigoStr);
    var precioSeguro = (parseFloat(item.precio) || 0).toFixed(2);

    for (var c = 0; c < item.cantidad; c++) {
      var div = document.createElement("div");
      div.className = "etiqueta";
      div.innerHTML =
        "<div class='etiqueta-nombre'>" + nombreSeguro + "</div>" +
        "<div class='etiqueta-precio'>$" + precioSeguro + "</div>" +
        "<svg class='barcode' " +
        "jsbarcode-format='" + formatoBarra + "' " +
        "jsbarcode-value='" + codigoAtributoSeguro + "' " +
        "jsbarcode-width='" + grosorBarra + "' " +
        "jsbarcode-height='46' " +
        "jsbarcode-fontsize='13' " +
        "jsbarcode-textmargin='3' " +
        "jsbarcode-margin='10'></svg>";
      contenedor.appendChild(div);
    }
  }

  try {
    JsBarcode(".barcode").init();
  } catch (e) {
    document.querySelectorAll(".barcode").forEach(function(svgEl) {
      svgEl.setAttribute("jsbarcode-format", "CODE128");
    });
    JsBarcode(".barcode").init();
  }

  colaEtiquetas = [];
  actualizarUIColaEtiquetas();
  ejecutarImpresionNativa("modo-etiquetas");
}

// ============================================================================
// 3. ESCÁNER EN VIVO IPHONE / ANDROID CON ZBAR-WASM, ZOOM Y SELECTOR DE LENTE
// ============================================================================
function abrirModoHttpsEnVivo() {
  var host = window.location.hostname;
  window.location.href = "https://" + host + ":3443";
}

function obtenerFormatosSoportados() {
  if (typeof Html5QrcodeSupportedFormats === "undefined") return undefined;
  return [
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.QR_CODE
  ];
}

function aplicarCodigoEscaneado(codigoLeido) {
  if (escaneoEnProceso || !codigoLeido) return;
  var limpio = String(codigoLeido).trim();
  if (!limpio) return;

  escaneoEnProceso = true;
  if (typeof reproducirBeepEscaner === "function") {
    reproducirBeepEscaner();
  }
  try {
    if (navigator.vibrate) navigator.vibrate(80);
  } catch (e) {}

  detenerEscanerCamara();

  if (destinoEscaner === "producto") {
    document.getElementById("prodInputId").value = limpio;
    actualizarPreviewBarcodeProd();
  } else {
    document.getElementById("codigo").value = limpio;
    if (limpio.toUpperCase().startsWith("TICKET-")) {
      document.getElementById("codigo").value = "";
      abrirDetalleTicket(limpio.toUpperCase());
    } else {
      google.script.run.withSuccessHandler(agregarAlTicket).buscarProducto(limpio);
    }
  }
  setTimeout(function() { escaneoEnProceso = false; }, 650);
}

function listarLentesTraserosDisponibles() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  var select = document.getElementById("selectCamaraLente");
  if (!select) return;

  navigator.mediaDevices.enumerateDevices().then(function(devices) {
    var camarasVideo = devices.filter(function(d) { return d.kind === "videoinput"; });
    if (camarasVideo.length === 0) return;

    var traseras = camarasVideo.filter(function(d) {
      var lbl = (d.label || "").toLowerCase();
      return !lbl.includes("front") && !lbl.includes("frontal") && !lbl.includes("facetime") && !lbl.includes("user");
    });

    var listaMostrar = traseras.length > 0 ? traseras : camarasVideo;
    select.innerHTML = "";

    listaMostrar.forEach(function(cam, idx) {
      var opt = document.createElement("option");
      opt.value = cam.deviceId;
      var nombreLente = cam.label || ("Cámara Trasera " + (idx + 1));
      opt.innerText = nombreLente;
      if (cam.deviceId === idDispositivoCamaraActual) opt.selected = true;
      select.appendChild(opt);
    });
  }).catch(function() {});
}

function cambiarCamaraEscaner(nuevoDeviceId) {
  if (!nuevoDeviceId) return;
  idDispositivoCamaraActual = nuevoDeviceId;
  try {
    localStorage.setItem("pos_camara_preferida_id", nuevoDeviceId);
  } catch (e) {}
  iniciarStreamNativoZBar(nuevoDeviceId);
}

function aplicarZoomCamara(nivelZoom) {
  zoomActualCamara = parseFloat(nivelZoom) || 1;
  try {
    localStorage.setItem("pos_zoom_preferido", String(zoomActualCamara));
  } catch (e) {}

  var botones = document.querySelectorAll(".btn-zoom-cam[data-zoom]");
  botones.forEach(function(btn) {
    if (parseFloat(btn.getAttribute("data-zoom")) === zoomActualCamara) {
      btn.classList.add("activo");
    } else {
      btn.classList.remove("activo");
    }
  });

  var videoEl = document.getElementById("videoEscanerNativo");
  var aplicoHardware = false;

  if (streamCamaraActiva) {
    var tracks = streamCamaraActiva.getVideoTracks();
    if (tracks && tracks.length > 0) {
      var track = tracks[0];
      try {
        var caps = (typeof track.getCapabilities === "function") ? track.getCapabilities() : {};
        if (caps && caps.zoom) {
          var zMin = caps.zoom.min || 1;
          var zMax = caps.zoom.max || 4;
          var zTarget = Math.min(zMax, Math.max(zMin, zoomActualCamara));
          track.applyConstraints({ advanced: [{ zoom: zTarget }] });
          aplicoHardware = true;
        }
      } catch (e) {}
    }
  }

  if (videoEl) {
    videoEl.style.transform = aplicoHardware ? "scale(1)" : ("scale(" + zoomActualCamara + ")");
  }
}

function toggleLinternaCamara() {
  if (!streamCamaraActiva) return;
  var tracks = streamCamaraActiva.getVideoTracks();
  if (!tracks || tracks.length === 0) return;
  var track = tracks[0];

  try {
    linternaActiva = !linternaActiva;
    track.applyConstraints({ advanced: [{ torch: linternaActiva }] }).then(function() {
      var btnLuz = document.getElementById("btnLinternaCam");
      if (btnLuz) {
        btnLuz.classList.toggle("activo", linternaActiva);
      }
    }).catch(function() {
      linternaActiva = false;
    });
  } catch (e) {
    linternaActiva = false;
  }
}

function mejorarContrastePapel(imageData) {
  var data = imageData.data;
  var len = data.length;
  var minLum = 255;
  var maxLum = 0;

  for (var i = 0; i < len; i += 16) {
    var lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  var rango = Math.max(25, maxLum - minLum);
  var factor = 255 / rango;

  for (var j = 0; j < len; j += 4) {
    var gris = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    var estirado = (gris - minLum) * factor;
    if (estirado < 0) estirado = 0;
    else if (estirado > 255) estirado = 255;

    data[j] = estirado;
    data[j + 1] = estirado;
    data[j + 2] = estirado;
  }
  return imageData;
}

var alternadorFiltroFrame = false;

function analizarFrameVideoZBar() {
  if (escaneoEnProceso || !streamCamaraActiva) return;
  var video = document.getElementById("videoEscanerNativo");
  if (!video || video.readyState < 2 || !video.videoWidth) return;

  if (!canvasEscanerOffscreen) {
    canvasEscanerOffscreen = document.createElement("canvas");
    ctxEscanerOffscreen = canvasEscanerOffscreen.getContext("2d", { willReadFrequently: true });
  }

  var vw = video.videoWidth;
  var vh = video.videoHeight;

  var factorRecorte = Math.max(1, zoomActualCamara);
  var cropW = Math.floor((vw * 0.88) / factorRecorte);
  var cropH = Math.floor((vh * 0.50) / factorRecorte);
  var startX = Math.floor((vw - cropW) / 2);
  var startY = Math.floor((vh - cropH) / 2);

  var outW = Math.min(1100, cropW);
  var outH = Math.floor(cropH * (outW / cropW));

  canvasEscanerOffscreen.width = outW;
  canvasEscanerOffscreen.height = outH;
  ctxEscanerOffscreen.drawImage(video, startX, startY, cropW, cropH, 0, 0, outW, outH);

  var imgData = ctxEscanerOffscreen.getImageData(0, 0, outW, outH);
  alternadorFiltroFrame = !alternadorFiltroFrame;
  if (alternadorFiltroFrame) {
    imgData = mejorarContrastePapel(imgData);
  }

  if (typeof zbarWasm !== "undefined" && typeof zbarWasm.scanImageData === "function") {
    zbarWasm.scanImageData(imgData).then(function(symbols) {
      if (symbols && symbols.length > 0) {
        var texto = symbols[0].decode();
        if (texto) aplicarCodigoEscaneado(texto);
      }
    }).catch(function() {});
  } else if ("BarcodeDetector" in window) {
    try {
      var detector = new BarcodeDetector({ formats: ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "itf", "qr_code"] });
      detector.detect(canvasEscanerOffscreen).then(function(codigos) {
        if (codigos && codigos.length > 0 && codigos[0].rawValue) {
          aplicarCodigoEscaneado(codigos[0].rawValue);
        }
      }).catch(function() {});
    } catch (e) {}
  }
}

function detenerStreamActual() {
  if (intervaloEscaneoWasm) {
    clearInterval(intervaloEscaneoWasm);
    intervaloEscaneoWasm = null;
  }
  if (streamCamaraActiva) {
    try {
      streamCamaraActiva.getTracks().forEach(function(t) { t.stop(); });
    } catch (e) {}
    streamCamaraActiva = null;
  }
  try {
    if (lectorQR && lectorQR.isScanning) {
      lectorQR.stop().then(function() { lectorQR.clear(); }).catch(function() {});
    }
  } catch (e) {}
  lectorQR = null;
}

function iniciarStreamNativoZBar(deviceIdEspecifico) {
  detenerStreamActual();

  var contenedor = document.getElementById("lectorCamaraBox");
  contenedor.innerHTML =
    "<div class='visor-video-wrapper'>" +
      "<video id='videoEscanerNativo' autoplay playsinline muted></video>" +
      "<div class='guia-laser-barcode'><div class='linea-roja-laser'></div></div>" +
    "</div>";

  var constraintsVideo = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    focusMode: { ideal: "continuous" }
  };

  if (deviceIdEspecifico) {
    constraintsVideo.deviceId = { exact: deviceIdEspecifico };
  } else {
    constraintsVideo.facingMode = { ideal: "environment" };
  }

  navigator.mediaDevices.getUserMedia({ video: constraintsVideo, audio: false })
    .then(function(stream) {
      streamCamaraActiva = stream;
      var tracks = stream.getVideoTracks();
      if (tracks && tracks.length > 0 && tracks[0].getSettings) {
        var settings = tracks[0].getSettings();
        if (settings.deviceId) idDispositivoCamaraActual = settings.deviceId;
      }

      var videoEl = document.getElementById("videoEscanerNativo");
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.play().catch(function() {});
      }

      listarLentesTraserosDisponibles();

      var zoomGuardado = 1.5;
      try {
        var zg = parseFloat(localStorage.getItem("pos_zoom_preferido"));
        if (zg && zg >= 1) zoomGuardado = zg;
      } catch (e) {}
      setTimeout(function() { aplicarZoomCamara(zoomGuardado); }, 250);

      intervaloEscaneoWasm = setInterval(analizarFrameVideoZBar, 95);
    })
    .catch(function() {
      if (deviceIdEspecifico) {
        try { localStorage.removeItem("pos_camara_preferida_id"); } catch (e) {}
        iniciarStreamNativoZBar("");
        return;
      }
      iniciarFallbackHtml5Qrcode();
    });
}

function iniciarFallbackHtml5Qrcode() {
  try {
    var opcionesInstancia = {
      verbose: false,
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
    var formatos = obtenerFormatosSoportados();
    if (formatos) opcionesInstancia.formatsToSupport = formatos;

    document.getElementById("lectorCamaraBox").innerHTML = "";
    lectorQR = new Html5Qrcode("lectorCamaraBox", opcionesInstancia);

    lectorQR.start(
      { facingMode: "environment" },
      { fps: 15, qrbox: { width: 250, height: 100 } },
      function(codigoLeido) { aplicarCodigoEscaneado(codigoLeido); },
      function() {}
    ).catch(function() {
      document.getElementById("avisoHttpsIphone").style.display = "block";
      document.getElementById("lectorCamaraBox").innerHTML =
        "<div style='padding:18px; color:#94a3b8; font-size:12px;'>Para escanear en vivo sin tomar foto en iPhone, pulsa el botón azul <b>Ir a HTTPS (:3443)</b> de arriba, o usa el botón de abajo.</div>";
    });
  } catch (e) {
    document.getElementById("avisoHttpsIphone").style.display = "block";
  }
}

function iniciarEscanerCamara(destino) {
  destinoEscaner = destino;
  escaneoEnProceso = false;
  linternaActiva = false;
  document.getElementById("inputFotoBarcode").value = "";
  document.getElementById("lblEstadoEscaner").innerText = "En papel usa Zoom 1.5x o 2x a ~18 cm de distancia para enfoque instantáneo:";
  document.getElementById("modalEscanerCamara").classList.add("activo");

  var esContextoSeguro = window.isSecureContext || location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  document.getElementById("avisoHttpsIphone").style.display = esContextoSeguro ? "none" : "block";

  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    var camGuardada = "";
    try {
      camGuardada = localStorage.getItem("pos_camara_preferida_id") || "";
    } catch (e) {}
    iniciarStreamNativoZBar(camGuardada);
  } else {
    document.getElementById("avisoHttpsIphone").style.display = "block";
    document.getElementById("lectorCamaraBox").innerHTML =
      "<div style='padding:18px; color:#94a3b8; font-size:12px;'>Pulsa el botón <b>Ir a HTTPS (:3443)</b> de arriba para abrir el lector continuo en iPhone, o usa el botón de foto de abajo.</div>";
  }
}

function detenerEscanerCamara() {
  document.getElementById("modalEscanerCamara").classList.remove("activo");
  detenerStreamActual();
}

// ============================================================================
// 4. ESCANEO DESDE FOTO CON ZBAR-WASM MULTI-ESCALA (PARA PAPEL EN IPHONE)
// ============================================================================
function escanearImagenConZBarMultiPaso(imgElement, onExito, onFallo) {
  if (typeof zbarWasm === "undefined" || typeof zbarWasm.scanImageData !== "function") {
    onFallo();
    return;
  }

  var resoluciones = [1600, 1100, 800];
  var intentos = [];

  resoluciones.forEach(function(maxDim) {
    intentos.push({ maxDim: maxDim, contraste: false });
    intentos.push({ maxDim: maxDim, contraste: true });
  });

  var indice = 0;
  var canvasTmp = document.createElement("canvas");
  var ctxTmp = canvasTmp.getContext("2d", { willReadFrequently: true });

  function probarSiguiente() {
    if (indice >= intentos.length) {
      onFallo();
      return;
    }
    var cfg = intentos[indice++];
    var w = imgElement.width;
    var h = imgElement.height;
    if (w > h) {
      if (w > cfg.maxDim) { h = Math.round(h * (cfg.maxDim / w)); w = cfg.maxDim; }
    } else {
      if (h > cfg.maxDim) { w = Math.round(w * (cfg.maxDim / h)); h = cfg.maxDim; }
    }
    canvasTmp.width = w;
    canvasTmp.height = h;
    ctxTmp.drawImage(imgElement, 0, 0, w, h);

    var imageData = ctxTmp.getImageData(0, 0, w, h);
    if (cfg.contraste) {
      imageData = mejorarContrastePapel(imageData);
    }

    zbarWasm.scanImageData(imageData).then(function(symbols) {
      if (symbols && symbols.length > 0) {
        var decodificado = symbols[0].decode();
        if (decodificado) {
          onExito(decodificado);
          return;
        }
      }
      probarSiguiente();
    }).catch(function() {
      probarSiguiente();
    });
  }

  probarSiguiente();
}

function redimensionarArchivoParaBarcode(file, maxDim, callback) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var canvas = document.createElement("canvas");
      var w = img.width;
      var h = img.height;
      if (w > h) {
        if (w > maxDim) { h = Math.round(h * (maxDim / w)); w = maxDim; }
      } else {
        if (h > maxDim) { w = Math.round(w * (maxDim / h)); h = maxDim; }
      }
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.filter = "contrast(1.35) saturate(0)";
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(function(blob) {
        if (blob) {
          var archivoOptimo = new File([blob], "barcode_opt.jpg", { type: "image/jpeg" });
          callback(archivoOptimo, img);
        } else {
          callback(file, img);
        }
      }, "image/jpeg", 0.92);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function procesarFotoBarcode(event) {
  var archivo = event.target.files[0];
  if (!archivo) return;
  document.getElementById("lblEstadoEscaner").innerText = "Analizando código impreso en alta definición...";

  redimensionarArchivoParaBarcode(archivo, 1500, function(archivoOptimo, imgCargada) {
    escanearImagenConZBarMultiPaso(
      imgCargada,
      function(codigoZBar) {
        aplicarCodigoEscaneado(codigoZBar);
      },
      function() {
        try {
          var opciones = { verbose: false };
          var formatos = obtenerFormatosSoportados();
          if (formatos) opciones.formatsToSupport = formatos;

          var lectorArchivo = new Html5Qrcode("lectorCamaraBox", opciones);
          lectorArchivo.scanFile(archivoOptimo, true)
            .then(function(codigoLeido) {
              aplicarCodigoEscaneado(codigoLeido);
            })
            .catch(function() {
              document.getElementById("lblEstadoEscaner").innerText = "Aleja el iPhone unos 15-18 cm del papel y usa el botón 2x.";
              mostrarAviso("No se detectó el código", "Si la etiqueta está muy cerca, el lente principal del iPhone desenfoca el papel. Mantén el teléfono a ~18 cm de distancia usando el Zoom 2x.", "alerta");
            });
        } catch (e) {
          mostrarAviso("Error", "No se pudo procesar la imagen.", "error");
        }
      }
    );
  });
}