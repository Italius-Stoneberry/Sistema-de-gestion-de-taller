/* ================================================================
   Frontend funcional del Sistema de Gestión de Taller.
   Vanilla JS, sin framework ni build: fácil de servir y de reemplazar.
   Toda la lógica de datos vive acá; la parte visual es intencionalmente
   mínima (ver styles.css).
   ================================================================ */

// ---------- Estado y utilidades ----------
let TOKEN = localStorage.getItem('token') || null;
let USER = JSON.parse(localStorage.getItem('user') || 'null');

const $ = (sel) => document.querySelector(sel);
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const puedeEditar = () => USER && (USER.rol === 'admin' || USER.rol === 'gestor');
const esAdmin = () => USER && USER.rol === 'admin';
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
const IVA = 1.21; // alícuota general — el precio con IVA se calcula al vuelo, nunca se guarda

// ====== DATOS DEL TALLER (completar UNA vez: salen en los presupuestos) ======
const DATOS_TALLER = {
  nombre: 'GraficArte',
  cuit: '23-21372397-9',            // CUIT
  iibb: '108797',             // Ingresos Brutos
  inicio: '08/2015',                // Inicio de actividades (MM/AAAA)
  iva: 'Responsable Inscripto',     // Condición frente al IVA del taller
  correo: 'graficarte@gmail.com',
  instagram: '@graficarte_mdz',
  whatsapp: '+54 9 261 580-8038',
};
// ============================================================================
const conIVA = (n) => money(Number(n || 0) * IVA);
const fecha = (d) => (d ? String(d).slice(0, 10) : '');
// Para MOSTRAR en pantalla: DD/MM/AAAA (los <input type="date"> siguen usando fecha()).
const fechaAR = (d) => { const s = fecha(d); const p = s.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s; };

const LBL = {
  disciplina: { laser: 'Láser', serigrafia: 'Serigrafía', ploteo: 'Ploteo/Cartelería', impresion: 'Impresión' },
  estado: { cotizar: 'Por cotizar', presupuestado: 'Presupuestado', pedido: 'Pedido', en_progreso: 'En progreso', en_espera: 'En espera', finalizado: 'Finalizado' },
  cheque_tipo: { recibido: 'Recibido', emitido: 'Emitido' },
  cheque_modalidad: { fisico: 'Físico', electronico: 'E-check' },
  cheque_estado: { pendiente: 'Pendiente', cobrado: 'Cobrado', depositado: 'Depositado', rechazado: 'Rechazado' },
  pago_estado: { pendiente: 'Pendiente', pagado: 'Pagado' },
  rubro_precio: { serigrafia: 'Serigrafía', laser: 'Grabado láser (CO2/fibra)', impresion: 'Impresión', ploteo: 'Cartelería / Ploteo', diseno: 'Diseño' },
  modo_precio: { por_cantidad: 'Por cantidad', por_m2: 'Por m²', por_hora: 'Por hora' },
};

// Badges de estado con la paleta de marca (dorado=activo, negro=ok, rojo=alerta, gris=neutro)
function badge(txt, tipo) { return `<span class="badge badge-${tipo}">${txt}</span>`; }
function badgeEstado(e) {
  const m = { cotizar: 'neutro', presupuestado: 'activo', pedido: 'neutro', en_progreso: 'activo', en_espera: 'alerta', finalizado: 'ok' };
  return badge(LBL.estado[e] || e, m[e] || 'neutro');
}
function badgeCheque(e) {
  const m = { pendiente: 'neutro', cobrado: 'ok', depositado: 'ok', rechazado: 'alerta' };
  return badge(LBL.cheque_estado[e] || e, m[e] || 'neutro');
}
function badgePago(e) {
  const m = { pendiente: 'alerta', pagado: 'ok' };
  return badge(LBL.pago_estado[e] || e, m[e] || 'neutro');
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { salir(); throw new Error('Sesión vencida'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}

// ---------- Toasts (avisos no bloqueantes, reemplazan a alert) ----------
function toast(msg, tipo = 'ok') {
  let cont = document.getElementById('toasts');
  if (!cont) { cont = document.createElement('div'); cont.id = 'toasts'; document.body.appendChild(cont); }
  const t = document.createElement('div');
  t.className = 'toast' + (tipo === 'error' ? ' toast-error' : '');
  t.textContent = msg;
  cont.appendChild(t);
  setTimeout(() => { t.classList.add('irse'); setTimeout(() => t.remove(), 350); }, 3500);
}
// Cualquier error async sin manejar (fallos de API en los handlers) termina en un toast.
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || 'Error inesperado';
  if (msg !== 'Sesión vencida') toast(msg, 'error');
  e.preventDefault();
});

// ---------- Móvil: copiar los encabezados a cada celda (data-label) ----------
// styles.css usa esas etiquetas para mostrar cada fila como tarjeta en pantallas chicas.
function etiquetarTabla(tabla) {
  const ths = [...tabla.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  if (!ths.length) return;
  tabla.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => { if (ths[i]) td.dataset.label = ths[i]; });
  });
}
new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.tagName === 'TABLE') etiquetarTabla(n);
    else if (n.querySelectorAll) n.querySelectorAll('table').forEach(etiquetarTabla);
  }));
}).observe(document.body, { childList: true, subtree: true });

// ---------- PWA: registrar el service worker (solo funciona con HTTPS o localhost) ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });

// ---------- Login / logout ----------
$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const { token, user } = await api('POST', '/auth/login', {
      email: $('#login-email').value.trim(),
      password: $('#login-password').value,
    });
    TOKEN = token; USER = user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    iniciarApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

function salir() {
  TOKEN = null; USER = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  $('#app').classList.add('oculto');
  $('#vista-login').classList.remove('oculto');
}
$('#btn-salir').addEventListener('click', salir);

// ---------- Arranque de la app ----------
const VISTAS = [
  { id: 'dashboard', nombre: 'Inicio', render: vistaDashboard },
  { id: 'trabajos', nombre: 'Trabajos', render: vistaTrabajos },
  { id: 'cheques', nombre: 'Cheques', render: vistaCheques },
  { id: 'pagos', nombre: 'Pagos de servicios', render: vistaPagos },
  { id: 'compras', nombre: 'Compras', render: vistaCompras },
  { id: 'precios', nombre: 'Precios', render: vistaPrecios },
  { id: 'clientes', nombre: 'Clientes', render: vistaClientes },
  { id: 'bandeja', nombre: 'Bandeja', render: vistaBandeja },
  { id: 'usuarios', nombre: 'Usuarios', render: vistaUsuarios, soloAdmin: true },
];

function iniciarApp() {
  $('#vista-login').classList.add('oculto');
  $('#app').classList.remove('oculto');
  $('#usuario-actual').textContent = `${USER.nombre} (${USER.rol})`;
  const menu = $('#menu');
  menu.innerHTML = '';
  VISTAS.filter((v) => !v.soloAdmin || esAdmin()).forEach((v) => {
    const b = document.createElement('button');
    b.textContent = v.nombre;
    b.dataset.vista = v.id;
    b.onclick = () => abrirVista(v.id);
    menu.appendChild(b);
  });
  abrirVista('dashboard');
  refrescarBadgeBandeja();
}

function abrirVista(id) {
  const v = VISTAS.find((x) => x.id === id);
  document.querySelectorAll('#menu button').forEach((b) => b.classList.toggle('activo', b.dataset.vista === id));
  $('#contenido').innerHTML = '<p>Cargando...</p>';
  v.render();
}

// ---------- Dashboard ----------
async function vistaDashboard() {
  const d = await api('GET', '/dashboard');
  const estados = {};
  d.trabajos_por_estado.forEach((r) => (estados[r.estado] = r.n));
  const disc = d.en_curso_por_disciplina.map((r) => `${LBL.disciplina[r.disciplina] || r.disciplina}: ${r.n}`).join(' · ') || 'sin trabajos en curso';

  $('#contenido').innerHTML = `
    <h2>Resumen</h2>
    <div class="tarjetas">
      <div class="tarjeta"><div>Por cotizar</div><div class="num">${estados.cotizar || 0}</div></div>
      <div class="tarjeta"><div>Presupuestado</div><div class="num">${estados.presupuestado || 0}</div></div>
      <div class="tarjeta"><div>Pedidos</div><div class="num">${estados.pedido || 0}</div></div>
      <div class="tarjeta"><div>En progreso</div><div class="num">${estados.en_progreso || 0}</div></div>
      <div class="tarjeta"><div>En espera</div><div class="num">${estados.en_espera || 0}</div></div>
      <div class="tarjeta"><div>Finalizados</div><div class="num">${estados.finalizado || 0}</div></div>
    </div>
    <p style="margin-top:12px"><strong>En curso por disciplina:</strong> ${esc(disc)}</p>
    <div class="tarjetas">
      <div class="tarjeta"><div>Finalizados sin cobrar</div><div class="num">${d.finalizados.sin_cobrar}</div><div>${money(d.finalizados.monto_por_cobrar)}</div></div>
      <div class="tarjeta"><div>Finalizados sin facturar</div><div class="num">${d.finalizados.sin_facturar}</div></div>
      <div class="tarjeta"><div>Cheques pendientes</div><div class="num">${d.cheques_pendientes.n}</div><div>${money(d.cheques_pendientes.total)}</div></div>
    </div>

    <h3>Cheques próximos a vencer (15 días)</h3>
    ${tablaSimple(d.cheques_proximos, ['fecha_cobro', 'tipo', 'relacionado', 'importe'],
    (c) => `<tr><td>${fechaAR(c.fecha_cobro)}</td><td>${LBL.cheque_tipo[c.tipo]}</td><td>${esc(c.relacionado)}</td><td>${money(c.importe)}</td></tr>`,
    ['Fecha', 'Tipo', 'Relacionado', 'Importe'])}

    <h3>Pagos de servicios pendientes</h3>
    ${tablaSimple(d.pagos_pendientes, ['concepto'],
      (p) => `<tr><td>${esc(p.concepto)}</td><td>${fechaAR(p.fecha_vencimiento)}</td><td>${money(p.importe)}</td></tr>`,
      ['Concepto', 'Vence', 'Importe'])}
  `;
}

