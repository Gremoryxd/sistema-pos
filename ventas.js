// ============================================================================
// 1. VENTAS EN ESPERA (PAUSAR CARRITO [F4]), PAGOS MIXTOS Y CLIENTE VIP
// ============================================================================
function guardarVentasEnEsperaLocal() {
  try {
    if (ventasEnEspera.length > 0) {
      localStorage.setItem("pos_ventas_espera", JSON.stringify(ventasEnEspera));
    } else {
      localStorage.removeItem("pos_ventas_espera");
    }
  } catch (e) {}
}

function restaurarVentasEnEsperaLocal() {
  try {
    var guardado = localStorage.getItem("pos_ventas_espera");
    if (guardado) {
      var parsed = JSON.parse(guardado);
      if (Array.isArray(parsed)) {
        ventasEnEspera = parsed;
        renderizarBarraVentasEspera();
      }
    }
  } catch (e) {}
}

function renderizarBarraVentasEspera() {
  var contenedor = document.getElementById("barraVentasEspera");
  if (!contenedor) return;

  if (!ventasEnEspera || ventasEnEspera.length === 0) {
    contenedor.classList.remove("activo");
    contenedor.innerHTML = "";
    return;
  }

  var html = "<span style='font-size:11px; font-weight:800; color:#d97706; text-transform:uppercase;'>⏸️ En Espera (" + ventasEnEspera.length + "):</span>";
  ventasEnEspera.forEach(function(v, idx) {
    html +=
      "<div class='chip-venta-espera' onclick='recuperarVentaEnEspera(" + idx + ")' title='Clic para retomar esta cuenta'>" +
        "<span>👤 " + escaparHTMLSeguro(v.etiqueta) + " ($" + parseFloat(v.total).toFixed(2) + ")</span>" +
        "<span class='btn-cerrar-espera' onclick='event.stopPropagation(); eliminarVentaEnEspera(" + idx + ")' title='Descartar'>✕</span>" +
      "</div>";
  });

  contenedor.innerHTML = html;
  contenedor.classList.add("activo");
}

function ponerCarritoEnEspera() {
  if (!PIN_SESION_ACTIVA) { bloquearCaja(); return; }
  if (carrito.length === 0) {
    mostrarAviso("Carrito Vacío", "Agrega al menos un producto antes de poner la cuenta en espera.", "alerta");
    return;
  }

  var nom = document.getElementById("nombreCliente").value.trim();
  var tel = document.getElementById("telefonoCliente").value.trim();
  var dir = document.getElementById("direccionCliente").value.trim();
  var refF = document.getElementById("inputRefFiscalVenta") ? document.getElementById("inputRefFiscalVenta").value.trim() : "";
  var hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  var etiqueta = nom || (tel ? ("Tel: " + tel) : ("Cliente " + hora));

  ventasEnEspera.push({
    etiqueta: etiqueta,
    carrito: JSON.parse(JSON.stringify(carrito)),
    nombre: nom,
    telefono: tel,
    direccion: dir,
    refFiscal: refF,
    metodoPago: document.getElementById("selectMetodoPago").value,
    total: totalFinal
  });

  carrito = [];
  document.getElementById("nombreCliente").value = "";
  document.getElementById("telefonoCliente").value = "";
  document.getElementById("direccionCliente").value = "";
  if (document.getElementById("inputRefFiscalVenta")) {
    document.getElementById("inputRefFiscalVenta").value = "";
  }
  document.getElementById("pagoCliente").value = "";
  limpiarBadgeClienteVIP();
  guardarVentasEnEsperaLocal();
  renderizarBarraVentasEspera();
  actualizarPantalla();
  document.getElementById("codigo").focus();
}

function recuperarVentaEnEspera(idx) {
  var itemEspera = ventasEnEspera[idx];
  if (!itemEspera) return;

  if (carrito.length > 0) {
    ponerCarritoEnEspera();
  }

  carrito = itemEspera.carrito || [];
  document.getElementById("nombreCliente").value = itemEspera.nombre || "";
  document.getElementById("telefonoCliente").value = itemEspera.telefono || "";
  document.getElementById("direccionCliente").value = itemEspera.direccion || "";
  if (document.getElementById("inputRefFiscalVenta")) {
    document.getElementById("inputRefFiscalVenta").value = itemEspera.refFiscal || "";
  }
  if (itemEspera.metodoPago) {
    document.getElementById("selectMetodoPago").value = itemEspera.metodoPago;
    document.getElementById("selectMetodoPago").dispatchEvent(new Event('change'));
  }

  ventasEnEspera.splice(idx, 1);
  guardarVentasEnEsperaLocal();
  renderizarBarraVentasEspera();
  actualizarPantalla();
  if (typeof reproducirBeepEscaner === "function") reproducirBeepEscaner();
}

function eliminarVentaEnEspera(idx) {
  ventasEnEspera.splice(idx, 1);
  guardarVentasEnEsperaLocal();
  renderizarBarraVentasEspera();
}

function pagoRapido(monto) {
  var pagoInput = document.getElementById("pagoCliente");
  var metodo = document.getElementById("selectMetodoPago").value;
  var usaEfectivo = metodo.includes("Efectivo") || metodo.includes("Pago Mixto") || (metodo.includes("Apartado") && document.getElementById("selectMetodoAnticipo").value === "Efectivo");
  if (!usaEfectivo) return;

  if (monto === 'exacto') {
    var objetivo = totalFinal;
    if (metodo.includes("Apartado")) {
      objetivo = parseFloat(document.getElementById("inputMontoAnticipo").value) || 0;
    } else if (metodo.includes("Pago Mixto")) {
      objetivo = parseFloat(document.getElementById("inputMixtoEfectivo").value) || 0;
    }
    pagoInput.value = objetivo.toFixed(2);
  } else {
    pagoInput.value = monto.toFixed(2);
  }
  calcularCambio();
}

function actualizarMetodoAnticipo() {
  var subMetodo = document.getElementById("selectMetodoAnticipo").value;
  var pagoInput = document.getElementById("pagoCliente");
  var cambioText = document.getElementById("cambioCliente");

  if (subMetodo === "Efectivo") {
    pagoInput.disabled = false;
    document.getElementById("botonesDineroRapido").style.display = "flex";
  } else {
    pagoInput.value = "";
    pagoInput.disabled = true;
    cambioText.innerText = "0.00";
    document.getElementById("botonesDineroRapido").style.display = "none";
  }
}

function recalcularPagoMixto() {
  var efMixto = parseFloat(document.getElementById("inputMixtoEfectivo").value) || 0;
  if (efMixto < 0) efMixto = 0;
  if (efMixto > totalFinal) efMixto = totalFinal;

  var restanteBanco = Math.max(0, totalFinal - efMixto);
  document.getElementById("lblMixtoTransferencia").innerText = restanteBanco.toFixed(2);

  var pagoInput = document.getElementById("pagoCliente");
  if (!pagoInput.value || parseFloat(pagoInput.value) < efMixto) {
    pagoInput.value = efMixto > 0 ? efMixto.toFixed(2) : "";
  }
  calcularCambio();
}

document.getElementById("selectMetodoPago").addEventListener("change", function() {
  var metodo = this.value;
  var pagoInput = document.getElementById("pagoCliente");
  var cambioText = document.getElementById("cambioCliente");
  
  document.getElementById("cajaDatosEnvio").style.display = metodo.includes("Envío") ? "block" : "none";
  document.getElementById("cajaAnticipo").style.display = metodo.includes("Apartado") ? "block" : "none";
  document.getElementById("cajaPagoMixto").style.display = metodo.includes("Pago Mixto") ? "block" : "none";

  if (metodo.includes("Efectivo") || metodo.includes("Pago Mixto")) {
    pagoInput.disabled = false;
    document.getElementById("botonesDineroRapido").style.display = "flex";
    if (metodo.includes("Pago Mixto")) recalcularPagoMixto();
  } else if (metodo.includes("Apartado")) {
    actualizarMetodoAnticipo();
  } else {
    pagoInput.value = "";
    pagoInput.disabled = true;
    cambioText.innerText = "0.00";
    document.getElementById("botonesDineroRapido").style.display = "none";
  }
  actualizarPantalla();
});

document.getElementById("inputPinAcceso").addEventListener("keypress", function(event) {
  if (event.key === "Enter") verificarAccesoInicial();
});

function verificarAccesoInicial() {
  var pin = document.getElementById("inputPinAcceso").value;
  if (pin === "") return;
  document.getElementById("btnVerificarAcceso").innerText = "Verificando...";
  document.getElementById("btnVerificarAcceso").disabled = true;

  google.script.run.withSuccessHandler(function(respuesta) {
    if (respuesta && respuesta.valido) {
      CAJERO_ACTIVO = respuesta.nombreCajero;
      PIN_SESION_ACTIVA = respuesta.tokenSesion || pin;
      PIN_ADMIN_INVENTARIO = "";
      document.getElementById("inputPinAcceso").value = "";
      document.getElementById("lblCajeroActivo").innerText = CAJERO_ACTIVO + " [Cambiar]";
      document.getElementById("pantallaBloqueo").classList.add("oculto");
      
      var localHoyStr = obtenerFechaLocalHoyYMD();
      document.getElementById("filtroFechaHistorial").value = localHoyStr;
      document.getElementById("inputFechaCorte").value = localHoyStr;
      
      if (respuesta.licencia && typeof aplicarEstadoLicenciaEnUI === "function") {
        aplicarEstadoLicenciaEnUI(respuesta.licencia);
      } else if (typeof verificarEstadoLicenciaServidor === "function") {
        verificarEstadoLicenciaServidor(false);
      }

      if (typeof reiniciarTemporizadorInactividad === "function") {
        reiniciarTemporizadorInactividad();
      }

      cargarDiseñoTicketGuardado();
      document.getElementById("codigo").focus();
    } else {
      document.getElementById("btnVerificarAcceso").innerText = "Desbloquear Terminal";
      document.getElementById("btnVerificarAcceso").disabled = false;
      document.getElementById("inputPinAcceso").value = "";
      if (respuesta && respuesta.bloqueado) {
        mostrarAviso("Terminal Protegida", respuesta.mensaje || "Demasiados intentos fallidos. Espere unos minutos.", "alerta");
      } else {
        mostrarAviso("Acceso Denegado", "El código PIN ingresado no es válido.", "error");
      }
    }
  }).validarPinAcceso(pin);
}

function limpiarBadgeClienteVIP() {
  var badge = document.getElementById("badgeClienteVIP");
  if (!badge) return;
  badge.classList.remove("activo");
  badge.innerHTML = "";
}

document.getElementById("telefonoCliente").addEventListener("input", function() {
  if (this.value.trim() === "") limpiarBadgeClienteVIP();
});

function buscarClientePorTeclado(event) {
  if (event.key === "Enter") {
    var telefono = document.getElementById("telefonoCliente").value.trim();
    if (telefono === "") return;
    document.getElementById("nombreCliente").placeholder = "Buscando...";
    google.script.run.withSuccessHandler(function(cliente) {
      if (cliente && cliente.encontrado) {
        if (typeof reproducirBeepEscaner === "function") reproducirBeepEscaner();
        document.getElementById("nombreCliente").value = cliente.nombre;
        document.getElementById("direccionCliente").value = cliente.direccion;

        var badge = document.getElementById("badgeClienteVIP");
        if (badge) {
          var compras = parseInt(cliente.totalCompras) || 0;
          var acumulado = parseFloat(cliente.montoAcumulado) || 0;
          var iconoVip = compras >= 5 ? "⭐ Cliente Frecuente VIP" : "🛍️ Cliente Registrado";
          badge.innerHTML =
            "<span>" + iconoVip + " (" + compras + " compra" + (compras === 1 ? "" : "s") + ")</span>" +
            "<span>Total Histórico: $" + acumulado.toFixed(2) + "</span>";
          badge.classList.add("activo");
        }
        document.getElementById("selectMetodoPago").focus(); 
      } else {
        limpiarBadgeClienteVIP();
        document.getElementById("nombreCliente").placeholder = "Nombre Completo";
        mostrarAviso("Nuevo Registro", "El teléfono se guardará automáticamente al procesar la venta.", "info");
        document.getElementById("nombreCliente").focus();
      }
    }).buscarClientePorTelefono(telefono);
  }
}

