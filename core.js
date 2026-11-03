// ============================================================================
// 1. ESCUDO DE SEGURIDAD Y ELIMINACIÓN TOTAL DEL CUADRO DE AUTORRELLENO
// ============================================================================
document.addEventListener("contextmenu", function(e) {
  e.preventDefault();
  return false;
});

document.addEventListener("keydown", function(e) {
  if (e.key === "F12" || e.keyCode === 123) { e.preventDefault(); return false; }
  if (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i" || e.key === "J" || e.key === "j" || e.key === "C" || e.key === "c")) {
    e.preventDefault(); return false;
  }
  if (e.ctrlKey && (e.key === "U" || e.key === "u" || e.key === "S" || e.key === "s")) {
    e.preventDefault(); return false;
  }
});

function obtenerFechaLocalHoyYMD() {
  var hoy = new Date();
  return hoy.getFullYear() + "-" + String(hoy.getMonth() + 1).padStart(2, '0') + "-" + String(hoy.getDate()).padStart(2, '0');
}

function esRutaFotoValida(strFoto) {
  if (!strFoto || typeof strFoto !== "string") return false;
  return strFoto.startsWith("http") || strFoto.startsWith("data:image") || strFoto.startsWith("/fotos/") || strFoto.startsWith("/");
}

function escaparHTMLCore(texto) {
  if (texto === null || texto === undefined) return "";
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================================
// 2. VARIABLES DE ESTADO, SONIDO "BEEP" LÁSER Y PUENTE PROXY (x-pos-pin)
// ============================================================================
var carrito = [];
var ventasEnEspera = [];
var inventarioCacheGlobal = [];
var filtroStockInventarioActual = "todos";
var subtotalBruto = 0; 
var totalFinal = 0;
var descuentoAplicadoTotal = 0; 
var accionPinProtegida = ""; 
var parametroPinProtegido = "";
var idProductoAAjustar = ""; 
var idProductoParaOferta = ""; 
var ticketEnVista = null; 
var colaEtiquetas = []; 
var historialGlobal = []; 
var CAJERO_ACTIVO = "Desconocido"; 
var PIN_SESION_ACTIVA = "";
var PIN_ADMIN_INVENTARIO = "";
var ID_A_LIQUIDAR = ""; 
var ITEM_A_DEVOLVER = { idVenta: "", idProducto: "", nombre: "", maxCant: 0 };
var FOTO_PRODUCTO_BASE64 = "";
var lectorQR = null;
var destinoEscaner = "carrito";
var escaneoEnProceso = false;
var ESTADO_LICENCIA_ACTUAL = null;
var MODO_BLOQUEO_LICENCIA_FORZADO = false;

var TIEMPO_INACTIVIDAD_MS = 5 * 60 * 1000;
var timerInactividadPOS = null;
var impresionEnCursoPOS = false;

var SONIDO_BEEP_ACTIVO = true;
var audioCtxPOS = null;

try {
  var cfgBeep = localStorage.getItem("pos_sonido_beep");
  if (cfgBeep === "0") SONIDO_BEEP_ACTIVO = false;
} catch (e) {}

// Purga total de credenciales administrativas en memoria
function purgarPinAdminMemoria() {
  PIN_ADMIN_INVENTARIO = "";
  var inpBovedaPin = document.getElementById("bovedaPinDueno");
  if (inpBovedaPin) inpBovedaPin.value = "";
  var inpPinSeg = document.getElementById("inputPinSeguridad");
  if (inpPinSeg) inpPinSeg.value = "";
}

// Purga inteligente al cerrar sub-modales: mantiene la sesión Admin solo si el modal de Inventario sigue abierto detrás
function purgarPinAdminSiInventarioCerrado() {
  var inpBovedaPin = document.getElementById("bovedaPinDueno");
  if (inpBovedaPin) inpBovedaPin.value = "";
  var inpPinSeg = document.getElementById("inputPinSeguridad");
  if (inpPinSeg) inpPinSeg.value = "";

  var modalInv = document.getElementById("modalInventario");
  var inventarioSigueAbierto = modalInv && modalInv.classList.contains("activo");
  if (!inventarioSigueAbierto) {
    PIN_ADMIN_INVENTARIO = "";
  }
}

function actualizarIconoBotonBeep() {
  var btn = document.getElementById("btnSonidoBeep");
  if (!btn) return;
  btn.innerText = SONIDO_BEEP_ACTIVO ? "🔊" : "🔇";
  btn.title = SONIDO_BEEP_ACTIVO ? "Sonido Beep Activado (Clic para silenciar)" : "Sonido Beep Silenciado (Clic para activar)";
}

function toggleSonidoBeep() {
  SONIDO_BEEP_ACTIVO = !SONIDO_BEEP_ACTIVO;
  try {
    localStorage.setItem("pos_sonido_beep", SONIDO_BEEP_ACTIVO ? "1" : "0");
  } catch (e) {}
  actualizarIconoBotonBeep();
  if (SONIDO_BEEP_ACTIVO) reproducirBeepEscaner();
}

function reproducirBeepEscaner() {
  if (!SONIDO_BEEP_ACTIVO) return;
  try {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtxPOS) audioCtxPOS = new AudioContextClass();
    if (audioCtxPOS.state === "suspended") audioCtxPOS.resume();

    var osc = audioCtxPOS.createOscillator();
    var gain = audioCtxPOS.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1850, audioCtxPOS.currentTime);

    gain.gain.setValueAtTime(0.16, audioCtxPOS.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtxPOS.currentTime + 0.085);

    osc.connect(gain);
    gain.connect(audioCtxPOS.destination);
    osc.start();
    osc.stop(audioCtxPOS.currentTime + 0.09);
  } catch (e) {}
}

window.google = {
  script: {
    run: new Proxy({}, {
      get(target, prop) {
        const crearCliente = (onSuccess, onFailure) => new Proxy({}, {
          get(_, nombreFuncion) {
            if (nombreFuncion === 'withSuccessHandler') return (fn) => crearCliente(fn, onFailure);
            if (nombreFuncion === 'withFailureHandler') return (fn) => crearCliente(onSuccess, fn);
            return (...argumentos) => {
              fetch('/api/ejecutar', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-pos-pin': PIN_SESION_ACTIVA || ''
                },
                body: JSON.stringify({ funcion: nombreFuncion, argumentos })
              })
              .then(async (r) => {
                if (r.status === 402) {
                  let dataLic = {};
                  try { dataLic = await r.json(); } catch (e) {}
                  if (dataLic && dataLic.estadoLicencia) {
                    aplicarEstadoLicenciaEnUI(dataLic.estadoLicencia);
                  }
                  abrirModalLicenciaSistema(true, dataLic.estadoLicencia || null);
                  throw new Error((dataLic && dataLic.error) || "Licencia vencida, suspendida o no autorizada en este equipo.");
                }
                if (r.status === 401) {
                  bloquearCaja();
                  throw new Error("Sesión expirada o no autorizada.");
                }
                return r.json();
              })
              .then(data => {
                if (data.error && onFailure) onFailure(new Error(data.error));
                else if (onSuccess) onSuccess(data.resultado);
              })
              .catch(err => { if (onFailure) onFailure(err); });
            };
          }
        });
        return crearCliente(null, null)[prop];
      }
    })
  }
};

window.addEventListener("DOMContentLoaded", function() {
  var inputs = document.querySelectorAll("input");
  inputs.forEach(function(inp, idx) {
    if (inp.type !== "file" && inp.type !== "date" && inp.type !== "checkbox" && inp.type !== "range") {
      inp.setAttribute("autocomplete", "one-time-code");
      inp.setAttribute("autocorrect", "off");
      inp.setAttribute("autocapitalize", "off");
      inp.setAttribute("spellcheck", "false");
      inp.setAttribute("aria-autocomplete", "none");
      inp.setAttribute("name", "campo_pos_" + idx + "_" + Math.random().toString(36).substring(2, 8));
      if (inp.type === "text") {
        inp.setAttribute("list", "bloqueo-historial");
      }
    }
  });
  actualizarIconoBotonBeep();
  cargarDiseñoTicketGuardado();
  verificarEstadoLicenciaServidor(false);
  inicializarBuscadoresConSugerencias();
  iniciarMonitorInactividadPOS();
  if (typeof restaurarVentasEnEsperaLocal === "function") {
    restaurarVentasEnEsperaLocal();
  }

  // Enlace seguro para autorizar exportación de Excel (.CSV) cuando el operador activo es Cajero
  if (typeof window.respuestaAccesoGenerico === "function") {
    var _origRespuestaAccesoGenerico = window.respuestaAccesoGenerico;
    window.respuestaAccesoGenerico = function(esValido, pinUsado) {
      _origRespuestaAccesoGenerico(esValido, pinUsado);
      if (esValido && accionPinProtegida === "exportar_csv") {
        var origen = parametroPinProtegido || "historial";
        exportarReporteContableUI(origen, pinUsado);
      }
    };
  }
});

window.addEventListener("beforeprint", function() {
  impresionEnCursoPOS = true;
});

window.addEventListener("afterprint", function() {
  impresionEnCursoPOS = false;
  setPrintMode("");
  reiniciarTemporizadorInactividad();
});

// ============================================================================
// 2.5 CONTROLADOR DE LICENCIAMIENTO COMERCIAL (HARDWARE ID + AVISO 5 DÍAS)
// ============================================================================
function verificarEstadoLicenciaServidor(abrirModalSiTodoBien) {
  google.script.run.withSuccessHandler(function(estado) {
    if (!estado) return;
    aplicarEstadoLicenciaEnUI(estado);
    if (estado.bloqueado) {
      abrirModalLicenciaSistema(true, estado);
    } else if (abrirModalSiTodoBien) {
      abrirModalLicenciaSistema(false, estado);
    }
  }).obtenerEstadoLicencia();
}

function aplicarEstadoLicenciaEnUI(estado) {
  if (!estado) return;
  ESTADO_LICENCIA_ACTUAL = estado;

  var inpHwid = document.getElementById("lblHardwareIdEquipo");
  if (inpHwid && estado.hardwareId) {
    inpHwid.value = estado.hardwareId;
  }

  var lblEstado = document.getElementById("lblEstadoActualLicencia");
  var lblVenc = document.getElementById("lblVencimientoActualLicencia");

  if (lblEstado) {
    if (estado.bloqueado) {
      lblEstado.innerText = "⛔ BLOQUEADA (" + (estado.motivoBloqueo || "SIN LICENCIA") + ")";
      lblEstado.style.color = "#ef4444";
    } else {
      lblEstado.innerText = "✅ " + (estado.cliente || "Licencia Activa");
      lblEstado.style.color = "#10b981";
    }
  }

  if (lblVenc) {
    if (estado.fechaVencimiento) {
      var textoDias = estado.tipo === "PERMANENTE"
        ? "PERMANENTE"
        : (estado.diasRestantes >= 0 ? (estado.fechaVencimiento + " (" + estado.diasRestantes + "d)") : ("Venció: " + estado.fechaVencimiento));
      lblVenc.innerText = textoDias;
      lblVenc.style.color = (estado.diasRestantes <= 5 && estado.tipo !== "PERMANENTE") ? "#f59e0b" : "#10b981";
    } else {
      lblVenc.innerText = "Sin Vigencia";
      lblVenc.style.color = "#ef4444";
    }
  }

  var banner = document.getElementById("bannerAvisoLicencia");
  var lblBanner = document.getElementById("lblTextoBannerLicencia");
  if (banner && lblBanner) {
    if (!estado.bloqueado && estado.mostrarAviso5Dias) {
      lblBanner.innerText = estado.mensaje || ("⚠️ Aviso: Tu licencia mensual vence en " + estado.diasRestantes + " día(s) (" + estado.fechaVencimiento + ").");
      banner.style.display = "flex";
    } else {
      banner.style.display = "none";
    }
  }
}