function tablaSimple(filas, _c, rowFn, headers) {
  if (!filas || !filas.length) return '<p>Nada por ahora.</p>';
  return `<div class="tabla-scroll"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${filas.map(rowFn).join('')}</tbody></table></div>`;
}

// ---------- Trabajos ----------
async function vistaTrabajos() {
  const cont = $('#contenido');
  cont.innerHTML = `
    <h2>Trabajos</h2>
    <div class="filtros">
      <label>Estado <select id="f-estado"><option value="">Todos</option>${opts(LBL.estado)}</select></label>
      <label>Disciplina <select id="f-disciplina"><option value="">Todas</option>${opts(LBL.disciplina)}</select></label>
      <label>Cobro <select id="f-pagado"><option value="">Todos</option><option value="false">No pagado</option><option value="true">Pagado</option></select></label>
      <label>Facturación <select id="f-facturado"><option value="">Todos</option><option value="false">No facturado</option><option value="true">Facturado</option></select></label>
      <label>Buscar <input id="f-buscar" placeholder="cliente o descripción" /></label>
      ${puedeEditar() ? '<button id="btn-nuevo-trabajo" class="btn-primary">+ Nuevo trabajo</button>' : ''}
    </div>
    <div id="lista-trabajos"></div>
  `;
  ['f-estado', 'f-disciplina', 'f-pagado', 'f-facturado'].forEach((id) => $('#' + id).addEventListener('change', cargarTrabajos));
  $('#f-buscar').addEventListener('input', debounce(cargarTrabajos, 300));
  if (puedeEditar()) $('#btn-nuevo-trabajo').addEventListener('click', () => formTrabajo());
  cargarTrabajos();
}

const AVANCE = { cotizar: 'presupuestado', presupuestado: 'pedido', pedido: 'en_progreso', en_progreso: 'finalizado', en_espera: 'en_progreso', finalizado: 'finalizado' };

async function cargarTrabajos() {
  const qs = new URLSearchParams();
  const g = (id) => $('#' + id) && $('#' + id).value;
  if (g('f-estado')) qs.set('estado', g('f-estado'));
  if (g('f-disciplina')) qs.set('disciplina', g('f-disciplina'));
  if (g('f-pagado')) qs.set('pagado', g('f-pagado'));
  if (g('f-facturado')) qs.set('facturado', g('f-facturado'));
  if (g('f-buscar')) qs.set('buscar', g('f-buscar'));
  const filas = await api('GET', '/trabajos?' + qs.toString());
  renderTrabajos(filas);
}

// Renderiza la lista EN EL ORDEN RECIBIDO. Los cambios rápidos (estado/cobro/facturación)
// editan la fila en su lugar y re-renderizan este mismo array: nada salta de posición.
// El orden por estado se aplica recién al recargar la vista o cambiar un filtro.
function renderTrabajos(filas) {
  $('#lista-trabajos').innerHTML = filas.length ? `
    <table><thead><tr>
      <th>Cliente</th><th>Descripción</th><th>Disciplina</th><th>Estado</th>
      <th>Cobro</th><th>Facturación</th><th>Precio</th><th>Precio c/IVA</th><th>Ingreso</th><th></th>
    </tr></thead><tbody>
    ${filas.map((t) => `<tr>
      <td>${esc(t.contacto_nombre || t.cliente)}${t.empresa_nombre ? ` <small style="color:var(--ga-texto-2)">(${esc(t.empresa_nombre)})</small>` : ''}${t.origen === 'ia' && !t.revisado ? ' <em>(IA sin revisar)</em>' : ''}</td>
      <td>${esc(t.descripcion)}</td>
      <td>${LBL.disciplina[t.disciplina] || t.disciplina}</td>
      <td><span class="clic" data-adv="${t.id}" title="Avanzar estado">${badgeEstado(t.estado)} <b class="adv">▸</b></span></td>
      <td><span class="clic" data-cobro="${t.id}" title="Marcar cobro">${t.pagado ? badge('Pagado', 'ok') : badge('No pagado', 'alerta')}</span></td>
      <td><span class="clic" data-fact="${t.id}" title="Marcar facturación">${t.facturado ? badge('Facturado', 'ok') : badge('No facturado', 'neutro')}</span></td>
      <td>${money(t.precio)}${t.cantidad > 0 && t.precio_unitario > 0 ? `<br><small style="color:var(--ga-texto-2)">${Number(t.cantidad)} × ${money(t.precio_unitario)}</small>` : ''}</td>
      <td>${conIVA(t.precio)}</td>
      <td>${fechaAR(t.fecha_ingreso)}</td>
      <td class="acciones">${puedeEditar() ? `<button data-edit="${t.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${t.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}
    </tbody></table>` : '<p>No hay trabajos con esos filtros.</p>';

  $('#lista-trabajos').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    const t = filas.find((x) => x.id == b.dataset.edit);
    // Al guardar desde el modal, refresca la fila en su lugar (sin reordenar)
    formTrabajo(t, async () => {
      try {
        const act = await api('GET', '/trabajos/' + t.id);
        const i = filas.findIndex((x) => x.id == t.id);
        if (i >= 0) filas[i] = act;
        renderTrabajos(filas);
      } catch { cargarTrabajos(); }
    });
  });
  $('#lista-trabajos').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (confirm('¿Eliminar este trabajo?')) { await api('DELETE', '/trabajos/' + b.dataset.del); cargarTrabajos(); }
  });

  const rapido = async (id, campos) => {
    try {
      const act = await api('PATCH', '/trabajos/' + id + '/rapido', campos);
      const i = filas.findIndex((x) => x.id == id);
      // Merge: la respuesta trae la fila actualizada; conservamos empresa/contacto del join.
      if (i >= 0) filas[i] = { ...filas[i], ...act };
      renderTrabajos(filas);
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#lista-trabajos').querySelectorAll('[data-adv]').forEach((b) => b.onclick = () => {
    const t = filas.find((x) => x.id == b.dataset.adv);
    const sig = AVANCE[t.estado] || t.estado;
    if (sig !== t.estado) rapido(t.id, { estado: sig });
  });
  $('#lista-trabajos').querySelectorAll('[data-cobro]').forEach((b) => b.onclick = () => {
    const t = filas.find((x) => x.id == b.dataset.cobro); rapido(t.id, { pagado: !t.pagado });
  });
  $('#lista-trabajos').querySelectorAll('[data-fact]').forEach((b) => b.onclick = () => {
    const t = filas.find((x) => x.id == b.dataset.fact); rapido(t.id, { facturado: !t.facturado });
  });
}

