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
const fecha = (d) => (d ? String(d).slice(0, 10) : '');

const LBL = {
  disciplina: { laser: 'Láser', serigrafia: 'Serigrafía', ploteo: 'Ploteo/Cartelería', impresion: 'Impresión' },
  estado: { cotizar: 'Por cotizar', presupuestado: 'Presupuestado', pedido: 'Pedido', en_progreso: 'En progreso', en_espera: 'En espera', finalizado: 'Finalizado' },
  cheque_tipo: { recibido: 'Recibido', emitido: 'Emitido' },
  cheque_modalidad: { fisico: 'Físico', electronico: 'E-check' },
  cheque_estado: { pendiente: 'Pendiente', cobrado: 'Cobrado', depositado: 'Depositado', rechazado: 'Rechazado' },
  pago_estado: { pendiente: 'Pendiente', pagado: 'Pagado' },
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
      (c) => `<tr><td>${fecha(c.fecha_cobro)}</td><td>${LBL.cheque_tipo[c.tipo]}</td><td>${esc(c.relacionado)}</td><td>${money(c.importe)}</td></tr>`,
      ['Fecha', 'Tipo', 'Relacionado', 'Importe'])}

    <h3>Pagos de servicios pendientes</h3>
    ${tablaSimple(d.pagos_pendientes, ['concepto'],
      (p) => `<tr><td>${esc(p.concepto)}</td><td>${fecha(p.fecha_vencimiento)}</td><td>${money(p.importe)}</td></tr>`,
      ['Concepto', 'Vence', 'Importe'])}
  `;
}

function tablaSimple(filas, _c, rowFn, headers) {
  if (!filas || !filas.length) return '<p>Nada por ahora.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${filas.map(rowFn).join('')}</tbody></table>`;
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
  $('#lista-trabajos').innerHTML = filas.length ? `
    <table><thead><tr>
      <th>Cliente</th><th>Descripción</th><th>Disciplina</th><th>Estado</th>
      <th>Cobro</th><th>Facturación</th><th>Precio</th><th>Ingreso</th><th></th>
    </tr></thead><tbody>
    ${filas.map((t) => `<tr>
      <td>${esc(t.contacto_nombre || t.cliente)}${t.empresa_nombre ? ` <small style="color:var(--ga-texto-2)">(${esc(t.empresa_nombre)})</small>` : ''}${t.origen === 'ia' && !t.revisado ? ' <em>(IA sin revisar)</em>' : ''}</td>
      <td>${esc(t.descripcion)}</td>
      <td>${LBL.disciplina[t.disciplina] || t.disciplina}</td>
      <td><span class="clic" data-adv="${t.id}" title="Avanzar estado">${badgeEstado(t.estado)} <b class="adv">▸</b></span></td>
      <td><span class="clic" data-cobro="${t.id}" title="Marcar cobro">${t.pagado ? badge('Pagado','ok') : badge('No pagado','alerta')}</span></td>
      <td><span class="clic" data-fact="${t.id}" title="Marcar facturación">${t.facturado ? badge('Facturado','ok') : badge('No facturado','neutro')}</span></td>
      <td>${money(t.precio)}</td>
      <td>${fecha(t.fecha_ingreso)}</td>
      <td class="acciones">${puedeEditar() ? `<button data-edit="${t.id}">Editar</button>` : ''}${esAdmin() ? `<button data-del="${t.id}" class="btn-danger">Eliminar</button>` : ''}</td>
    </tr>`).join('')}
    </tbody></table>` : '<p>No hay trabajos con esos filtros.</p>';

  $('#lista-trabajos').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => formTrabajo(filas.find((t) => t.id == b.dataset.edit)));
  $('#lista-trabajos').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (confirm('¿Eliminar este trabajo?')) { await api('DELETE', '/trabajos/' + b.dataset.del); cargarTrabajos(); }
  });

  const rapido = async (id, campos) => { try { await api('PATCH', '/trabajos/' + id + '/rapido', campos); cargarTrabajos(); } catch (e) { alert(e.message); } };
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
      <label>Precio <input name="precio" type="number" step="0.01" value="${t.precio ?? ''}" /></label>
      <label>Cobro <select name="pagado"><option value="false">No pagado</option><option value="true" ${t.pagado ? 'selected' : ''}>Pagado</option></select></label>
      <label>Facturación <select name="facturado"><option value="false">No facturado</option><option value="true" ${t.facturado ? 'selected' : ''}>Facturado</option></select></label>
      <label>Entrega estimada <input name="fecha_entrega_estimada" type="date" value="${fecha(t.fecha_entrega_estimada)}" /></label>
      <label>Responsable <input name="responsable" value="${esc(t.responsable)}" /></label>
      <label class="full">Notas <textarea name="notas">${esc(t.notas)}</textarea></label>
    </div>
  `, async (f) => {
    const body = {
      empresa_nombre: f.empresa_nombre.value, contacto_nombre: f.contacto_nombre.value,
      descripcion: f.descripcion.value,
      disciplina: f.disciplina.value, estado: f.estado.value, precio: Number(f.precio.value || 0),
      pagado: f.pagado.value === 'true', facturado: f.facturado.value === 'true',
      fecha_entrega_estimada: f.fecha_entrega_estimada.value || null,
      responsable: f.responsable.value, notas: f.notas.value,
    };
    if (t.id) await api('PUT', '/trabajos/' + t.id, body);
    else await api('POST', '/trabajos', body);
    cerrarModal(); (onDone || cargarTrabajos)();
  });
  poblarDatalistsCliente();
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
      <td>${esc(c.relacionado)}</td><td>${money(c.importe)}</td><td>${fecha(c.fecha_cobro)}</td>
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
    </div>`, async (f) => {
    const body = { tipo: f.tipo.value, modalidad: f.modalidad.value, estado: f.estado.value, numero: f.numero.value, banco: f.banco.value,
      importe: Number(f.importe.value || 0), relacionado: f.relacionado.value,
      fecha_emision: f.fecha_emision.value || null, fecha_cobro: f.fecha_cobro.value || null };
    if (c.id) await api('PUT', '/cheques/' + c.id, body); else await api('POST', '/cheques', body);
    cerrarModal(); (onDone || cargarCheques)();
  });
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
      <td>${esc(p.concepto)}${p.origen === 'ia' && !p.revisado ? ' <em>(IA)</em>' : ''}</td><td>${esc(p.periodo)}</td><td>${fecha(p.fecha_vencimiento)}</td>
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
    const body = { concepto: f.concepto.value, importe: Number(f.importe.value || 0), estado: f.estado.value,
      periodo: f.periodo.value, fecha_vencimiento: f.fecha_vencimiento.value || null, notas: f.notas.value };
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
      d.cheques.map((c) => `<tr><td>${LBL.cheque_tipo[c.tipo]}</td><td>${esc(c.relacionado)}</td><td>${money(c.importe)}</td><td>${fecha(c.fecha_cobro)}</td><td>${esc(c.origen_ref) || 'IA'}</td><td class="acciones">${accionesBandeja('cheques', c.id)}</td></tr>`).join('') +
      '</tbody></table>';
  }
  if (d.pagos.length) {
    html += '<h3>Pagos de servicios</h3><table><thead><tr><th>Concepto</th><th>Importe</th><th>Vence</th><th>Origen</th><th></th></tr></thead><tbody>' +
      d.pagos.map((p) => `<tr><td>${esc(p.concepto)}</td><td>${money(p.importe)}</td><td>${fecha(p.fecha_vencimiento)}</td><td>${esc(p.origen_ref) || 'IA'}</td><td class="acciones">${accionesBandeja('pagos', p.id)}</td></tr>`).join('') +
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
    </div>
    <h3>Empresas</h3><div id="lista-empresas">Cargando...</div>
    <h3>Contactos</h3><div id="lista-contactos">Cargando...</div>`;
  if (puedeEditar()) {
    $('#btn-nueva-empresa').addEventListener('click', () => formEmpresa());
    $('#btn-nuevo-contacto').addEventListener('click', () => formContacto());
  }
  cargarEmpresas(); cargarContactos();
}

async function cargarEmpresas() {
  const filas = await api('GET', '/empresas');
  $('#lista-empresas').innerHTML = filas.length ? `
    <table><thead><tr><th>Nombre</th><th>Cond. pago</th><th>Contactos</th><th>Teléfono</th><th></th></tr></thead><tbody>
    ${filas.map((e) => `<tr>
      <td>${esc(e.nombre)}</td>
      <td>${e.condicion_pago === 'diferido' ? badge('Diferido','alerta') : badge('Contado','neutro')}</td>
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
      <div class="tarjeta"><div>Facturado total</div><div class="num">${money(total)}</div></div>
      <div class="tarjeta"><div>Por cobrar</div><div class="num">${money(porCobrar)}</div></div>
    </div>
    ${filas.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Fecha</th><th>Descripción</th><th>Disciplina</th><th>Estado</th><th>Precio</th></tr></thead><tbody>
      ${filas.map((t) => `<tr><td>${fecha(t.fecha_ingreso)}</td><td>${esc(t.descripcion)}</td><td>${LBL.disciplina[t.disciplina] || t.disciplina}</td><td>${badgeEstado(t.estado)}</td><td>${money(t.precio)}</td></tr>`).join('')}
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
    try { await onSubmit(e.target); }
    catch (err) { fondo.querySelector('#modal-error').textContent = err.message; }
  });
}
function cerrarModal() { const m = $('#modal-fondo'); if (m) m.remove(); }

// ---------- Inicio ----------
if (TOKEN && USER) iniciarApp();