function abrirModalLicenciaSistema(forzarBloqueo, estadoRecibido) {
  var modal = document.getElementById("modalLicenciaSistema");
  if (!modal) return;

  if (estadoRecibido) {
    aplicarEstadoLicenciaEnUI(estadoRecibido);
  } else {
    google.script.run.withSuccessHandler(function(est) {
      if (est) aplicarEstadoLicenciaEnUI(est);
    }).obtenerEstadoLicencia();
  }

  var estActual = estadoRecibido || ESTADO_LICENCIA_ACTUAL || {};
  MODO_BLOQUEO_LICENCIA_FORZADO = Boolean(forzarBloqueo || estActual.bloqueado);

  var btnCerrarX = document.getElementById("btnCerrarModalLicencia");
  var btnCancelar = document.getElementById("btnCancelarModalLicencia");
  var cajaAlerta = document.getElementById("cajaAlertaBloqueoLicencia");

  if (MODO_BLOQUEO_LICENCIA_FORZADO) {
    if (btnCerrarX) btnCerrarX.style.display = "none";
    if (btnCancelar) btnCancelar.style.display = "none";
    if (cajaAlerta) {
      cajaAlerta.style.display = "block";
      cajaAlerta.style.background = "rgba(239, 68, 68, 0.12)";
      cajaAlerta.style.borderColor = "#ef4444";
      cajaAlerta.style.color = "#ef4444";
      cajaAlerta.innerText = estActual.mensaje || "⛔ El acceso operativo al sistema se encuentra pausado. Copia el Hardware ID de abajo, solicítale a tu proveedor tu código de activación mensual y pégalo aquí para desbloquear.";
    }
  } else {
    if (btnCerrarX) btnCerrarX.style.display = "inline-block";
    if (btnCancelar) btnCancelar.style.display = "inline-block";
    if (cajaAlerta) {
      if (estActual.mostrarAviso5Dias) {
        cajaAlerta.style.display = "block";
        cajaAlerta.style.background = "rgba(245, 158, 11, 0.12)";
        cajaAlerta.style.borderColor = "#f59e0b";
        cajaAlerta.style.color = "#d97706";
        cajaAlerta.innerText = estActual.mensaje;
      } else {
        cajaAlerta.style.display = "none";
      }
    }
  }

  var inpCod = document.getElementById("inputCodigoLicenciaNuevo");
  if (inpCod) inpCod.value = "";

  modal.classList.add("activo");
}

function cerrarModalLicenciaSistema() {
  if (MODO_BLOQUEO_LICENCIA_FORZADO && ESTADO_LICENCIA_ACTUAL && ESTADO_LICENCIA_ACTUAL.bloqueado) {
    return;
  }
  var modal = document.getElementById("modalLicenciaSistema");
  if (modal) modal.classList.remove("activo");
}

function copiarHardwareIdPortapapeles() {
  var inp = document.getElementById("lblHardwareIdEquipo");
  if (!inp || !inp.value) return;
  var texto = inp.value.trim();

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(function() {
      mostrarAviso("Hardware ID Copiado", "Se copió el código de máquina:\n" + texto + "\n\nEnvíalo por WhatsApp al administrador del software para recibir tu clave.", "exito");
    }).catch(function() {
      inp.select();
      document.execCommand("copy");
      mostrarAviso("Hardware ID Copiado", "Código copiado: " + texto, "exito");
    });
  } else {
    inp.select();
    document.execCommand("copy");
    mostrarAviso("Hardware ID Copiado", "Código copiado: " + texto, "exito");
  }
}

function activarNuevaLicenciaUI() {
  var inp = document.getElementById("inputCodigoLicenciaNuevo");
  var codigo = inp ? inp.value.trim() : "";
  if (!codigo) {
    mostrarAviso("Código Requerido", "Pega el código de licencia (POSLIC-...) proporcionado por tu proveedor.", "alerta");
    return;
  }

  var btn = document.getElementById("btnActivarLicencia");
  btn.innerText = "Verificando Firma Criptográfica...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    btn.innerText = "✅ Activar y Desbloquear Licencia";
    btn.disabled = false;

    if (res && res.exito) {
      MODO_BLOQUEO_LICENCIA_FORZADO = false;
      if (res.estado) aplicarEstadoLicenciaEnUI(res.estado);
      var modal = document.getElementById("modalLicenciaSistema");
      if (modal) modal.classList.remove("activo");
      mostrarAviso("Licencia Activada", res.mensaje, "exito");
    } else {
      mostrarAviso("Licencia Inválida", (res && res.mensaje) || "El código ingresado no es válido para este Hardware ID.", "error");
    }
  }).activarLicenciaSistema(codigo);
}

// ============================================================================
// 3. MOTOR DE RECOMENDACIONES EN VIVO (CAJA, INVENTARIO Y ETIQUETAS)
// ============================================================================
var timersSugerencias = {};
var cacheSugerenciasActivas = {};
var indiceSeleccionadoSugerencia = {};

function cerrarTodasLasSugerencias() {
  Object.keys(timersSugerencias).forEach(function(k) {
    if (timersSugerencias[k]) {
      clearTimeout(timersSugerencias[k]);
      timersSugerencias[k] = null;
    }
  });
  document.querySelectorAll(".sugerencias-dropdown").forEach(function(el) {
    el.classList.remove("activo");
    el.innerHTML = "";
  });
}

document.addEventListener("click", function(e) {
  if (!e.target.closest(".buscador-wrapper") && !e.target.closest("#modalInventario") && !e.target.closest("#modalMenuEtiquetas")) {
    cerrarTodasLasSugerencias();
  }
});

function filtrarTablaInventarioDOM(texto) {
  var filtro = (texto || "").toLowerCase().trim();
  var filas = document.querySelectorAll("#listaInventarioCompleto tr");
  filas.forEach(function(tr) {
    if (tr.cells.length < 3) return;
    var contenido = tr.innerText.toLowerCase();
    var stockAttr = tr.getAttribute("data-stock");
    var stockFila = stockAttr !== null ? (parseFloat(stockAttr) || 0) : 999;
    var cumpleStock = true;
    if (filtroStockInventarioActual === "bajo") cumpleStock = (stockFila > 0 && stockFila <= 5);
    else if (filtroStockInventarioActual === "agotado") cumpleStock = (stockFila <= 0);

    var cumpleTexto = (!filtro || contenido.includes(filtro));
    tr.style.display = (cumpleStock && cumpleTexto) ? "" : "none";
  });
}