function formTrabajo(t, onDone) {
  t = t || {};
  abrirModal(`${t.id ? 'Editar' : 'Nuevo'} trabajo`, `
    <div class="grid">
      <label class="full">Empresa (opcional) <input name="empresa_nombre" list="dl-empresas" value="${esc(t.empresa_nombre)}" placeholder="Andreu, Muni... (vacío si no aplica)" /></label>
      <label class="full">Contacto / Cliente <input name="contacto_nombre" list="dl-contactos" value="${esc(t.contacto_nombre || t.cliente)}" placeholder="Ramiro, Marianela, o el nombre del cliente" required /></label>
      <datalist id="dl-empresas"></datalist>
      <datalist id="dl-contactos"></datalist>
      <label>Disciplina <select name="disciplina">${opts(LBL.disciplina, t.disciplina)}</select></label>
      <label class="full">Descripción <textarea name="descripcion">${esc(t.descripcion)}</textarea></label>
      <label>Estado <select name="estado">${opts(LBL.estado, t.estado)}</select></label>
      <label>Cantidad <input name="cantidad" type="number" step="1" min="0" value="${t.cantidad ? Number(t.cantidad) : ''}" placeholder="ej: 100" /></label>
      <label>Precio unitario <input name="precio_unitario" type="number" step="0.01" value="${t.precio_unitario ? Number(t.precio_unitario) : ''}" placeholder="por unidad" /></label>
      <label>Precio (total) <input name="precio" type="number" step="0.01" value="${t.precio ?? ''}" /></label>
      <label>Precio c/IVA (21%) <input id="precio-iva" disabled value="${conIVA(t.precio)}" /></label>
      <label>Cobro <select name="pagado"><option value="false">No pagado</option><option value="true" ${t.pagado ? 'selected' : ''}>Pagado</option></select></label>
      <label>Facturación <select name="facturado"><option value="false">No facturado</option><option value="true" ${t.facturado ? 'selected' : ''}>Facturado</option></select></label>
      <label>Entrega estimada <input name="fecha_entrega_estimada" type="date" value="${fecha(t.fecha_entrega_estimada)}" /></label>
      <label>Responsable <input name="responsable" value="${esc(t.responsable)}" /></label>
      <label class="full">Notas <textarea name="notas">${esc(t.notas)}</textarea></label>
      ${galeriaCampo('trabajo', t.id)}
    </div>
  `, async (f) => {
    const body = {
      empresa_nombre: f.empresa_nombre.value, contacto_nombre: f.contacto_nombre.value,
      descripcion: f.descripcion.value,
      disciplina: f.disciplina.value, estado: f.estado.value, precio: Number(f.precio.value || 0),
      cantidad: f.cantidad.value || null, precio_unitario: f.precio_unitario.value || null,
      pagado: f.pagado.value === 'true', facturado: f.facturado.value === 'true',
      fecha_entrega_estimada: f.fecha_entrega_estimada.value || null,
      responsable: f.responsable.value, notas: f.notas.value,
    };
    if (t.id) await api('PUT', '/trabajos/' + t.id, body);
    else await api('POST', '/trabajos', body);
    cerrarModal(); (onDone || cargarTrabajos)();
  });
  poblarDatalistsCliente();
  const $m = (sel) => document.querySelector('#modal-fondo ' + sel);
  const fCant = $m('[name="cantidad"]'), fUnit = $m('[name="precio_unitario"]'), fPrecio = $m('[name="precio"]'), fIva = $m('#precio-iva');
  const recalc = () => {
    const c = Number(fCant.value || 0), u = Number(fUnit.value || 0);
    if (c > 0 && u > 0) {
      fPrecio.value = Math.round(c * u * 100) / 100;
      fPrecio.readOnly = true; fPrecio.style.background = 'var(--ga-panel)';
      fPrecio.title = 'Se calcula solo: cantidad × precio unitario';
    } else {
      fPrecio.readOnly = false; fPrecio.style.background = ''; fPrecio.title = '';
    }
    if (fIva) fIva.value = conIVA(fPrecio.value);
  };
  [fCant, fUnit, fPrecio].forEach((el) => el && el.addEventListener('input', recalc));
  recalc();
  if (t.id) cargarGaleria('trabajo', t.id);
}

// ---------- Cheques ----------
async function vistaCheques() {
  $('#contenido').innerHTML = `
    <h2>Cheques</h2>
    <div class="filtros">
      <label>Tipo <select id="cf-tipo"><option value="">Todos</option>${opts(LBL.cheque_tipo)}</select></label>
      <label>Estado <select id="cf-estado"><option value="">Todos</option>${opts(LBL.cheque_estado)}</select></label>
      ${puedeEditar() ? '<button id="btn-nuevo-cheque" class="btn-primary">+ Nuevo cheque</button>' : ''}
    </div>
    <div id="lista-cheques"></div>`;
  ['cf-tipo', 'cf-estado'].forEach((id) => $('#' + id).addEventListener('change', cargarCheques));
  if (puedeEditar()) $('#btn-nuevo-cheque').addEventListener('click', () => formCheque());
  cargarCheques();
}

async function cargarCheques() {
  const qs = new URLSearchParams();
  if ($('#cf-tipo').value) qs.set('tipo', $('#cf-tipo').value);
  if ($('#cf-estado').value) qs.set('estado', $('#cf-estado').value);
  const filas = await api('GET', '/cheques?' + qs.toString());
  $('#lista-cheques').innerHTML = filas.length ? `
    <table><thead><tr><th>Tipo</th><th>Nº</th><th>Banco</th><th>Relacionado</th><th>Importe</th><th>Cobro/Venc.</th><th>Estado</th><th></th></tr></thead><tbody>
    ${filas.map((c) => `<tr>
      <td>${LBL.cheque_tipo[c.tipo]}${c.modalidad === 'electronico' ? ' <span class="badge badge-neutro">E-check</span>' : ''}${c.origen === 'ia' && !c.revisado ? ' <em>(IA)</em>' : ''}</td><td>${esc(c.numero)}</td><td>${esc(c.banco)}</td>
      <td>${esc(c.relacionado)}</td><td>${money(c.importe)}</td><td>${fechaAR(c.fecha_cobro)}</td>
      <td>${badgeCheque(c.estado)}</td>
      <td class="acciones">${puedeEditar() ? `<button data-edit="${c.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${c.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p>Sin cheques.</p>';
  $('#lista-cheques').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formCheque(filas.find((c) => c.id == b.dataset.edit)));
  $('#lista-cheques').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('¿Eliminar cheque?')) { await api('DELETE', '/cheques/' + b.dataset.del); cargarCheques(); } });
}

function formCheque(c, onDone) {
  c = c || {};
  abrirModal(`${c.id ? 'Editar' : 'Nuevo'} cheque`, `
    <div class="grid">
      <label>Tipo <select name="tipo">${opts(LBL.cheque_tipo, c.tipo)}</select></label>
      <label>Modalidad <select name="modalidad">${opts(LBL.cheque_modalidad, c.modalidad || 'fisico')}</select></label>
      <label>Estado <select name="estado">${opts(LBL.cheque_estado, c.estado)}</select></label>
      <label>Número <input name="numero" value="${esc(c.numero)}" /></label>
      <label>Banco <input name="banco" value="${esc(c.banco)}" /></label>
      <label>Importe <input name="importe" type="number" step="0.01" value="${c.importe ?? ''}" /></label>
      <label>Cliente/Proveedor <input name="relacionado" value="${esc(c.relacionado)}" /></label>
      <label>Fecha emisión <input name="fecha_emision" type="date" value="${fecha(c.fecha_emision)}" /></label>
      <label>Fecha cobro/venc. <input name="fecha_cobro" type="date" value="${fecha(c.fecha_cobro)}" /></label>
      ${galeriaCampo('cheque', c.id)}
    </div>`, async (f) => {
    const body = {
      tipo: f.tipo.value, modalidad: f.modalidad.value, estado: f.estado.value, numero: f.numero.value, banco: f.banco.value,
      importe: Number(f.importe.value || 0), relacionado: f.relacionado.value,
      fecha_emision: f.fecha_emision.value || null, fecha_cobro: f.fecha_cobro.value || null
    };
    if (c.id) await api('PUT', '/cheques/' + c.id, body); else await api('POST', '/cheques', body);
    cerrarModal(); (onDone || cargarCheques)();
  });
  if (c.id) cargarGaleria('cheque', c.id);
}

// ---------- GALERÍA DE ADJUNTOS (imágenes) ----------
function galeriaCampo(entidad, id) {
  if (!id) return '';
  return `<div class="full">
    <div class="galeria-tit">Fotos</div>
    <div id="galeria" class="galeria">Cargando…</div>
  </div>`;
}
async function cargarGaleria(entidad, id) {
  const cont = $('#galeria');
  if (!cont) return;
  let filas = [];
  try { filas = await api('GET', `/adjuntos?entidad=${entidad}&entidad_id=${id}`); } catch { cont.textContent = 'No se pudieron cargar las fotos.'; return; }
  if (!filas.length) { cont.innerHTML = '<span class="galeria-vacia">Sin fotos.</span>'; return; }
  cont.innerHTML = '';
  for (const a of filas) {
    const wrap = document.createElement('div');
    wrap.className = 'foto';
    const img = document.createElement('img');
    img.alt = a.descripcion || 'foto';
    img.loading = 'lazy';
    try {
      const res = await fetch('/api/adjuntos/' + a.id + '/archivo', { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} });
      if (res.ok) { const url = URL.createObjectURL(await res.blob()); img.src = url; img.onclick = () => window.open(url, '_blank'); }
    } catch { /* ignora */ }
    wrap.appendChild(img);
    if (a.descripcion) { const cap = document.createElement('div'); cap.className = 'foto-cap'; cap.textContent = a.descripcion; wrap.appendChild(cap); }
    if (puedeEditar()) {
      const del = document.createElement('button');
      del.type = 'button'; del.textContent = '✕'; del.className = 'foto-del'; del.title = 'Borrar';
      del.onclick = async () => { if (confirm('¿Borrar esta foto?')) { await api('DELETE', '/adjuntos/' + a.id); cargarGaleria(entidad, id); } };
      wrap.appendChild(del);
    }
    cont.appendChild(wrap);
  }
}

// ---------- Pagos de servicios ----------
async function vistaPagos() {
  $('#contenido').innerHTML = `
    <h2>Pagos de servicios</h2>
    <div class="filtros">
      <label>Estado <select id="pf-estado"><option value="">Todos</option>${opts(LBL.pago_estado)}</select></label>
      ${puedeEditar() ? '<button id="btn-nuevo-pago" class="btn-primary">+ Nuevo pago</button>' : ''}
    </div>
    <div id="lista-pagos"></div>`;
  $('#pf-estado').addEventListener('change', cargarPagos);
  if (puedeEditar()) $('#btn-nuevo-pago').addEventListener('click', () => formPago());
  cargarPagos();
}

async function cargarPagos() {
  const qs = new URLSearchParams();
  if ($('#pf-estado').value) qs.set('estado', $('#pf-estado').value);
  const filas = await api('GET', '/pagos?' + qs.toString());
  $('#lista-pagos').innerHTML = filas.length ? `
    <table><thead><tr><th>Concepto</th><th>Período</th><th>Vence</th><th>Importe</th><th>Estado</th><th></th></tr></thead><tbody>
    ${filas.map((p) => `<tr>
      <td>${esc(p.concepto)}${p.origen === 'ia' && !p.revisado ? ' <em>(IA)</em>' : ''}</td><td>${esc(p.periodo)}</td><td>${fechaAR(p.fecha_vencimiento)}</td>
      <td>${money(p.importe)}</td><td>${badgePago(p.estado)}</td>
      <td class="acciones">${puedeEditar() ? `<button data-edit="${p.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${p.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p>Sin pagos cargados.</p>';
  $('#lista-pagos').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formPago(filas.find((p) => p.id == b.dataset.edit)));
  $('#lista-pagos').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('¿Eliminar pago?')) { await api('DELETE', '/pagos/' + b.dataset.del); cargarPagos(); } });
}

