#!/usr/bin/env node
/**
 * Builds the two importable n8n workflows from the sources in /src.
 *
 *   node scripts/build-workflows.js
 *
 * Output:
 *   workflows/salon-booking-tools.json  (sub-workflow: Google Sheets + booking engine)
 *   workflows/salon-booking-bot.json    (main workflow: WhatsApp + Gemini AI agent)
 *
 * Keeping the Code-node logic in /src means it can be unit tested (see /tests)
 * and reviewed on GitHub as normal JavaScript instead of escaped JSON strings.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SHEET_ID = 'REPLACE_WITH_YOUR_SPREADSHEET_ID';
const TOOLS_WORKFLOW_ID = 'REPLACE_WITH_TOOLS_WORKFLOW_ID';
const TIMEZONE = 'America/Argentina/Buenos_Aires';

// Deterministic IDs so rebuilding produces clean diffs.
const uid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const node = (wf, name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, id: uid(`${wf}:${name}`), name, type, typeVersion, position, ...extra,
});

const sticky = (wf, name, content, position, width, height, color = 7) =>
  node(wf, name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color });

const rl = (value, mode = 'id') => ({ __rl: true, value, mode });
const sheet = (name) => ({ documentId: rl(SHEET_ID), sheetName: rl(name, 'name') });

const main = (...targets) => ({ main: targets.map((t) => (t ? [].concat(t).map((n) => ({ node: n, type: 'main', index: 0 })) : [])) });
const ai = (type, target) => ({ [type]: [[{ node: target, type, index: 0 }]] });

const condition = (wf, key, left, right) => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: uid(`${wf}:cond:${key}`), leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } }],
  combinator: 'and',
});

// ============================================================================
// 1) Sub-workflow: Salon Booking - Tools
// ============================================================================
const T = 'tools';
const engineSource = read('src/booking-engine.js');
const engineCode = `${engineSource}

// ============================== n8n adapter ==============================
// Reads the rows loaded by the Google Sheets nodes and runs the engine once.
const rows = (nodeName) => $(nodeName).all().map((i) => i.json).filter((r) => r && Object.keys(r).length > 0);
const input = $('When Called by Agent').first().json;

const result = runBookingEngine(input, {
  services: rows('Read Services'),
  staff: rows('Read Staff'),
  appointments: rows('Read Appointments'),
  clients: rows('Read Clients'),
});

return [{ json: result }];
`;

const TOOL_INPUTS = ['action', 'phone', 'profile_name', 'client_name', 'service_id', 'staff_id', 'date', 'time', 'appointment_id'];

const readOpts = { executeOnce: true, alwaysOutputData: true };
const writeColumns = (matching = []) => ({ mappingMode: 'autoMapInputData', value: {}, matchingColumns: matching, schema: [] });

const toolsNodes = [
  sticky(T, 'Note: Overview', [
    '## Salon Booking - Tools',
    'Called by the AI agent in **Salon Booking Bot** through 5 tools.',
    '',
    '1. Loads the 4 tables from Google Sheets',
    '2. **Booking Engine** (pure JavaScript, unit tested in `/src`) decides the answer',
    '3. If the action changes data, the matching branch writes to the sheet',
    '4. **Return Result** sends the answer back to the agent',
    '',
    'Test it: pin data is attached to the trigger, just click *Test workflow*.',
  ].join('\n'), [-280, -380], 520, 300, 5),
  sticky(T, 'Note: Writes', '### Writes\nOnly `create_appointment` and `cancel_appointment` modify the sheet. Values are written RAW so phones and dates stay as text.', [1240, -220], 420, 140, 7),

  node(T, 'When Called by Agent', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [-280, 0], {
    workflowInputs: { values: TOOL_INPUTS.map((name) => ({ name })) },
  }),
  node(T, 'Read Services', 'n8n-nodes-base.googleSheets', 4.5, [-40, 0], { operation: 'read', ...sheet('Services'), options: {} }, readOpts),
  node(T, 'Read Staff', 'n8n-nodes-base.googleSheets', 4.5, [180, 0], { operation: 'read', ...sheet('Staff'), options: {} }, readOpts),
  node(T, 'Read Appointments', 'n8n-nodes-base.googleSheets', 4.5, [400, 0], { operation: 'read', ...sheet('Appointments'), options: {} }, readOpts),
  node(T, 'Read Clients', 'n8n-nodes-base.googleSheets', 4.5, [620, 0], { operation: 'read', ...sheet('Clients'), options: {} }, readOpts),
  node(T, 'Booking Engine', 'n8n-nodes-base.code', 2, [840, 0], { jsCode: engineCode }),
  node(T, 'Route Write', 'n8n-nodes-base.switch', 3.2, [1060, 0], {
    rules: {
      values: [
        { conditions: condition(T, 'create', '={{ $json.op }}', 'create'), renameOutput: true, outputKey: 'Create' },
        { conditions: condition(T, 'cancel', '={{ $json.op }}', 'cancel'), renameOutput: true, outputKey: 'Cancel' },
      ],
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'No write' },
  }),
  node(T, 'Appointment Row', 'n8n-nodes-base.code', 2, [1300, -100], { jsCode: 'return [{ json: $input.first().json.appointment_row }];' }),
  node(T, 'Save Appointment', 'n8n-nodes-base.googleSheets', 4.5, [1520, -100], {
    operation: 'append', ...sheet('Appointments'), columns: writeColumns(), options: { cellFormat: 'RAW' },
  }),
  node(T, 'Client Row', 'n8n-nodes-base.code', 2, [1740, -100], { jsCode: "return [{ json: $('Booking Engine').first().json.client_row }];" }),
  node(T, 'Upsert Client', 'n8n-nodes-base.googleSheets', 4.5, [1960, -100], {
    operation: 'appendOrUpdate', ...sheet('Clients'), columns: writeColumns(['phone']), options: { cellFormat: 'RAW' },
  }),
  node(T, 'Cancellation Row', 'n8n-nodes-base.code', 2, [1300, 100], { jsCode: 'return [{ json: $input.first().json.update_row }];' }),
  node(T, 'Mark as Cancelled', 'n8n-nodes-base.googleSheets', 4.5, [1520, 100], {
    operation: 'update', ...sheet('Appointments'), columns: writeColumns(['appointment_id']), options: { cellFormat: 'RAW' },
  }),
  node(T, 'Return Result', 'n8n-nodes-base.code', 2, [2200, 0], {
    jsCode: "// Whatever this node outputs is what the AI agent receives from the tool.\nreturn [{ json: $('Booking Engine').first().json.response }];",
  }),
];

const toolsWorkflow = {
  name: 'Salon Booking - Tools',
  nodes: toolsNodes,
  pinData: {
    'When Called by Agent': [{ json: { action: 'check_availability', phone: '5492231112233', profile_name: 'Test User', client_name: '', service_id: 'S01', staff_id: '', date: '2026-11-10', time: '', appointment_id: '' } }],
  },
  connections: {
    'When Called by Agent': main('Read Services'),
    'Read Services': main('Read Staff'),
    'Read Staff': main('Read Appointments'),
    'Read Appointments': main('Read Clients'),
    'Read Clients': main('Booking Engine'),
    'Booking Engine': main('Route Write'),
    'Route Write': main('Appointment Row', 'Cancellation Row', 'Return Result'),
    'Appointment Row': main('Save Appointment'),
    'Save Appointment': main('Client Row'),
    'Client Row': main('Upsert Client'),
    'Upsert Client': main('Return Result'),
    'Cancellation Row': main('Mark as Cancelled'),
    'Mark as Cancelled': main('Return Result'),
  },
  active: false,
  settings: { executionOrder: 'v1', timezone: TIMEZONE, callerPolicy: 'workflowsFromSameOwner' },
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

// ============================================================================
// 2) Main workflow: Salon Booking Bot
// ============================================================================
const M = 'bot';
const NM = "$('Normalize Message').first().json";

const fromAI = (key, description, def) =>
  `={{ $fromAI('${key}', '${description.replace(/'/g, "\\'")}', 'string'${def !== undefined ? `, '${def}'` : ''}) }}`;

const toolNode = (name, position, description, values) => node(M, name, '@n8n/n8n-nodes-langchain.toolWorkflow', 2, position, {
  description,
  workflowId: rl(TOOLS_WORKFLOW_ID),
  workflowInputs: {
    mappingMode: 'defineBelow',
    value: { action: name, ...values },
    matchingColumns: [],
    schema: TOOL_INPUTS.map((id) => ({
      id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false,
    })),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
});

const systemPrompt = read('src/system-prompt.md');

const botNodes = [
  sticky(M, 'Note: Overview', [
    '## Salon Booking Bot (WhatsApp + Gemini)',
    '**Flow:** WhatsApp message -> normalize -> AI agent (Gemini + memory + 5 tools) -> reply on WhatsApp -> log to Google Sheets.',
    '',
    'The agent never touches the sheet directly: every read/write goes through the **Salon Booking - Tools** sub-workflow, where the business rules live.',
    '',
    'The customer phone is injected by the workflow (not chosen by the AI), so a customer can only see or cancel their own appointments.',
  ].join('\n'), [-300, -420], 560, 260, 5),
  sticky(M, 'Note: Tools', '### Agent tools\nEach tool calls the same sub-workflow with a fixed `action`. Fields using `$fromAI()` are filled in by Gemini; `phone` comes from the webhook.', [700, 420], 600, 120, 7),

  node(M, 'WhatsApp Trigger', 'n8n-nodes-base.whatsAppTrigger', 1, [-300, 0], { updates: ['messages'] }),
  node(M, 'Normalize Message', 'n8n-nodes-base.code', 2, [-80, 0], { jsCode: read('src/normalize-message.js') }),
  node(M, 'Is Text?', 'n8n-nodes-base.if', 2.2, [140, 0], {
    conditions: condition(M, 'is-text', '={{ $json.type }}', 'text'),
    options: {},
  }),
  node(M, 'Salon Assistant', '@n8n/n8n-nodes-langchain.agent', 1.7, [420, -20], {
    promptType: 'define',
    text: '={{ $json.text }}',
    options: { systemMessage: `=${systemPrompt}`, maxIterations: 10 },
  }, { onError: 'continueErrorOutput' }),
  node(M, 'Gemini Chat Model', '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, [300, 220], {
    modelName: 'models/gemini-2.5-flash',
    options: { temperature: 0.3 },
  }),
  node(M, 'Conversation Memory', '@n8n/n8n-nodes-langchain.memoryBufferWindow', 1.3, [460, 220], {
    sessionIdType: 'customKey',
    sessionKey: `={{ ${NM}.phone }}`,
    contextWindowLength: 12,
  }),
  toolNode('get_services', [620, 260],
    'Returns the salon catalog: services (ID, name, duration, price) and which stylists perform each one, plus stylists working days and hours. Call it before quoting any price or service.',
    {}),
  toolNode('check_availability', [760, 260],
    'Returns free start times for a service on a given date, grouped by stylist. If the day is full or closed, it suggests the next available date.',
    {
      service_id: fromAI('service_id', 'Service ID from get_services, e.g. S01'),
      date: fromAI('date', 'Date in YYYY-MM-DD format'),
      staff_id: fromAI('staff_id', 'Optional stylist ID from get_services. Empty string means any stylist', ''),
    }),
  toolNode('create_appointment', [900, 260],
    'Books an appointment. Only call it after the customer explicitly confirmed service, date and time. Returns the appointment code.',
    {
      phone: `={{ ${NM}.phone }}`,
      profile_name: `={{ ${NM}.profile_name }}`,
      service_id: fromAI('service_id', 'Service ID, e.g. S01'),
      date: fromAI('date', 'Date in YYYY-MM-DD format'),
      time: fromAI('time', 'Start time in 24h HH:MM format, e.g. 15:30'),
      staff_id: fromAI('staff_id', 'Optional stylist ID. Empty string means any available stylist', ''),
      client_name: fromAI('client_name', 'Customer full name if they told you, otherwise empty string', ''),
    }),
  toolNode('list_my_appointments', [1040, 260],
    'Lists the upcoming booked appointments of the customer you are chatting with (codes, services, dates, times).',
    { phone: `={{ ${NM}.phone }}` }),
  toolNode('cancel_appointment', [1180, 260],
    'Cancels one of the customer\'s upcoming appointments by its code (APT-...). Confirm with the customer before calling it.',
    {
      phone: `={{ ${NM}.phone }}`,
      appointment_id: fromAI('appointment_id', 'Appointment code, e.g. APT-261110-AB12'),
    }),
  node(M, 'Send Reply', 'n8n-nodes-base.whatsApp', 1, [820, -120], {
    operation: 'send',
    phoneNumberId: `={{ ${NM}.phone_number_id }}`,
    recipientPhoneNumber: `={{ ${NM}.reply_to }}`,
    textBody: '={{ $json.output }}',
    additionalFields: {},
  }),
  node(M, 'Build Log Row', 'n8n-nodes-base.set', 3.4, [1040, -120], {
    assignments: {
      assignments: [
        ['timestamp', `={{ $now.setZone('${TIMEZONE}').toFormat('yyyy-MM-dd HH:mm:ss') }}`],
        ['phone', `={{ ${NM}.phone }}`],
        ['profile_name', `={{ ${NM}.profile_name }}`],
        ['message_type', `={{ ${NM}.type }}`],
        ['incoming_text', `={{ ${NM}.text }}`],
        ['bot_reply', "={{ $('Salon Assistant').first().json.output }}"],
      ].map(([name, value]) => ({ id: uid(`${M}:log:${name}`), name, value, type: 'string' })),
    },
    options: {},
  }),
  node(M, 'Log Conversation', 'n8n-nodes-base.googleSheets', 4.5, [1260, -120], {
    operation: 'append', ...sheet('MessageLog'), columns: writeColumns(), options: { cellFormat: 'RAW' },
  }),
  node(M, 'Reply Fallback', 'n8n-nodes-base.whatsApp', 1, [820, 60], {
    operation: 'send',
    phoneNumberId: `={{ ${NM}.phone_number_id }}`,
    recipientPhoneNumber: `={{ ${NM}.reply_to }}`,
    textBody: 'Sorry, I had a technical problem. Please try again in a minute or call us at +54 223 000-0000. / Perdón, tuve un problema técnico. Probá de nuevo en un minuto o llamanos al +54 223 000-0000.',
    additionalFields: {},
  }),
  node(M, 'Reply Unsupported', 'n8n-nodes-base.whatsApp', 1, [140, 260], {
    operation: 'send',
    phoneNumberId: `={{ ${NM}.phone_number_id }}`,
    recipientPhoneNumber: `={{ ${NM}.reply_to }}`,
    textBody: 'For now I can only read text messages 🙏 Please write your question. / Por ahora solo puedo leer mensajes de texto 🙏 Escribime tu consulta.',
    additionalFields: {},
  }),
];

const botWorkflow = {
  name: 'Salon Booking Bot',
  nodes: botNodes,
  pinData: {},
  connections: {
    'WhatsApp Trigger': main('Normalize Message'),
    'Normalize Message': main('Is Text?'),
    'Is Text?': main('Salon Assistant', 'Reply Unsupported'),
    'Salon Assistant': main('Send Reply', 'Reply Fallback'),
    'Send Reply': main('Build Log Row'),
    'Build Log Row': main('Log Conversation'),
    'Gemini Chat Model': ai('ai_languageModel', 'Salon Assistant'),
    'Conversation Memory': ai('ai_memory', 'Salon Assistant'),
    get_services: ai('ai_tool', 'Salon Assistant'),
    check_availability: ai('ai_tool', 'Salon Assistant'),
    create_appointment: ai('ai_tool', 'Salon Assistant'),
    list_my_appointments: ai('ai_tool', 'Salon Assistant'),
    cancel_appointment: ai('ai_tool', 'Salon Assistant'),
  },
  active: false,
  settings: { executionOrder: 'v1', timezone: TIMEZONE },
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

fs.mkdirSync(path.join(ROOT, 'workflows'), { recursive: true });
for (const [file, wf] of [['salon-booking-tools.json', toolsWorkflow], ['salon-booking-bot.json', botWorkflow]]) {
  fs.writeFileSync(path.join(ROOT, 'workflows', file), JSON.stringify(wf, null, 2) + '\n');
  console.log(`built workflows/${file} (${wf.nodes.length} nodes)`);
}