function seleccionarRecomendacionProducto(modoDestino, idProd) {
  var lista = cacheSugerenciasActivas[modoDestino] || [];
  var prod = lista.find(function(x) { return String(x.idProducto) === String(idProd); });
  cerrarTodasLasSugerencias();

  if (modoDestino === "carrito") {
    document.getElementById("codigo").value = "";
    if (prod) {
      agregarAlTicket({
        encontrado: true,
        idProducto: prod.idProducto,
        nombre: prod.nombre,
        precioOriginal: prod.precioOriginal,
        precioFinal: prod.precioFinal,
        stock: prod.stock
      });
    } else {
      google.script.run.withSuccessHandler(agregarAlTicket).buscarProducto(idProd, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
    }
  } else if (modoDestino === "etiquetas") {
    var inpEtiq = document.getElementById("inputCodigoEtiqueta");
    inpEtiq.value = idProd;
    agregarEtiquetaALista();
  } else if (modoDestino === "inventario") {
    var inpInv = document.getElementById("inputBuscarInventario");
    if (prod && inpInv) {
      inpInv.value = prod.nombre;
      filtrarTablaInventarioDOM(prod.idProducto);
    }
  }
}

function renderizarDropdownSugerencias(contenedorId, modoDestino, listaProductos) {
  var box = document.getElementById(contenedorId);
  if (!box) return;

  cacheSugerenciasActivas[modoDestino] = listaProductos || [];
  indiceSeleccionadoSugerencia[modoDestino] = -1;

  if (!listaProductos || listaProductos.length === 0) {
    box.classList.remove("activo");
    box.innerHTML = "";
    return;
  }

  var html = "";
  listaProductos.forEach(function(p, idx) {
    var thumb = esRutaFotoValida(p.foto)
      ? "<img src='" + escaparHTMLCore(p.foto) + "' class='sugerencia-thumb'>"
      : "<div class='sugerencia-thumb'>ITEM</div>";

    var colorStock = p.stock > 0 ? "#10b981" : "#ef4444";
    var textoStock = p.stock > 0 ? ("Stock: " + p.stock) : "AGOTADO";
    var idEsc = escaparTextoJS(p.idProducto);
    var nombreSeguro = escaparHTMLCore(p.nombre);
    var idSeguro = escaparHTMLCore(p.idProducto);
    var catSegura = escaparHTMLCore(p.categoria || "");

    var precioHtml = "$" + parseFloat(p.precioFinal).toFixed(2);
    if (p.tieneOferta) {
      precioHtml = "<del style='color:#ef4444; font-size:10px; font-weight:600;'>$" + parseFloat(p.precioOriginal).toFixed(2) + "</del><br>$" + parseFloat(p.precioFinal).toFixed(2);
    }

    var botonesInventarioExtra = "";
    if (modoDestino === "inventario") {
      botonesInventarioExtra =
        "<button type='button' class='btn-ajuste-stock' style='background:#059669; padding:4px 8px; font-size:10px;' onclick=\"event.stopPropagation(); cerrarTodasLasSugerencias(); enviarProductoAlCarritoDesdeInventario('" + idEsc + "')\">+ Carrito</button>" +
        "<button type='button' class='btn-ajuste-stock' style='background:#4f46e5; padding:4px 8px; font-size:10px;' onclick=\"event.stopPropagation(); cerrarTodasLasSugerencias(); abrirFichaEditarProducto('" + idEsc + "')\">Editar</button>";
    }

    html +=
      "<div class='sugerencia-item' data-idx='" + idx + "' onclick=\"seleccionarRecomendacionProducto('" + modoDestino + "', '" + idEsc + "')\">" +
        thumb +
        "<div class='sugerencia-info'>" +
          "<div class='sugerencia-titulo'>" + nombreSeguro + "</div>" +
          "<div class='sugerencia-sub'>" +
            "<span style='font-family:monospace; font-weight:700;'>ID: " + idSeguro + "</span>" +
            "<span style='font-weight:800; color:" + colorStock + ";'>" + textoStock + "</span>" +
            (catSegura ? ("<span>• " + catSegura + "</span>") : "") +
          "</div>" +
        "</div>" +
        botonesInventarioExtra +
        "<div class='sugerencia-precio'>" + precioHtml + "</div>" +
      "</div>";
  });

  box.innerHTML = html;
  box.classList.add("activo");
}

function vincularInputAutocompletado(inputId, contenedorId, modoDestino) {
  var inp = document.getElementById(inputId);
  var box = document.getElementById(contenedorId);
  if (!inp || !box) return;

  inp.addEventListener("input", function() {
    var texto = inp.value.trim();

    if (modoDestino === "inventario") {
      filtrarTablaInventarioDOM(texto);
    }

    if (timersSugerencias[modoDestino]) {
      clearTimeout(timersSugerencias[modoDestino]);
    }

    if (texto.length < 1 || texto.toUpperCase().startsWith("TICKET-")) {
      box.classList.remove("activo");
      box.innerHTML = "";
      return;
    }

    timersSugerencias[modoDestino] = setTimeout(function() {
      var valorActual = inp.value.trim();
      if (!valorActual || valorActual.toUpperCase().startsWith("TICKET-")) {
        box.classList.remove("activo");
        box.innerHTML = "";
        return;
      }
      google.script.run.withSuccessHandler(function(resultados) {
        if (!inp.value.trim() || (document.activeElement !== inp && modoDestino !== "inventario")) return;
        renderizarDropdownSugerencias(contenedorId, modoDestino, resultados);
      }).sugerirProductos(valorActual);
    }, 130);
  });

  inp.addEventListener("keydown", function(e) {
    if (!box.classList.contains("activo")) return;
    var items = box.querySelectorAll(".sugerencia-item");
    if (items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      indiceSeleccionadoSugerencia[modoDestino] = (indiceSeleccionadoSugerencia[modoDestino] + 1) % items.length;
      actualizarResaltadoSugerencia(items, indiceSeleccionadoSugerencia[modoDestino]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      indiceSeleccionadoSugerencia[modoDestino] = (indiceSeleccionadoSugerencia[modoDestino] - 1 + items.length) % items.length;
      actualizarResaltadoSugerencia(items, indiceSeleccionadoSugerencia[modoDestino]);
    } else if (e.key === "Enter" && indiceSeleccionadoSugerencia[modoDestino] >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      var lista = cacheSugerenciasActivas[modoDestino] || [];
      var elegido = lista[indiceSeleccionadoSugerencia[modoDestino]];
      if (elegido) {
        seleccionarRecomendacionProducto(modoDestino, elegido.idProducto);
      }
    } else if (e.key === "Escape") {
      box.classList.remove("activo");
    }
  });
}

function actualizarResaltadoSugerencia(itemsDOM, idxActivo) {
  itemsDOM.forEach(function(el, i) {
    if (i === idxActivo) {
      el.classList.add("seleccionado");
      el.scrollIntoView({ block: "nearest" });
    } else {
      el.classList.remove("seleccionado");
    }
  });
}

function inicializarBuscadoresConSugerencias() {
  vincularInputAutocompletado("codigo", "sugerenciasCarrito", "carrito");
  vincularInputAutocompletado("inputBuscarInventario", "sugerenciasInventario", "inventario");
  vincularInputAutocompletado("inputCodigoEtiqueta", "sugerenciasEtiquetas", "etiquetas");
}

// ============================================================================
// 4. BÓVEDA DE DATOS + VISOR DE MESES ANTERIORES (SOLO DUEÑO / ADMIN)
// ============================================================================
var RESPALDO_BOVEDA_DESCARGADO_SESION = false;
var DATOS_VISOR_BOVEDA_ACTUAL = null;

function abrirModalBovedaDatos() {
  var modal = document.getElementById("modalBovedaDatos");
  if (!modal) {
    mostrarAviso("Actualización Requerida", "Presiona Ctrl + F5 en tu navegador para cargar la ventana de Bóveda.", "alerta");
    return;
  }

  RESPALDO_BOVEDA_DESCARGADO_SESION = false;
  DATOS_VISOR_BOVEDA_ACTUAL = null;

  modal.classList.add("activo");
  cambiarTabBoveda('limpiar');

  var inpPin = document.getElementById("bovedaPinDueno");
  if (inpPin) inpPin.value = PIN_ADMIN_INVENTARIO || "";

  var inpClave = document.getElementById("bovedaClaveSecreta");
  if (inpClave) inpClave.value = "";

  var inpFrase = document.getElementById("inputConfirmarFraseBoveda");
  if (inpFrase) inpFrase.value = "";

  var chkProd = document.getElementById("chkConservarProductosBoveda");
  if (chkProd) chkProd.checked = true;

  var inpFileRest = document.getElementById("inputArchivoRestaurarBoveda");
  if (inpFileRest) inpFileRest.value = "";

  var inpFileVisor = document.getElementById("inputArchivoVisorBoveda");
  if (inpFileVisor) inpFileVisor.value = "";

  var panelVisor = document.getElementById("panelResultadosVisorBoveda");
  if (panelVisor) panelVisor.style.display = "none";

  var cajaPaso2 = document.getElementById("cajaPaso2Limpieza");
  if (cajaPaso2) {
    cajaPaso2.style.opacity = "0.55";
    cajaPaso2.style.pointerEvents = "none";
  }
}

function cerrarModalBovedaDatos() {
  var modal = document.getElementById("modalBovedaDatos");
  if (modal) modal.classList.remove("activo");
  var inpClave = document.getElementById("bovedaClaveSecreta");
  if (inpClave) inpClave.value = "";
  purgarPinAdminSiInventarioCerrado();
}

function cambiarTabBoveda(tab) {
  var secLimpiar = document.getElementById("seccionBovedaLimpiar");
  var secVisor = document.getElementById("seccionBovedaVisor");
  var secRestaurar = document.getElementById("seccionBovedaRestaurar");

  if (secLimpiar) secLimpiar.style.display = (tab === 'limpiar') ? "block" : "none";
  if (secVisor) secVisor.style.display = (tab === 'visor') ? "block" : "none";
  if (secRestaurar) secRestaurar.style.display = (tab === 'restaurar') ? "block" : "none";

  var btnLimpiar = document.getElementById("tabBtnBovedaLimpiar");
  var btnVisor = document.getElementById("tabBtnBovedaVisor");
  var btnRestaurar = document.getElementById("tabBtnBovedaRestaurar");

  if (btnLimpiar) btnLimpiar.classList.toggle("activo", tab === 'limpiar');
  if (btnVisor) btnVisor.classList.toggle("activo", tab === 'visor');
  if (btnRestaurar) btnRestaurar.classList.toggle("activo", tab === 'restaurar');
}

function exportarRespaldoBovedaUI() {
  var pinDueno = document.getElementById("bovedaPinDueno").value.trim() || PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA;
  var claveSecreta = document.getElementById("bovedaClaveSecreta").value.trim();

  if (!pinDueno || claveSecreta.length < 6) {
    mostrarAviso("Credenciales Requeridas", "Ingresa el PIN del Dueño / Administrador y una Contraseña Secreta de Cifrado de al menos 6 caracteres.", "alerta");
    return;
  }

  var btn = document.getElementById("btnDescargarBoveda");
  btn.innerText = "Cifrando con AES-256-GCM...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    btn.innerText = "⬇️ 1. Generar y Descargar Archivo del Mes (.posbkp)";
    btn.disabled = false;

    if (!res || !res.exito) {
      mostrarAviso("Acceso Denegado", (res && res.mensaje) || "No se pudo generar el respaldo.", "error");
      return;
    }

    var blob = new Blob([res.contenidoCifrado], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = res.nombreArchivo || "BOVEDA_POS.posbkp";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 2000);

    RESPALDO_BOVEDA_DESCARGADO_SESION = true;
    var cajaPaso2 = document.getElementById("cajaPaso2Limpieza");
    if (cajaPaso2) {
      cajaPaso2.style.opacity = "1";
      cajaPaso2.style.pointerEvents = "auto";
    }

    mostrarAviso(
      "Respaldo Descargado",
      res.mensaje + "\n\nResumen guardado en tu archivo:\n• Ventas: " + res.resumen.ventas + "\n• Clientes: " + res.resumen.clientes + "\n• Productos con Stock: " + res.resumen.productos,
      "exito"
    );
  }).exportarBovedaDatos(pinDueno, claveSecreta);
}

function ejecutarLimpiezaBaseDatosUI() {
  if (!RESPALDO_BOVEDA_DESCARGADO_SESION) {
    mostrarAviso("Candado de Seguridad", "Primero debes descargar el archivo de respaldo en el Paso 1 antes de limpiar la base de datos.", "alerta");
    return;
  }

  var pinDueno = document.getElementById("bovedaPinDueno").value.trim() || PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA;
  var claveSecreta = document.getElementById("bovedaClaveSecreta").value.trim();
  var frase = document.getElementById("inputConfirmarFraseBoveda").value.trim();
  var conservarProductos = document.getElementById("chkConservarProductosBoveda").checked;

  if (frase.toUpperCase() !== "ELIMINAR DATOS") {
    mostrarAviso("Confirmación Requerida", "Escribe exactamente las palabras ELIMINAR DATOS para confirmar el borrado.", "alerta");
    return;
  }

  var btn = document.getElementById("btnEjecutarLimpiezaBoveda");
  btn.innerText = "Limpiando Base de Datos...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    btn.innerText = "🗑️ 2. Ejecutar Limpieza de Cierre de Mes Ahora";
    btn.disabled = false;

    if (res && res.exito) {
      carrito = [];
      ventasEnEspera = [];
      try {
        localStorage.removeItem("pos_carrito_backup");
        localStorage.removeItem("pos_ventas_espera");
      } catch(e) {}
      if (typeof renderizarBarraVentasEspera === "function") renderizarBarraVentasEspera();
      actualizarPantalla();
      cerrarModalBovedaDatos();
      google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
      mostrarAviso("Cierre de Mes Completado", res.mensaje, "exito");
    } else {
      mostrarAviso("Operación Rechazada", (res && res.mensaje) || "No se pudo limpiar la base de datos.", "error");
    }
  }).limpiarBaseDatosMaestra(pinDueno, claveSecreta, frase, conservarProductos);
}