function formPago(p, onDone) {
  p = p || {};
  abrirModal(`${p.id ? 'Editar' : 'Nuevo'} pago`, `
    <div class="grid">
      <label class="full">Concepto <input name="concepto" value="${esc(p.concepto)}" required /></label>
      <label>Importe <input name="importe" type="number" step="0.01" value="${p.importe ?? ''}" /></label>
      <label>Estado <select name="estado">${opts(LBL.pago_estado, p.estado)}</select></label>
      <label>Período <input name="periodo" placeholder="2026-07" value="${esc(p.periodo)}" /></label>
      <label>Vencimiento <input name="fecha_vencimiento" type="date" value="${fecha(p.fecha_vencimiento)}" /></label>
      <label class="full">Notas <textarea name="notas">${esc(p.notas)}</textarea></label>
    </div>`, async (f) => {
    const body = {
      concepto: f.concepto.value, importe: Number(f.importe.value || 0), estado: f.estado.value,
      periodo: f.periodo.value, fecha_vencimiento: f.fecha_vencimiento.value || null, notas: f.notas.value
    };
    if (p.id) await api('PUT', '/pagos/' + p.id, body); else await api('POST', '/pagos', body);
    cerrarModal(); (onDone || cargarPagos)();
  });
}

// ---------- COMPRAS (lista de insumos) ----------
function vistaCompras() {
  $('#contenido').innerHTML = `
    <h2>Lista de compras</h2>
    <div class="filtros">
      <label>Ver <select id="cf-comprado"><option value="false">Pendientes</option><option value="true">Compradas</option><option value="">Todas</option></select></label>
      ${puedeEditar() ? '<button id="btn-nueva-compra" class="btn-primary">+ Agregar</button>' : ''}
    </div>
    <div id="lista-compras"></div>`;
  $('#cf-comprado').addEventListener('change', cargarCompras);
  if (puedeEditar()) $('#btn-nueva-compra').addEventListener('click', () => formCompra());
  cargarCompras();
}

async function cargarCompras() {
  const qs = new URLSearchParams();
  const f = $('#cf-comprado').value;
  if (f) qs.set('comprado', f);
  const filas = await api('GET', '/compras?' + qs.toString());
  $('#lista-compras').innerHTML = filas.length ? `
    <table><thead><tr><th></th><th>Ítem</th><th>Cantidad</th><th></th></tr></thead><tbody>
    ${filas.map((c) => `<tr>
      <td>${puedeEditar() ? `<input type="checkbox" data-check="${c.id}" ${c.comprado ? 'checked' : ''} />` : (c.comprado ? '✅' : '⬜')}</td>
      <td>${c.comprado ? '<s>' + esc(c.item) + '</s>' : esc(c.item)}${c.origen === 'ia' ? ' <em>(IA)</em>' : ''}</td>
      <td>${esc(c.cantidad)}</td>
      <td class="acciones">${puedeEditar() ? `<button data-edit="${c.id}">Editar</button><button data-del="${c.id}" class="btn-danger">Borrar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p>La lista está vacía.</p>';
  $('#lista-compras').querySelectorAll('[data-check]').forEach((b) => b.onclick = async () => { await api('PATCH', '/compras/' + b.dataset.check + '/comprado', { comprado: b.checked }); cargarCompras(); });
  $('#lista-compras').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formCompra(filas.find((c) => c.id == b.dataset.edit)));
  $('#lista-compras').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('¿Borrar de la lista?')) { await api('DELETE', '/compras/' + b.dataset.del); cargarCompras(); } });
}

function formCompra(c, onDone) {
  c = c || {};
  abrirModal(`${c.id ? 'Editar' : 'Agregar'} ítem`, `
    <div class="grid">
      <label class="full">Ítem <input name="item" value="${esc(c.item)}" required /></label>
      <label class="full">Cantidad <input name="cantidad" placeholder="2 rollos, medio kilo…" value="${esc(c.cantidad)}" /></label>
    </div>`, async (f) => {
    const body = { item: f.item.value, cantidad: f.cantidad.value || null };
    if (c.id) await api('PUT', '/compras/' + c.id, body); else await api('POST', '/compras', body);
    cerrarModal(); (onDone || cargarCompras)();
  });
}

// ---------- Usuarios (solo admin) ----------
async function vistaUsuarios() {
  $('#contenido').innerHTML = `
    <h2>Usuarios</h2>
    <div class="filtros"><button id="btn-nuevo-usuario" class="btn-primary">+ Nuevo usuario</button></div>
    <div id="lista-usuarios"></div>`;
  $('#btn-nuevo-usuario').addEventListener('click', () => formUsuario());
  cargarUsuarios();
}

async function cargarUsuarios() {
  const filas = await api('GET', '/usuarios');
  $('#lista-usuarios').innerHTML = `
    <table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Activo</th><th></th></tr></thead><tbody>
    ${filas.map((u) => `<tr>
      <td>${esc(u.nombre)}</td><td>${esc(u.email)}</td><td>${esc(u.rol)}</td><td>${u.activo ? 'Sí' : 'No'}</td>
      <td class="acciones"><button data-edit="${u.id}">Editar</button>${u.id != USER.id ? `<button data-del="${u.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#lista-usuarios').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formUsuario(filas.find((u) => u.id == b.dataset.edit)));
  $('#lista-usuarios').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('¿Eliminar usuario?')) { await api('DELETE', '/usuarios/' + b.dataset.del); cargarUsuarios(); } });
}

function formUsuario(u) {
  u = u || {};
  const roles = { admin: 'admin', gestor: 'gestor', consulta: 'consulta' };
  abrirModal(`${u.id ? 'Editar' : 'Nuevo'} usuario`, `
    <div class="grid">
      <label class="full">Nombre <input name="nombre" value="${esc(u.nombre)}" required /></label>
      ${u.id ? '' : '<label class="full">Email <input name="email" type="email" required /></label>'}
      <label>Rol <select name="rol">${opts(roles, u.rol)}</select></label>
      <label>Activo <select name="activo"><option value="true" ${u.activo !== false ? 'selected' : ''}>Sí</option><option value="false" ${u.activo === false ? 'selected' : ''}>No</option></select></label>
      <label class="full">${u.id ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña'} <input name="password" type="password" ${u.id ? '' : 'required'} /></label>
    </div>`, async (f) => {
    if (u.id) {
      const body = { nombre: f.nombre.value, rol: f.rol.value, activo: f.activo.value === 'true' };
      if (f.password.value) body.password = f.password.value;
      await api('PUT', '/usuarios/' + u.id, body);
    } else {
      await api('POST', '/usuarios', { nombre: f.nombre.value, email: f.email.value, rol: f.rol.value, password: f.password.value });
    }
    cerrarModal(); cargarUsuarios();
  });
}