document.getElementById("codigo").addEventListener("keypress", function(event) {
  if (event.key === "Enter") {
    var codigoOriginal = this.value.trim(); 
    var codigoMayusculas = codigoOriginal.toUpperCase(); 
    if (codigoOriginal === "") return;
    cerrarTodasLasSugerencias();
    if (codigoMayusculas.startsWith("TICKET-")) {
      document.getElementById("codigo").value = "";
      abrirDetalleTicket(codigoMayusculas);
      return;
    }
    document.getElementById("codigo").disabled = true;
    google.script.run.withSuccessHandler(agregarAlTicket).buscarProducto(codigoOriginal);
  }
});

document.getElementById("inputPinSeguridad").addEventListener("keypress", function(event) {
  if (event.key === "Enter") confirmarPinSeguridad();
});

function agregarAlTicket(producto) {
  document.getElementById("codigo").disabled = false;
  document.getElementById("codigo").value = "";
  document.getElementById("codigo").focus();

  if (producto && producto.encontrado) {
    if (producto.stock <= 0) {
      mostrarAviso("Sin Existencias", "El producto se encuentra agotado en inventario.", "alerta");
      return;
    }
    var index = carrito.findIndex(function(p) { return p.idProducto === producto.idProducto; });
    if (index !== -1) {
      if (carrito[index].cantidad + 1 > producto.stock) {
        mostrarAviso("Límite de Stock", "Solo hay " + producto.stock + " unidades disponibles.", "alerta");
        return;
      }
      carrito[index].cantidad += 1;
      carrito[index].stockMax = producto.stock;
    } else {
      carrito.push({
        idProducto: producto.idProducto,
        nombre: producto.nombre,
        precioOriginal: producto.precioOriginal,
        precioFinal: producto.precioFinal,
        cantidad: 1,
        stockMax: producto.stock
      });
    }
    if (typeof reproducirBeepEscaner === "function") reproducirBeepEscaner();
    actualizarPantalla();
  } else {
    mostrarAviso("No Encontrado", "No se encontró ningún producto con ese código o nombre.", "error");
  }
}

function cambiarCantidadCarrito(index, cambio) {
  if (!carrito[index]) return;
  var nuevaCant = carrito[index].cantidad + cambio;
  if (nuevaCant <= 0) {
    eliminarDelCarrito(index);
    return;
  }
  if (carrito[index].stockMax && nuevaCant > carrito[index].stockMax) {
    mostrarAviso("Límite de Stock", "Solo hay " + carrito[index].stockMax + " unidades disponibles.", "alerta");
    return;
  }
  carrito[index].cantidad = nuevaCant;
  actualizarPantalla();
}

function eliminarDelCarrito(index) {
  carrito.splice(index, 1);
  actualizarPantalla();
}

function actualizarPantalla() {
  var tbody = document.getElementById("listaProductos");
  tbody.innerHTML = "";
  subtotalBruto = 0;
  descuentoAplicadoTotal = 0;

  for (var i = 0; i < carrito.length; i++) {
    var item = carrito[i];
    subtotalBruto += (item.precioOriginal * item.cantidad);
    descuentoAplicadoTotal += ((item.precioOriginal - item.precioFinal) * item.cantidad);

    var tr = document.createElement("tr");
    var celdaPrecio = "$" + item.precioFinal.toFixed(2);
    if (item.precioOriginal > item.precioFinal) {
      celdaPrecio = "<del style='color:#ef4444; font-size:12px;'>$" + item.precioOriginal.toFixed(2) + "</del><br>$" + item.precioFinal.toFixed(2);
    }
    var controlesCant = "<div class='ctrl-cantidad'><button onclick='cambiarCantidadCarrito(" + i + ", -1)'>-</button><span>" + item.cantidad + "</span><button onclick='cambiarCantidadCarrito(" + i + ", 1)'>+</button></div>";
    tr.innerHTML = "<td style='font-weight:500;'>" + escaparHTMLSeguro(item.nombre) + "</td><td style='text-align:center;'>" + controlesCant + "</td><td>" + celdaPrecio + "</td><td style='font-weight:700;'>$" + (item.precioFinal * item.cantidad).toFixed(2) + "</td><td style='text-align:right;'><button class='btn-eliminar' onclick='eliminarDelCarrito(" + i + ")'>Quitar</button></td>";
    tbody.appendChild(tr);
  }
  
  var tarifaEnvio = 0;
  var metodoPago = document.getElementById("selectMetodoPago").value;
  
  if (metodoPago.includes("Envío")) {
    tarifaEnvio = parseFloat(document.getElementById("inputTarifaEnvio").value) || 0;
    if (tarifaEnvio > 0) {
      document.getElementById("lineaTarifaEnvio").style.display = "flex";
      document.getElementById("montoTarifaEnvio").innerText = tarifaEnvio.toFixed(2);
    } else {
      document.getElementById("lineaTarifaEnvio").style.display = "none";
    }
  } else {
    document.getElementById("lineaTarifaEnvio").style.display = "none";
  }

  totalFinal = subtotalBruto - descuentoAplicadoTotal + tarifaEnvio;
  
  document.getElementById("subtotalVenta").innerText = subtotalBruto.toFixed(2);
  document.getElementById("descuentoVenta").innerText = descuentoAplicadoTotal.toFixed(2);
  document.getElementById("totalVenta").innerText = totalFinal.toFixed(2);

  if (metodoPago.includes("Pago Mixto")) {
    var efMixto = parseFloat(document.getElementById("inputMixtoEfectivo").value) || 0;
    var restBanco = Math.max(0, totalFinal - efMixto);
    document.getElementById("lblMixtoTransferencia").innerText = restBanco.toFixed(2);
  }

  calcularCambio();

  try {
    if (carrito.length > 0) {
      localStorage.setItem("pos_carrito_backup", JSON.stringify(carrito));
    } else {
      localStorage.removeItem("pos_carrito_backup");
    }
  } catch(e) {}
}

function calcularCambio() {
  var metodoPago = document.getElementById("selectMetodoPago").value;
  var pago = parseFloat(document.getElementById("pagoCliente").value) || 0;
  var targetTotal = totalFinal;
  
  if (metodoPago.includes("Apartado")) {
    targetTotal = parseFloat(document.getElementById("inputMontoAnticipo").value) || 0;
  } else if (metodoPago.includes("Pago Mixto")) {
    targetTotal = parseFloat(document.getElementById("inputMixtoEfectivo").value) || 0;
  }
  
  var cambio = pago - targetTotal;
  if (cambio < 0 || targetTotal === 0) {
    document.getElementById("cambioCliente").innerText = "0.00";
  } else {
    document.getElementById("cambioCliente").innerText = cambio.toFixed(2);
  }
}

(function restaurarRespaldoCarrito() {
  try {
    var guardado = localStorage.getItem("pos_carrito_backup");
    if (guardado) {
      var parseado = JSON.parse(guardado);
      if (Array.isArray(parseado) && parseado.length > 0) {
        carrito = parseado;
        actualizarPantalla();
      }
    }
  } catch(e) {}
})();

function procesarCobro() {
  if (!PIN_SESION_ACTIVA) { bloquearCaja(); return; }
  if (carrito.length === 0) {
    mostrarAviso("Carrito Vacío", "Agregue al menos un artículo antes de cobrar.", "alerta");
    return;
  }
  var metodoPago = document.getElementById("selectMetodoPago").value;
  var pago = parseFloat(document.getElementById("pagoCliente").value) || 0;
  var refFiscalVal = document.getElementById("inputRefFiscalVenta") ? document.getElementById("inputRefFiscalVenta").value.trim() : "";
  var datosExtra = { repartidor: "", tarifa: 0, anticipo: 0, refFiscal: refFiscalVal };

  if (metodoPago.includes("Efectivo")) {
    if (pago < totalFinal || document.getElementById("pagoCliente").value === "") { 
      mostrarAviso("Importe Insuficiente", "Ingrese el efectivo recibido del cliente (mayor o igual al total).", "alerta");
      return; 
    }
  }
  
  if (metodoPago.includes("Envío")) {
    datosExtra.repartidor = document.getElementById("inputRepartidor").value;
    datosExtra.tarifa = parseFloat(document.getElementById("inputTarifaEnvio").value) || 0;
  }

  if (metodoPago.includes("Pago Mixto")) {
    var efMixto = parseFloat(document.getElementById("inputMixtoEfectivo").value) || 0;
    var bancoMixto = document.getElementById("selectMixtoBanco").value || "Agrícola";
    if (efMixto <= 0 || efMixto >= totalFinal) {
      mostrarAviso("Desglose Mixto Inválido", "En Pago Mixto, la parte en Efectivo debe ser mayor a $0.00 y menor al Total ($" + totalFinal.toFixed(2) + ").", "alerta");
      return;
    }
    if (pago < efMixto) {
      mostrarAviso("Efectivo Insuficiente", "El efectivo recibido debe cubrir al menos la parte en efectivo ($" + efMixto.toFixed(2) + ").", "alerta");
      return;
    }
    datosExtra.mixtoEfectivo = efMixto;
    datosExtra.mixtoBanco = bancoMixto;
  }
  
  if (metodoPago.includes("Apartado")) {
    var subMetodo = document.getElementById("selectMetodoAnticipo").value;
    datosExtra.anticipo = parseFloat(document.getElementById("inputMontoAnticipo").value) || 0;
    
    if (datosExtra.anticipo <= 0) {
      mostrarAviso("Anticipo Requerido", "Indique el monto del abono dejado por el cliente.", "alerta");
      return;
    }
    
    if (subMetodo === "Efectivo") {
      if (pago < datosExtra.anticipo || document.getElementById("pagoCliente").value === "") {
        mostrarAviso("Importe Insuficiente", "Ingrese cuánto efectivo entregó el cliente para cubrir el anticipo.", "alerta");
        return;
      }
    }
    metodoPago = "Apartado (" + subMetodo + ")";
  }

  document.getElementById("btnCobrar").innerHTML = "<span>PROCESANDO...</span>";
  document.getElementById("btnCobrar").disabled = true;
  var nombre = document.getElementById("nombreCliente").value || "Cliente Mostrador";
  var telefono = document.getElementById("telefonoCliente").value || "N/A";
  var direccion = document.getElementById("direccionCliente").value || "N/A";
  
  google.script.run
    .withSuccessHandler(ventaExitosa)
    .withFailureHandler(function() {
      mostrarAviso("Error de Red", "No se pudo conectar con el servidor. Verifique su conexión e intente de nuevo.", "error");
      document.getElementById("btnCobrar").innerHTML = '<span>Procesar Pago</span><span class="kbd-inline">+</span>';
      document.getElementById("btnCobrar").disabled = false;
    })
    .registrarVenta(carrito, totalFinal, nombre, telefono, direccion, metodoPago, descuentoAplicadoTotal, CAJERO_ACTIVO, datosExtra, PIN_SESION_ACTIVA);
}