function inspeccionarArchivoBovedaUI() {
  var pinDueno = document.getElementById("bovedaPinDueno").value.trim() || PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA;
  var claveSecreta = document.getElementById("bovedaClaveSecreta").value.trim();
  var fileInput = document.getElementById("inputArchivoVisorBoveda");

  if (!pinDueno || !claveSecreta) {
    mostrarAviso("Credenciales Requeridas", "Ingresa arriba el PIN del Dueño / Administrador y la Contraseña Secreta con la que cifraste el archivo.", "alerta");
    return;
  }

  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    mostrarAviso("Archivo Faltante", "Selecciona el archivo .posbkp del mes que deseas auditar.", "alerta");
    return;
  }

  var archivo = fileInput.files[0];
  var btn = document.getElementById("btnInspeccionarBoveda");
  btn.innerText = "Descifrando en memoria...";
  btn.disabled = true;

  var reader = new FileReader();
  reader.onload = function(e) {
    var contenido = e.target.result;
    google.script.run.withSuccessHandler(function(res) {
      btn.innerText = "📂 Abrir Archivo en Visor";
      btn.disabled = false;

      if (!res || !res.exito) {
        mostrarAviso("Error al Abrir Archivo", (res && res.mensaje) || "Contraseña o archivo inválido.", "error");
        return;
      }

      DATOS_VISOR_BOVEDA_ACTUAL = res;
      document.getElementById("lblFechaExportacionVisor").innerText = res.fechaExportacion || "-";
      document.getElementById("lblClientesVisor").innerText = res.totalClientes || 0;

      var m = res.metricas || {};
      var totalV = parseFloat(m.totalVendido) || 0;
      var ganNeta = parseFloat(m.gananciaNetaReal) || 0;
      var margen = parseFloat(m.margenPorcentaje) || 0;
      var ef = parseFloat(m.efectivo) || 0;
      var bancos = (parseFloat(m.agricola) || 0) + (parseFloat(m.cuscatlan) || 0);
      var costo = parseFloat(m.costoMercaderia) || 0;
      var gastos = parseFloat(m.gastos) || 0;

      document.getElementById("visorTotalVendido").innerText = "$" + totalV.toFixed(2) + " (" + (m.ticketsValidos || 0) + " tkt)";
      document.getElementById("visorGananciaNeta").innerText = (ganNeta < 0 ? "-$" : "$") + Math.abs(ganNeta).toFixed(2) + " (" + margen.toFixed(1) + "%)";
      document.getElementById("visorEfectivoBancos").innerText = "Ef: $" + ef.toFixed(2) + " | Bco: $" + bancos.toFixed(2);
      document.getElementById("visorCostoGastos").innerText = "Costo: $" + costo.toFixed(2) + " | Egr: $" + gastos.toFixed(2);

      document.getElementById("inputBuscarEnVisor").value = "";
      document.getElementById("selectVistaTablaVisor").value = "ventas";
      document.getElementById("panelResultadosVisorBoveda").style.display = "block";
      renderizarTablaVisorBoveda();
    }).inspeccionarBovedaDatos(contenido, pinDueno, claveSecreta);
  };
  reader.readAsText(archivo);
}

function renderizarTablaVisorBoveda() {
  if (!DATOS_VISOR_BOVEDA_ACTUAL) return;
  var vista = document.getElementById("selectVistaTablaVisor").value;
  var filtro = (document.getElementById("inputBuscarEnVisor").value || "").toLowerCase().trim();
  var thead = document.getElementById("theadVisorBoveda");
  var tbody = document.getElementById("tbodyVisorBoveda");
  tbody.innerHTML = "";

  if (vista === "ventas") {
    thead.innerHTML = "<tr><th>Ticket / Fecha</th><th>Cliente</th><th>Artículos</th><th>Método / Estado</th><th style='text-align:right;'>Total</th></tr>";
    var listaV = (DATOS_VISOR_BOVEDA_ACTUAL.ventas || []).filter(function(v) {
      if (!filtro) return true;
      return (v.idVenta + " " + v.fecha + " " + v.cliente + " " + v.articulos + " " + v.metodo + " " + (v.refFiscal || "")).toLowerCase().includes(filtro);
    });
    if (listaV.length === 0) {
      tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; padding:20px; color:var(--text-muted);'>Sin ventas que coincidan.</td></tr>";
      return;
    }
    listaV.forEach(function(v) {
      var tr = document.createElement("tr");
      var esAnulada = (v.estado || "").toLowerCase() === "anulada";
      var badgeFiscal = v.refFiscal ? ("<br><small style='color:#059669; font-family:monospace;'>DTE/Fact: " + escaparHTMLCore(v.refFiscal) + "</small>") : "";
      tr.innerHTML =
        "<td style='font-family:monospace; font-weight:700;'>" + escaparHTMLCore(v.idVenta) + "<br><small style='color:var(--text-muted);'>" + escaparHTMLCore(v.fecha) + "</small>" + badgeFiscal + "</td>" +
        "<td><b>" + escaparHTMLCore(v.cliente) + "</b><br><small style='color:var(--text-muted);'>Op: " + escaparHTMLCore(v.cajero) + "</small></td>" +
        "<td style='max-width:220px;'>" + escaparHTMLCore(v.articulos) + "</td>" +
        "<td>" + escaparHTMLCore(v.metodo) + "<br><small style='font-weight:700;'>" + escaparHTMLCore(v.estado) + "</small></td>" +
        "<td style='text-align:right; font-weight:800; color:" + (esAnulada ? "#ef4444; text-decoration:line-through" : "#10b981") + ";'>$" + parseFloat(v.total).toFixed(2) + "</td>";
      tbody.appendChild(tr);
    });
  } else if (vista === "productos") {
    thead.innerHTML = "<tr><th>Código</th><th>Producto</th><th>Categoría</th><th style='text-align:right;'>Costo / Precio</th><th style='text-align:center;'>Stock Guardado</th></tr>";
    var listaP = (DATOS_VISOR_BOVEDA_ACTUAL.productos || []).filter(function(p) {
      if (!filtro) return true;
      return (p.id + " " + p.nombre + " " + p.categoria).toLowerCase().includes(filtro);
    });
    if (listaP.length === 0) {
      tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; padding:20px; color:var(--text-muted);'>Sin productos que coincidan.</td></tr>";
      return;
    }
    listaP.forEach(function(p) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td style='font-family:monospace; font-weight:700;'>" + escaparHTMLCore(p.id) + "</td>" +
        "<td style='font-weight:700;'>" + escaparHTMLCore(p.nombre) + "</td>" +
        "<td>" + escaparHTMLCore(p.categoria) + "</td>" +
        "<td style='text-align:right;'>C: $" + p.costo.toFixed(2) + " | <b>V: $" + p.precio.toFixed(2) + "</b></td>" +
        "<td style='text-align:center; font-weight:800;'>" + p.stock + "</td>";
      tbody.appendChild(tr);
    });
  } else if (vista === "kardex") {
    thead.innerHTML = "<tr><th>Fecha</th><th>Código</th><th>Producto</th><th>Movimiento</th><th style='text-align:center;'>Cant.</th><th>Operador</th></tr>";
    var listaK = (DATOS_VISOR_BOVEDA_ACTUAL.kardex || []).filter(function(k) {
      if (!filtro) return true;
      return (k.fecha + " " + k.idProducto + " " + k.nombreProducto + " " + k.tipo + " " + k.cajero).toLowerCase().includes(filtro);
    });
    if (listaK.length === 0) {
      tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; padding:20px; color:var(--text-muted);'>Sin movimientos de Kardex en este archivo.</td></tr>";
      return;
    }
    listaK.forEach(function(k) {
      var tr = document.createElement("tr");
      var signo = k.cantidad > 0 ? ("+" + k.cantidad) : k.cantidad;
      tr.innerHTML =
        "<td>" + escaparHTMLCore(k.fecha) + "</td>" +
        "<td style='font-family:monospace; font-weight:700;'>" + escaparHTMLCore(k.idProducto) + "</td>" +
        "<td>" + escaparHTMLCore(k.nombreProducto) + "</td>" +
        "<td>" + escaparHTMLCore(k.tipo) + "</td>" +
        "<td style='text-align:center; font-weight:800; color:" + (k.cantidad > 0 ? "#10b981" : "#ef4444") + ";'>" + signo + "</td>" +
        "<td>" + escaparHTMLCore(k.cajero) + "</td>";
      tbody.appendChild(tr);
    });
  } else if (vista === "gastos") {
    thead.innerHTML = "<tr><th>Fecha</th><th>Concepto del Egreso</th><th>Operador</th><th style='text-align:right;'>Monto</th></tr>";
    var listaG = (DATOS_VISOR_BOVEDA_ACTUAL.gastos || []).filter(function(g) {
      if (!filtro) return true;
      return (g.fecha + " " + g.concepto + " " + g.cajero).toLowerCase().includes(filtro);
    });
    if (listaG.length === 0) {
      tbody.innerHTML = "<tr><td colspan='4' style='text-align:center; padding:20px; color:var(--text-muted);'>Sin egresos registrados en este archivo.</td></tr>";
      return;
    }
    listaG.forEach(function(g) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escaparHTMLCore(g.fecha) + "</td>" +
        "<td style='font-weight:700;'>" + escaparHTMLCore(g.concepto) + "</td>" +
        "<td>" + escaparHTMLCore(g.cajero) + "</td>" +
        "<td style='text-align:right; font-weight:800; color:#ef4444;'>-$" + parseFloat(g.monto).toFixed(2) + "</td>";
      tbody.appendChild(tr);
    });
  }
}

function restaurarArchivoBovedaUI() {
  var pinDueno = document.getElementById("bovedaPinDueno").value.trim() || PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA;
  var claveSecreta = document.getElementById("bovedaClaveSecreta").value.trim();
  var fileInput = document.getElementById("inputArchivoRestaurarBoveda");

  if (!pinDueno || !claveSecreta) {
    mostrarAviso("Credenciales Requeridas", "Ingresa arriba el PIN del Dueño / Administrador y la Contraseña Secreta del archivo.", "alerta");
    return;
  }

  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    mostrarAviso("Archivo Faltante", "Selecciona el archivo .posbkp que deseas restaurar.", "alerta");
    return;
  }

  var archivo = fileInput.files[0];
  var btn = document.getElementById("btnRestaurarBoveda");
  btn.innerText = "Descifrando y Restaurando...";
  btn.disabled = true;

  var reader = new FileReader();
  reader.onload = function(e) {
    var contenido = e.target.result;
    google.script.run.withSuccessHandler(function(res) {
      btn.innerText = "🔄 Descifrar y Restaurar Datos en el Sistema";
      btn.disabled = false;

      if (res && res.exito) {
        cerrarModalBovedaDatos();
        cargarDiseñoTicketGuardado();
        google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
        mostrarAviso("Bóveda Restaurada", res.mensaje, "exito");
      } else {
        mostrarAviso("Error de Restauración", (res && res.mensaje) || "Archivo o contraseña inválida.", "error");
      }
    }).restaurarBovedaDatos(contenido, pinDueno, claveSecreta);
  };
  reader.readAsText(archivo);
}

