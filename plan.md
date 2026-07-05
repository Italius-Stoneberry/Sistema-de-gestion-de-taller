# Sistema de Gestión de Taller

## Plan técnico — Trabajos, pagos y gestión familiar

**Preparado para:** Italo
**Fecha:** 4 de julio de 2026
**Versión del documento:** 1.0 (borrador para revisar en familia)

---

## 1. Resumen ejecutivo

Este documento define cómo construir una aplicación web para organizar el taller de tu papá: registrar los **trabajos** (láser, serigrafía, ploteo/cartelería), seguir su **estado** desde el pedido hasta la entrega y el cobro, y llevar el control de **cheques** y **pagos de servicios**. La familia podrá **iniciar sesión** con distintos permisos para cargar, gestionar y consultar la información.

La recomendación central es construir **una sola aplicación web** (que se ve bien tanto en la PC del taller como en el celular) **alojada en tu NAS de casa** dentro de un contenedor Docker, y acceder a ella desde afuera de forma segura mediante una **VPN privada (Tailscale)**. Esto te da lectura *y* escritura desde cualquier lado, sin exponer el NAS a internet, con un costo prácticamente nulo para empezar.

Más abajo comparo esta opción con tu idea de "web pública de solo lectura + edición local" y explico por qué, para tu caso, la VPN es más simple y más segura, dejando la web pública como una fase opcional a futuro.

---

## 2. Objetivo del proyecto

Reemplazar el seguimiento manual (papeles, memoria, mensajes sueltos) por un sistema único donde:

- Se cargue cada trabajo con su cliente, disciplina, precio y estado.
- Se vea de un vistazo qué está pendiente, en progreso, en espera y finalizado.
- Se controle qué trabajos finalizados están **cobrados** y cuáles **facturados**.
- Se lleve el registro de **cheques** y **pagos de servicios** del taller.
- La familia colabore con roles y permisos claros.
- Todo quede respaldado y seguro en infraestructura propia (el NAS de casa).

**Objetivo secundario (a futuro):** dejar la base preparada para, si funciona bien, convertirla en un producto vendible a otros talleres.

---

## 3. Alcance de la primera versión (MVP)

Para no arrancar con algo gigante, la **Versión 1** debería cubrir lo esencial y funcionar de punta a punta:

**Sí entra en la V1:**

- Gestión de trabajos con estados y disciplinas.
- Control de cobro y facturación de trabajos finalizados.
- Módulo de cheques.
- Módulo de pagos de servicios.
- Login familiar con roles (administrador y colaborador).
- Panel principal (dashboard) con lo pendiente y los totales.
- Funciona en PC y celular (diseño responsive).

**Queda para más adelante (V2 en adelante):**

- Portal de solo lectura para que los clientes vean el estado de su pedido.
- Reportes avanzados y estadísticas por máquina/mes.
- Presupuestos y remitos en PDF.
- Notificaciones automáticas (WhatsApp/email).
- Versión como producto para vender a otros talleres.

Definir bien este límite es la decisión más importante del proyecto: mantiene el primer entregable chico, útil y terminable.

---

## 4. Usuarios y roles (login familiar)

Cada integrante entra con su propio usuario y contraseña. Los permisos se controlan por **rol**:

| Rol | Quién | Puede hacer |
|---|---|---|
| **Administrador** | Papá (dueño) | Todo: crear/editar/eliminar trabajos, ver y gestionar dinero (cheques, pagos, cobros), administrar usuarios. |
| **Gestor** | Familia que opera el día a día | Crear y editar trabajos, cambiar estados, cargar cheques y pagos. No elimina ni administra usuarios. |
| **Consulta** | Quien solo necesita mirar | Ver trabajos y estados, sin modificar nada. |

Los roles se pueden ajustar, pero conviene empezar con estos tres. Cada acción importante queda registrada con **quién** y **cuándo** la hizo (bitácora / historial), algo clave para la seguridad y para evitar confusiones sobre "quién cambió esto".

---

## 5. Funciones y modelo de datos

Esta sección describe la información que guarda el sistema. Es el corazón del proyecto.

### 5.1 Trabajos

Cada trabajo (pedido) tiene, como mínimo:

- **Cliente** (nombre y contacto).
- **Descripción** del trabajo.
- **Disciplina / máquina**: Láser, Serigrafía, o Ploteo/Cartelería.
- **Estado** actual (ver 5.2).
- **Precio** acordado.
- **Fechas**: ingreso, entrega estimada, entrega real.
- **Responsable** asignado (opcional).
- **Notas** internas.
- **Historial** de cambios de estado.

