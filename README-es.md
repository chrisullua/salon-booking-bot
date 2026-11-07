# Glow Studio – Asistente de Reservas por WhatsApp

Un recepcionista con IA para un salón de belleza que reserva, consulta y cancela turnos a través de **WhatsApp**, construido con **n8n**, **Google Gemini** y **Google Sheets** como base de datos.

Los clientes escriben en lenguaje natural (*"¿Tienen lugar para un corte de pelo el próximo martes por la tarde?"*). El asistente verifica la disponibilidad real, confirma los detalles, guarda la reserva y responde con un código de turno. Responde en el idioma del cliente (español o inglés).

> Glow Studio es un negocio ficticio. Todos los nombres, números de teléfono y datos en este repositorio son simulados.

<!-- Agrega una grabación de pantalla aquí cuando tengas una, ej. ![Demo](docs/demo.gif) -->

---

## Características

- **Reserva en lenguaje natural** mediante un agente de IA impulsado por Gemini y memoria de conversación por cliente.
- **Motor de disponibilidad real**: horarios de estilistas, días laborables, duración de servicios, detección de solapamientos, tiempo mínimo de anticipación y ventana de reserva.
- **Autoservicio**: los clientes pueden listar y cancelar sus propios turnos.
- **Reglas de negocio aplicadas en código, no en el prompt**: la IA no puede reservar un horario ocupado, reservar en el pasado ni cancelar el turno de otra persona.
- **Google Sheets como base de datos ligera** que el personal del salón puede leer y editar directamente.
- **Registro de conversaciones** para auditoría y analítica.
- **Lógica de negocio probada con pruebas unitarias** (`npm test`), mantenida como JavaScript puro en `/src`.

## Arquitectura

![Flujo principal](./assets/wf-n8n-image.png)
![Subflujo](./assets/swf1-n8n-image.png)

**¿Por qué dos flujos de trabajo?** El agente de IA decide *qué* hacer; el subflujo de herramientas decide *si está permitido* y realiza las lecturas y escrituras. Cada llamada a una herramienta pasa por el mismo **Motor de Reservas** determinista, de modo que las reglas de negocio no se pueden eludir por una respuesta inesperada del modelo.

**Detalle de seguridad:** el número de teléfono del cliente es inyectado por el flujo de trabajo desde el webhook de WhatsApp, nunca elegido por la IA. Un cliente solo puede ver o cancelar sus propios turnos, incluso si le pide al bot información de otra persona.

### Herramientas del agente

| Herramienta | Lo que proporciona la IA | Lo que inyecta el flujo de trabajo | Escribe en la hoja |
|---|---|---|---|
| `get_services` | – | – | No |
| `check_availability` | servicio, fecha, estilista (opcional) | – | No |
| `create_appointment` | servicio, fecha, hora, estilista (opcional), nombre | teléfono, nombre de WhatsApp | `Appointments`, `Clients` |
| `list_my_appointments` | – | teléfono | No |
| `cancel_appointment` | código de turno | teléfono | `Appointments` |

## Modelo de datos (Google Sheets)

Una sola hoja de cálculo con cinco pestañas. Los nombres de las pestañas y los encabezados deben coincidir exactamente.

| Pestaña | Columnas | Propósito |
|---|---|---|
| **Services** | `service_id`, `name`, `category`, `duration_min`, `price`, `active` | Catálogo. Cambia `active` a `FALSE` para ocultar un servicio. |
| **Staff** | `staff_id`, `name`, `service_ids`, `work_days`, `start_time`, `end_time`, `active` | Estilistas. `service_ids` como `S01,S03`; `work_days` como `Tue-Sat` o `Mon,Wed,Fri`. |
| **Clients** | `phone`, `name`, `created_at`, `last_booking_at`, `total_bookings` | Una fila por cliente, actualizada/insertada en cada reserva. |
| **Appointments** | `appointment_id`, `phone`, `client_name`, `service_id`, `service_name`, `staff_id`, `staff_name`, `date`, `start_time`, `end_time`, `price`, `status`, `channel`, `created_at`, `updated_at` | Reservas. `status`: `booked`, `cancelled`, `completed`, `no_show`. |
| **MessageLog** | `timestamp`, `phone`, `profile_name`, `message_type`, `incoming_text`, `bot_reply` | Cada mensaje procesado y la respuesta del bot. |

`Appointments` está intencionadamente **desnormalizada** (almacena nombres de servicios y estilistas, no solo IDs). El personal puede leerla sin realizar búsquedas adicionales y se conecta directamente con Looker Studio o una tabla dinámica.