// ============================================================================
// 5. PERSONALIZACIÓN AVANZADA DE TICKET, BLINDAJE LEGAL Y GUÍAS (EN SERVIDOR)
// ============================================================================
var DISENO_ACTUAL = {
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

var LOGO_SUPERIOR_TEMP = "";
var WATERMARK_TEMP_BASE64 = "";

function cambiarTabDiseno(tab) {
  if (tab === 'guia') {
    document.getElementById("seccionDisenoTicket").style.display = "none";
    document.getElementById("seccionDisenoGuia").style.display = "block";
    document.getElementById("tabBtnTicket").classList.remove("activo");
    document.getElementById("tabBtnGuia").classList.add("activo");
  } else {
    document.getElementById("seccionDisenoTicket").style.display = "block";
    document.getElementById("seccionDisenoGuia").style.display = "none";
    document.getElementById("tabBtnTicket").classList.add("activo");
    document.getElementById("tabBtnGuia").classList.remove("activo");
  }
}

function aplicarDisenoEnDOM(cfg) {
  if (!cfg) return;
  DISENO_ACTUAL = Object.assign({}, DISENO_ACTUAL, cfg);

  var nombre = DISENO_ACTUAL.nombreTienda || "MI TIENDA";
  document.getElementById("ticket-titulo-tienda").innerText = nombre;
  document.getElementById("print-corte-tienda").innerText = nombre;
  document.getElementById("ticket-subtitulo-tienda").innerText = DISENO_ACTUAL.subtituloTienda || "";

  var elNit = document.getElementById("ticket-nit-tienda");
  elNit.innerText = DISENO_ACTUAL.nitTienda || "";
  elNit.style.display = DISENO_ACTUAL.nitTienda ? "block" : "none";

  var elDirTienda = document.getElementById("ticket-direccion-tienda");
  elDirTienda.innerText = DISENO_ACTUAL.direccionTienda || "";
  elDirTienda.style.display = DISENO_ACTUAL.direccionTienda ? "block" : "none";

  var elTelTienda = document.getElementById("ticket-telefono-tienda");
  elTelTienda.innerText = DISENO_ACTUAL.telefonoTienda || "";
  elTelTienda.style.display = DISENO_ACTUAL.telefonoTienda ? "block" : "none";

  var elRedes = document.getElementById("ticket-redes-tienda");
  elRedes.innerText = DISENO_ACTUAL.redesTienda || "";
  elRedes.style.display = DISENO_ACTUAL.redesTienda ? "block" : "none";

  var elPolitica = document.getElementById("ticket-politica-custom");
  elPolitica.innerText = DISENO_ACTUAL.politicaTicket || "";
  elPolitica.style.display = DISENO_ACTUAL.politicaTicket ? "block" : "none";

  var elLeyendaLegal = document.getElementById("ticket-leyenda-legal-custom");
  if (elLeyendaLegal) {
    var txtLegal = (DISENO_ACTUAL.leyendaLegalTicket !== undefined)
      ? DISENO_ACTUAL.leyendaLegalTicket
      : "DOCUMENTO EXCLUSIVO DE CONTROL INTERNO DE INVENTARIO. NO TIENE VALIDEZ FISCAL NI SUSTITUYE FACTURA O DOCUMENTO TRIBUTARIO ELECTRÓNICO (DTE).";
    elLeyendaLegal.innerText = txtLegal;
    elLeyendaLegal.style.display = (DISENO_ACTUAL.mostrarLeyendaLegalTicket !== false && txtLegal) ? "block" : "none";
  }

  var elNotaPie = document.getElementById("lblNotaLegalPieSistema");
  if (elNotaPie) {
    elNotaPie.innerText = DISENO_ACTUAL.notaLegalPieSistema || "";
    elNotaPie.style.display = DISENO_ACTUAL.notaLegalPieSistema ? "block" : "none";
  }

  var contRefFiscal = document.getElementById("contenedorCampoRefFiscal");
  if (contRefFiscal) {
    contRefFiscal.style.display = (DISENO_ACTUAL.mostrarCampoRefFiscal !== false) ? "block" : "none";
  }

  document.getElementById("ticket-frase-custom").innerText = DISENO_ACTUAL.fraseTicket || "";
  document.getElementById("ticket-saludo-final").innerText = DISENO_ACTUAL.saludoFinalTicket || "¡GRACIAS POR SU COMPRA!";
  document.getElementById("ticket-web-custom").innerText = DISENO_ACTUAL.webTicket || "";

  document.getElementById("fila-ticket-cajero").style.display = (DISENO_ACTUAL.mostrarCajeroTicket !== false) ? "flex" : "none";
  document.getElementById("fila-ticket-cliente").style.display = (DISENO_ACTUAL.mostrarClienteTicket !== false) ? "flex" : "none";
  document.getElementById("contenedor-barcode-ticket-print").style.display = (DISENO_ACTUAL.mostrarBarcodeTicket !== false) ? "block" : "none";

  var imgLogoTop = document.getElementById("ticket-logo-superior");
  if (esRutaFotoValida(DISENO_ACTUAL.logoSuperior)) {
    imgLogoTop.src = DISENO_ACTUAL.logoSuperior;
    imgLogoTop.style.display = "block";
  } else {
    imgLogoTop.src = "";
    imgLogoTop.style.display = "none";
  }

  var imgWm = document.getElementById("ticket-watermark");
  if (esRutaFotoValida(DISENO_ACTUAL.watermark)) {
    imgWm.src = DISENO_ACTUAL.watermark;
    imgWm.style.opacity = DISENO_ACTUAL.opacidadWatermark || 0.18;
    imgWm.style.display = "block";
  } else {
    imgWm.src = "";
    imgWm.style.display = "none";
  }

  try {
    localStorage.setItem("pos_diseno_cache", JSON.stringify(DISENO_ACTUAL));
  } catch(e) {}
}

function cargarDiseñoTicketGuardado() {
  try {
    var cacheLocal = localStorage.getItem("pos_diseno_cache");
    if (cacheLocal) {
      aplicarDisenoEnDOM(JSON.parse(cacheLocal));
    }
  } catch(e) {}

  google.script.run.withSuccessHandler(function(cfgRemota) {
    if (cfgRemota) {
      aplicarDisenoEnDOM(cfgRemota);
    }
  }).obtenerDisenoImpresion();
}

function abrirModalDiseñoTicket() {
  cambiarTabDiseno('ticket');
  document.getElementById("cfgNombreTienda").value = DISENO_ACTUAL.nombreTienda || "MI TIENDA";
  document.getElementById("cfgSubtituloTienda").value = DISENO_ACTUAL.subtituloTienda || "Comprobante de Control Interno";
  document.getElementById("cfgNitTienda").value = DISENO_ACTUAL.nitTienda || "";
  document.getElementById("cfgTelefonoTienda").value = DISENO_ACTUAL.telefonoTienda || "";
  document.getElementById("cfgDireccionTienda").value = DISENO_ACTUAL.direccionTienda || "";
  document.getElementById("cfgRedesTienda").value = DISENO_ACTUAL.redesTienda || "";
  document.getElementById("cfgPoliticaTicket").value = DISENO_ACTUAL.politicaTicket || "";
  if (document.getElementById("cfgLeyendaLegalTicket")) {
    document.getElementById("cfgLeyendaLegalTicket").value = (DISENO_ACTUAL.leyendaLegalTicket !== undefined)
      ? DISENO_ACTUAL.leyendaLegalTicket
      : "DOCUMENTO EXCLUSIVO DE CONTROL INTERNO DE INVENTARIO. NO TIENE VALIDEZ FISCAL NI SUSTITUYE FACTURA O DOCUMENTO TRIBUTARIO ELECTRÓNICO (DTE).";
  }
  if (document.getElementById("cfgNotaLegalPieSistema")) {
    document.getElementById("cfgNotaLegalPieSistema").value = (DISENO_ACTUAL.notaLegalPieSistema !== undefined)
      ? DISENO_ACTUAL.notaLegalPieSistema
      : "Software de Control Interno Administrativo de Inventario y Caja.";
  }
  document.getElementById("cfgFraseTicket").value = DISENO_ACTUAL.fraseTicket || "";
  document.getElementById("cfgSaludoFinalTicket").value = DISENO_ACTUAL.saludoFinalTicket || "¡GRACIAS POR SU COMPRA!";
  document.getElementById("cfgWebTicket").value = DISENO_ACTUAL.webTicket || "";

  var opacidad = parseFloat(DISENO_ACTUAL.opacidadWatermark) || 0.18;
  document.getElementById("cfgOpacidadWatermark").value = opacidad;
  document.getElementById("lblValorOpacidad").innerText = Math.round(opacidad * 100) + "%";

  document.getElementById("cfgMostrarCajeroTicket").checked = (DISENO_ACTUAL.mostrarCajeroTicket !== false);
  document.getElementById("cfgMostrarClienteTicket").checked = (DISENO_ACTUAL.mostrarClienteTicket !== false);
  document.getElementById("cfgMostrarBarcodeTicket").checked = (DISENO_ACTUAL.mostrarBarcodeTicket !== false);
  if (document.getElementById("cfgMostrarLeyendaLegalTicket")) {
    document.getElementById("cfgMostrarLeyendaLegalTicket").checked = (DISENO_ACTUAL.mostrarLeyendaLegalTicket !== false);
  }
  if (document.getElementById("cfgMostrarCampoRefFiscal")) {
    document.getElementById("cfgMostrarCampoRefFiscal").checked = (DISENO_ACTUAL.mostrarCampoRefFiscal !== false);
  }

  document.getElementById("cfgRemitenteGuia").value = DISENO_ACTUAL.remitenteGuia || DISENO_ACTUAL.nombreTienda || "MI TIENDA";
  document.getElementById("cfgTelefonoRemitenteGuia").value = DISENO_ACTUAL.telefonoRemitenteGuia || DISENO_ACTUAL.telefonoTienda || "";
  document.getElementById("cfgDireccionRemitenteGuia").value = DISENO_ACTUAL.direccionRemitenteGuia || DISENO_ACTUAL.direccionTienda || "";
  document.getElementById("cfgTituloEtiquetaGuia").value = DISENO_ACTUAL.tituloEtiquetaGuia || "ORDEN DE DESPACHO A DOMICILIO";
  document.getElementById("cfgNotaGuia").value = DISENO_ACTUAL.notaGuia || "";
  document.getElementById("cfgSelloFragilGuia").value = DISENO_ACTUAL.selloFragilGuia || "";
  document.getElementById("cfgMostrarLogoEnGuia").checked = (DISENO_ACTUAL.mostrarLogoEnGuia !== false);
  document.getElementById("cfgMostrarRepartidorEnGuia").checked = (DISENO_ACTUAL.mostrarRepartidorEnGuia !== false);

  LOGO_SUPERIOR_TEMP = DISENO_ACTUAL.logoSuperior || "";
  WATERMARK_TEMP_BASE64 = DISENO_ACTUAL.watermark || "";

  if (esRutaFotoValida(LOGO_SUPERIOR_TEMP)) {
    document.getElementById("previewLogoSuperiorBox").innerHTML = "<img src='" + escaparHTMLCore(LOGO_SUPERIOR_TEMP) + "' style='width:100%; height:100%; object-fit:contain;'>";
  } else {
    document.getElementById("previewLogoSuperiorBox").innerHTML = "<span style='font-size:9px; color:#64748b; text-align:center;'>Sin Logo</span>";
  }

  if (esRutaFotoValida(WATERMARK_TEMP_BASE64)) {
    document.getElementById("previewWatermarkBox").innerHTML = "<img src='" + escaparHTMLCore(WATERMARK_TEMP_BASE64) + "' style='width:100%; height:100%; object-fit:contain;'>";
  } else {
    document.getElementById("previewWatermarkBox").innerHTML = "<span style='font-size:9px; color:#64748b; text-align:center;'>Sin Fondo</span>";
  }

  document.getElementById("modalPersonalizarTicket").classList.add("activo");
}

function cerrarModalDiseñoTicket() {
  document.getElementById("modalPersonalizarTicket").classList.remove("activo");
  purgarPinAdminSiInventarioCerrado();
}

function comprimirImagenDiseno(file, maxDim, callback) {
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
      ctx.drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL("image/png", 0.85));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function procesarImagenLogoSuperior(event) {
  var file = event.target.files[0];
  if (!file) return;
  comprimirImagenDiseno(file, 320, function(base64) {
    LOGO_SUPERIOR_TEMP = base64;
    document.getElementById("previewLogoSuperiorBox").innerHTML = "<img src='" + escaparHTMLCore(LOGO_SUPERIOR_TEMP) + "' style='width:100%; height:100%; object-fit:contain;'>";
  });
}

function quitarImagenLogoSuperior() {
  LOGO_SUPERIOR_TEMP = "";
  document.getElementById("inputArchivoLogoSuperior").value = "";
  document.getElementById("previewLogoSuperiorBox").innerHTML = "<span style='font-size:9px; color:#64748b; text-align:center;'>Sin Logo</span>";
}

function procesarImagenWatermark(event) {
  var file = event.target.files[0];
  if (!file) return;
  comprimirImagenDiseno(file, 420, function(base64) {
    WATERMARK_TEMP_BASE64 = base64;
    document.getElementById("previewWatermarkBox").innerHTML = "<img src='" + escaparHTMLCore(WATERMARK_TEMP_BASE64) + "' style='width:100%; height:100%; object-fit:contain;'>";
  });
}

function quitarImagenWatermark() {
  WATERMARK_TEMP_BASE64 = "";
  document.getElementById("inputArchivoWatermark").value = "";
  document.getElementById("previewWatermarkBox").innerHTML = "<span style='font-size:9px; color:#64748b; text-align:center;'>Sin Fondo</span>";
}

function guardarDiseñoTicket() {
  var nuevoObj = {
    nombreTienda: document.getElementById("cfgNombreTienda").value.trim() || "MI TIENDA",
    subtituloTienda: document.getElementById("cfgSubtituloTienda").value.trim() || "Comprobante de Control Interno",
    nitTienda: document.getElementById("cfgNitTienda").value.trim(),
    telefonoTienda: document.getElementById("cfgTelefonoTienda").value.trim(),
    direccionTienda: document.getElementById("cfgDireccionTienda").value.trim(),
    redesTienda: document.getElementById("cfgRedesTienda").value.trim(),
    politicaTicket: document.getElementById("cfgPoliticaTicket").value.trim(),
    leyendaLegalTicket: document.getElementById("cfgLeyendaLegalTicket") ? document.getElementById("cfgLeyendaLegalTicket").value.trim() : DISENO_ACTUAL.leyendaLegalTicket,
    notaLegalPieSistema: document.getElementById("cfgNotaLegalPieSistema") ? document.getElementById("cfgNotaLegalPieSistema").value.trim() : DISENO_ACTUAL.notaLegalPieSistema,
    fraseTicket: document.getElementById("cfgFraseTicket").value.trim(),
    saludoFinalTicket: document.getElementById("cfgSaludoFinalTicket").value.trim() || "¡GRACIAS POR SU COMPRA!",
    webTicket: document.getElementById("cfgWebTicket").value.trim(),
    logoSuperior: LOGO_SUPERIOR_TEMP,
    watermark: WATERMARK_TEMP_BASE64,
    opacidadWatermark: parseFloat(document.getElementById("cfgOpacidadWatermark").value) || 0.18,
    mostrarCajeroTicket: document.getElementById("cfgMostrarCajeroTicket").checked,
    mostrarClienteTicket: document.getElementById("cfgMostrarClienteTicket").checked,
    mostrarBarcodeTicket: document.getElementById("cfgMostrarBarcodeTicket").checked,
    mostrarLeyendaLegalTicket: document.getElementById("cfgMostrarLeyendaLegalTicket") ? document.getElementById("cfgMostrarLeyendaLegalTicket").checked : true,
    mostrarCampoRefFiscal: document.getElementById("cfgMostrarCampoRefFiscal") ? document.getElementById("cfgMostrarCampoRefFiscal").checked : true,

    remitenteGuia: document.getElementById("cfgRemitenteGuia").value.trim() || "MI TIENDA",
    telefonoRemitenteGuia: document.getElementById("cfgTelefonoRemitenteGuia").value.trim(),
    direccionRemitenteGuia: document.getElementById("cfgDireccionRemitenteGuia").value.trim(),
    tituloEtiquetaGuia: document.getElementById("cfgTituloEtiquetaGuia").value.trim() || "ORDEN DE DESPACHO A DOMICILIO",
    notaGuia: document.getElementById("cfgNotaGuia").value.trim(),
    selloFragilGuia: document.getElementById("cfgSelloFragilGuia").value.trim(),
    mostrarLogoEnGuia: document.getElementById("cfgMostrarLogoEnGuia").checked,
    mostrarRepartidorEnGuia: document.getElementById("cfgMostrarRepartidorEnGuia").checked
  };

  var btn = document.getElementById("btnGuardarDisenoGlobal");
  btn.innerText = "Guardando...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    btn.innerText = "Guardar Diseño en Servidor";
    btn.disabled = false;
    if (res && res.exito) {
      aplicarDisenoEnDOM(res.diseno || nuevoObj);
      cerrarModalDiseñoTicket();
      mostrarAviso("Diseño Sincronizado", res.mensaje, "exito");
    } else {
      mostrarAviso("Acceso Denegado", (res && res.mensaje) || "No se pudo guardar el diseño.", "error");
    }
  }).guardarDisenoImpresion(nuevoObj, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

// ============================================================================
// 6. BITÁCORA KARDEX EN PANTALLA (CON FILTRO POR FECHAS)
// ============================================================================
var kardexGlobal = [];

function extraerFechaYMDDeTexto(fechaStr, fechaRaw) {
  if (fechaRaw) {
    var dRaw = new Date(fechaRaw);
    if (!isNaN(dRaw.getTime())) {
      return dRaw.getFullYear() + "-" + String(dRaw.getMonth() + 1).padStart(2, '0') + "-" + String(dRaw.getDate()).padStart(2, '0');
    }
  }
  if (!fechaStr) return "";
  var limpio = String(fechaStr).trim().split(",")[0].split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(limpio)) return limpio;
  var partes = limpio.split("/");
  if (partes.length === 3 && partes[2].length === 4) {
    var p0 = parseInt(partes[0], 10);
    var p1 = parseInt(partes[1], 10);
    var anio = partes[2];
    var dia = p0;
    var mes = p1;
    if (p1 > 12) { mes = p0; dia = p1; }
    return anio + "-" + String(mes).padStart(2, '0') + "-" + String(dia).padStart(2, '0');
  }
  var d = new Date(fechaStr);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
  }
  return "";
}