### 5.2 Estados del trabajo

El trabajo avanza por estos estados principales:

| Estado | Significado |
|---|---|
| **Pedido** | Ingresó, todavía no se empezó. |
| **En progreso** | Se está fabricando. |
| **En espera** | Frenado (falta material, aprobación del cliente, etc.). |
| **Finalizado** | Terminado. Se subdivide según cobro y facturación (ver 5.3). |

### 5.3 Subestados de "Finalizado": cobro y facturación

Un trabajo terminado se clasifica según **dos condiciones independientes**, porque un trabajo puede estar cobrado pero no facturado, o al revés:

- **Cobro:** Pagado / No pagado
- **Facturación:** Facturado / No facturado

Al ser dos ejes separados, se cubren las cuatro combinaciones posibles:

| # | Cobro | Facturación | Ejemplo típico |
|---|---|---|---|
| 1 | Pagado | Facturado | Trabajo cerrado y en regla. |
| 2 | Pagado | No facturado | Cobrado en efectivo, falta hacer la factura. |
| 3 | No pagado | Facturado | Facturado, esperando que el cliente pague. |
| 4 | No pagado | No facturado | Entregado, todavía sin cobrar ni facturar. |

Esto permite filtrar rápido, por ejemplo, "todo lo finalizado que **falta cobrar**" o "lo que **falta facturar**", que suele ser donde se escapa el dinero.

### 5.4 Disciplinas / máquinas

Los trabajos se agrupan y filtran por disciplina: **Láser**, **Serigrafía** y **Ploteo/Cartelería**. Esto sirve para ver la carga de cada máquina y organizar la producción. La lista de disciplinas queda configurable por si en el futuro se suma otra máquina o servicio.

### 5.5 Cheques

Registro de cheques que entran y salen del taller:

- Número de cheque, banco.
- Tipo: recibido (de un cliente) o emitido (a un proveedor).
- Importe.
- Fecha de emisión y **fecha de cobro/vencimiento**.
- Estado: pendiente, cobrado, depositado, rechazado.
- Vínculo opcional al trabajo o al proveedor relacionado.

El sistema puede avisar los cheques **próximos a vencer**, que es uno de los mayores dolores de cabeza.

### 5.6 Pagos de servicios

Control de gastos fijos y servicios del taller (luz, gas, alquiler, internet, proveedores recurrentes):

- Concepto / servicio.
- Importe y período (mes).
- Fecha de vencimiento.
- Estado: pendiente / pagado.
- Comprobante (opcional, foto o archivo adjunto).

Con un panel de "vencimientos del mes" para no pagar recargos por olvidos.

---

## 6. Recomendación de arquitectura

### 6.1 Tu idea y por qué la intuición es buena

Vos propusiste una **web pública de solo lectura** y que **los cambios se hagan en una web local**. La intuición de fondo es muy buena: *no querés exponer a internet la parte donde se modifica y se ve el dinero.* Ese instinto de separar "lo que se ve desde afuera" de "lo que se edita adentro" es exactamente el principio de seguridad correcto (mínima exposición).

El problema práctico de mantener **dos sistemas** (uno público de lectura + uno local de escritura) es que hay que **sincronizar** los datos entre ambos, resolver conflictos y duplicar el mantenimiento. Es más trabajo y más superficie de error.

### 6.2 La recomendación: una sola app en el NAS + VPN privada

Se obtiene el mismo objetivo de seguridad, más simple, así:

1. **Una sola aplicación** corriendo en tu **NAS**, dentro de un contenedor **Docker**. Ahí viven la app y la base de datos.
2. El NAS **no se expone** a internet (no se abren puertos hacia afuera). Desde la red de casa/taller se entra directamente.
3. Para entrar **desde afuera** (papá desde el taller, vos desde donde sea), se usa **Tailscale**: una VPN privada que conecta los dispositivos de la familia con el NAS mediante un "túnel" cifrado, como si estuvieran todos en la misma red local. No hay nada visible ni atacable desde internet abierto.

Con esto, **todos tienen lectura y escritura seguras desde cualquier lugar**, sin duplicar sistemas y sin sincronización. Tailscale tiene un **plan gratuito para hasta 6 usuarios** con dispositivos ilimitados, que alcanza de sobra para la familia.

```
   Papá (taller)        Vos (celular/PC)        Familia
        │                     │                     │
        └──── túnel cifrado Tailscale (VPN) ────────┘
                          │
                    ┌─────▼─────┐
                    │   NAS de  │   Docker:
                    │   casa    │   - App web
                    │           │   - Base de datos
                    └───────────┘   - Backups
```