function ventaExitosa(mensaje) {
  if (String(mensaje).includes("Error")) {
    mostrarAviso("Operación Rechazada", mensaje, "error");
    document.getElementById("btnCobrar").innerHTML = '<span>Procesar Pago</span><span class="kbd-inline">+</span>';
    document.getElementById("btnCobrar").disabled = false;
    return;
  }

  var partesRespuesta = String(mensaje).split("|");
  var idTicketReal = partesRespuesta.length > 1 ? partesRespuesta[1].trim() : ("TICKET-" + String(Date.now()).slice(-6));

  var metodoPago = document.getElementById("selectMetodoPago").value;
  var datosExtraAnticipo = parseFloat(document.getElementById("inputMontoAnticipo").value) || 0;
  var telVal = document.getElementById("telefonoCliente").value.trim();
  var dirVal = document.getElementById("direccionCliente").value.trim();
  var refFiscalVal = document.getElementById("inputRefFiscalVenta") ? document.getElementById("inputRefFiscalVenta").value.trim() : "";

  var textoMetodoTicket = metodoPago;
  if (metodoPago.includes("Pago Mixto")) {
    var efM = parseFloat(document.getElementById("inputMixtoEfectivo").value) || 0;
    var trM = Math.max(0, totalFinal - efM);
    var bcoM = document.getElementById("selectMixtoBanco").value || "Agrícola";
    textoMetodoTicket = "Mixto (Ef:$" + efM.toFixed(2) + " + " + bcoM + ":$" + trM.toFixed(2) + ")";
  }

  document.getElementById("ticket-fecha").innerText = new Date().toLocaleDateString();
  document.getElementById("ticket-cliente").innerText = document.getElementById("nombreCliente").value || "Cliente Mostrador";
  document.getElementById("ticket-telefono").innerText = telVal || "N/A";
  document.getElementById("ticket-direccion").innerText = dirVal || "N/A";
  document.getElementById("fila-ticket-tel").style.display = (telVal && DISENO_ACTUAL.mostrarClienteTicket !== false) ? "flex" : "none";
  document.getElementById("fila-ticket-dir").style.display = (dirVal && DISENO_ACTUAL.mostrarClienteTicket !== false) ? "flex" : "none";

  var filaRefFiscal = document.getElementById("fila-ticket-ref-fiscal");
  var txtRefFiscal = document.getElementById("ticket-ref-fiscal");
  if (filaRefFiscal && txtRefFiscal) {
    txtRefFiscal.innerText = refFiscalVal;
    filaRefFiscal.style.display = refFiscalVal ? "flex" : "none";
  }

  document.getElementById("ticket-metodo").innerText = textoMetodoTicket;
  document.getElementById("ticket-cajero-print").innerText = CAJERO_ACTIVO;
  document.getElementById("ticket-descuento-monto").innerText = descuentoAplicadoTotal.toFixed(2);
  
  if (metodoPago.includes("Apartado")) {
    document.getElementById("ticket-tipo-comprobante").innerText = "COMPROBANTE DE ANTICIPO";
    document.getElementById("ticket-zona-anticipo").style.display = "block";
    document.getElementById("ticket-anticipo-monto").innerText = datosExtraAnticipo.toFixed(2);
    document.getElementById("ticket-saldo-monto").innerText = (totalFinal - datosExtraAnticipo).toFixed(2);
  } else {
    document.getElementById("ticket-tipo-comprobante").innerText = "";
    document.getElementById("ticket-zona-anticipo").style.display = "none";
  }
  
  var tbodyTicket = document.getElementById("ticket-items");
  tbodyTicket.innerHTML = "";
  for (var i = 0; i < carrito.length; i++) {
    var tr = document.createElement("tr");
    var descNombre = carrito[i].cantidad > 1 ? (carrito[i].cantidad + "x " + carrito[i].nombre) : carrito[i].nombre;
    tr.innerHTML = "<td>" + escaparHTMLSeguro(descNombre) + "</td><td>$" + (carrito[i].precioFinal * carrito[i].cantidad).toFixed(2) + "</td>";
    tbodyTicket.appendChild(tr);
  }
  
  var tarifaLocal = parseFloat(document.getElementById("inputTarifaEnvio").value) || 0;
  if (metodoPago.includes("Envío") && tarifaLocal > 0) {
    var trEnvio = document.createElement("tr");
    var rep = document.getElementById("inputRepartidor").value || "Envío";
    trEnvio.innerHTML = "<td>Cargo Envío (" + escaparHTMLSeguro(rep.substring(0, 12)) + ")</td><td>$" + tarifaLocal.toFixed(2) + "</td>";
    tbodyTicket.appendChild(trEnvio);
  }

  document.getElementById("ticket-total-monto").innerText = totalFinal.toFixed(2);
  renderizarBarcodeTicketInferior(idTicketReal);
  
  var cajaExito = document.getElementById("cajaCambioExito");
  if (metodoPago.includes("Efectivo") || metodoPago.includes("Pago Mixto")) {
    cajaExito.innerHTML = "Entregar Cambio:<br><span style='color:#10b981; font-size: 32px;'>$" + document.getElementById("cambioCliente").innerText + "</span>";
    cajaExito.style.display = "block";
  } else if (metodoPago.includes("Apartado")) {
    var subMetodoStr = document.getElementById("selectMetodoAnticipo").value;
    if (subMetodoStr === "Efectivo") {
      cajaExito.innerHTML = "Anticipo Registrado.<br>Entregar Cambio:<br><span style='color:#10b981; font-size: 32px;'>$" + document.getElementById("cambioCliente").innerText + "</span>";
    } else {
      cajaExito.innerHTML = "<span style='color:#f59e0b;'>Anticipo Registrado Correctamente</span>";
    }
    cajaExito.style.display = "block";
  } else {
    cajaExito.style.display = "none";
  }

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
  document.getElementById("inputRepartidor").value = "";
  document.getElementById("inputTarifaEnvio").value = "";
  document.getElementById("inputMontoAnticipo").value = "";
  document.getElementById("inputMixtoEfectivo").value = "";
  limpiarBadgeClienteVIP();
  document.getElementById("selectMetodoPago").value = "Efectivo (Local)";
  document.getElementById("selectMetodoAnticipo").value = "Efectivo";
  document.getElementById("selectMetodoPago").dispatchEvent(new Event('change'));
  actualizarPantalla();
  document.getElementById("btnCobrar").innerHTML = '<span>Procesar Pago</span><span class="kbd-inline">+</span>';
  document.getElementById("btnCobrar").disabled = false;
}

function imprimirTicket() { 
  ejecutarImpresionNativa("modo-ticket");
}

function cerrarVentanaExito() {
  document.getElementById("ventanaExito").classList.remove("activo");
  document.getElementById("codigo").focus();
}

function abrirModalGasto() {
  document.getElementById("inputConceptoGasto").value = "";
  document.getElementById("inputMontoGasto").value = "";
  document.getElementById("modalGastos").classList.add("activo");
}

function cerrarModalGasto() {
  document.getElementById("modalGastos").classList.remove("activo");
}

// ============================================================================
// 2. CORTE DE CAJA Z, ARQUEOS CIEGOS, FONDO INICIAL Y UTILIDAD REAL
// ============================================================================
function actualizarEstadoVisualFondo(montoFondo, estaBloqueado) {
  var inputFondo = document.getElementById("inputFondoInicialCorte");
  var btnFondo = document.getElementById("btnGuardarFondoCorte");
  var lblEstado = document.getElementById("lblEstadoFondoDia");

  if (estaBloqueado || montoFondo > 0) {
    inputFondo.value = parseFloat(montoFondo).toFixed(2);
    inputFondo.disabled = true;
    btnFondo.disabled = true;
    btnFondo.innerText = "🔒 Fondo Fijado (Hoy)";
    btnFondo.style.background = "#475569";
    btnFondo.style.cursor = "not-allowed";
    lblEstado.innerText = "El fondo de esta fecha ya fue registrado. Podrá ingresarse uno nuevo mañana.";
    lblEstado.style.color = "#10b981";
  } else {
    inputFondo.value = "";
    inputFondo.disabled = false;
    btnFondo.disabled = false;
    btnFondo.innerText = "Aplicar Fondo";
    btnFondo.style.background = "#0284c7";
    btnFondo.style.cursor = "pointer";
    lblEstado.innerText = "Disponible para registrar (solo se permite 1 vez por día).";
    lblEstado.style.color = "var(--text-muted)";
  }
}

function abrirCorteCaja() {
  if (!PIN_ADMIN_INVENTARIO) {
    pedirPinSeguridad('corte_z', '');
    return;
  }

  document.getElementById("modalCorteCaja").classList.add("activo");
  var inputFecha = document.getElementById("inputFechaCorte");
  if (!inputFecha.value) {
    inputFecha.value = obtenerFechaLocalHoyYMD();
  }

  var select = document.getElementById("selectCajeroCorte");
  var seleccionPrevia = select.value || "Todos";

  google.script.run.withSuccessHandler(function(cajeros) {
    select.innerHTML = '<option value="Todos">Todos (Consolidado Z)</option>';
    var existePrevia = false;
    for (var i = 0; i < cajeros.length; i++) {
      var opt = document.createElement("option");
      opt.value = cajeros[i];
      opt.innerText = "Operador: " + cajeros[i];
      if (cajeros[i] === seleccionPrevia) existePrevia = true;
      select.appendChild(opt);
    }
    select.value = existePrevia ? seleccionPrevia : "Todos";
    calcularCorteCaja();
  }).obtenerListaCajeros();
}