La plantilla incluye 8 servicios, 3 estilistas, 12 clientes y ~290 turnos (octubre-noviembre de 2026), por lo que la disponibilidad se ve realista y los datos están listos para un panel de control. Se pretende que `completed` y `no_show` sean actualizados por el personal del salón.

### Reglas de negocio

Configuradas en la parte superior de [`src/booking-engine.js`](src/booking-engine.js):

| Regla | Valor por defecto |
|---|---|
| Zona horaria | `America/Argentina/Buenos_Aires` |
| Horarios de inicio ofrecidos | cada 30 min |
| Aviso mínimo para reservar | 60 min |
| Ventana de reserva | 30 días de anticipación |
| Cancelación permitida hasta | 2 h antes del turno |

## Estructura del repositorio

```text
├── workflows/
│   ├── salon-booking-bot.json      # Flujo principal: WhatsApp + agente de IA (importar en n8n)
│   └── salon-booking-tools.json    # Subflujo: motor de reservas + Google Sheets (importar en n8n)
├── sheets/
│   ├── salon-booking-db-template.xlsx   # Plantilla de base de datos con datos de ejemplo
│   └── csv/                              # Mismos datos en CSV, un archivo por pestaña
├── src/
│   ├── booking-engine.js           # Lógica de negocio (embebida en el nodo de código "Booking Engine")
│   ├── normalize-message.js        # Procesamiento de webhook (embebido en "Normalize Message")
│   └── system-prompt.md            # Instrucciones del agente de IA
├── scripts/
│   ├── build-workflows.js          # Regenera /workflows a partir de /src
│   └── generate-sample-data.py     # Regenera la hoja de cálculo de ejemplo
└── tests/
    └── booking-engine.test.js      # Pruebas unitarias (ejecutor de pruebas integrado de Node)
```

Los archivos JSON en `/workflows` son **generados**. Para cambiar la lógica, edita en `/src`, ejecuta `npm run build` y vuelve a importar.

---

## Configuración

### Requisitos previos