### 6.3 La web pública de solo lectura, como fase opcional

Tu idea original **no se descarta**: es ideal como **Fase 2**. Cuando el sistema esté maduro, se puede publicar un portal **de solo lectura para clientes** (por ejemplo, que con un código vean el estado de *su* pedido), usando **Cloudflare Tunnel** (que expone solo esa vista pública, sin abrir puertos del NAS) y mostrando únicamente datos no sensibles. Así se logra lo que querías —una cara pública— pero sin arriesgar la parte administrativa ni el dinero.

### 6.4 Comparación rápida

| Enfoque | Ventajas | Desventajas |
|---|---|---|
| **Dos sistemas (público lectura + local escritura)** — tu idea original | Separación fuerte de lo público | Hay que sincronizar datos y mantener dos apps; más complejo y más propenso a errores |
| **Una app en NAS + VPN (Tailscale)** — recomendado | Lectura/escritura seguras desde todos lados; sin sincronización; costo casi nulo; NAS no expuesto | Cada usuario instala Tailscale una vez (muy simple) |
| **App en la nube (servicio pago)** | Cero mantenimiento de servidor | Costo mensual; los datos salen de tu control; menos alineado con "empezar simple y propio" |

---

## 7. Stack tecnológico sugerido

Priorizando que sea estándar, mantenible y fácil de alojar en el NAS:

| Capa | Tecnología sugerida | Por qué |
|---|---|---|
| **Frontend** (lo que se ve) | Aplicación web responsive (React) | Una sola base de código sirve para PC y celular. |
| **Backend** (la lógica) | Node.js o Python | Maduros, con mucho soporte y talento disponible. |
| **Base de datos** | PostgreSQL | Robusta, confiable, ideal para datos con dinero de por medio. |
| **Empaquetado** | Docker / Docker Compose | El NAS lo soporta nativamente (Container Manager); despliegue y backups simples. |
| **Acceso remoto seguro** | Tailscale (VPN) | Acceso cifrado sin exponer el NAS. |
| **Portal público (Fase 2)** | Cloudflare Tunnel | Expone solo la vista pública, sin abrir puertos. |

Nota: si más adelante se quiere vender el producto, este stack (React + backend + PostgreSQL + Docker) es exactamente el que se usa para llevar una app a la nube en modo multi-cliente, así que **no habría que reescribir** — solo adaptar.

---

## 8. Ciberseguridad

Pediste una estructura de seguridad firme. Estos son los pilares, del más importante al de detalle:

1. **No exponer el NAS a internet.** El acceso externo es solo por la VPN privada (Tailscale). Esto elimina de un plumazo la mayoría de los ataques automáticos.
2. **Autenticación fuerte.** Contraseñas guardadas cifradas (hash con *bcrypt/argon2*, nunca en texto plano). Sesiones seguras y opción de segundo factor (2FA) para el administrador.
3. **Permisos por rol.** Cada usuario ve y hace solo lo que su rol permite (ver sección 4). El dinero (cheques, cobros) solo para roles autorizados.
4. **Conexión cifrada (HTTPS/TLS)** dentro de la red, para que ni siquiera en la red local viajen datos en claro.
5. **Bitácora de auditoría.** Registro de quién hizo cada cambio importante y cuándo. Sirve para seguridad y para resolver dudas internas.
6. **Backups automáticos.** Copia diaria de la base de datos + snapshots del NAS. Idealmente una copia adicional fuera del NAS (regla 3-2-1: 3 copias, 2 medios, 1 fuera de sitio).
7. **Actualizaciones.** Mantener al día el sistema del NAS, Docker y las dependencias de la app para cerrar vulnerabilidades conocidas.
8. **Principio de mínimo privilegio.** Nadie tiene más acceso del que necesita; el usuario de la base de datos tampoco.

Con estos ocho puntos, el sistema queda a un nivel de seguridad muy sólido para un taller familiar, e incluso servible como base si a futuro se vende.

---

## 9. Backups y continuidad

- **Base de datos:** respaldo automático diario, guardado dentro del NAS y con una copia fuera (por ejemplo, un disco externo o un almacenamiento en la nube cifrado).
- **Snapshots del NAS:** aprovechar la función de snapshots para poder volver atrás ante un error.
- **Prueba de restauración:** cada tanto, verificar que un backup realmente se puede restaurar (un backup que nunca se probó no es un backup confiable).
- **Documentar** cómo levantar todo de nuevo si el NAS falla, para no depender de la memoria.