function guardarFondoInicialUI() {
  var fechaElegida = document.getElementById("inputFechaCorte").value || obtenerFechaLocalHoyYMD();
  var cajeroElegido = document.getElementById("selectCajeroCorte").value || "Todos";
  var montoFondo = parseFloat(document.getElementById("inputFondoInicialCorte").value) || 0;

  if (montoFondo <= 0) {
    mostrarAviso("Monto Inválido", "Ingrese un monto mayor a $0.00 para establecer el fondo inicial del día.", "alerta");
    return;
  }

  var btn = document.getElementById("btnGuardarFondoCorte");
  btn.innerText = "Guardando...";
  btn.disabled = true;

  google.script.run.withSuccessHandler(function(res) {
    if (res && res.exito === false) {
      mostrarAviso("Fondo Ya Registrado / Restringido", res.mensaje || "El fondo inicial de este día ya fue ingresado anteriormente y no puede modificarse hasta el día siguiente.", "alerta");
      calcularCorteCaja();
      return;
    }
    try {
      localStorage.setItem("pos_fondo_fijado_" + fechaElegida, montoFondo.toFixed(2));
    } catch(e) {}
    mostrarAviso("Fondo Registrado", "El fondo inicial de $" + montoFondo.toFixed(2) + " ha quedado fijado para el día " + fechaElegida + ".", "exito");
    calcularCorteCaja();
  }).guardarFondoInicialCorte(fechaElegida, cajeroElegido, montoFondo, CAJERO_ACTIVO, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function calcularCorteCaja() {
  var fechaElegida = document.getElementById("inputFechaCorte").value;
  var cajeroElegido = document.getElementById("selectCajeroCorte").value || "Todos";
  if (!fechaElegida) {
    fechaElegida = obtenerFechaLocalHoyYMD();
    document.getElementById("inputFechaCorte").value = fechaElegida;
  }
  document.getElementById("btnImprimirCorte").disabled = true;
  
  google.script.run
    .withSuccessHandler(function(corte) {
      var fondoMostrado = parseFloat(corte.fondoInicial) || 0;
      var respaldoLocal = 0;
      try {
        respaldoLocal = parseFloat(localStorage.getItem("pos_fondo_fijado_" + fechaElegida)) || 0;
      } catch(e) {}

      if (fondoMostrado <= 0 && respaldoLocal > 0) {
        fondoMostrado = respaldoLocal;
        corte.fondoInicial = fondoMostrado;
        corte.totalEnCajon = Math.max(0, fondoMostrado + corte.efectivo - corte.gastos);
      }

      var bloqueadoHoy = (corte.fondoBloqueado === true) || (fondoMostrado > 0);
      actualizarEstadoVisualFondo(fondoMostrado, bloqueadoHoy);

      var costoMerc = parseFloat(corte.costoMercaderia) || 0;
      var gananciaNeta = parseFloat(corte.gananciaNetaReal) || 0;
      var margenPct = parseFloat(corte.margenPorcentaje) || 0;

      document.getElementById("corteEfectivoNeto").innerText = "$" + corte.efectivoNeto.toFixed(2);
      document.getElementById("corteTotalEnCajon").innerText = "$" + corte.totalEnCajon.toFixed(2);
      document.getElementById("corteAgricola").innerText = "$" + corte.agricola.toFixed(2);
      document.getElementById("corteCuscatlan").innerText = "$" + corte.cuscatlan.toFixed(2);
      document.getElementById("corteContraentrega").innerText = "$" + corte.contraentrega.toFixed(2);
      document.getElementById("corteGastos").innerText = "-$" + corte.gastos.toFixed(2);
      document.getElementById("corteCostoMercaderia").innerText = "$" + costoMerc.toFixed(2);
      document.getElementById("corteGananciaNeta").innerText = (gananciaNeta < 0 ? "-$" : "$") + Math.abs(gananciaNeta).toFixed(2);
      document.getElementById("corteGananciaNeta").style.color = gananciaNeta >= 0 ? "#059669" : "#ef4444";
      document.getElementById("corteMargenPorcentaje").innerText = margenPct.toFixed(1) + "%";

      // Mostrar Arqueos Ciegos declarados por cajeros en esta fecha
      var boxArqueos = document.getElementById("contenedorArqueosCiegosCorte");
      var listaArqueos = document.getElementById("listaArqueosCiegosCorte");
      if (boxArqueos && listaArqueos) {
        var arqueos = Array.isArray(corte.arqueosCiegosHoy) ? corte.arqueosCiegosHoy : [];
        if (arqueos.length > 0) {
          var htmlArq = "";
          arqueos.forEach(function(a) {
            var dif = parseFloat(a.diferencia) || 0;
            var colorDif = Math.abs(dif) < 0.01 ? "#10b981" : (dif < 0 ? "#ef4444" : "#f59e0b");
            var signoDif = dif > 0 ? ("+$" + dif.toFixed(2)) : (dif < 0 ? ("-$" + Math.abs(dif).toFixed(2)) : "$0.00");
            htmlArq +=
              "<div style='display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px dashed var(--border-color); gap:8px; flex-wrap:wrap;'>" +
                "<span><b>" + escaparHTMLSeguro(a.cajero) + "</b> <small style='color:var(--text-muted);'>(" + escaparHTMLSeguro(a.hora) + ")</small>" +
                (a.notas ? (" — <i>" + escaparHTMLSeguro(a.notas) + "</i>") : "") + "</span>" +
                "<span>Declaró: <b>$" + parseFloat(a.declarado).toFixed(2) + "</b> | Esperado: $" + parseFloat(a.esperado).toFixed(2) + " | " +
                "<strong style='color:" + colorDif + ";'>" + escaparHTMLSeguro(a.estadoCuadre) + " (" + signoDif + ")</strong></span>" +
              "</div>";
          });
          listaArqueos.innerHTML = htmlArq;
          boxArqueos.style.display = "block";
        } else {
          listaArqueos.innerHTML = "";
          boxArqueos.style.display = "none";
        }
      }
      
      var partes = fechaElegida.split("-");
      var fechaFormat = partes[2] + "/" + partes[1] + "/" + partes[0];
      
      document.getElementById("print-corte-fecha").innerText = fechaFormat;
      document.getElementById("print-corte-cajero").innerText = (cajeroElegido === "Todos") ? "Todos (Consolidado Z)" : cajeroElegido;
      document.getElementById("print-corte-tickets").innerText = corte.tickets;
      document.getElementById("print-corte-fondo-inicial").innerText = "$" + fondoMostrado.toFixed(2);
      document.getElementById("print-corte-ingreso-efectivo").innerText = "$" + corte.efectivo.toFixed(2);
      document.getElementById("print-corte-gastos").innerText = corte.gastos.toFixed(2);
      document.getElementById("print-corte-efectivo-neto").innerText = "$" + corte.efectivoNeto.toFixed(2);
      document.getElementById("print-corte-total-cajon").innerText = "$" + corte.totalEnCajon.toFixed(2);
      document.getElementById("print-corte-agricola").innerText = "$" + corte.agricola.toFixed(2);
      document.getElementById("print-corte-cuscatlan").innerText = "$" + corte.cuscatlan.toFixed(2);
      document.getElementById("print-corte-contraentrega").innerText = "$" + corte.contraentrega.toFixed(2);
      document.getElementById("print-corte-costo").innerText = "-$" + costoMerc.toFixed(2);
      document.getElementById("print-corte-ganancia-neta").innerText = (gananciaNeta < 0 ? "-$" : "$") + Math.abs(gananciaNeta).toFixed(2);
      document.getElementById("print-corte-margen").innerText = margenPct.toFixed(1) + "%";
      document.getElementById("print-corte-total").innerText = corte.totalVendido.toFixed(2);
      
      document.getElementById("btnImprimirCorte").disabled = false;
    })
    .withFailureHandler(function(err) {
      cerrarCorteCaja();
      mostrarAviso("Acceso Denegado", (err && err.message) || "Se requiere autorización de Administrador para consultar el Corte Z.", "error");
    })
    .obtenerDatosCorteDeCaja(fechaElegida, cajeroElegido, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function cerrarCorteCaja() {
  document.getElementById("modalCorteCaja").classList.remove("activo");
  if (typeof purgarPinAdminMemoria === "function") purgarPinAdminMemoria();
  else PIN_ADMIN_INVENTARIO = "";
  document.getElementById("codigo").focus();
}

function imprimirCorteCajaFisico() { 
  ejecutarImpresionNativa("modo-corte");
}

// ============================================================================
// 3. HISTORIAL DE OPERACIONES, DETALLE DE TICKET, LIQUIDACIONES Y DEVOLUCIONES
// ============================================================================
function abrirHistorial() {
  document.getElementById("modalHistorial").classList.add("activo");
  cargarHistorialConFiltro();
}

function cargarHistorialConFiltro() {
  var fechaElegida = document.getElementById("filtroFechaHistorial").value;
  if (!fechaElegida) fechaElegida = "Todos";
  document.getElementById("listaHistorial").innerHTML = "<tr><td colspan='6' style='text-align:center; padding: 30px; color: var(--text-muted);'>Consultando base de datos...</td></tr>";
  google.script.run.withSuccessHandler(function(datos) {
    historialGlobal = datos;
    renderizarTablaHistorial();
  }).obtenerHistorial(fechaElegida);
}

function cerrarHistorial() {
  document.getElementById("modalHistorial").classList.remove("activo");
  document.getElementById("codigo").focus();
}

function renderizarTablaHistorial() {
  var filtroTipo = document.getElementById("filtroHistorial").value;
  var tbody = document.getElementById("listaHistorial");
  tbody.innerHTML = "";
  var mostrados = 0;

  for (var i = 0; i < historialGlobal.length; i++) {
    var item = historialGlobal[i];
    if (filtroTipo !== "Todos" && !item.metodo.includes(filtroTipo)) continue;
    mostrados++;
    var tr = document.createElement("tr");
    
    var esAnulada = (item.estado || "").toLowerCase() === "anulada";
    var esCortesia = (item.estado || "").toLowerCase() === "cortesía" || item.metodo.includes("Cortesía");
    var esEnvio = item.metodo.includes("(Envío)");
    var idVentaEsc = escaparTextoJS(item.idVenta);
    var chkHtml = (esEnvio && !esAnulada) ? "<input type='checkbox' class='chk-guia' value='" + escaparHTMLSeguro(item.idVenta) + "' style='width:18px; height:18px; cursor:pointer;'>" : "";
    var tipoBadge = esCortesia ? "<span style='color:#a855f7; font-weight:800; font-size:10px;'>CORTESÍA</span>" : (esEnvio ? "<span style='color:#4f46e5; font-weight:800; font-size:10px;'>ENVÍO</span>" : "<span style='color:#059669; font-weight:800; font-size:10px;'>LOCAL</span>");
    var estadoBadge = "";
    var btnLiquidar = "";

    var totalNum = parseFloat(String(item.total).replace(/[^0-9.-]+/g, "")) || 0;
    var anticipoNum = parseFloat(String(item.anticipo).replace(/[^0-9.-]+/g, "")) || 0;
    
    if (esAnulada) {
      estadoBadge = "<br><span class='badge-stock badge-rojo'>ANULADA</span>";
    } else if (esCortesia) {
      estadoBadge = "<br><span class='badge-stock badge-cortesia'>USO PROPIO</span>";
    } else if (item.estado === "Pendiente" || item.estado === "Apartado") {
      estadoBadge = "<br><span style='color:#d97706; font-size:10px; font-weight:800;'>" + escaparHTMLSeguro(item.estado.toUpperCase()) + "</span>";
      btnLiquidar = "<button class='btn-liquidar' onclick=\"abrirModalLiquidar('" + idVentaEsc + "', '" + escaparTextoJS(item.estado) + "', " + totalNum + ", " + anticipoNum + ")\" style='margin-right: 6px;'>Liquidar</button>";
    } else if (item.estado !== "Pagado") {
      estadoBadge = "<br><span class='badge-liquidado'>" + escaparHTMLSeguro(item.estado) + "</span>";
    }

    var badgeFiscalHtml = item.refFiscal
      ? "<br><small style='color:#059669; font-family:monospace; font-weight:700;'>DTE/Fact: " + escaparHTMLSeguro(item.refFiscal) + "</small>"
      : "";

    var btnDetalles = "<button class='btn-ajuste-stock' style='background:#0284c7; margin-right:6px;' onclick=\"abrirDetalleTicket('" + idVentaEsc + "')\">Detalle</button>";
    var btnAnular = esAnulada ? "" : "<button class='btn-eliminar' onclick=\"pedirPinSeguridad('anular', '" + idVentaEsc + "')\">Anular</button>";
    
    var estiloMonto = esAnulada ? "text-decoration:line-through; color:var(--text-muted);" : (esCortesia ? "font-weight:800; color:#a855f7;" : "font-weight:800; color:#10b981;");
    tr.innerHTML = "<td style='text-align:center;'>" + chkHtml + "</td><td style='font-family:monospace; font-size:12px; font-weight: 700;'>" + escaparHTMLSeguro(item.idVenta) + "<br>" + tipoBadge + " " + estadoBadge + badgeFiscalHtml + "</td><td style='font-size:13px;'>" + escaparHTMLSeguro(item.fecha) + "</td><td style='font-size:13px; font-weight: 500;'>" + escaparHTMLSeguro(item.cliente) + "</td><td style='" + estiloMonto + "'>$" + totalNum.toFixed(2) + "</td><td style='white-space:nowrap; text-align: right;'>" + btnLiquidar + btnDetalles + btnAnular + "</td>";
    tbody.appendChild(tr);
  }
  if (mostrados === 0) {
    tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; padding: 40px; color: var(--text-muted); font-weight: 500;'>Sin registros para los filtros seleccionados.</td></tr>";
  }
}

function abrirModalLiquidar(idVenta, estado, total, anticipo) {
  ID_A_LIQUIDAR = idVenta;
  var msg = estado === "Apartado" ? "Seleccione la cuenta donde ingresó el saldo restante del cliente." : "Seleccione la cuenta donde el mensajero liquidó el paquete.";
  document.getElementById("lblLiquidarProducto").innerText = "Comprobante: " + idVenta + "\n" + msg;
  
  var t = parseFloat(String(total).replace(/[^0-9.-]+/g, "")) || 0;
  var a = parseFloat(String(anticipo).replace(/[^0-9.-]+/g, "")) || 0;
  var restante = (estado === "Apartado") ? Math.max(0, t - a) : t;
  
  document.getElementById("divMontoLiquidar").style.display = "block";
  document.getElementById("inputMontoLiquidar").value = restante.toFixed(2);
  document.getElementById("modalLiquidarEnvio").classList.add("activo");
}

function cerrarModalLiquidar() {
  document.getElementById("modalLiquidarEnvio").classList.remove("activo");
  ID_A_LIQUIDAR = "";
}

function abrirDetalleTicket(idVenta) {
  document.getElementById("lblDetalleIdVenta").innerText = idVenta;
  document.getElementById("lblDetalleCliente").innerText = "...";
  document.getElementById("lblDetalleFecha").innerText = "...";
  document.getElementById("lblDetalleMetodoPago").innerText = "...";
  document.getElementById("lblDetalleTotal").innerText = "0.00";
  document.getElementById("zonaDetalleEnvio").style.display = "none";
  if (document.getElementById("filaDetalleRefFiscal")) document.getElementById("filaDetalleRefFiscal").style.display = "none";
  if (document.getElementById("filaDetalleMotivoAnulacion")) document.getElementById("filaDetalleMotivoAnulacion").style.display = "none";
  document.getElementById("modalDetalleTicket").classList.add("activo");
  document.getElementById("btnReimprimirTicket").disabled = true;
  document.getElementById("btnImprimirGuia").disabled = true; 
  google.script.run.withSuccessHandler(mostrarDetalleTicket).obtenerTicketCompleto(idVenta);
}

function cerrarModalDetalleTicket() {
  document.getElementById("modalDetalleTicket").classList.remove("activo");
  ticketEnVista = null;
}

function mostrarDetalleTicket(ticket) {
  if (!ticket || !ticket.encabezado || !ticket.encabezado.idVenta) {
    mostrarAviso("Error", "No se encontró el comprobante solicitado.", "error");
    return;
  }

  ticketEnVista = ticket; 
  document.getElementById("lblDetalleIdVenta").innerText = ticket.encabezado.idVenta;
  document.getElementById("lblDetalleCliente").innerText = ticket.encabezado.cliente || "Cliente Mostrador";
  document.getElementById("lblDetalleFecha").innerText = ticket.encabezado.fecha;
  document.getElementById("lblDetalleCajero").innerText = ticket.encabezado.cajero || "Desconocido";

  if (document.getElementById("filaDetalleRefFiscal")) {
    if (ticket.encabezado.refFiscal) {
      document.getElementById("lblDetalleRefFiscal").innerText = ticket.encabezado.refFiscal;
      document.getElementById("filaDetalleRefFiscal").style.display = "block";
    } else {
      document.getElementById("filaDetalleRefFiscal").style.display = "none";
    }
  }

  if (document.getElementById("filaDetalleMotivoAnulacion")) {
    if (ticket.encabezado.motivoAnulacion) {
      document.getElementById("lblDetalleMotivoAnulacion").innerText = ticket.encabezado.motivoAnulacion;
      document.getElementById("filaDetalleMotivoAnulacion").style.display = "block";
    } else {
      document.getElementById("filaDetalleMotivoAnulacion").style.display = "none";
    }
  }
  
  if (ticket.encabezado.repartidor) {
    document.getElementById("zonaDetalleEnvio").style.display = "block";
    document.getElementById("lblDetalleRepartidor").innerText = ticket.encabezado.repartidor;
    document.getElementById("lblDetalleTarifa").innerText = parseFloat(ticket.encabezado.tarifa).toFixed(2);
  }
  
  var metodoStr = ticket.encabezado.metodoPago || "Efectivo (Local)";
  var estadoCobroStr = ticket.encabezado.estado || "Pagado";
  var esAnulada = estadoCobroStr.toLowerCase() === "anulada";
  
  if (esAnulada) {
    document.getElementById("lblDetalleMetodoPago").innerHTML = escaparHTMLSeguro(metodoStr) + " <span style='color:#ef4444; font-weight: bold;'>(ANULADA)</span>";
  } else if ((metodoStr.includes("Contraentrega") || metodoStr.includes("Apartado")) && estadoCobroStr !== "Pendiente" && estadoCobroStr !== "Apartado") {
    document.getElementById("lblDetalleMetodoPago").innerHTML = escaparHTMLSeguro(metodoStr) + " <span style='color:#10b981; font-weight: bold;'>(" + escaparHTMLSeguro(estadoCobroStr) + ")</span>";
  } else {
    document.getElementById("lblDetalleMetodoPago").innerText = metodoStr;
  }
  
  if (estadoCobroStr === "Apartado") {
    document.getElementById("btnLiquidarDetalle").style.display = "inline-block";
  } else {
    document.getElementById("btnLiquidarDetalle").style.display = "none";
  }
  
  document.getElementById("lblDetalleTotal").innerText = parseFloat(ticket.encabezado.total).toFixed(2);

  var tbody = document.getElementById("listaDetallesTicket");
  tbody.innerHTML = "";
  for (var i = 0; i < ticket.detalles.length; i++) {
    var item = ticket.detalles[i];
    var tr = document.createElement("tr");
    var nombreEscapado = escaparTextoJS(item.nombre);
    var btnDevolver = esAnulada ? "-" : "<button class='btn-eliminar' style='padding: 4px 8px; font-size: 11px;' onclick=\"abrirModalDevolucion('" + escaparTextoJS(ticket.encabezado.idVenta) + "', '" + escaparTextoJS(item.idProducto) + "', '" + nombreEscapado + "', " + item.cantidad + ")\">Devolver</button>";
    tr.innerHTML = "<td style='text-align:center; font-weight:bold;'>" + item.cantidad + "</td><td>" + escaparHTMLSeguro(item.nombre) + "</td><td style='text-align:right; font-weight:600;'>$" + parseFloat(item.subtotal).toFixed(2) + "</td><td style='text-align:center;'>" + btnDevolver + "</td>";
    tbody.appendChild(tr);
  }
  
  var tarifaDetalle = parseFloat(ticket.encabezado.tarifa) || 0;
  if (metodoStr.includes("Envío") && tarifaDetalle > 0) {
    var trEnvio = document.createElement("tr");
    var repDetalle = ticket.encabezado.repartidor || "Local";
    trEnvio.innerHTML = "<td style='text-align:center; font-weight:bold;'>1</td><td>Envío (" + escaparHTMLSeguro(repDetalle.substring(0, 15)) + ")</td><td style='text-align:right; font-weight:600;'>$" + tarifaDetalle.toFixed(2) + "</td><td style='text-align:center;'>-</td>";
    tbody.appendChild(trEnvio);
  }

  document.getElementById("btnReimprimirTicket").disabled = false;
  document.getElementById("btnImprimirGuia").style.display = (metodoStr.includes("(Envío)") && !esAnulada) ? "inline-block" : "none";
  document.getElementById("btnImprimirGuia").disabled = false;
}

function abrirLiquidarDesdeDetalle() {
  cerrarModalDetalleTicket();
  abrirModalLiquidar(ticketEnVista.encabezado.idVenta, "Apartado", ticketEnVista.encabezado.total, ticketEnVista.encabezado.anticipo);
}

function abrirModalDevolucion(idVenta, idProducto, nombre, maxCant) {
  ITEM_A_DEVOLVER = { idVenta: idVenta, idProducto: idProducto, nombre: nombre, maxCant: maxCant };
  document.getElementById("lblDevolucionInfo").innerText = "Artículo: " + nombre + "\nCantidad facturada: " + maxCant + " unidad(es).";
  document.getElementById("inputCantidadDevolver").value = 1;
  document.getElementById("inputCantidadDevolver").max = maxCant;
  document.getElementById("modalDevolucionParcial").classList.add("activo");
}

function cerrarModalDevolucion() {
  document.getElementById("modalDevolucionParcial").classList.remove("activo");
  ITEM_A_DEVOLVER = { idVenta: "", idProducto: "", nombre: "", maxCant: 0 };
}

function reimprimirTicketActual() {
  if (!ticketEnVista) return;
  
  if (ticketEnVista.encabezado.metodoPago.includes("Apartado") && ticketEnVista.encabezado.estado === "Apartado") {
    document.getElementById("ticket-tipo-comprobante").innerText = "COMPROBANTE DE ANTICIPO (COPIA)";
    document.getElementById("ticket-zona-anticipo").style.display = "block";
    var ant = parseFloat(ticketEnVista.encabezado.anticipo) || 0;
    var tot = parseFloat(ticketEnVista.encabezado.total) || 0;
    document.getElementById("ticket-anticipo-monto").innerText = ant.toFixed(2);
    document.getElementById("ticket-saldo-monto").innerText = (tot - ant).toFixed(2);
  } else {
    document.getElementById("ticket-tipo-comprobante").innerText = "COPIA DE COMPROBANTE";
    document.getElementById("ticket-zona-anticipo").style.display = "none";
  }
  
  var tel = ticketEnVista.encabezado.telefono;
  var dir = ticketEnVista.encabezado.direccion;
  var refF = ticketEnVista.encabezado.refFiscal || "";
  document.getElementById("ticket-fecha").innerText = ticketEnVista.encabezado.fecha;
  document.getElementById("ticket-cliente").innerText = ticketEnVista.encabezado.cliente || "Cliente Mostrador";
  document.getElementById("ticket-telefono").innerText = tel || "N/A";
  document.getElementById("ticket-direccion").innerText = dir || "N/A";
  document.getElementById("fila-ticket-tel").style.display = (tel && tel !== "N/A" && DISENO_ACTUAL.mostrarClienteTicket !== false) ? "flex" : "none";
  document.getElementById("fila-ticket-dir").style.display = (dir && dir !== "N/A" && DISENO_ACTUAL.mostrarClienteTicket !== false) ? "flex" : "none";

  if (document.getElementById("fila-ticket-ref-fiscal") && document.getElementById("ticket-ref-fiscal")) {
    document.getElementById("ticket-ref-fiscal").innerText = refF;
    document.getElementById("fila-ticket-ref-fiscal").style.display = refF ? "flex" : "none";
  }

  document.getElementById("ticket-metodo").innerText = ticketEnVista.encabezado.estado !== "Pagado" ? ticketEnVista.encabezado.estado : ticketEnVista.encabezado.metodoPago; 
  document.getElementById("ticket-cajero-print").innerText = ticketEnVista.encabezado.cajero || "N/A";
  document.getElementById("ticket-descuento-monto").innerText = (parseFloat(ticketEnVista.encabezado.descuento) || 0).toFixed(2);

  var tbodyTicket = document.getElementById("ticket-items");
  tbodyTicket.innerHTML = "";
  for (var i = 0; i < ticketEnVista.detalles.length; i++) {
    var tr = document.createElement("tr");
    var dItem = ticketEnVista.detalles[i];
    var textoProd = dItem.cantidad > 1 ? (dItem.cantidad + "x " + dItem.nombre) : dItem.nombre;
    tr.innerHTML = "<td>" + escaparHTMLSeguro(textoProd) + "</td><td>$" + parseFloat(dItem.subtotal).toFixed(2) + "</td>";
    tbodyTicket.appendChild(tr);
  }
  
  var tarifa = parseFloat(ticketEnVista.encabezado.tarifa) || 0;
  if (ticketEnVista.encabezado.metodoPago.includes("Envío") && tarifa > 0) {
    var trEnvio = document.createElement("tr");
    var rep = ticketEnVista.encabezado.repartidor || "Local";
    trEnvio.innerHTML = "<td>Cargo Envío (" + escaparHTMLSeguro(rep.substring(0, 10)) + ")</td><td>$" + tarifa.toFixed(2) + "</td>";
    tbodyTicket.appendChild(trEnvio);
  }

  document.getElementById("ticket-total-monto").innerText = parseFloat(ticketEnVista.encabezado.total).toFixed(2);
  renderizarBarcodeTicketInferior(ticketEnVista.encabezado.idVenta);
  
  ejecutarImpresionNativa("modo-ticket");
}

// ============================================================================
// 4. GENERADOR DE GUÍAS DE ENVÍO (ANTI-XSS) Y AUTORIZACIÓN POR PIN
// ============================================================================
function escaparHTMLSeguro(texto) {
  if (texto === null || texto === undefined) return "";
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirCardEnvio(ventaDatos) {
  var metodo = ventaDatos.metodo || "Efectivo";
  var bg = "#f8fafc"; var color = "#0f172a"; var border = "black"; var metodoText = "";
  if (metodo.includes("Contraentrega")) {
    metodoText = "CONTRAENTREGA: COBRAR $" + (parseFloat(ventaDatos.total) || 0).toFixed(2);
    bg = "#fee2e2"; color = "#dc2626"; border = "#dc2626";
  } else if (metodo.includes("Transferencia") || metodo.includes("Pago Mixto")) {
    metodoText = "PAGADO (" + metodo.replace(/\(Envío\)/gi, "").trim() + ")";
    bg = "#dcfce7"; color = "#16a34a"; border = "#16a34a";
  } else {
    metodoText = metodo;
  }

  var remitenteNombre = escaparHTMLSeguro(DISENO_ACTUAL.remitenteGuia || DISENO_ACTUAL.nombreTienda || "MI TIENDA");
  var remitenteTel = escaparHTMLSeguro(DISENO_ACTUAL.telefonoRemitenteGuia || DISENO_ACTUAL.telefonoTienda || "");
  var remitenteDir = escaparHTMLSeguro(DISENO_ACTUAL.direccionRemitenteGuia || DISENO_ACTUAL.direccionTienda || "");
  var tituloGuia = escaparHTMLSeguro(DISENO_ACTUAL.tituloEtiquetaGuia || "ORDEN DE DESPACHO A DOMICILIO");
  var idVentaSeguro = escaparHTMLSeguro(ventaDatos.idVenta || "");
  var clienteSeguro = escaparHTMLSeguro(ventaDatos.cliente || "Sin Nombre");
  var direccionSegura = escaparHTMLSeguro(ventaDatos.direccion || "Sin Dirección");
  var telefonoSeguro = escaparHTMLSeguro(ventaDatos.telefono || "N/A");
  var repartidorSeguro = escaparHTMLSeguro(ventaDatos.repartidor || "");
  var notaGuiaSegura = escaparHTMLSeguro(DISENO_ACTUAL.notaGuia || "");
  var selloFragilSeguro = escaparHTMLSeguro(DISENO_ACTUAL.selloFragilGuia || "");
  var metodoTextSeguro = escaparHTMLSeguro(metodoText);

  var logoSrc = esRutaFotoValida(DISENO_ACTUAL.logoSuperior) ? DISENO_ACTUAL.logoSuperior : (esRutaFotoValida(DISENO_ACTUAL.watermark) ? DISENO_ACTUAL.watermark : "");
  var htmlLogoGuia = (DISENO_ACTUAL.mostrarLogoEnGuia !== false && logoSrc)
    ? `<img src="${escaparHTMLSeguro(logoSrc)}" style="max-width:48px; max-height:48px; object-fit:contain; margin-right:8px;">`
    : "";

  var htmlRepartidor = (DISENO_ACTUAL.mostrarRepartidorEnGuia !== false && repartidorSeguro)
    ? `<p style="margin-top:5px; font-size:12px; border-top:1px dashed #64748b; padding-top:4px;">🚴 Ruta / Mensajero: ${repartidorSeguro}</p>`
    : "";

  var htmlNotaGuia = notaGuiaSegura
    ? `<div class="envio-nota-box"><b>📌 Nota:</b> ${notaGuiaSegura}</div>`
    : "";

  var htmlSelloFragil = selloFragilSeguro
    ? `<div class="envio-sello-fragil">${selloFragilSeguro}</div>`
    : "";

  return `
    <div class="envio-card">
      <div class="envio-header">
        <div style="display:flex; align-items:center;">
          ${htmlLogoGuia}
          <div class="envio-remitente">
            <h3>REMITENTE: ${remitenteNombre}</h3>
            ${remitenteTel ? `<p>Tel: ${remitenteTel}</p>` : ""}
            ${remitenteDir ? `<p>${remitenteDir}</p>` : ""}
          </div>
        </div>
        <div style="text-align: right;">
          <span style="font-weight:900; font-size:11px; border:1.5px solid black; padding:4px 6px; display:inline-block; text-transform:uppercase;">${tituloGuia}</span>
          <div style="font-size:10px; margin-top:4px; font-family:monospace;">${idVentaSeguro}</div>
        </div>
      </div>
      <div class="envio-destinatario">
        <p style="font-size:11px; color:#555; margin:0 0 4px 0; text-transform:uppercase;">DESTINATARIO:</p>
        <h2>${clienteSeguro}</h2>
        <p>📍 Dirección: ${direccionSegura}</p>
        <p>📞 Teléfono: ${telefonoSeguro}</p>
        ${htmlRepartidor}
      </div>
      ${htmlNotaGuia}
      ${htmlSelloFragil}
      <div class="envio-metodo" style="background-color: ${bg}; color: ${color}; border-color: ${border};">${metodoTextSeguro}</div>
      <div class="envio-barcode"><svg class="barcode-envio" jsbarcode-value="${idVentaSeguro}" jsbarcode-width="2" jsbarcode-height="55" jsbarcode-fontsize="13" jsbarcode-margin="8"></svg></div>
    </div>`;
}

function imprimirEtiquetaEnvioActual() {
  if (!ticketEnVista) return;
  document.getElementById("gridEnviosContainer").innerHTML = construirCardEnvio({
    idVenta: ticketEnVista.encabezado.idVenta,
    cliente: ticketEnVista.encabezado.cliente,
    direccion: ticketEnVista.encabezado.direccion,
    telefono: ticketEnVista.encabezado.telefono,
    metodo: ticketEnVista.encabezado.metodoPago,
    repartidor: ticketEnVista.encabezado.repartidor,
    total: ticketEnVista.encabezado.total
  });
  JsBarcode(".barcode-envio").init();
  ejecutarImpresionNativa("modo-envio");
}

function imprimirLoteGuiasEnvio() {
  var casillas = document.querySelectorAll('.chk-guia:checked');
  if (casillas.length === 0) {
    mostrarAviso("Selección Vacía", "Marque al menos una casilla de envío en la tabla.", "alerta");
    return;
  }
  var contenedor = document.getElementById("gridEnviosContainer");
  contenedor.innerHTML = "";
  casillas.forEach(function(chk) {
    var v = historialGlobal.find(x => x.idVenta === chk.value);
    if (v) contenedor.innerHTML += construirCardEnvio(v);
  });
  JsBarcode(".barcode-envio").init();
  document.querySelectorAll('.chk-guia:checked').forEach(c => c.checked = false);
  ejecutarImpresionNativa("modo-envio");
}

function pedirPinSeguridad(accion, parametro) {
  accionPinProtegida = accion;
  parametroPinProtegido = parametro;
  if (accion === "anular") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para anular:\n" + parametro;
  else if (accion === "inventario") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para acceder al Inventario.";
  else if (accion === "nuevo_producto") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para crear productos.";
  else if (accion === "cortesia") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para autorizar el retiro por Cortesía / Uso Propio.";
  else if (accion === "etiquetas") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para imprimir Etiquetas.";
  else if (accion === "corte_z") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para acceder al Arqueo y Corte Z.";
  else if (accion === "liquidar") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para liquidar este comprobante.";
  else if (accion === "gasto") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para autorizar el egreso.";
  else if (accion === "oferta") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para aplicar la promoción.";
  else if (accion === "devolucion") document.getElementById("lblMotivoPin").innerText = "Ingrese PIN de Administrador para autorizar el retorno.";

  var contMotivoAnul = document.getElementById("contenedorMotivoPinAnulacion");
  var inpMotivoAnul = document.getElementById("inputMotivoAnulacionPin");
  if (contMotivoAnul && inpMotivoAnul) {
    contMotivoAnul.style.display = (accion === "anular") ? "block" : "none";
    inpMotivoAnul.value = "";
  }

  document.getElementById("inputPinSeguridad").value = "";
  document.getElementById("btnConfirmarPin").innerText = "Autorizar";
  document.getElementById("btnConfirmarPin").disabled = false;
  document.getElementById("modalPin").classList.add("activo");
  setTimeout(function() { document.getElementById("inputPinSeguridad").focus(); }, 100);
}

function cerrarModalPin() {
  document.getElementById("modalPin").classList.remove("activo");
  document.getElementById("inputPinSeguridad").value = "";
}

function confirmarPinSeguridad() {
  var pin = document.getElementById("inputPinSeguridad").value;
  if (pin === "") return;
  document.getElementById("btnConfirmarPin").innerText = "Verificando...";
  document.getElementById("btnConfirmarPin").disabled = true;

  if (accionPinProtegida === "anular") {
    var motivoAnulacion = document.getElementById("inputMotivoAnulacionPin") ? document.getElementById("inputMotivoAnulacionPin").value.trim() : "";
    google.script.run.withSuccessHandler(respuestaAnulacion).anularVenta(parametroPinProtegido, pin, CAJERO_ACTIVO, motivoAnulacion);
  } else if (accionPinProtegida === "cortesia") {
    google.script.run.withSuccessHandler(function(esValido) {
      if (esValido) {
        cerrarModalPin();
        procesarSalidaCortesia(pin);
      } else {
        document.getElementById("btnConfirmarPin").innerText = "Autorizar";
        document.getElementById("btnConfirmarPin").disabled = false;
        mostrarAviso("Acceso Denegado", "Se requiere PIN de Administrador válido para autorizar una cortesía.", "error");
      }
    }).validarPin(pin);
  } else if (accionPinProtegida === "liquidar") {
    var metodoSelec = document.getElementById("selectMetodoLiquidacion").value;
    google.script.run.withSuccessHandler(function(respuesta) {
      cerrarModalPin();
      if (respuesta.exito) { 
        cerrarModalLiquidar(); 
        mostrarAviso("Liquidación Exitosa", respuesta.mensaje, "exito"); 
        cargarHistorialConFiltro(); 
        if (respuesta.ticket) {
          imprimirTicketFinalLiquidacion(respuesta.ticket);
        }
      } else {
        mostrarAviso("Error", respuesta.mensaje, "error");
      }
    }).liquidarTicketPendiente(ID_A_LIQUIDAR, metodoSelec, pin, CAJERO_ACTIVO);
  } else if (accionPinProtegida === "gasto") {
    var concepto = document.getElementById("inputConceptoGasto").value;
    var monto = parseFloat(document.getElementById("inputMontoGasto").value) || 0;
    if (concepto === "" || monto <= 0) {
      cerrarModalPin();
      mostrarAviso("Datos Incompletos", "Indique concepto y monto válido para el egreso.", "alerta");
      return;
    }
    google.script.run.withSuccessHandler(function(res) {
      cerrarModalPin();
      if (res.exito) {
        cerrarModalGasto();
        mostrarAviso("Egreso Registrado", res.mensaje, "exito");
      } else {
        mostrarAviso("Error", res.mensaje, "error");
      }
    }).registrarGasto(concepto, monto, CAJERO_ACTIVO, pin);
  } else if (accionPinProtegida === "devolucion") {
    var cantDevolver = parseInt(document.getElementById("inputCantidadDevolver").value) || 0;
    if (cantDevolver <= 0 || cantDevolver > ITEM_A_DEVOLVER.maxCant) {
      cerrarModalPin();
      mostrarAviso("Cantidad Inválida", "Verifique las unidades a devolver.", "alerta");
      return;
    }
    google.script.run.withSuccessHandler(function(res) {
      cerrarModalPin();
      if (res.exito) { 
        cerrarModalDevolucion(); 
        mostrarAviso("Retorno Completado", res.mensaje, "exito"); 
        abrirDetalleTicket(ITEM_A_DEVOLVER.idVenta); 
        cargarHistorialConFiltro(); 
      } else { 
        mostrarAviso("Error", res.mensaje, "error"); 
      }
    }).devolverProductoParcial(ITEM_A_DEVOLVER.idVenta, ITEM_A_DEVOLVER.idProducto, cantDevolver, pin, CAJERO_ACTIVO);
  } else if (accionPinProtegida === "oferta") {
    google.script.run.withSuccessHandler(function(esValido) {
      if (esValido) {
        cerrarModalPin();
        procesarGuardadoDeOferta(pin);
      } else {
        document.getElementById("btnConfirmarPin").innerText = "Autorizar";
        document.getElementById("btnConfirmarPin").disabled = false;
        mostrarAviso("Acceso Denegado", "PIN de Administrador incorrecto.", "error");
      }
    }).validarPin(pin);
  } else {
    google.script.run.withSuccessHandler(function(esValido) {
      respuestaAccesoGenerico(esValido, pin);
    }).validarPin(pin);
  }
}

function imprimirTicketFinalLiquidacion(ticket) {
  document.getElementById("ticket-tipo-comprobante").innerText = "COMPROBANTE LIQUIDADO";
  document.getElementById("ticket-zona-anticipo").style.display = "none";
  document.getElementById("ticket-fecha").innerText = ticket.encabezado.fecha;
  document.getElementById("ticket-cliente").innerText = ticket.encabezado.cliente || "Cliente Mostrador";
  document.getElementById("fila-ticket-tel").style.display = "none";
  document.getElementById("fila-ticket-dir").style.display = "none";
  if (document.getElementById("fila-ticket-ref-fiscal") && document.getElementById("ticket-ref-fiscal")) {
    var refF = ticket.encabezado.refFiscal || "";
    document.getElementById("ticket-ref-fiscal").innerText = refF;
    document.getElementById("fila-ticket-ref-fiscal").style.display = refF ? "flex" : "none";
  }
  document.getElementById("ticket-metodo").innerText = ticket.encabezado.estado || "Pagado"; 
  document.getElementById("ticket-cajero-print").innerText = ticket.encabezado.cajero || "N/A";
  document.getElementById("ticket-descuento-monto").innerText = (parseFloat(ticket.encabezado.descuento) || 0).toFixed(2);

  var tbodyTicket = document.getElementById("ticket-items");
  tbodyTicket.innerHTML = "";
  for (var i = 0; i < ticket.detalles.length; i++) {
    var tr = document.createElement("tr");
    var itemActual = ticket.detalles[i];
    var textoProd = itemActual.cantidad > 1 ? (itemActual.cantidad + "x " + itemActual.nombre) : itemActual.nombre;
    tr.innerHTML = "<td>" + escaparHTMLSeguro(textoProd) + "</td><td>$" + parseFloat(itemActual.subtotal).toFixed(2) + "</td>";
    tbodyTicket.appendChild(tr);
  }
  
  document.getElementById("ticket-total-monto").innerText = parseFloat(ticket.encabezado.total).toFixed(2);
  renderizarBarcodeTicketInferior(ticket.encabezado.idVenta);
  ejecutarImpresionNativa("modo-ticket");
}

function respuestaAnulacion(respuesta) {
  cerrarModalPin();
  if (respuesta.exito) {
    mostrarAviso("Comprobante Anulado", respuesta.mensaje, "exito");
    cargarHistorialConFiltro();
  } else {
    mostrarAviso("Error de Autorización", respuesta.mensaje, "error");
  }
}

function respuestaAccesoGenerico(esValido, pinUsado) {
  if (esValido) {
    cerrarModalPin();
    PIN_ADMIN_INVENTARIO = pinUsado;
    if (accionPinProtegida === "inventario") {
      filtroStockInventarioActual = "todos";
      document.getElementById("inputBuscarInventario").value = "";
      document.getElementById("modalInventario").classList.add("activo");
      document.getElementById("listaInventarioCompleto").innerHTML = "<tr><td colspan='7' style='text-align:center; padding:25px;'>Consultando inventario...</td></tr>";
      google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
    } else if (accionPinProtegida === "nuevo_producto") {
      abrirFichaProductoNuevo();
    } else if (accionPinProtegida === "etiquetas") {
      document.getElementById("modalMenuEtiquetas").classList.add("activo");
      document.getElementById("inputCodigoEtiqueta").value = "";
      document.getElementById("inputCantidadEtiquetas").value = "10";
      setTimeout(function() { document.getElementById("inputCodigoEtiqueta").focus(); }, 100);
    } else if (accionPinProtegida === "corte_z") {
      abrirCorteCaja();
    }
  } else {
    document.getElementById("btnConfirmarPin").innerText = "Autorizar";
    document.getElementById("btnConfirmarPin").disabled = false;
    mostrarAviso("Acceso Denegado", "El PIN ingresado es incorrecto o se encuentra temporalmente bloqueado.", "error");
  }
}

// ============================================================================
// 5. INVENTARIO, FILTROS DE STOCK BAJO/AGOTADO, LISTA DE COMPRAS Y ATAJOS
// ============================================================================
function cerrarModalInventario() {
  cerrarTodasLasSugerencias();
  document.getElementById("modalInventario").classList.remove("activo");
  if (typeof purgarPinAdminMemoria === "function") purgarPinAdminMemoria();
  else PIN_ADMIN_INVENTARIO = "";
  document.getElementById("codigo").focus();
}

function cerrarModalMenuEtiquetas() {
  cerrarTodasLasSugerencias();
  document.getElementById("modalMenuEtiquetas").classList.remove("activo");
  if (typeof purgarPinAdminMemoria === "function") purgarPinAdminMemoria();
  else PIN_ADMIN_INVENTARIO = "";
  document.getElementById("codigo").focus();
}

function enviarProductoAlCarritoDesdeInventario(idProd) {
  cerrarModalInventario();
  document.getElementById("codigo").disabled = true;
  google.script.run.withSuccessHandler(agregarAlTicket).buscarProducto(idProd);
}

function mostrarInventarioCompleto(datos) {
  inventarioCacheGlobal = Array.isArray(datos) ? datos : [];
  var tbody = document.getElementById("listaInventarioCompleto");
  tbody.innerHTML = "";

  var cntTodos = inventarioCacheGlobal.length;
  var cntBajo = 0;
  var cntAgotado = 0;

  inventarioCacheGlobal.forEach(function(item) {
    var st = parseFloat(item.stock) || 0;
    if (st <= 0) cntAgotado++;
    else if (st <= 5) cntBajo++;
  });

  if (document.getElementById("cntInvTodos")) document.getElementById("cntInvTodos").innerText = cntTodos;
  if (document.getElementById("cntInvBajo")) document.getElementById("cntInvBajo").innerText = cntBajo;
  if (document.getElementById("cntInvAgotado")) document.getElementById("cntInvAgotado").innerText = cntAgotado;

  if (inventarioCacheGlobal.length === 0) {
    tbody.innerHTML = "<tr><td colspan='7' style='text-align:center; padding: 40px; color: var(--text-muted);'>El inventario está vacío. Pulsa '+ Nuevo Producto' para agregar el primero.</td></tr>";
    return;
  }

  for (var i = 0; i < inventarioCacheGlobal.length; i++) {
    var tr = document.createElement("tr");
    var stockNum = parseFloat(inventarioCacheGlobal[i].stock) || 0;
    tr.setAttribute("data-stock", stockNum);

    var estadoHtml = stockNum > 5 ? "<span class='badge-stock badge-verde'>Disponible</span>" : (stockNum > 0 ? "<span class='badge-stock badge-naranja'>Stock Bajo</span>" : "<span class='badge-stock badge-rojo'>Agotado</span>");
    if (inventarioCacheGlobal[i].oferta) estadoHtml += "<br><div class='badge-stock badge-oferta'>Promoción</div>";
    
    var idEscapado = escaparTextoJS(inventarioCacheGlobal[i].id);
    var nombreEscapado = escaparTextoJS(inventarioCacheGlobal[i].nombre);

    var tieneFoto = esRutaFotoValida(inventarioCacheGlobal[i].foto);
    var fotoHtml = tieneFoto ? "<img src='" + escaparHTMLSeguro(inventarioCacheGlobal[i].foto) + "' class='foto-producto' loading='lazy'>" : "<div class='foto-producto'>ITEM</div>";
    
    var btnVender = "<button class='btn-ajuste-stock' style='background:#059669; margin-right:4px;' onclick=\"enviarProductoAlCarritoDesdeInventario('" + idEscapado + "')\">+ Carrito</button>";
    var btnEditar = "<button class='btn-ajuste-stock' style='background:#4f46e5; margin-right:4px;' onclick=\"abrirFichaEditarProducto('" + idEscapado + "')\">Editar</button>";
    var btnAjustar = "<button class='btn-ajuste-stock' style='margin-right:4px;' onclick=\"abrirModalAjusteStock('" + idEscapado + "', '" + nombreEscapado + "', " + stockNum + ")\">Stock</button>";
    var btnOferta = "<button class='btn-ajuste-stock btn-oferta' onclick=\"abrirModalOferta('" + idEscapado + "', '" + nombreEscapado + "')\">Oferta</button>";
    
    tr.innerHTML = "<td>" + fotoHtml + "</td><td style='font-family:monospace; font-size:12px; font-weight: 700;'>" + escaparHTMLSeguro(inventarioCacheGlobal[i].id) + "</td><td style='font-weight:600; font-size:13px;'>" + escaparHTMLSeguro(inventarioCacheGlobal[i].nombre) + "</td><td style='font-weight: 700; color: #10b981;'>$" + parseFloat(inventarioCacheGlobal[i].precio).toFixed(2) + "</td><td style='text-align:center; font-size:16px; font-weight:800;'>" + stockNum + "</td><td style='text-align:center;'>" + estadoHtml + "</td><td style='text-align:right; white-space:nowrap;'>" + btnVender + btnEditar + btnAjustar + btnOferta + "</td>";
    tbody.appendChild(tr);
  }

  aplicarFiltroRapidoInventario(filtroStockInventarioActual);
}

function aplicarFiltroRapidoInventario(modoFiltro) {
  filtroStockInventarioActual = modoFiltro || "todos";

  var btnTodos = document.getElementById("btnFiltroInvTodos");
  var btnBajo = document.getElementById("btnFiltroInvBajo");
  var btnAgotado = document.getElementById("btnFiltroInvAgotado");
  if (btnTodos) btnTodos.classList.toggle("activo", filtroStockInventarioActual === "todos");
  if (btnBajo) btnBajo.classList.toggle("activo", filtroStockInventarioActual === "bajo");
  if (btnAgotado) btnAgotado.classList.toggle("activo", filtroStockInventarioActual === "agotado");

  var textoBuscado = document.getElementById("inputBuscarInventario") ? document.getElementById("inputBuscarInventario").value : "";
  filtrarTablaInventarioDOM(textoBuscado);
}

function obtenerProductosFaltantesInventario() {
  return (inventarioCacheGlobal || []).filter(function(p) {
    return (parseFloat(p.stock) || 0) <= 5;
  }).sort(function(a, b) {
    return (parseFloat(a.stock) || 0) - (parseFloat(b.stock) || 0);
  });
}

function copiarListaComprasPortapapeles() {
  var faltantes = obtenerProductosFaltantesInventario();
  if (faltantes.length === 0) {
    mostrarAviso("Sin Faltantes", "Todos tus productos tienen más de 5 unidades disponibles.", "exito");
    return;
  }

  var lineas = ["📋 LISTA DE REABASTECIMIENTO - " + (DISENO_ACTUAL.nombreTienda || "MI TIENDA") + " (" + new Date().toLocaleDateString() + "):"];
  faltantes.forEach(function(p) {
    var st = parseFloat(p.stock) || 0;
    var estadoTxt = st <= 0 ? "[AGOTADO]" : ("[Quedan: " + st + "]");
    lineas.push("• " + p.nombre + " (ID: " + p.id + ") " + estadoTxt + " — Costo Ref: $" + (parseFloat(p.costo) || 0).toFixed(2));
  });

  var textoFinal = lineas.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(textoFinal).then(function() {
      mostrarAviso("Lista Copiada", "Se copiaron " + faltantes.length + " producto(s) por reabastecer al portapapeles (listo para pegar en WhatsApp o Notas).", "exito");
    }).catch(function() {
      mostrarAviso("Lista de Compras", textoFinal, "info");
    });
  } else {
    mostrarAviso("Lista de Compras", textoFinal, "info");
  }
}

function imprimirListaComprasReabastecimiento() {
  var faltantes = obtenerProductosFaltantesInventario();
  if (faltantes.length === 0) {
    mostrarAviso("Sin Faltantes", "No hay productos agotados ni con stock bajo (≤ 5) para imprimir.", "exito");
    return;
  }

  var zona = document.getElementById("zona-lista-compras");
  var filasHtml = "";
  faltantes.forEach(function(p) {
    var st = parseFloat(p.stock) || 0;
    filasHtml +=
      "<tr>" +
        "<td style='padding:6px; border-bottom:1px solid #cbd5e1; font-family:monospace;'>" + escaparHTMLSeguro(p.id) + "</td>" +
        "<td style='padding:6px; border-bottom:1px solid #cbd5e1; font-weight:bold;'>" + escaparHTMLSeguro(p.nombre) + "</td>" +
        "<td style='padding:6px; border-bottom:1px solid #cbd5e1; text-align:center; font-weight:bold;'>" + (st <= 0 ? "AGOTADO (0)" : st) + "</td>" +
        "<td style='padding:6px; border-bottom:1px solid #cbd5e1; text-align:right;'>$" + (parseFloat(p.costo) || 0).toFixed(2) + "</td>" +
      "</tr>";
  });

  zona.innerHTML =
    "<h2 style='margin:0 0 4px 0; text-transform:uppercase;'>" + escaparHTMLSeguro(DISENO_ACTUAL.nombreTienda || "MI TIENDA") + " — Lista de Compras y Reabastecimiento</h2>" +
    "<p style='margin:0 0 12px 0; font-size:12px;'>Fecha: " + new Date().toLocaleString() + " | Artículos con Stock ≤ 5: <b>" + faltantes.length + "</b></p>" +
    "<table style='width:100%; border-collapse:collapse; font-size:12px;'>" +
      "<thead><tr style='background:#f1f5f9; border-bottom:2px solid black;'>" +
        "<th style='padding:6px; text-align:left;'>Código</th>" +
        "<th style='padding:6px; text-align:left;'>Producto</th>" +
        "<th style='padding:6px; text-align:center;'>Existencia Actual</th>" +
        "<th style='padding:6px; text-align:right;'>Costo Compra Ref.</th>" +
      "</tr></thead>" +
      "<tbody>" + filasHtml + "</tbody>" +
    "</table>";

  ejecutarImpresionNativa("modo-lista-compras");
}

function abrirModalOferta(id, nombre) {
  idProductoParaOferta = id;
  document.getElementById("lblOfertaProducto").innerText = nombre;
  document.getElementById("inputOfertaValor").value = "";
  document.getElementById("inputOfertaFecha").value = ""; 
  document.getElementById("modalOfertaProducto").classList.add("activo");
}

function cerrarModalOferta() {
  document.getElementById("modalOfertaProducto").classList.remove("activo");
  idProductoParaOferta = "";
}

function procesarGuardadoDeOferta(pinAutorizado) {
  var valor = document.getElementById("inputOfertaValor").value || 0;
  var tipo = document.getElementById("inputOfertaTipo").value;
  var fecha = document.getElementById("inputOfertaFecha").value;
  
  document.getElementById("btnGuardarOferta").innerText = "Guardando...";
  document.getElementById("btnGuardarOferta").disabled = true;
  google.script.run.withSuccessHandler(function(respuesta) {
    cerrarModalOferta();
    document.getElementById("btnGuardarOferta").innerText = "Guardar Promoción";
    document.getElementById("btnGuardarOferta").disabled = false;
    if (respuesta.exito) {
      mostrarAviso("Promoción Aplicada", respuesta.mensaje, "exito");
      document.getElementById("listaInventarioCompleto").innerHTML = "<tr><td colspan='7' style='text-align:center; padding:25px;'>Actualizando inventario...</td></tr>";
      google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || pinAutorizado || PIN_SESION_ACTIVA);
    } else {
      mostrarAviso("Error", respuesta.mensaje, "error");
    }
  }).configurarDescuentoProducto(idProductoParaOferta, valor, tipo, fecha, pinAutorizado);
}

function abrirModalAjusteStock(id, nombre, stockActual) {
  idProductoAAjustar = id;
  document.getElementById("lblAjusteProducto").innerText = nombre + "\nExistencia actual: " + stockActual;
  document.getElementById("inputNuevoStock").value = stockActual;
  document.getElementById("modalAjusteStock").classList.add("activo");
}

function cerrarModalAjusteStock() {
  document.getElementById("modalAjusteStock").classList.remove("activo");
  idProductoAAjustar = "";
}

function modificarCantidadStock(cambio) {
  var input = document.getElementById("inputNuevoStock");
  var valorActual = parseInt(input.value) || 0;
  var nuevoValor = valorActual + cambio;
  if (nuevoValor < 0) nuevoValor = 0;
  input.value = nuevoValor;
}

function guardarAjusteStock() {
  var nuevoStock = document.getElementById("inputNuevoStock").value;
  if (nuevoStock === "" || idProductoAAjustar === "") return;
  document.getElementById("btnGuardarStock").innerText = "Guardando...";
  document.getElementById("btnGuardarStock").disabled = true;
  google.script.run.withSuccessHandler(respuestaAjusteStock).actualizarStock(idProductoAAjustar, nuevoStock, CAJERO_ACTIVO, PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
}

function respuestaAjusteStock(respuesta) {
  document.getElementById("btnGuardarStock").innerText = "Confirmar";
  document.getElementById("btnGuardarStock").disabled = false;
  cerrarModalAjusteStock();
  if (respuesta.exito) {
    mostrarAviso("Inventario Actualizado", respuesta.mensaje, "exito");
    document.getElementById("listaInventarioCompleto").innerHTML = "<tr><td colspan='7' style='text-align:center; padding:25px;'>Actualizando inventario...</td></tr>";
    google.script.run.withSuccessHandler(mostrarInventarioCompleto).obtenerInventarioVisual(PIN_ADMIN_INVENTARIO || PIN_SESION_ACTIVA);
  } else {
    mostrarAviso("Error", respuesta.mensaje, "error");
  }
}

document.addEventListener("keydown", function(event) {
  if (event.key === "F1") {
    event.preventDefault();
    document.getElementById("codigo").focus();
  }
  if (event.key === "F2") {
    event.preventDefault();
    document.getElementById("selectMetodoPago").focus();
  }
  if (event.key === "F4") {
    event.preventDefault();
    ponerCarritoEnEspera();
  }
  if (event.key === "Escape") {
    cerrarTodasLasSugerencias();
    if (document.getElementById("modalLicenciaSistema") && document.getElementById("modalLicenciaSistema").classList.contains("activo")) { cerrarModalLicenciaSistema(); return; }
    if (document.getElementById("modalEscanerCamara").classList.contains("activo")) { detenerEscanerCamara(); return; }
    if (document.getElementById("modalControlSuscripciones") && document.getElementById("modalControlSuscripciones").classList.contains("activo")) { cerrarModalControlSuscripciones(); return; }
    if (document.getElementById("modalAuditoriaSeguridad") && document.getElementById("modalAuditoriaSeguridad").classList.contains("activo")) { cerrarModalAuditoriaSeguridad(); return; }
    if (document.getElementById("modalArqueoCiego") && document.getElementById("modalArqueoCiego").classList.contains("activo")) { cerrarModalArqueoCiego(); return; }
    if (document.getElementById("modalBovedaDatos").classList.contains("activo")) { cerrarModalBovedaDatos(); return; }
    if (document.getElementById("modalPersonalizarTicket").classList.contains("activo")) { cerrarModalDiseñoTicket(); return; }
    if (document.getElementById("modalKardex").classList.contains("activo")) { cerrarModalKardex(); return; }
    if (document.getElementById("modalMensaje").classList.contains("activo")) { cerrarModalMensaje(); return; }
    if (document.getElementById("ventanaExito").classList.contains("activo")) { cerrarVentanaExito(); return; }
    if (document.getElementById("modalPin").classList.contains("activo")) { cerrarModalPin(); return; }
    if (document.getElementById("modalFichaProducto").classList.contains("activo")) { cerrarFichaProducto(); return; }
    if (document.getElementById("modalGestionUsuarios").classList.contains("activo")) { cerrarModalUsuarios(); return; }
    if (document.getElementById("modalDevolucionParcial").classList.contains("activo")) { cerrarModalDevolucion(); return; }
    if (document.getElementById("modalLiquidarEnvio").classList.contains("activo")) { cerrarModalLiquidar(); return; }
    if (document.getElementById("modalDetalleTicket").classList.contains("activo")) { cerrarModalDetalleTicket(); return; }
    if (document.getElementById("modalAjusteStock").classList.contains("activo")) { cerrarModalAjusteStock(); return; }
    if (document.getElementById("modalOfertaProducto").classList.contains("activo")) { cerrarModalOferta(); return; }
    if (document.getElementById("modalInventario").classList.contains("activo")) { cerrarModalInventario(); return; }
    if (document.getElementById("modalHistorial").classList.contains("activo")) { cerrarHistorial(); return; }
    if (document.getElementById("modalCorteCaja").classList.contains("activo")) { cerrarCorteCaja(); return; }
    if (document.getElementById("modalGastos").classList.contains("activo")) { cerrarModalGasto(); return; }
    if (document.getElementById("modalMenuEtiquetas").classList.contains("activo")) { cerrarModalMenuEtiquetas(); return; }
    if (typeof purgarPinAdminMemoria === "function") purgarPinAdminMemoria();
  }
  if (event.key === "+" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
    event.preventDefault();
    if (carrito.length > 0 && !document.getElementById("btnCobrar").disabled && !document.getElementById("ventanaExito").classList.contains("activo")) {
      procesarCobro();
    }
  }
});