function abrirModalKardex() {
  document.getElementById("modalKardex").classList.add("activo");
  document.getElementById("filtroFechaKardex").value = "";
  cargarKardexConFiltro();
}

function limpiarFiltroFechaKardex() {
  document.getElementById("filtroFechaKardex").value = "";
  cargarKardexConFiltro();
}

function cargarKardexConFiltro() {
  var fechaFiltro = document.getElementById("filtroFechaKardex").value || "Todos";
  document.getElementById("listaKardexTabla").innerHTML = "<tr><td colspan='6' style='text-align:center; padding:30px; color:var(--text-muted);'>Consultando bitácora de movimientos...</td></tr>";
  document.getElementById("lblResumenKardex").innerText = "Consultando...";

  google.script.run.withSuccessHandler(function(filas) {
    kardexGlobal = Array.isArray(filas) ? filas : [];
    renderizarTablaKardex();
  }).obtenerKardex(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA, fechaFiltro);
}

function renderizarTablaKardex() {
  var fechaFiltro = document.getElementById("filtroFechaKardex").value;
  var tbody = document.getElementById("listaKardexTabla");
  var lblResumen = document.getElementById("lblResumenKardex");
  tbody.innerHTML = "";

  var filasFiltradas = kardexGlobal.filter(function(f) {
    if (!fechaFiltro || fechaFiltro === "Todos") return true;
    var fYMD = f.fechaYMD || extraerFechaYMDDeTexto(f.fecha, f.fechaISO);
    return fYMD === fechaFiltro;
  });

  lblResumen.innerText = filasFiltradas.length + " movimiento(s)";

  if (filasFiltradas.length === 0) {
    var msgVacio = fechaFiltro ? "No hay movimientos registrados en la fecha seleccionada (" + fechaFiltro + ")." : "Aún no hay movimientos registrados en el Kardex.";
    tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; padding:35px; color:var(--text-muted);'>" + msgVacio + "</td></tr>";
    return;
  }

  filasFiltradas.forEach(function(f) {
    var tr = document.createElement("tr");
    var cant = parseFloat(f.cantidad) || 0;
    var signo = cant > 0 ? "+" + cant : cant;
    var colorCant = cant > 0 ? "#10b981" : ((f.tipo || "").includes("Cortesía") ? "#a855f7" : "#ef4444");
    tr.innerHTML = "<td style='font-size:12px;'>" + escaparHTMLCore(f.fecha) + "</td>" +
                   "<td style='font-family:monospace; font-size:12px; font-weight:700;'>" + escaparHTMLCore(f.idProducto) + "</td>" +
                   "<td style='font-weight:600; font-size:13px;'>" + escaparHTMLCore(f.nombreProducto) + "</td>" +
                   "<td style='font-size:13px;'>" + escaparHTMLCore(f.tipo) + "</td>" +
                   "<td style='text-align:center; font-weight:800; font-size:15px; color:" + colorCant + ";'>" + signo + "</td>" +
                   "<td style='font-weight:700; font-size:13px; color:#38bdf8;'>" + escaparHTMLCore(f.cajero) + "</td>";
    tbody.appendChild(tr);
  });
}

function cerrarModalKardex() {
  document.getElementById("modalKardex").classList.remove("activo");
  purgarPinAdminSiInventarioCerrado();
}