// ---------- Bandeja (pendientes de revisar, cargados por IA) ----------
async function vistaBandeja() {
  $('#contenido').innerHTML = `
    <h2>Bandeja — pendientes de revisar</h2>
    <p style="font-size:13px">Entradas cargadas automáticamente (WhatsApp/correo). Revisá los datos y confirmá, o descartá.</p>
    <div id="lista-bandeja">Cargando...</div>`;
  cargarBandeja();
}

function accionesBandeja(tipo, id) {
  if (!puedeEditar()) return '';
  return `<button data-conf="${tipo}:${id}" class="btn-primary">Confirmar</button>
          <button data-editb="${tipo}:${id}">Editar</button>
          <button data-desc="${tipo}:${id}" class="btn-danger">Descartar</button>`;
}

async function cargarBandeja() {
  const d = await api('GET', '/bandeja');
  refrescarBadgeBandeja(d.total);
  const cont = $('#lista-bandeja');
  if (!cont) return;
  if (!d.total) { cont.innerHTML = '<p>Nada pendiente. Todo revisado.</p>'; return; }

  let html = '';
  if (d.trabajos.length) {
    html += '<h3>Trabajos</h3><table><thead><tr><th>Cliente</th><th>Descripción</th><th>Disciplina</th><th>Precio</th><th>Origen</th><th></th></tr></thead><tbody>' +
      d.trabajos.map((t) => `<tr><td>${esc(t.cliente)}</td><td>${esc(t.descripcion)}</td><td>${LBL.disciplina[t.disciplina] || t.disciplina}</td><td>${money(t.precio)}</td><td>${esc(t.origen_ref) || 'IA'}</td><td class="acciones">${accionesBandeja('trabajos', t.id)}</td></tr>`).join('') +
      '</tbody></table>';
  }
  if (d.cheques.length) {
    html += '<h3>Cheques</h3><table><thead><tr><th>Tipo</th><th>Relacionado</th><th>Importe</th><th>Cobro/Venc.</th><th>Origen</th><th></th></tr></thead><tbody>' +
      d.cheques.map((c) => `<tr><td>${LBL.cheque_tipo[c.tipo]}</td><td>${esc(c.relacionado)}</td><td>${money(c.importe)}</td><td>${fechaAR(c.fecha_cobro)}</td><td>${esc(c.origen_ref) || 'IA'}</td><td class="acciones">${accionesBandeja('cheques', c.id)}</td></tr>`).join('') +
      '</tbody></table>';
  }
  if (d.pagos.length) {
    html += '<h3>Pagos de servicios</h3><table><thead><tr><th>Concepto</th><th>Importe</th><th>Vence</th><th>Origen</th><th></th></tr></thead><tbody>' +
      d.pagos.map((p) => `<tr><td>${esc(p.concepto)}</td><td>${money(p.importe)}</td><td>${fechaAR(p.fecha_vencimiento)}</td><td>${esc(p.origen_ref) || 'IA'}</td><td class="acciones">${accionesBandeja('pagos', p.id)}</td></tr>`).join('') +
      '</tbody></table>';
  }
  cont.innerHTML = html;

  const lookup = { trabajos: d.trabajos, cheques: d.cheques, pagos: d.pagos };
  const forms = { trabajos: formTrabajo, cheques: formCheque, pagos: formPago };

  cont.querySelectorAll('[data-conf]').forEach((b) => b.onclick = async () => {
    const [tipo, id] = b.dataset.conf.split(':');
    await api('PATCH', `/${tipo}/${id}/confirmar`);
    cargarBandeja();
  });
  cont.querySelectorAll('[data-desc]').forEach((b) => b.onclick = async () => {
    const [tipo, id] = b.dataset.desc.split(':');
    if (confirm('¿Descartar esta entrada?')) { await api('DELETE', `/${tipo}/${id}/borrador`); cargarBandeja(); }
  });
  cont.querySelectorAll('[data-editb]').forEach((b) => b.onclick = () => {
    const [tipo, id] = b.dataset.editb.split(':');
    const item = lookup[tipo].find((x) => x.id == id);
    forms[tipo](item, cargarBandeja);
  });
}

async function refrescarBadgeBandeja(total) {
  try {
    if (total === undefined) { const d = await api('GET', '/bandeja'); total = d.total; }
  } catch { return; }
  const btn = document.querySelector('#menu button[data-vista="bandeja"]');
  if (btn) btn.textContent = 'Bandeja' + (total ? ` (${total})` : '');
  // El título de la pestaña también avisa cuántos pendientes hay.
  document.title = (total ? `(${total}) ` : '') + 'GraficArte — Gestión de Taller';
}
// Refresco automático: si entra algo por WhatsApp mientras la pestaña está abierta, se nota.
setInterval(() => { if (TOKEN && USER) refrescarBadgeBandeja(); }, 60000);

// ---------- Lista de precios + calculadora de presupuestos ----------
// Precio unitario según cantidad: usa la escala más alta que la cantidad alcanza
// (149 unidades → precio de 100). Si esa escala no está cargada, cae a la más cercana.
function precioUnitarioPara(item, cant) {
  const escalas = [[500, item.p500], [250, item.p250], [100, item.p100], [50, item.p50]]
    .filter(([, v]) => v != null && Number(v) > 0);
  if (!escalas.length) return null;
  const alcanzada = escalas.find(([min]) => cant >= min);
  return Number((alcanzada || escalas[escalas.length - 1])[1]);
}

async function vistaPrecios() {
  $('#contenido').innerHTML = `
    <h2>Precios y presupuestos</h2>
    <div class="filtros" id="calc-panel">
      <label style="min-width:220px">Ítem <select id="calc-item"></select></label>
      <label id="calc-l-cant">Cantidad <input id="calc-cant" type="number" min="1" value="100" /></label>
      <label id="calc-l-m2" class="oculto">M² <input id="calc-m2" type="number" step="0.01" min="0" value="1" /></label>
      <label>Horas de diseño <input id="calc-horas" type="number" step="0.5" min="0" value="0" /></label>
      <div style="display:flex;flex-direction:column;gap:2px;font-size:.9rem" id="calc-out"></div>
      <button id="calc-agregar" class="btn-primary">➕ Agregar al presupuesto</button>
    </div>
    <h3>Presupuesto en armado</h3>
    <div class="filtros" id="pres-panel">
      <label>Cliente <input id="pres-cliente" placeholder="nombre o razón social" /></label>
      <label>CUIT / DNI <input id="pres-cuit" placeholder="opcional" style="width:150px" /></label>
      <label>Dirección <input id="pres-dir" placeholder="opcional" /></label>
      <label>Localidad <input id="pres-loc" placeholder="opcional" style="width:140px" /></label>
      <label>Cond. IVA <select id="pres-iva">
        <option>Consumidor Final</option>
        <option>Responsable Inscripto</option>
        <option>Monotributo</option>
        <option>Exento</option>
      </select></label>
      <label>Cond. de venta <select id="pres-venta">
        <option>Contado</option>
        <option>Cuenta corriente</option>
      </select></label>
      <label>Validez (días) <input id="pres-validez" type="number" min="1" value="15" style="width:90px" /></label>
      <label style="flex:1;min-width:220px">Condiciones / notas <input id="pres-notas" placeholder="Seña 50%. Entrega: 7 días hábiles." /></label>
      <div id="pres-lineas" style="width:100%"></div>
      <button id="pres-generar" class="btn-dark">🖨 Generar presupuesto (PDF)</button>
      ${puedeEditar() ? '<button id="pres-crear">Crear trabajo presupuestado</button>' : ''}
      <button id="pres-vaciar" class="btn-danger">Vaciar</button>
    </div>
    <div class="filtros">
      ${puedeEditar() ? '<button id="btn-nuevo-precio" class="btn-primary">+ Nuevo ítem</button>' : ''}
      <span style="font-size:.85rem;color:var(--ga-texto-2)">Por cantidad: precio POR UNIDAD en cada escala. La calculadora usa la escala alcanzada (149 u. paga precio de 100).</span>
    </div>
    <div id="lista-precios">Cargando...</div>`;
  if (puedeEditar()) $('#btn-nuevo-precio').addEventListener('click', () => formPrecio());
  cargarPrecios();
}

let PRECIOS = [];
let CARRITO = [];

