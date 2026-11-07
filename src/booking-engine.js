/**
 * Booking Engine
 * ---------------------------------------------------------------------------
 * Pure business logic for the salon booking bot. No I/O, no n8n globals:
 * it receives the tool input plus the current sheet rows and returns
 *   - `response`: what the AI agent receives back from the tool
 *   - `op`: which write (if any) the n8n workflow must perform afterwards
 *   - the rows to write (appointment_row / client_row / update_row)
 *
 * This file is the single source of truth. `scripts/build-workflows.js`
 * embeds it into the "Booking Engine" Code node, and `tests/` runs it
 * locally with Node's built-in test runner.
 */

const CONFIG = {
  timezone: 'America/Argentina/Buenos_Aires',
  currency: 'ARS',
  slotStepMin: 30,           // granularity of offered start times
  minLeadMin: 60,            // can't book less than 1 hour from now
  maxDaysAhead: 30,          // booking window
  cancelMinHoursBefore: 2,   // cancellations allowed up to 2 hours before
  maxSlotsShown: 12,         // per stylist, to keep tool output small
  nextAvailableSearchDays: 7,
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ----------------------------------------------------------------- helpers --

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

function isActive(v) {
  const s = str(v).toLowerCase();
  if (s === '') return true; // empty cell = active by default
  return ['true', 'yes', 'y', '1', 'si', 'sí'].includes(s);
}

/** Accepts 'YYYY-MM-DD', 'DD/MM/YYYY' or a Sheets serial number. */
function normDate(v) {
  if (typeof v === 'number' && v > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function isRealDate(d) {
  if (!d) return false;
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

/** Accepts '9:00', '09:00', '9:00:00', '9', '9am', '3:30 pm' or a day fraction. Returns minutes. */
function toMinutes(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) return Math.round(v * 1440);
  const s = str(v).toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?(am|pm|hs)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const fmtTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dayIndex(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Current date and minutes-of-day in the salon's time zone (no external libs). */
function nowInZone(tz = CONFIG.timezone, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, minutes, stamp: `${date} ${parts.hour}:${parts.minute}:${parts.second}` };
}

/** 'Tue,Wed,Thu' or 'Tue-Sat' or 'Mon-Fri,Sat' -> Set of day indexes */
function parseWorkDays(v) {
  const out = new Set();
  const idx = (name) => DAY_NAMES.findIndex((d) => d.toLowerCase() === name.slice(0, 3).toLowerCase());
  for (const chunk of str(v).split(',').map((c) => c.trim()).filter(Boolean)) {
    const [a, b] = chunk.split('-').map((c) => c.trim());
    const i = idx(a);
    if (i < 0) continue;
    if (!b) { out.add(i); continue; }
    const j = idx(b);
    if (j < 0) continue;
    for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }
  }
  return out;
}

const splitList = (v) => str(v).split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean);

const money = (n) => `${CONFIG.currency} ${Number(n || 0).toLocaleString('en-US')}`;

function randomCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ------------------------------------------------------------ data access --

function buildContext(data) {
  const services = (data.services || [])
    .filter((r) => str(r.service_id))
    .map((r) => ({
      id: str(r.service_id).toUpperCase(),
      name: str(r.name),
      category: str(r.category),
      duration: Number(r.duration_min) || 30,
      price: Number(r.price) || 0,
      active: isActive(r.active),
    }));

  const staff = (data.staff || [])
    .filter((r) => str(r.staff_id))
    .map((r) => ({
      id: str(r.staff_id).toUpperCase(),
      name: str(r.name),
      services: splitList(r.service_ids),
      days: parseWorkDays(r.work_days),
      daysLabel: str(r.work_days),
      start: toMinutes(r.start_time),
      end: toMinutes(r.end_time),
      active: isActive(r.active),
    }));

  const appointments = (data.appointments || [])
    .filter((r) => str(r.appointment_id))
    .map((r) => ({
      raw: r,
      id: str(r.appointment_id).toUpperCase(),
      phone: str(r.phone),
      serviceId: str(r.service_id).toUpperCase(),
      serviceName: str(r.service_name),
      staffId: str(r.staff_id).toUpperCase(),
      staffName: str(r.staff_name),
      date: normDate(r.date),
      start: toMinutes(r.start_time),
      end: toMinutes(r.end_time),
      price: Number(r.price) || 0,
      status: str(r.status).toLowerCase(),
    }));

  const clients = (data.clients || []).filter((r) => str(r.phone));

  return { services, staff, appointments, clients };
}

/** Lets the LLM pass either the ID ('S01') or (part of) the name ('haircut'). */
function findByIdOrName(list, query) {
  const q = str(query).toLowerCase();
  if (!q) return null;
  return (
    list.find((x) => x.id.toLowerCase() === q) ||
    list.find((x) => x.name.toLowerCase() === q) ||
    list.find((x) => x.name.toLowerCase().includes(q)) ||
    null
  );
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/** Free start times for one stylist on one date. */
function freeSlots(ctx, stylist, service, date, now) {
  if (!stylist.days.has(dayIndex(date))) return [];
  if (stylist.start === null || stylist.end === null) return [];
  const busy = ctx.appointments.filter(
    (a) => a.staffId === stylist.id && a.date === date && a.status === 'booked' && a.start !== null,
  );
  const earliest = date === now.date ? now.minutes + CONFIG.minLeadMin : -1;
  const slots = [];
  for (let t = stylist.start; t + service.duration <= stylist.end; t += CONFIG.slotStepMin) {
    if (t < earliest) continue;
    const end = t + service.duration;
    if (busy.some((a) => overlaps(t, end, a.start, a.end ?? a.start + 30))) continue;
    slots.push(t);
  }
  return slots;
}

function candidateStaff(ctx, service, staffQuery) {
  let list = ctx.staff.filter((s) => s.active && s.services.includes(service.id));
  if (str(staffQuery) && !['any', 'anyone', 'cualquiera', 'none'].includes(str(staffQuery).toLowerCase())) {
    const wanted = findByIdOrName(list, staffQuery);
    if (!wanted) return { error: `No active stylist matching "${staffQuery}" performs ${service.name}.`, list: [] };
    list = [wanted];
  }
  return { list };
}

function validateDate(date, now) {
  if (!date || !isRealDate(date)) return 'Invalid date. Use the format YYYY-MM-DD.';
  if (date < now.date) return `That date is in the past (today is ${now.date}).`;
  if (diffDays(now.date, date) > CONFIG.maxDaysAhead) return `Bookings open only ${CONFIG.maxDaysAhead} days ahead (until ${addDays(now.date, CONFIG.maxDaysAhead)}).`;
  return null;
}

function findNextAvailable(ctx, service, staffList, fromDate, now) {
  for (let i = 1; i <= CONFIG.nextAvailableSearchDays; i++) {
    const d = addDays(fromDate, i);
    if (diffDays(now.date, d) > CONFIG.maxDaysAhead) break;
    for (const st of staffList) {
      const slots = freeSlots(ctx, st, service, d, now);
      if (slots.length) return { date: d, day: DAY_FULL[dayIndex(d)], staff_id: st.id, staff_name: st.name, first_slot: fmtTime(slots[0]) };
    }
  }
  return null;
}

const fail = (message, extra = {}) => ({ op: 'none', response: { ok: false, message, ...extra } });

// ------------------------------------------------------------------ actions --

function getServices(ctx) {
  const services = ctx.services.filter((s) => s.active).map((s) => ({
    service_id: s.id,
    name: s.name,
    category: s.category,
    duration_min: s.duration,
    price: money(s.price),
    stylists: ctx.staff.filter((st) => st.active && st.services.includes(s.id)).map((st) => `${st.name} (${st.id})`),
  }));
  const stylists = ctx.staff.filter((s) => s.active).map((s) => ({
    staff_id: s.id,
    name: s.name,
    works: `${s.daysLabel} ${fmtTime(s.start ?? 0)}-${fmtTime(s.end ?? 0)}`,
  }));
  return { op: 'none', response: { ok: true, services, stylists } };
}

function checkAvailability(ctx, input, now) {
  const service = findByIdOrName(ctx.services.filter((s) => s.active), input.service_id);
  if (!service) return fail(`Service "${str(input.service_id)}" not found. Call get_services to see valid IDs.`);
  const date = normDate(input.date);
  const dateError = validateDate(date, now);
  if (dateError) return fail(dateError);

  const { list, error } = candidateStaff(ctx, service, input.staff_id);
  if (error) return fail(error);

  const availability = list
    .map((st) => {
      const slots = freeSlots(ctx, st, service, date, now);
      return { staff_id: st.id, staff_name: st.name, slots: slots.slice(0, CONFIG.maxSlotsShown).map(fmtTime), total_free: slots.length };
    })
    .filter((a) => a.total_free > 0);

  const base = {
    service: `${service.name} (${service.id}) - ${service.duration} min - ${money(service.price)}`,
    date,
    day: DAY_FULL[dayIndex(date)],
  };
  if (availability.length) return { op: 'none', response: { ok: true, ...base, availability } };

  return {
    op: 'none',
    response: {
      ok: true,
      ...base,
      availability: [],
      message: 'No free slots on that date.',
      next_available: findNextAvailable(ctx, service, list, date, now),
    },
  };
}

function createAppointment(ctx, input, now) {
  const phone = str(input.phone);
  if (!phone) return fail('Missing customer phone (internal error).');

  const service = findByIdOrName(ctx.services.filter((s) => s.active), input.service_id);
  if (!service) return fail(`Service "${str(input.service_id)}" not found. Call get_services to see valid IDs.`);
  const date = normDate(input.date);
  const dateError = validateDate(date, now);
  if (dateError) return fail(dateError);
  const start = toMinutes(input.time);
  if (start === null) return fail('Invalid time. Use the 24h format HH:MM, e.g. 15:30.');

  const { list, error } = candidateStaff(ctx, service, input.staff_id);
  if (error) return fail(error);

  const end = start + service.duration;

  // Same customer, overlapping booked appointment -> refuse (prevents double booking by retries)
  const clash = ctx.appointments.find(
    (a) => a.phone === phone && a.date === date && a.status === 'booked' && overlaps(start, end, a.start, a.end ?? a.start + 30),
  );
  if (clash) {
    return fail(`The customer already has ${clash.serviceName} with ${clash.staffName} at ${fmtTime(clash.start)} that day (code ${clash.id}).`);
  }

  const stylist = list.find((st) => freeSlots(ctx, st, service, date, now).includes(start));
  if (!stylist) {
    const alternatives = list
      .map((st) => ({ staff_id: st.id, staff_name: st.name, slots: freeSlots(ctx, st, service, date, now).slice(0, 6).map(fmtTime) }))
      .filter((a) => a.slots.length);
    return fail(`${fmtTime(start)} is not available for ${service.name} on ${date}.`, {
      alternatives,
      next_available: alternatives.length ? null : findNextAvailable(ctx, service, list, date, now),
    });
  }

  const existing = ctx.clients.find((c) => str(c.phone) === phone);
  const clientName = str(input.client_name) || str(existing && existing.name) || str(input.profile_name) || 'Customer';
  const id = `APT-${date.replace(/-/g, '').slice(2)}-${randomCode()}`;

  const appointment_row = {
    appointment_id: id,
    phone,
    client_name: clientName,
    service_id: service.id,
    service_name: service.name,
    staff_id: stylist.id,
    staff_name: stylist.name,
    date,
    start_time: fmtTime(start),
    end_time: fmtTime(end),
    price: service.price,
    status: 'booked',
    channel: 'whatsapp',
    created_at: now.stamp,
    updated_at: now.stamp,
  };

  const client_row = {
    phone,
    name: clientName,
    created_at: str(existing && existing.created_at) || now.stamp,
    last_booking_at: now.stamp,
    total_bookings: (Number(existing && existing.total_bookings) || 0) + 1,
  };

  return {
    op: 'create',
    appointment_row,
    client_row,
    response: {
      ok: true,
      message: 'Appointment booked.',
      appointment: {
        code: id,
        service: service.name,
        stylist: stylist.name,
        date,
        day: DAY_FULL[dayIndex(date)],
        time: `${fmtTime(start)}-${fmtTime(end)}`,
        price: money(service.price),
        client_name: clientName,
      },
    },
  };
}

function listAppointments(ctx, input, now) {
  const phone = str(input.phone);
  const upcoming = ctx.appointments
    .filter((a) => a.phone === phone && a.status === 'booked' && a.date && (a.date > now.date || (a.date === now.date && a.start >= now.minutes)))
    .sort((a, b) => (a.date + fmtTime(a.start)).localeCompare(b.date + fmtTime(b.start)))
    .map((a) => ({
      code: a.id,
      service: a.serviceName,
      stylist: a.staffName,
      date: a.date,
      day: DAY_FULL[dayIndex(a.date)],
      time: `${fmtTime(a.start)}-${fmtTime(a.end ?? a.start)}`,
      price: money(a.price),
    }));
  return {
    op: 'none',
    response: { ok: true, appointments: upcoming, message: upcoming.length ? undefined : 'The customer has no upcoming appointments.' },
  };
}

function cancelAppointment(ctx, input, now) {
  const phone = str(input.phone);
  const code = str(input.appointment_id).toUpperCase();
  const appt = ctx.appointments.find((a) => a.id === code);

  // Same message whether it doesn't exist or belongs to someone else: no data leaks.
  if (!appt || appt.phone !== phone) return fail(`No appointment with code ${code} was found for this customer. Use list_my_appointments.`);
  if (appt.status !== 'booked') return fail(`Appointment ${code} is already ${appt.status}.`);

  const minutesUntil = diffDays(now.date, appt.date) * 1440 + (appt.start - now.minutes);
  if (minutesUntil < 0) return fail(`Appointment ${code} has already started or passed.`);
  if (minutesUntil < CONFIG.cancelMinHoursBefore * 60) {
    return fail(`Appointments can only be cancelled up to ${CONFIG.cancelMinHoursBefore} hours in advance. Ask the customer to call the salon.`);
  }

  return {
    op: 'cancel',
    update_row: { appointment_id: appt.id, status: 'cancelled', updated_at: now.stamp },
    response: {
      ok: true,
      message: 'Appointment cancelled.',
      cancelled: { code: appt.id, service: appt.serviceName, stylist: appt.staffName, date: appt.date, time: fmtTime(appt.start) },
    },
  };
}

// --------------------------------------------------------------- dispatcher --

function runBookingEngine(input, data, at = new Date()) {
  const now = nowInZone(CONFIG.timezone, at);
  const ctx = buildContext(data);
  const action = str(input.action);
  try {
    switch (action) {
      case 'get_services': return getServices(ctx);
      case 'check_availability': return checkAvailability(ctx, input, now);
      case 'create_appointment': return createAppointment(ctx, input, now);
      case 'list_my_appointments': return listAppointments(ctx, input, now);
      case 'cancel_appointment': return cancelAppointment(ctx, input, now);
      default: return fail(`Unknown action "${action}".`);
    }
  } catch (err) {
    return fail(`Internal error: ${err.message}`);
  }
}

// Export for Node tests; ignored inside the n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runBookingEngine, CONFIG, _internals: { normDate, toMinutes, parseWorkDays, nowInZone, addDays, fmtTime } };
}