// ============================================================================
// 7. ARQUEO CIEGO, BITÁCORA DE AUDITORÍA, EXPORTACIÓN CSV Y AUTO-BLOQUEO
// ============================================================================
function abrirModalArqueoCiego() {
  if (!PIN_SESION_ACTIVA) { bloquearCaja(); return; }
  document.getElementById("inputEfectivoArqueoCiego").value = "";
  document.getElementById("inputNotasArqueoCiego").value = "";
  document.getElementById("modalArqueoCiego").classList.add("activo");
  setTimeout(function() { document.getElementById("inputEfectivoArqueoCiego").focus(); }, 100);
}

function cerrarModalArqueoCiego() {
  document.getElementById("modalArqueoCiego").classList.remove("activo");
  document.getElementById("codigo").focus();
}

function confirmarArqueoCiegoUI() {
  var efectivo = parseFloat(document.getElementById("inputEfectivoArqueoCiego").value) || 0;
  var notas = document.getElementById("inputNotasArqueoCiego").value.trim();

  var btn = document.getElementById("btnGuardarArqueoCiego");
  btn.innerText = "Registrando Turno...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    btn.innerText = "✅ Registrar Entrega";
    btn.disabled = false;
    cerrarModalArqueoCiego();
    if (res && res.exito) {
      mostrarAviso("Entrega de Turno Exitosa", res.mensaje, "exito");
    } else {
      mostrarAviso("Operación Rechazada", (res && res.mensaje) || "No se pudo registrar el arqueo.", "error");
    }
  }).registrarArqueoCiegoTurno(efectivo, notas, PIN_SESION_ACTIVA);
}

var auditoriaCacheGlobal = [];

function abrirModalAuditoriaSeguridad() {
  document.getElementById("modalAuditoriaSeguridad").classList.add("activo");
  document.getElementById("filtroFechaAuditoria").value = "";
  document.getElementById("inputBuscarAuditoria").value = "";
  cargarBitacoraAuditoriaUI();
}

function cerrarModalAuditoriaSeguridad() {
  document.getElementById("modalAuditoriaSeguridad").classList.remove("activo");
  purgarPinAdminSiInventarioCerrado();
}

function cargarBitacoraAuditoriaUI() {
  var fechaFiltro = document.getElementById("filtroFechaAuditoria").value || "Todos";
  document.getElementById("listaAuditoriaSeguridad").innerHTML = "<tr><td colspan='6' style='text-align:center; padding:30px; color:var(--text-muted);'>Consultando bitácora de seguridad...</td></tr>";

  google.script.run.withSuccessHandler(function(filas) {
    auditoriaCacheGlobal = Array.isArray(filas) ? filas : [];
    renderizarTablaAuditoriaDOM();
  }).obtenerBitacoraAuditoria(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA, fechaFiltro);
}

function renderizarTablaAuditoriaDOM() {
  var filtro = (document.getElementById("inputBuscarAuditoria").value || "").toLowerCase().trim();
  var tbody = document.getElementById("listaAuditoriaSeguridad");
  tbody.innerHTML = "";

  var filtradas = auditoriaCacheGlobal.filter(function(a) {
    if (!filtro) return true;
    return (a.fecha + " " + a.evento + " " + a.detalle + " " + a.usuario + " " + a.ip + " " + a.nivel).toLowerCase().includes(filtro);
  });

  if (filtradas.length === 0) {
    tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; padding:30px; color:var(--text-muted);'>Sin eventos de seguridad que coincidan.</td></tr>";
    return;
  }

  filtradas.forEach(function(a) {
    var tr = document.createElement("tr");
    var colorNivel = "#10b981";
    var niv = (a.nivel || "").toUpperCase();
    if (niv === "CRITICO") colorNivel = "#ef4444";
    else if (niv === "ALERTA") colorNivel = "#f59e0b";

    tr.innerHTML =
      "<td style='font-size:11.5px; white-space:nowrap;'>" + escaparHTMLCore(a.fecha) + "</td>" +
      "<td><span style='font-weight:900; font-size:10px; padding:2px 6px; border-radius:4px; background:" + colorNivel + "; color:white;'>" + escaparHTMLCore(a.nivel) + "</span></td>" +
      "<td style='font-weight:700; font-size:12px;'>" + escaparHTMLCore(a.evento) + "</td>" +
      "<td style='font-size:12px; max-width:280px;'>" + escaparHTMLCore(a.detalle) + "</td>" +
      "<td style='font-weight:700; font-size:12px; color:#38bdf8;'>" + escaparHTMLCore(a.usuario) + "</td>" +
      "<td style='font-family:monospace; font-size:11.5px; color:var(--text-muted);'>" + escaparHTMLCore(a.ip) + "</td>";
    tbody.appendChild(tr);
  });
}