async function cargarPrecios() {
  PRECIOS = await api('GET', '/precios');
  const cont = $('#lista-precios');
  const orden = ['serigrafia', 'laser', 'impresion', 'ploteo', 'diseno'];
  let html = '';
  for (const rubro of orden) {
    const items = PRECIOS.filter((x) => x.rubro === rubro);
    if (!items.length) continue;
    html += `<h3>${LBL.rubro_precio[rubro]}</h3>
      <table><thead><tr><th>Ítem</th><th>Modo</th><th>Costo</th><th>Precios de venta</th><th>Notas</th><th></th></tr></thead><tbody>
      ${items.map((x) => `<tr>
        <td>${esc(x.nombre)}</td>
        <td>${LBL.modo_precio[x.modo] || x.modo}</td>
        <td>${x.costo != null ? money(x.costo) : '—'}</td>
        <td>${x.modo === 'por_cantidad'
        ? [[50, x.p50], [100, x.p100], [250, x.p250], [500, x.p500]].filter(([, v]) => v != null).map(([n2, v]) => `×${n2}: <b>${money(v)}</b>/u`).join(' · ') || '—'
        : x.precio != null ? `<b>${money(x.precio)}</b> ${x.modo === 'por_m2' ? '/m²' : '/hora'}` : '—'}</td>
        <td>${esc(x.notas)}</td>
        <td class="acciones">${puedeEditar() ? `<button data-edit="${x.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${x.id}" class="btn-danger">Eliminar</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  cont.innerHTML = html || '<p>Todavía no hay ítems. Cargá el primero con "+ Nuevo ítem".</p>';
  cont.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formPrecio(PRECIOS.find((x) => x.id == b.dataset.edit)));
  cont.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (confirm('¿Eliminar este ítem de la lista de precios?')) { await api('DELETE', '/precios/' + b.dataset.del); cargarPrecios(); }
  });
  armarCalculadora();
}

function renderCarrito() {
  const cont = $('#pres-lineas');
  if (!cont) return;
  if (!CARRITO.length) {
    cont.innerHTML = '<span style="font-size:.85rem;color:var(--ga-texto-2)">Sin ítems: calculá arriba y tocá "Agregar al presupuesto".</span>';
    return;
  }
  const total = CARRITO.reduce((a, l) => a + l.importe, 0);
  cont.innerHTML = `<table><thead><tr><th>Concepto</th><th>Cant.</th><th>Unitario</th><th>Importe</th><th></th></tr></thead><tbody>
    ${CARRITO.map((l, i) => `<tr>
      <td>${esc(l.concepto)}${l.detalle ? ` <small style="color:var(--ga-texto-2)">${esc(l.detalle)}</small>` : ''}</td>
      <td>${l.cantidad ?? ''}</td><td>${l.unit != null ? money(l.unit) : ''}</td><td>${money(l.importe)}</td>
      <td class="acciones"><button data-quitar="${i}" title="Quitar">✕</button></td>
    </tr>`).join('')}</tbody></table>
    <p style="text-align:right;margin:8px 0 0">Subtotal: <b>${money(total)}</b> · c/IVA: <b>${conIVA(total)}</b></p>`;
  cont.querySelectorAll('[data-quitar]').forEach((b) => b.onclick = () => { CARRITO.splice(Number(b.dataset.quitar), 1); renderCarrito(); });
}

function armarCalculadora() {
  const sel = $('#calc-item');
  if (!sel) return;
  const cotizables = PRECIOS.filter((x) => x.modo !== 'por_hora');
  sel.innerHTML = cotizables.length
    ? cotizables.map((x) => `<option value="${x.id}">${LBL.rubro_precio[x.rubro]} — ${esc(x.nombre)}</option>`).join('')
    : '<option value="">(cargá ítems primero)</option>';
  const disenio = PRECIOS.find((x) => x.modo === 'por_hora');

  const calc = () => {
    const item = PRECIOS.find((x) => x.id == sel.value);
    const out = $('#calc-out');
    if (!item) { out.innerHTML = ''; return null; }
    const esCant = item.modo === 'por_cantidad';
    $('#calc-l-cant').classList.toggle('oculto', !esCant);
    $('#calc-l-m2').classList.toggle('oculto', esCant);
    const horas = Number($('#calc-horas').value || 0);
    let sub = 0; let detalle = ''; let cant = null; let unit = null;
    if (esCant) {
      cant = Math.max(1, Number($('#calc-cant').value || 0));
      unit = precioUnitarioPara(item, cant);
      if (unit == null) { out.innerHTML = '<span style="color:var(--ga-rojo)">Este ítem no tiene escalas cargadas.</span>'; return null; }
      sub = cant * unit;
      detalle = `${cant} × ${money(unit)}`;
    } else {
      const m2 = Math.max(0, Number($('#calc-m2').value || 0));
      if (item.precio == null) { out.innerHTML = '<span style="color:var(--ga-rojo)">Este ítem no tiene precio por m².</span>'; return null; }
      unit = Number(item.precio); cant = m2;
      sub = m2 * unit;
      detalle = `${m2} m² × ${money(unit)}`;
    }
    const tarifaDis = disenio ? Number(disenio.precio || 0) : 0;
    const dis = horas * tarifaDis;
    const total = sub + dis;
    out.innerHTML = `<span>${detalle} = <b>${money(sub)}</b></span>`
      + (horas > 0 ? `<span>Diseño: ${horas} h × ${money(tarifaDis)} = <b>${money(dis)}</b>${tarifaDis ? '' : ' ⚠️ tarifa de diseño en $0'}</span>` : '')
      + `<span style="font-size:1.05rem">TOTAL: <b>${money(total)}</b> · c/IVA: <b>${conIVA(total)}</b></span>`;
    return { item, cant, unit, horas, sub, dis, tarifaDis, total, detalle };
  };

  ['calc-item', 'calc-cant', 'calc-m2', 'calc-horas'].forEach((id) => {
    const el = $('#' + id);
    if (el) { el.addEventListener('input', calc); el.addEventListener('change', calc); }
  });
  calc();

  $('#calc-agregar').onclick = () => {
    const c = calc();
    if (!c) return toast('Completá la calculadora primero', 'error');
    CARRITO.push({ concepto: c.item.nombre, detalle: c.detalle, cantidad: c.cant, unit: c.unit, importe: c.sub });
    if (c.horas > 0) CARRITO.push({ concepto: 'Diseño', detalle: `${c.horas} h × ${money(c.tarifaDis)}`, cantidad: c.horas, unit: c.tarifaDis, importe: c.dis });
    $('#calc-horas').value = 0;
    renderCarrito();
    toast('Agregado al presupuesto ✓');
  };

  $('#pres-vaciar').onclick = () => { CARRITO = []; renderCarrito(); };

  $('#pres-generar').onclick = () => {
    if (!CARRITO.length) return toast('Agregá ítems al presupuesto primero', 'error');
    const total = CARRITO.reduce((a, l) => a + l.importe, 0);
    const ahora = new Date();
    const dd = (n) => String(n).padStart(2, '0');
    const num = `P-${ahora.getFullYear()}${dd(ahora.getMonth() + 1)}${dd(ahora.getDate())}-${dd(ahora.getHours())}${dd(ahora.getMinutes())}`;
    const html = htmlPresupuesto({
      num,
      fechaTxt: `${dd(ahora.getDate())}/${dd(ahora.getMonth() + 1)}/${ahora.getFullYear()}`,
      cliente: $('#pres-cliente').value.trim() || 'Consumidor Final',
      cuitCliente: $('#pres-cuit').value.trim(),
      direccion: $('#pres-dir').value.trim(),
      localidad: $('#pres-loc').value.trim(),
      condIVA: $('#pres-iva').value,
      condVenta: $('#pres-venta').value,
      validez: Number($('#pres-validez').value || 15),
      notas: $('#pres-notas').value.trim(),
      lineas: CARRITO, total,
    });
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
  };

  const btnCrear = $('#pres-crear');
  if (btnCrear) btnCrear.onclick = () => {
    if (!CARRITO.length) return toast('Agregá ítems al presupuesto primero', 'error');
    const total = CARRITO.reduce((a, l) => a + l.importe, 0);
    const desc = CARRITO.map((l) => `${l.concepto} (${l.detalle})`).join(' + ');
    const pre = {
      estado: 'presupuestado', disciplina: 'impresion', descripcion: desc, precio: total,
      contacto_nombre: $('#pres-cliente').value.trim()
    };
    if (CARRITO.length === 1 && CARRITO[0].cantidad && CARRITO[0].unit != null) {
      pre.cantidad = CARRITO[0].cantidad; pre.precio_unitario = CARRITO[0].unit;
    }
    formTrabajo(pre, () => toast('Trabajo presupuestado creado ✓'));
  };

  renderCarrito();
}

// Documento A4 imprimible con la identidad de marca (mismo sistema que la web).
function htmlPresupuesto({ num, fechaTxt, cliente, cuitCliente, direccion, localidad, condIVA, condVenta, validez, notas, lineas, total }) {
  const t = DATOS_TALLER;
  const filas = lineas.map((l) => `<tr>
      <td>${esc(l.concepto)}${l.detalle ? `<div class="det">${esc(l.detalle)}</div>` : ''}</td>
      <td class="der">${l.cantidad ?? ''}</td>
      <td class="der">${l.unit != null ? money(l.unit) : ''}</td>
      <td class="der">${money(l.importe)}</td>
    </tr>`).join('');
  const dirLinea = [direccion, localidad].filter(Boolean).join(', ');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<base href="${location.origin}/">
<title>Presupuesto ${num} — ${esc(t.nombre)}</title>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #56524f; font: 400 14px/1.55 'Inter', sans-serif; color: #1c1b1b; }
  .hoja { width: 210mm; min-height: 297mm; margin: 0 auto; background: #FFFEF8; padding: 15mm 15mm 12mm; display: flex; flex-direction: column; }
  header { display: flex; align-items: flex-start; justify-content: space-between; }
  header img { height: 44px; }
  .fiscal { margin-top: 8px; font: 400 11px/1.6 'Inter', sans-serif; color: #42474c; }
  .doc-tit { text-align: right; }
  .doc-tit .ov { font: 600 12px/1 'Inter', sans-serif; letter-spacing: .2em; text-transform: uppercase; color: #805600; }
  .doc-tit h1 { margin: 4px 0 2px; font: 800 28px/1 'Hanken Grotesk', sans-serif; letter-spacing: -.02em; }
  .doc-tit .fch { font: 500 13px/1.4 'Inter', sans-serif; color: #42474c; }
  .filo { height: 3px; background: #F6A800; margin: 14px 0 18px; }
  .datos { display: flex; justify-content: space-between; gap: 30px; margin-bottom: 22px; }
  .ov { font: 600 11px/1 'Inter', sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #805600; margin-bottom: 5px; }
  .datos .v { font: 700 16px/1.3 'Hanken Grotesk', sans-serif; }
  .datos .sub { font-size: 12.5px; color: #42474c; margin-top: 2px; }
  .datos .der2 { text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font: 600 11px/1 'Inter', sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #42474c; padding: 10px; border-bottom: 2px solid #121212; }
  th.der, td.der { text-align: right; white-space: nowrap; }
  td { padding: 11px 10px; border-bottom: 1px solid #e5e2e1; vertical-align: top; }
  td .det { font-size: 12px; color: #42474c; margin-top: 2px; }
  .totales { margin: 10px 0 0 auto; width: 64mm; }
  .totales .fila { display: flex; justify-content: space-between; padding: 7px 10px; font-size: 13.5px; color: #42474c; }
  .total-final { display: flex; justify-content: space-between; align-items: center; background: #121212; color: #fff; padding: 12px 14px; border-radius: 6px; margin-top: 4px; }
  .total-final b { font: 800 20px 'Hanken Grotesk', sans-serif; color: #F6A800; }
  .notas { margin-top: 22px; font-size: 13px; color: #42474c; border-left: 3px solid #F6A800; padding: 4px 12px; }
  footer { margin-top: auto; padding-top: 16px; border-top: 1px solid #e5e2e1; }
  .contacto { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #42474c; }
  .contacto b { color: #1c1b1b; }
  .legal { margin-top: 6px; font-size: 10.5px; color: #7a7f84; text-align: center; }
  .imprimir { position: fixed; top: 14px; right: 14px; padding: 12px 20px; background: #F6A800; color: #121212; font: 600 14px 'Inter', sans-serif; border: none; border-radius: 4px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
  @media print { .imprimir { display: none; } body { background: #FFFEF8; } }
</style></head><body>
<button class="imprimir" onclick="print()">🖨 Imprimir / Guardar PDF</button>
<div class="hoja">
  <header>
    <div>
      <img src="/brand/logo-negro.svg" alt="${esc(t.nombre)}">
      <div class="fiscal">CUIT: ${esc(t.cuit)} · Ing. Brutos: ${esc(t.iibb)}<br>Inicio de actividades: ${esc(t.inicio)}<br>Condición frente al IVA: <b>${esc(t.iva || 'Responsable Inscripto')}</b></div>
    </div>
    <div class="doc-tit"><div class="ov">Presupuesto</div><h1>${num}</h1><div class="fch">${fechaTxt}</div></div>
  </header>
  <div class="filo"></div>
  <div class="datos">
    <div>
      <div class="ov">Cliente</div>
      <div class="v">${esc(cliente)}</div>
      ${cuitCliente ? `<div class="sub">CUIT/DNI: ${esc(cuitCliente)}</div>` : ''}
      ${dirLinea ? `<div class="sub">${esc(dirLinea)}</div>` : ''}
      <div class="sub">IVA: ${esc(condIVA)}</div>
    </div>
    <div class="der2">
      <div class="ov">Condición de venta</div>
      <div class="v">${esc(condVenta)}</div>
      <div class="ov" style="margin-top:10px">Validez</div>
      <div class="v">${validez} días</div>
    </div>
  </div>
  <table><thead><tr><th>Concepto</th><th class="der">Cant.</th><th class="der">P. unitario</th><th class="der">Importe</th></tr></thead>
  <tbody>${filas}</tbody></table>
  <div class="totales">
    <div class="fila"><span>Subtotal</span><span>${money(total)}</span></div>
    <div class="fila"><span>IVA (21%)</span><span>${money(total * (IVA - 1))}</span></div>
    <div class="total-final"><span>TOTAL c/IVA</span><b>${conIVA(total)}</b></div>
  </div>
  ${notas ? `<div class="notas"><div class="ov">Condiciones</div>${esc(notas)}</div>` : ''}
  <footer>
    <div class="contacto">
      <span>✉️ ${esc(t.correo)}</span>
      <span><b>${esc(t.instagram)}</b></span>
      <span>📱 ${esc(t.whatsapp)}</span>
    </div>
    <div class="legal">Presupuesto sin valor de comprobante fiscal · ${esc(t.nombre)}</div>
  </footer>
</div>
</body></html>`;
}
// --- fin htmlPresupuesto ---

function formPrecio(x) {
  x = x || {};
  const opciones = (map, sel2) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel2 ? 'selected' : ''}>${v}</option>`).join('');
  abrirModal(`${x.id ? 'Editar' : 'Nuevo'} ítem de precio`, `
    <div class="grid">
      <label>Rubro <select name="rubro">${opciones(LBL.rubro_precio, x.rubro || 'serigrafia')}</select></label>
      <label>Modo <select name="modo">${opciones(LBL.modo_precio, x.modo || 'por_cantidad')}</select></label>
      <label class="full">Nombre <input name="nombre" value="${esc(x.nombre)}" placeholder="Remeras 1 color / Grabado fibra / Ploteo vehicular" required /></label>
      <label>Costo <input name="costo" type="number" step="0.01" value="${x.costo ?? ''}" placeholder="lo que te sale" /></label>
      <label class="m-flat">Precio ($/m² o $/hora) <input name="precio" type="number" step="0.01" value="${x.precio ?? ''}" /></label>
      <label class="m-cant">$/unidad ×50 <input name="p50" type="number" step="0.01" value="${x.p50 ?? ''}" /></label>
      <label class="m-cant">$/unidad ×100 <input name="p100" type="number" step="0.01" value="${x.p100 ?? ''}" /></label>
      <label class="m-cant">$/unidad ×250 <input name="p250" type="number" step="0.01" value="${x.p250 ?? ''}" /></label>
      <label class="m-cant">$/unidad ×500 <input name="p500" type="number" step="0.01" value="${x.p500 ?? ''}" /></label>
      <label class="full">Notas <textarea name="notas">${esc(x.notas)}</textarea></label>
    </div>`, async (f) => {
    const body = {
      rubro: f.rubro.value, modo: f.modo.value, nombre: f.nombre.value,
      costo: f.costo.value || null, precio: f.precio.value || null,
      p50: f.p50.value || null, p100: f.p100.value || null, p250: f.p250.value || null, p500: f.p500.value || null,
      notas: f.notas.value
    };
    if (x.id) await api('PUT', '/precios/' + x.id, body); else await api('POST', '/precios', body);
    cerrarModal(); cargarPrecios();
  });
  // Mostrar solo los campos del modo elegido
  const modoSel = document.querySelector('#modal-fondo [name="modo"]');
  const ajustar = () => {
    const esCant = modoSel.value === 'por_cantidad';
    document.querySelectorAll('#modal-fondo .m-cant').forEach((el) => el.classList.toggle('oculto', !esCant));
    document.querySelectorAll('#modal-fondo .m-flat').forEach((el) => el.classList.toggle('oculto', esCant));
  };
  modoSel.addEventListener('change', ajustar);
  ajustar();
}

// ---------- Helpers de UI ----------
// ---------- Clientes (empresas y contactos) ----------
async function poblarDatalistsCliente() {
  try {
    const [emp, con] = await Promise.all([api('GET', '/empresas'), api('GET', '/contactos')]);
    const de = $('#dl-empresas'); if (de) de.innerHTML = emp.map((e) => `<option value="${esc(e.nombre)}">`).join('');
    const dc = $('#dl-contactos'); if (dc) dc.innerHTML = con.map((c) => `<option value="${esc(c.nombre)}">`).join('');
  } catch (e) { /* silencioso */ }
}

async function vistaClientes() {
  $('#contenido').innerHTML = `
    <h2>Clientes</h2>
    <p style="font-size:13px">Las empresas agrupan a los contactos que piden trabajos. Un cliente chico puede ser un contacto sin empresa. Tocá "Trabajos" para ver el historial y lo facturado.</p>
    <div class="filtros">
      ${puedeEditar() ? '<button id="btn-nueva-empresa" class="btn-primary">+ Nueva empresa</button>' : ''}
      ${puedeEditar() ? '<button id="btn-nuevo-contacto" class="btn-primary">+ Nuevo contacto</button>' : ''}
      ${esAdmin() ? '<button id="btn-unificar" title="Une empresas y contactos con el mismo nombre y normaliza mayúsculas">🧹 Unificar duplicados</button>' : ''}
    </div>
    <h3>Empresas</h3><div id="lista-empresas">Cargando...</div>
    <h3>Contactos</h3><div id="lista-contactos">Cargando...</div>`;
  if (puedeEditar()) {
    $('#btn-nueva-empresa').addEventListener('click', () => formEmpresa());
    $('#btn-nuevo-contacto').addEventListener('click', () => formContacto());
  }
  if (esAdmin()) $('#btn-unificar').addEventListener('click', async () => {
    if (!confirm('Une empresas y contactos duplicados (mismo nombre) y normaliza la escritura.\nDos contactos iguales con empresas distintas NO se tocan. ¿Continuar?')) return;
    const r = await api('POST', '/clientes/unificar');
    toast(`Listo: ${r.contactos} contacto(s) y ${r.empresas} empresa(s) unificados`);
    cargarEmpresas(); cargarContactos();
  });
  cargarEmpresas(); cargarContactos();
}

async function cargarEmpresas() {
  const filas = await api('GET', '/empresas');
  $('#lista-empresas').innerHTML = filas.length ? `
    <table><thead><tr><th>Nombre</th><th>Cond. pago</th><th>Contactos</th><th>Teléfono</th><th></th></tr></thead><tbody>
    ${filas.map((e) => `<tr>
      <td>${esc(e.nombre)}</td>
      <td>${e.condicion_pago === 'diferido' ? badge('Diferido', 'alerta') : badge('Contado', 'neutro')}</td>
      <td>${e.contactos}</td><td>${esc(e.telefono)}</td>
      <td class="acciones"><button data-trab="${e.id}">Trabajos</button>${puedeEditar() ? `<button data-edit="${e.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${e.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p>Sin empresas todavía.</p>';
  $('#lista-empresas').querySelectorAll('[data-trab]').forEach((b) => b.onclick = () => verTrabajosCliente('empresa', b.dataset.trab, filas.find((e) => e.id == b.dataset.trab).nombre));
  $('#lista-empresas').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formEmpresa(filas.find((e) => e.id == b.dataset.edit)));
  $('#lista-empresas').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('¿Eliminar empresa? Los contactos quedan sin empresa.')) { await api('DELETE', '/empresas/' + b.dataset.del); cargarEmpresas(); cargarContactos(); } });
}

