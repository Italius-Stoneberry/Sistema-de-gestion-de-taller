# Capa de IA (opcional) — carga automática desde WhatsApp y correo

Esta capa **no es necesaria** para usar la app. Se activa cuando el equipo tenga la RAM y la
GPU listas. Deja que un audio de WhatsApp o un correo se conviertan solos en una entrada de la
tabla, que **siempre queda como borrador** para que una persona la revise y confirme (Bandeja).

## Cómo funciona

```
WhatsApp (WAHA) ─┐
                 ├─> n8n ─> [Whisper si es audio] ─> Ollama (extrae JSON) ─> POST /api/ingesta/... ─> Bandeja
Correo (IMAP)  ──┘                                                              (revisado = false)
```

Todo lo que entra por IA se guarda con `origen = 'ia'` y `revisado = false`, y aparece en la
pestaña **Bandeja** de la app. Nadie carga nada "a ciegas": se confirma con un clic.

## Requisitos del equipo

- **GPU NVIDIA** (tu 2060 de 12 GB es la indicada) con drivers + **nvidia-container-toolkit**.
- **RAM**: subí a 16-32 GB antes de activar esto (WAHA + n8n + Whisper suman).
- No corras la IA pesada **mientras imprimís con Klipper** (jitter del host).

## Puesta en marcha

1. Instalá el toolkit de NVIDIA para Docker (en el host Linux Mint):
   ```bash
   # Guía oficial: NVIDIA Container Toolkit. Verificá con:
   docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
   ```
2. Agregá al `.env` la clave de ingesta (ya está en `.env.example`):
   ```
   INGEST_API_KEY=<una cadena larga y aleatoria>
   ```
3. Levantá los dos compose juntos:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d
   ```
4. Descargá un modelo en Ollama (una sola vez):
   ```bash
   docker exec -it taller-ollama ollama pull qwen3:14b
   # alternativa más liviana: gemma3:12b  (o qwen3:8b si querés dejar VRAM para Whisper)
   ```
5. **Vinculá WhatsApp**: entrá al panel de WAHA (`http://<ip>:3001`) y escaneá el QR con el
   teléfono del taller.
6. **Configurá n8n**: entrá a `http://<ip>:5678`, importá el flujo de ejemplo
   (`n8n/ejemplo-whatsapp-a-trabajo.json`) y ajustá:
   - La URL/nombre del webhook de WAHA.
   - El header `x-api-key` con tu `INGEST_API_KEY`.
   - El modelo de Ollama si usaste otro.

> **Seguridad:** accedé a los paneles de n8n (5678) y WAHA (3001) **solo por Tailscale/red local**.
> No abras esos puertos a internet.

## Direcciones internas (dentro de la red Docker)

| Servicio | URL para usar en n8n |
|---|---|
| App (tu API) | `http://app:3000/api/ingesta/trabajo` |
| Ollama | `http://ollama:11434/api/generate` |
| Whisper | `http://whisper:9000/asr` |
| WAHA | `http://waha:3000` |

## Endpoints de ingesta (los que llama n8n)

| Método | Ruta | Crea |
|---|---|---|
| POST | `/api/ingesta/trabajo` | Trabajo (borrador) |
| POST | `/api/ingesta/cheque` | Cheque (borrador) |
| POST | `/api/ingesta/pago` | Pago de servicio (borrador) |

Todos requieren el header `x-api-key: <INGEST_API_KEY>`.

Ejemplo de cuerpo para `/api/ingesta/trabajo`:
```json
{
  "cliente": "Ferretería López",
  "descripcion": "Cartel de chapa 2x1 con corte láser",
  "disciplina": "laser",
  "precio": 45000,
  "origen_ref": "WhatsApp audio 2026-07-04 10:32"
}
```

## Prompt sugerido para el LLM (extracción a JSON)

> Sos un asistente que extrae datos de un mensaje de un taller. Devolvé SOLO un JSON válido con
> las claves: cliente, descripcion, disciplina (uno de: laser, serigrafia, ploteo), precio
> (número o 0 si no se menciona). Si el mensaje no es un pedido de trabajo, devolvé {"ignorar": true}.
> Mensaje: "<acá va el texto transcripto o el cuerpo del correo>"

Pedile a Ollama `"format": "json"` para forzar salida JSON.