function exportarReporteContableUI(tipoOrigen, pinAdminDirecto) {
  var fechaFiltro = (tipoOrigen === 'corte')
    ? (document.getElementById("inputFechaCorte").value || "Todos")
    : (document.getElementById("filtroFechaHistorial").value || "Todos");

  var credencial = pinAdminDirecto || PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA;

  google.script.run.withSuccessHandler(function(res) {
    if (!res || !res.exito) {
      if (!pinAdminDirecto && typeof pedirPinSeguridad === "function") {
        pedirPinSeguridad("exportar_csv", tipoOrigen);
        var lblMotivo = document.getElementById("lblMotivoPin");
        if (lblMotivo) {
          lblMotivo.innerText = "Ingrese PIN de Administrador para exportar el reporte contable a Excel (.CSV).";
        }
        return;
      }
      mostrarAviso("Acceso Denegado", (res && res.mensaje) || "No autorizado para exportar datos contables.", "error");
      return;
    }

    var blob = new Blob([res.contenidoCSV], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = res.nombreArchivo || "REPORTE_CONTABLE_POS.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 2000);

    var corteAbierto = document.getElementById("modalCorteCaja") && document.getElementById("modalCorteCaja").classList.contains("activo");
    if (!corteAbierto) {
      purgarPinAdminSiInventarioCerrado();
    }

    mostrarAviso("Reporte Exportado", "Se exportaron " + res.totalRegistros + " registros contables (incluyendo costos, utilidades y referencias DTE) al archivo " + res.nombreArchivo, "exito");
  }).exportarReporteContableCSV(fechaFiltro, credencial);
}

function iniciarMonitorInactividadPOS() {
  ["mousemove", "keydown", "click", "touchstart"].forEach(function(evento) {
    document.addEventListener(evento, reiniciarTemporizadorInactividad, { passive: true });
  });
  reiniciarTemporizadorInactividad();
}

function reiniciarTemporizadorInactividad() {
  if (timerInactividadPOS) {
    clearTimeout(timerInactividadPOS);
  }
  timerInactividadPOS = setTimeout(verificarInactividadYBloquear, TIEMPO_INACTIVIDAD_MS);
}

function verificarInactividadYBloquear() {
  var pantallaBloqueo = document.getElementById("pantallaBloqueo");
  var cajaDesbloqueada = pantallaBloqueo && pantallaBloqueo.classList.contains("oculto") && Boolean(PIN_SESION_ACTIVA);
  if (!cajaDesbloqueada) {
    reiniciarTemporizadorInactividad();
    return;
  }

  var modalCamara = document.getElementById("modalEscanerCamara");
  var escaneandoActivo = (modalCamara && modalCamara.classList.contains("activo")) || (typeof streamCamaraActiva !== "undefined" && Boolean(streamCamaraActiva));
  var imprimiendoActivo = impresionEnCursoPOS || document.body.className.includes("modo-");

  if (escaneandoActivo || imprimiendoActivo) {
    reiniciarTemporizadorInactividad();
    return;
  }

  document.querySelectorAll(".modal-fondo.activo").forEach(function(m) {
    if (m.id === "modalLicenciaSistema" && MODO_BLOQUEO_LICENCIA_FORZADO) return;
    m.classList.remove("activo");
  });

  purgarPinAdminMemoria();
  bloquearCaja();
}

function escaparTextoJS(str) {
  if (!str) return "";
  return str.toString().replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function toggleDarkMode() {
  document.body.classList.toggle("dark-mode");
}

function bloquearCaja() {
  cerrarTodasLasSugerencias();
  var tokenCerrar = PIN_SESION_ACTIVA;
  CAJERO_ACTIVO = "Desconocido";
  PIN_SESION_ACTIVA = "";
  purgarPinAdminMemoria();

  if (tokenCerrar) {
    try {
      google.script.run.cerrarSesionToken(tokenCerrar);
    } catch (e) {}
  }

  document.getElementById("lblCajeroActivo").innerText = "Bloqueado";
  document.getElementById("inputPinAcceso").value = "";
  document.getElementById("btnVerificarAcceso").innerText = "Desbloquear Terminal";
  document.getElementById("btnVerificarAcceso").disabled = false;
  document.getElementById("pantallaBloqueo").classList.remove("oculto");
  setTimeout(function() { document.getElementById("inputPinAcceso").focus(); }, 100);
}

function setPrintMode(modo) {
  var teniaModoOscuro = document.body.classList.contains("dark-mode");
  document.body.className = ""; 
  if (teniaModoOscuro) document.body.classList.add("dark-mode"); 
  if (modo) document.body.classList.add(modo);
}

function ejecutarImpresionNativa(modo) {
  impresionEnCursoPOS = true;
  setPrintMode(modo);
  window.print();
  setTimeout(function() { impresionEnCursoPOS = false; }, 1500);
}

function mostrarAviso(titulo, texto, tipo) {
  document.getElementById("tituloMensaje").innerText = titulo;
  document.getElementById("textoMensaje").innerText = texto;
  var box = document.getElementById("iconoMensajeBox");
  box.className = "icono-modal";

  var t = (tipo || "").toString();
  if (t.includes("❌") || t.includes("🚫") || t === "error") {
    box.classList.add("icono-rojo");
    box.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
  } else if (t.includes("⚠️") || t === "alerta") {
    box.classList.add("icono-ambar");
    box.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
  } else if (t.includes("✅") || t.includes("💸") || t === "exito") {
    box.classList.add("icono-verde");
    box.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  } else {
    box.classList.add("icono-azul");
    box.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
  }
  document.getElementById("modalMensaje").classList.add("activo");
}

function cerrarModalMensaje() {
  document.getElementById("modalMensaje").classList.remove("activo");
  document.getElementById("codigo").focus();
}

function abrirFichaProductoNuevo() {
  FOTO_PRODUCTO_BASE64 = "";
  document.getElementById("tituloModalFichaProd").innerText = "Nuevo Producto";
  document.getElementById("prodInputId").value = "";
  document.getElementById("prodInputNombre").value = "";
  document.getElementById("prodInputPrecio").value = "";
  document.getElementById("prodInputCosto").value = "";
  document.getElementById("prodInputStock").value = "1";
  document.getElementById("prodInputCategoria").value = "";
  document.getElementById("previewFotoContainer").innerHTML = "<span style='font-size:11px; color:var(--text-muted); text-align:center;'>Sin Foto</span>";
  document.getElementById("contenedorBarcodePreview").style.display = "none";
  document.getElementById("btnEliminarProdMaster").style.display = "none";
  document.getElementById("modalFichaProducto").classList.add("activo");
}

function abrirFichaEditarProducto(idProd) {
  google.script.run.withSuccessHandler(function(prod) {
    if (!prod || !prod.encontrado) return;
    FOTO_PRODUCTO_BASE64 = prod.foto || "";
    document.getElementById("tituloModalFichaProd").innerText = "Editar Producto";
    document.getElementById("prodInputId").value = prod.idProducto;
    document.getElementById("prodInputNombre").value = prod.nombre;
    document.getElementById("prodInputPrecio").value = prod.precioOriginal;
    document.getElementById("prodInputCosto").value = prod.costo || 0;
    document.getElementById("prodInputStock").value = prod.stock;
    document.getElementById("prodInputCategoria").value = prod.categoria || "";
    
    if (esRutaFotoValida(FOTO_PRODUCTO_BASE64)) {
      document.getElementById("previewFotoContainer").innerHTML = "<img src='" + escaparHTMLCore(FOTO_PRODUCTO_BASE64) + "' style='width:100%; height:100%; object-fit:cover;'>";
    } else {
      document.getElementById("previewFotoContainer").innerHTML = "<span style='font-size:11px; color:var(--text-muted); text-align:center;'>Sin Foto</span>";
    }
    actualizarPreviewBarcodeProd();
    document.getElementById("btnEliminarProdMaster").style.display = "inline-block";
    document.getElementById("modalFichaProducto").classList.add("activo");
  }).buscarProducto(idProd, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function cerrarFichaProducto() {
  document.getElementById("modalFichaProducto").classList.remove("activo");
  purgarPinAdminSiInventarioCerrado();
}

function procesarFotoCapturada(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var canvas = document.createElement("canvas");
      var maxDim = 360;
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
      ctx.drawImage(img, 0, 0, w, h);
      FOTO_PRODUCTO_BASE64 = canvas.toDataURL("image/jpeg", 0.75);
      document.getElementById("previewFotoContainer").innerHTML = "<img src='" + escaparHTMLCore(FOTO_PRODUCTO_BASE64) + "' style='width:100%; height:100%; object-fit:cover;'>";
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function limpiarFotoProducto() {
  FOTO_PRODUCTO_BASE64 = "";
  document.getElementById("inputArchivoFoto").value = "";
  document.getElementById("previewFotoContainer").innerHTML = "<span style='font-size:11px; color:var(--text-muted); text-align:center;'>Sin Foto</span>";
}

function guardarFichaProducto() {
  var obj = {
    id: document.getElementById("prodInputId").value.trim(),
    nombre: document.getElementById("prodInputNombre").value.trim(),
    precio: parseFloat(document.getElementById("prodInputPrecio").value) || 0,
    costo: parseFloat(document.getElementById("prodInputCosto").value) || 0,
    stock: parseFloat(document.getElementById("prodInputStock").value) || 0,
    categoria: document.getElementById("prodInputCategoria").value.trim(),
    foto: FOTO_PRODUCTO_BASE64
  };
  if (!obj.id || !obj.nombre) {
    mostrarAviso("Faltan Datos", "El Código de Barras y el Nombre son obligatorios.", "alerta");
    return;
  }
  var btn = document.getElementById("btnGuardarProdMaster");
  btn.innerText = "Guardando...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    btn.innerText = "Guardar Producto";
    btn.disabled = false;
    if (res.exito) {
      cerrarFichaProducto();
      mostrarAviso("Producto Guardado", res.mensaje, "exito");
      if (document.getElementById("modalInventario").classList.contains("activo")) {
        google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
      }
    } else {
      mostrarAviso("Error", res.mensaje, "error");
    }
  }).guardarProductoMaster(obj, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA, CAJERO_ACTIVO);
}

function borrarProductoActual() {
  var id = document.getElementById("prodInputId").value.trim();
  if (!id) return;
  google.script.run.withSuccessHandler(function(res) {
    if (res.exito) {
      cerrarFichaProducto();
      mostrarAviso("Producto Eliminado", res.mensaje, "exito");
      google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
    } else {
      mostrarAviso("Error", res.mensaje, "error");
    }
  }).eliminarProductoMaster(id, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function iniciarProcesoCortesia() {
  if (!PIN_SESION_ACTIVA) { bloquearCaja(); return; }
  if (carrito.length === 0) {
    mostrarAviso("Carrito Vacío", "Primero escanea o agrega al carrito el producto que vas a retirar por cortesía o uso propio.", "alerta");
    return;
  }
  pedirPinSeguridad('cortesia', '');
}

function procesarSalidaCortesia(pinAdminAutorizado) {
  var motivo = document.getElementById("nombreCliente").value.trim() || ("Uso Propio / Cortesía (" + CAJERO_ACTIVO + ")");
  var telefono = document.getElementById("telefonoCliente").value.trim() || "N/A";
  var direccion = "Retiro de Inventario (Cortesía)";
  var datosExtra = {
    repartidor: "",
    tarifa: 0,
    anticipo: 0,
    refFiscal: "",
    pinAdmin: pinAdminAutorizado || PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA
  };

  document.getElementById("btnCobrar").innerHTML = "<span>PROCESANDO CORTESÍA...</span>";
  document.getElementById("btnCobrar").disabled = true;

  google.script.run
    .withSuccessHandler(function(mensaje) {
      if (mensaje.includes("Error")) {
        mostrarAviso("Operación Rechazada", mensaje, "error");
        document.getElementById("btnCobrar").innerHTML = '<span>Procesar Pago</span><span class="kbd-inline">+</span>';
        document.getElementById("btnCobrar").disabled = false;
        return;
      }
      var partesMsg = String(mensaje).split("|");
      var idTicketServidor = partesMsg.length > 1 ? partesMsg[1].trim() : ("CORTESIA-" + String(Date.now()).slice(-6));
      document.getElementById("nombreCliente").value = motivo;
      document.getElementById("selectMetodoPago").value = "Efectivo (Local)";
      totalFinal = 0;
      ventaExitosaCortesia(motivo, idTicketServidor);
    })
    .registrarVenta(carrito, 0, motivo, telefono, direccion, "Cortesía / Uso Propio", subtotalBruto, CAJERO_ACTIVO, datosExtra, PIN_SESION_ACTIVA);
}

function ventaExitosaCortesia(motivo, idTicketReal) {
  document.getElementById("ticket-fecha").innerText = new Date().toLocaleDateString();
  document.getElementById("ticket-cliente").innerText = motivo;
  document.getElementById("fila-ticket-tel").style.display = "none";
  document.getElementById("fila-ticket-dir").style.display = "none";
  if (document.getElementById("fila-ticket-ref-fiscal")) {
    document.getElementById("fila-ticket-ref-fiscal").style.display = "none";
  }
  document.getElementById("ticket-metodo").innerText = "CORTESÍA / USO PROPIO";
  document.getElementById("ticket-cajero-print").innerText = CAJERO_ACTIVO;
  document.getElementById("ticket-tipo-comprobante").innerText = "VALE DE CORTESÍA / USO PROPIO";
  document.getElementById("ticket-zona-anticipo").style.display = "none";
  document.getElementById("ticket-descuento-monto").innerText = "0.00";

  var tbodyTicket = document.getElementById("ticket-items");
  tbodyTicket.innerHTML = "";
  for (var i = 0; i < carrito.length; i++) {
    var tr = document.createElement("tr");
    var descItem = carrito[i].cantidad > 1 ? (carrito[i].cantidad + "x " + carrito[i].nombre) : carrito[i].nombre;
    tr.innerHTML = "<td>" + escaparHTMLCore(descItem) + "</td><td>$0.00</td>";
    tbodyTicket.appendChild(tr);
  }
  document.getElementById("ticket-total-monto").innerText = "0.00";
  renderizarBarcodeTicketInferior(idTicketReal || ("CORTESIA-" + String(Date.now()).slice(-6)));

  var cajaExito = document.getElementById("cajaCambioExito");
  cajaExito.innerHTML = "<span style='color:#a855f7;'>🎁 Cortesía / Uso Propio Registrado<br><small style='color:var(--text-muted); font-size:13px;'>Stock descontado sin afectar el efectivo en caja.</small></span>";
  cajaExito.style.display = "block";
  document.getElementById("ventanaExito").classList.add("activo");

  carrito = [];
  try { localStorage.removeItem("pos_carrito_backup"); } catch(e) {}
  document.getElementById("pagoCliente").value = "";
  document.getElementById("nombreCliente").value = "";
  document.getElementById("telefonoCliente").value = "";
  document.getElementById("direccionCliente").value = "";
  if (document.getElementById("inputRefFiscalVenta")) {
    document.getElementById("inputRefFiscalVenta").value = "";
  }
  if (typeof limpiarBadgeClienteVIP === "function") limpiarBadgeClienteVIP();
  actualizarPantalla();
  document.getElementById("btnCobrar").innerHTML = '<span>Procesar Pago</span><span class="kbd-inline">+</span>';
  document.getElementById("btnCobrar").disabled = false;
}

function abrirModalUsuarios() {
  document.getElementById("modalGestionUsuarios").classList.add("activo");
  cargarListaUsuariosUI();
}

function cerrarModalUsuarios() {
  document.getElementById("modalGestionUsuarios").classList.remove("activo");
  purgarPinAdminSiInventarioCerrado();
}

function cargarListaUsuariosUI() {
  google.script.run.withSuccessHandler(function(lista) {
    var tbody = document.getElementById("listaUsuariosMaster");
    tbody.innerHTML = "";
    lista.forEach(function(u) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><b>" + escaparHTMLCore(u.nombre) + "</b></td>" +
        "<td style='font-family:monospace; color:var(--text-muted);'>" + escaparHTMLCore(u.pin) + "</td>" +
        "<td>" + escaparHTMLCore(u.rol.toUpperCase()) + "</td>" +
        "<td style='text-align:right;'><button class='btn-eliminar' onclick=\"borrarUsuarioUI('" + escaparTextoJS(u.nombre) + "')\">Quitar</button></td>";
      tbody.appendChild(tr);
    });
  }).obtenerUsuariosMaster(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function guardarUsuarioUI() {
  var nombre = document.getElementById("userNombreInput").value.trim();
  var pin = document.getElementById("userPinInput").value.trim();
  var rol = document.getElementById("userRolInput").value;
  google.script.run.withSuccessHandler(function(res) {
    if (res.exito) {
      document.getElementById("userNombreInput").value = "";
      document.getElementById("userPinInput").value = "";
      cargarListaUsuariosUI();
    } else {
      mostrarAviso("Error", res.mensaje, "error");
    }
  }).guardarUsuarioMaster({ nombre: nombre, pin: pin, rol: rol }, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function borrarUsuarioUI(identificador) {
  google.script.run.withSuccessHandler(function(res) {
    if (res.exito) cargarListaUsuariosUI();
    else mostrarAviso("Error", res.mensaje, "error");
  }).eliminarUsuarioMaster(identificador, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}