- n8n ejecutándose localmente (Docker o npm), se recomienda versión 1.80 o superior.
- Una aplicación de desarrollador en Meta con **WhatsApp Cloud API** y un número de teléfono de prueba.
- Una **clave de API de Google Gemini** ([Google AI Studio](https://aistudio.google.com/)).
- Una cuenta de Google para Sheets.
- [ngrok](https://ngrok.com/) para exponer tu instancia local de n8n a los webhooks de Meta.

### 1. Crear la base de datos

1. Crea una nueva hoja de cálculo en Google Sheets y ve a **Archivo → Importar → Subir**, elige `sheets/salon-booking-db-template.xlsx` y selecciona **Reemplazar hoja de cálculo**.
2. Verifica que existan las cinco pestañas: `Services`, `Staff`, `Clients`, `Appointments`, `MessageLog`.
3. Copia el ID de la hoja de cálculo desde la URL:
   `https://docs.google.com/spreadsheets/d/`**`ESTA_PARTE_ES_EL_ID`**`/edit`

### 2. Importar el subflujo de herramientas

1. Abre `workflows/salon-booking-tools.json` en un editor de texto y reemplaza cada ocurrencia de `REPLACE_WITH_YOUR_SPREADSHEET_ID` por el ID de tu hoja de cálculo (Buscar y reemplazar todo).
2. En n8n: **Crear flujo → menú ⋯ → Importar desde archivo** → elige el archivo editado.
3. Abre cada nodo de Google Sheets (7 en total) y selecciona tus credenciales de **Google Sheets**.
4. **Guarda**, y luego copia el ID de este flujo de trabajo desde la URL del navegador:
   `http://localhost:5678/workflow/`**`ESTE_ES_EL_ID_DEL_FLUJO`**
5. Haz clic en **Probar flujo de trabajo**. El disparador tiene datos de entrada fijos de prueba (`check_availability` para un corte de pelo). **Return Result** debería mostrar los horarios libres.

### 3. Importar el flujo principal del bot

1. Abre `workflows/salon-booking-bot.json` en un editor de texto y reemplaza:
   - `REPLACE_WITH_TOOLS_WORKFLOW_ID` (5 veces) → el ID del flujo del paso 2.4.
   - `REPLACE_WITH_YOUR_SPREADSHEET_ID` (1 vez) → el ID de tu hoja de cálculo.
2. Impórtalo de la misma manera.
3. Selecciona las credenciales:

   | Nodo | Tipo de credencial |
   |---|---|
   | WhatsApp Trigger | WhatsApp OAuth API (App ID + App Secret) |
   | Send Reply, Reply Fallback, Reply Unsupported | WhatsApp API (Access Token + Business Account ID) |
   | Gemini Chat Model | Google Gemini (PaLM) API |
   | Log Conversation | Google Sheets |

4. En **Gemini Chat Model**, verifica el modelo. El valor predeterminado es `gemini-2.5-flash`; si no aparece en la lista, elige el modelo *Flash* más reciente del menú desplegable (rápido y económico es lo ideal para chat).

### 4. Exponer n8n con ngrok

Meta solo puede enviar webhooks a una URL HTTPS pública.

```bash
# Un dominio estático gratuito evita cambiar la URL en cada reinicio:
# https://dashboard.ngrok.com/domains
ngrok http --url=tu-nombre.ngrok-free.app 5678
```

Luego indícale a n8n su URL pública y reinícialo:

```bash
# Docker
docker run -it --rm -p 5678:5678 \
  -e WEBHOOK_URL=https://tu-nombre.ngrok-free.app/ \
  -e GENERIC_TIMEZONE=America/Argentina/Buenos_Aires \
  -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n

# npm (macOS / Linux)
export WEBHOOK_URL=https://tu-nombre.ngrok-free.app/
n8n start
```

Abre el nodo **WhatsApp Trigger**: las URL del webhook que muestra ahora deberían comenzar con tu dominio de ngrok.

### 5. Desactivar las actualizaciones de estado en el disparador

WhatsApp envía un webhook no solo por cada mensaje, sino también por cada cambio de estado (*enviado*, *entregado*, *leído*). Cada uno inicia una ejecución, lo que desperdicia lecturas en Google Sheets y puede activar límites de frecuencia.

Abre **WhatsApp Trigger → Options → Receive Message Status Updates** y remueve **All** para que solo lleguen los mensajes reales.

### 6. Publicar ambos flujos de trabajo

Publica (o activa la opción **Active** en versiones anteriores de n8n) **ambos** flujos de trabajo:

1. **Salon Booking - Tools** primero. El agente llama a la versión *publicada* del subflujo, no al borrador.
2. **Salon Booking Bot**. El WhatsApp Trigger registra su webhook con tu aplicación de Meta de forma automática.

> Una aplicación de Meta tiene **una sola** URL de webhook. Activar este flujo reemplazará cualquier URL que estuvieran usando otros bots en la misma aplicación.

---

## Cómo probar

### Pruebas unitarias (no requiere n8n)

```bash
npm test
```

Esto ejecuta el motor de reservas contra datos de muestra fijos: disponibilidad, solapamientos, tiempo de anticipación, fechas pasadas o lejanas, reservas, comprobación de propiedad y reglas de cancelación.

### Guion de conversación

Envía estos mensajes desde tu número de prueba de WhatsApp (en español o inglés):

| # | Mensaje enviado | Resultado esperado |
|---|---|---|
| 1 | `¡Hola! ¿Qué servicios tienen?` | Catálogo con precios. Llama a `get_services`. |
| 2 | `Quisiera un corte de mujer el próximo martes` | 3–4 opciones de horario. Llama a `check_availability`. |
| 3 | `A las 11:00 por favor` | Resumen de la reserva, pide confirmación y tu nombre. |
| 4 | `Sí, soy Ana Perez` | Confirmación con un código `APT-…`. Nuevas filas en **Appointments** y **Clients**. |
| 5 | `¿Qué turnos tengo reservados?` | Muestra la reserva del paso 4. |
| 6 | `Cancélalo por favor` | Pregunta cuál o confirma, luego cancela. El `status` pasa a `cancelled`. |
| 7 | `¿Puedo reservar un balayage este domingo?` | Explica que está cerrado y propone la próxima fecha disponible. |
| 8 | Enviar una nota de voz | Respuesta de "solo texto". |
| 9 | `Cancelar APT-261110-XXXX` (código de otra persona) | No encontrado. Se aplica la restricción de propiedad. |

Después de cada mensaje, la pestaña **Executions** en n8n muestra cada llamada a herramientas y sus entradas y salidas exactas. Es la mejor manera de entender qué está haciendo el agente.

### Probar el flujo de herramientas de forma aislada

En **Salon Booking - Tools**, edita los datos fijados (*pinned data*) en **When Called by Agent** (por ejemplo, cambia `action` a `get_services` o `create_appointment`) y haz clic en **Test workflow**. Los datos fijados solo se usan para pruebas manuales.

---

## Solución de problemas

| Síntoma | Causa probable y solución |
|---|---|
| Los mensajes llegan pero las respuestas fallan con *recipient not in allowed list* (error 131030) | Los móviles argentinos llegan como `549…` pero la lista de permitidos de prueba usa `54…`. `Normalize Message` remueve el `9` (`STRIP_AR_MOBILE_9 = true`). Si tu número está registrado con el 9, cámbialo a `false`. Para otros países, revisa el formato del número en la lista de permitidos. |
| Nada llega a n8n | `WEBHOOK_URL` no configurada o n8n no se reinició. El flujo debe estar publicado/activo, ngrok ejecutándose y la URL del disparador debe mostrar el dominio de ngrok. |
| El webhook dejó de funcionar al reiniciar ngrok | Sin un dominio estático la URL cambia. Usa un dominio estático o actualiza `WEBHOOK_URL` y vuelve a activar el flujo. |
| *Workflow does not exist* en una herramienta | No se reemplazó `REPLACE_WITH_TOOLS_WORKFLOW_ID`. Abre cada nodo de herramienta y selecciona **Salon Booking - Tools** de la lista. |
| Un nodo de herramienta muestra una advertencia y el flujo no se puede publicar | Algunas versiones de n8n requieren el campo **Name** de la herramienta. Establécelo con el nombre del nodo (`get_services`, `check_availability`, …). |
| El bot dice que tiene "problemas para acceder al catálogo" | Falló una llamada a una herramienta. Asegúrate de que **Salon Booking - Tools** esté publicado y que cada nodo de Google Sheets tenga credenciales. Revisa **Salon Booking - Tools → Executions** para identificar el nodo en rojo. |
| Muchas ejecuciones por mensaje, o Gemini devuelve *429 Too Many Requests* | Las actualizaciones de estado están llegando al disparador (ver paso 5 de la configuración). Además, cada llamada a una herramienta es una solicitud adicional a Gemini, y la capa gratuita tiene límites bajos por minuto y por día. Espera a que se reinicie la cuota o habilita la facturación en Google AI Studio. |
| Gemini *model not found* | Selecciona un modelo actual en **Gemini Chat Model**. Es posible que las claves de API nuevas no tengan acceso a modelos antiguos. Elige un modelo *Flash* actual que admita llamadas a herramientas (*tool calling*). |
| Las fechas se muestran como números o `10/11/2026` en la hoja | Inofensivo. El motor lee fechas ISO, `DD/MM/YYYY` y números de serie de Sheets. Para mantener el orden, da formato a las columnas de fecha como *Texto plano*. |
| Google Sheets *429 Too Many Requests* | Cada llamada a una herramienta lee 4 pestañas. Está bien para demos; para tráfico alto consulta la hoja de ruta. |
| El bot "olvida" la conversación tras reiniciar n8n | Comportamiento esperado. *Window Buffer Memory* reside en la memoria del proceso de n8n. Reemplázalo por un nodo de memoria de chat en Postgres o Redis para obtener persistencia. |

## Decisiones de diseño

- **Google Sheets como base de datos**: cero configuración, visible en tiempo real durante una demostración y editable por el personal no técnico del salón. También alimenta directamente a Looker Studio.
- **Lógica de negocio en un solo nodo de código en lugar de múltiples nodos de n8n**: la disponibilidad es algorítmica (intervalos, solapamientos, horarios). Como código, es legible, versionable y permite pruebas unitarias. n8n maneja aquello en lo que destaca: integraciones, credenciales y orquestación.
- **Herramientas deterministas, conversación flexible**: el LLM maneja el idioma y el diálogo; el motor es la autoridad única sobre lo que se puede reservar.
- **Manejo de fechas en JS puro**: usa `Intl` con una zona horaria explícita, por lo que el comportamiento no depende de la configuración del reloj del servidor.

## Limitaciones y hoja de ruta

- **Concurrencia**: dos clientes que confirmen exactamente el mismo horario en el mismo segundo podrían tener éxito ambos, ya que Sheets no cuenta con transacciones. → Migrar a **PostgreSQL** con una restricción de exclusión o unicidad en (estilista, rango de tiempo).
- **Recordatorios**: enviar un recordatorio 24 horas antes de cada turno mediante un flujo programado. Fuera de la ventana de 24 horas de WhatsApp, esto requiere una plantilla de mensaje aprobada.
- **Panel de control**: un informe de Looker Studio sobre `Appointments` (reservas por día, ingresos, tasa de ausentismo, principales servicios y estilistas).
- **Memoria de chat persistente** (Postgres o Redis) y un indicador para **derivación a un agente humano**.
- **Mensajes interactivos de WhatsApp** (botones y listas) para seleccionar horarios.

## Stack tecnológico

n8n · n8n AI Agent (LangChain) · Google Gemini · WhatsApp Cloud API · Google Sheets API · JavaScript (Node.js) · ngrok