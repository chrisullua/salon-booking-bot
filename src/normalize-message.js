/**
 * Normalize Message (n8n Code node, "Run Once for All Items")
 * ---------------------------------------------------------------------------
 * Turns the raw WhatsApp Cloud API webhook payload into one clean item.
 * Status callbacks (sent / delivered / read) have no `messages` array and are
 * dropped here by returning an empty list, which ends the execution quietly.
 */

// Argentina quirk: inbound numbers arrive as 549 + area + number, but the
// Cloud API (especially the test allow-list) expects 54 + area + number.
// Set to false if your replies fail with "recipient not in allowed list".
const STRIP_AR_MOBILE_9 = true;

const raw = $input.first().json;
const value = raw.messages ? raw : raw.entry?.[0]?.changes?.[0]?.value ?? raw.body?.entry?.[0]?.changes?.[0]?.value ?? {};
const msg = value.messages?.[0];

if (!msg) return [];

const from = String(msg.from);
const replyTo = STRIP_AR_MOBILE_9 && /^549\d{10}$/.test(from) ? '54' + from.slice(3) : from;

let text = '';
if (msg.type === 'text') text = msg.text?.body ?? '';
else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '';
else if (msg.type === 'button') text = msg.button?.text ?? '';

return [{
  json: {
    phone: from,
    reply_to: replyTo,
    profile_name: value.contacts?.[0]?.profile?.name ?? '',
    type: text ? 'text' : msg.type,
    text: text.trim().slice(0, 1000),
    message_id: msg.id,
    phone_number_id: value.metadata?.phone_number_id,
  },
}];