---

## 10. Fases del proyecto (hoja de ruta)

| Fase | Qué incluye | Resultado |
|---|---|---|
| **0. Preparación** | Instalar Docker en el NAS, configurar Tailscale para la familia, definir estructura de datos final. | Infraestructura lista. |
| **1. MVP** | Trabajos + estados + disciplinas + cobro/facturación + cheques + pagos de servicios + login por roles + dashboard. | App usable en el taller día a día. |
| **2. Mejoras** | Reportes, presupuestos/remitos en PDF, notificaciones de vencimientos, portal público de solo lectura para clientes. | Sistema completo. |
| **3. Producto (opcional)** | Adaptar a multi-cliente, llevar a la nube, cobro por suscripción. | Producto vendible a otros talleres. |

---

## 11. Costos estimados

**Para empezar (Fases 0 y 1), el costo de infraestructura es prácticamente cero**, porque ya tenés el NAS:

| Concepto | Costo |
|---|---|
| NAS y almacenamiento | Ya lo tenés (solo consumo eléctrico). |
| Docker / PostgreSQL / la app | Software libre, sin licencia. |
| Tailscale (hasta 6 usuarios) | Gratis. |
| Cloudflare Tunnel (portal público, Fase 2) | Gratis en su nivel básico. |
| **Total para arrancar** | **~$0 de infraestructura.** |

El costo real del proyecto es el **desarrollo** (el tiempo de programar), ya sea que lo hagas vos aprendiendo, lo hagamos por partes acá, o se contrate ayuda puntual. Para la Fase 3 (vender como producto en la nube) sí aparecerían costos mensuales de servidor, pero eso recién si el proyecto despega.

### 11.1 Sobre el almacenamiento del NAS

Con **1 TB ya te sobra muchísimo**. Esta app guarda sobre todo **texto** (trabajos, estados, cheques, pagos): una base de datos así, aunque cargues miles de trabajos por año, ocupa apenas unos **cientos de MB**, no gigabytes. Lo único que puede pesar son las **fotos de comprobantes** si decidís adjuntarlas, y aun así, miles de fotos entran holgadas en una fracción de 1 TB.

No necesitás comprar disco por la app en sí. Donde **sí conviene invertir** es en la **seguridad de los datos**, no en la capacidad:

- Si tu NAS tiene **un solo disco**, sumar un **segundo disco de 1 TB** te permite armar un espejo (**RAID 1**): si un disco muere, no perdés nada. Esto es más valioso que tener más espacio.
- Sumado a eso, una **copia de backup fuera del NAS** (un disco externo o nube cifrada) completa la protección.

En resumen: el 1 TB actual alcanza para la app; el disco extra tiene sentido por **redundancia/seguridad**, no por falta de espacio.

---

## 12. De uso familiar a producto vendible

Si más adelante querés venderlo, la buena noticia es que **este diseño ya deja el camino allanado**: la misma app se puede convertir en "multi-cliente" (cada taller con sus datos aislados) y mudarse a la nube. Los puntos a reforzar en esa etapa serían el aislamiento de datos entre clientes, la facturación por suscripción y el soporte. Nada de eso obliga a rehacer lo de ahora; se construye encima. Por eso conviene, desde la V1, mantener el código ordenado y los datos bien separados por "taller/cuenta", aunque al principio haya una sola.

---

## 13. Recomendación final y próximos pasos

**Mi recomendación**, dado que nunca encaraste un proyecto así y querés algo seguro y simple: empezar con **una sola app web en el NAS + Tailscale**, acotada al **MVP de la sección 3**, y dejar la web pública y la venta como fases posteriores. Es el camino con menos piezas, menos costo y más seguridad, y no cierra ninguna puerta a futuro.

**Decisiones que necesito de tu lado para avanzar:**

1. ¿Confirmás el **alcance del MVP** (sección 3) o querés sumar/sacar algo?
2. ¿Qué **modelo/marca es tu NAS** (Synology, QNAP, otro)? Así verifico exactamente cómo corre Docker ahí.
3. ¿Cuántas personas de la familia van a usarlo y con qué **rol** cada una?
4. Para construir: ¿preferís que lo vayamos **armando por partes acá**, que te arme primero una **pantalla de demostración** para ver cómo se vería, o un plan de trabajo para programarlo vos/con ayuda?

Con esas respuestas, el siguiente paso natural es diseñar las pantallas del MVP y el modelo de datos en detalle.