function formEmpresa(e) {
  e = e || {};
  abrirModal(`${e.id ? 'Editar' : 'Nueva'} empresa`, `
    <div class="grid">
      <label class="full">Nombre <input name="nombre" value="${esc(e.nombre)}" required /></label>
      <label>Condición de pago <select name="condicion_pago"><option value="contado" ${e.condicion_pago !== 'diferido' ? 'selected' : ''}>Contado</option><option value="diferido" ${e.condicion_pago === 'diferido' ? 'selected' : ''}>Diferido</option></select></label>
      <label>Teléfono <input name="telefono" value="${esc(e.telefono)}" /></label>
      <label class="full">Notas <textarea name="notas">${esc(e.notas)}</textarea></label>
    </div>`, async (f) => {
    const body = { nombre: f.nombre.value, condicion_pago: f.condicion_pago.value, telefono: f.telefono.value, notas: f.notas.value };
    if (e.id) await api('PUT', '/empresas/' + e.id, body); else await api('POST', '/empresas', body);
    cerrarModal(); cargarEmpresas();
  });
}

async function cargarContactos() {
  const filas = await api('GET', '/contactos');
  $('#lista-contactos').innerHTML = filas.length ? `
    <table><thead><tr><th>Nombre</th><th>Empresa</th><th>Teléfono</th><th></th></tr></thead><tbody>
    ${filas.map((c) => `<tr>
      <td>${esc(c.nombre)}</td>
      <td>${c.empresa_nombre ? esc(c.empresa_nombre) : '<span style="color:var(--ga-texto-2)">—</span>'}</td>
      <td>${esc(c.telefono)}</td>
      <td class="acciones"><button data-trab="${c.id}">Trabajos</button>${puedeEditar() ? `<button data-edit="${c.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${c.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p>Sin contactos todavía.</p>';
  $('#lista-contactos').querySelectorAll('[data-trab]').forEach((b) => b.onclick = () => verTrabajosCliente('contacto', b.dataset.trab, filas.find((c) => c.id == b.dataset.trab).nombre));
  $('#lista-contactos').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formContacto(filas.find((c) => c.id == b.dataset.edit)));
  $('#lista-contactos').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('¿Eliminar contacto?')) { await api('DELETE', '/contactos/' + b.dataset.del); cargarContactos(); } });
}

async function formContacto(c) {
  c = c || {};
  const empresas = await api('GET', '/empresas');
  const opciones = ['<option value="">— sin empresa —</option>']
    .concat(empresas.map((e) => `<option value="${e.id}" ${c.empresa_id == e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`))
    .join('');
  abrirModal(`${c.id ? 'Editar' : 'Nuevo'} contacto`, `
    <div class="grid">
      <label class="full">Nombre <input name="nombre" value="${esc(c.nombre)}" required /></label>
      <label class="full">Empresa <select name="empresa_id">${opciones}</select></label>
      <label>Teléfono <input name="telefono" value="${esc(c.telefono)}" /></label>
      <label class="full">Notas <textarea name="notas">${esc(c.notas)}</textarea></label>
    </div>`, async (f) => {
    const body = { nombre: f.nombre.value, empresa_id: f.empresa_id.value || null, telefono: f.telefono.value, notas: f.notas.value };
    if (c.id) await api('PUT', '/contactos/' + c.id, body); else await api('POST', '/contactos', body);
    cerrarModal(); cargarContactos();
  });
}

// Historial de trabajos de un cliente (empresa o contacto) con totales
async function verTrabajosCliente(tipo, id, nombre) {
  const qs = (tipo === 'empresa' ? 'empresa_id=' : 'contacto_id=') + id;
  const filas = await api('GET', '/trabajos?' + qs);
  const suma = (f) => f.reduce((a, t) => a + Number(t.precio || 0), 0);
  const total = suma(filas);
  const porCobrar = suma(filas.filter((t) => t.estado === 'finalizado' && !t.pagado));
  abrirModalInfo('Trabajos de ' + nombre, `
    <div class="tarjetas" style="margin-bottom:14px">
      <div class="tarjeta"><div>Trabajos</div><div class="num">${filas.length}</div></div>
      <div class="tarjeta"><div>Total trabajos</div><div class="num">${money(total)}</div></div>
      <div class="tarjeta"><div>Por cobrar</div><div class="num">${money(porCobrar)}</div></div>
    </div>
    ${filas.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Fecha</th><th>Descripción</th><th>Disciplina</th><th>Estado</th><th>Precio</th></tr></thead><tbody>
      ${filas.map((t) => `<tr><td>${fechaAR(t.fecha_ingreso)}</td><td>${esc(t.descripcion)}</td><td>${LBL.disciplina[t.disciplina] || t.disciplina}</td><td>${badgeEstado(t.estado)}</td><td>${money(t.precio)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p>Sin trabajos registrados para este cliente.</p>'}`);
}

function abrirModalInfo(titulo, html) {
  cerrarModal();
  const fondo = document.createElement('div');
  fondo.className = 'modal-fondo';
  fondo.id = 'modal-fondo';
  fondo.innerHTML = `<div class="modal" style="width:640px"><h3>${esc(titulo)}</h3>${html}
    <div class="acciones" style="margin-top:16px"><button type="button" id="modal-cerrar" class="btn-primary">Cerrar</button></div></div>`;
  document.body.appendChild(fondo);
  fondo.querySelector('#modal-cerrar').onclick = cerrarModal;
}

function opts(map, sel) {
  return Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function abrirModal(titulo, htmlCampos, onSubmit) {
  cerrarModal();
  const fondo = document.createElement('div');
  fondo.className = 'modal-fondo';
  fondo.id = 'modal-fondo';
  fondo.innerHTML = `<form class="modal"><h3>${esc(titulo)}</h3>${htmlCampos}
    <p class="error" id="modal-error"></p>
    <div class="acciones"><button type="submit" class="btn-primary">Guardar</button><button type="button" id="modal-cancelar">Cancelar</button></div></form>`;
  document.body.appendChild(fondo);
  fondo.querySelector('#modal-cancelar').onclick = cerrarModal;
  fondo.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await onSubmit(e.target); toast('Guardado ✓'); }
    catch (err) { fondo.querySelector('#modal-error').textContent = err.message; }
  });
}
function cerrarModal() { const m = $('#modal-fondo'); if (m) m.remove(); }

// ---------- Inicio ----------
if (TOKEN && USER) iniciarApp();
