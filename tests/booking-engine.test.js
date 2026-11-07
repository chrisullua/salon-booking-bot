// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBookingEngine, _internals } = require('../src/booking-engine.js');

// Fixed "now": Thursday 2026-11-05 14:45 in Buenos Aires (UTC-3) = 17:45 UTC
const NOW = new Date('2026-11-05T17:45:00Z');
const PHONE = '5492231112233';

const data = () => ({
  services: [
    { service_id: 'S01', name: "Women's Haircut", category: 'Hair', duration_min: 45, price: 18000, active: 'TRUE' },
    { service_id: 'S02', name: "Men's Haircut", category: 'Hair', duration_min: 30, price: 12000, active: 'TRUE' },
    { service_id: 'S05', name: 'Balayage', category: 'Color', duration_min: 180, price: 85000, active: 'TRUE' },
    { service_id: 'S09', name: 'Retired Service', category: 'Hair', duration_min: 30, price: 1, active: 'FALSE' },
  ],
  staff: [
    { staff_id: 'ST01', name: 'Sofia Herrera', service_ids: 'S01,S05', work_days: 'Tue-Sat', start_time: '10:00', end_time: '19:00', active: 'TRUE' },
    { staff_id: 'ST02', name: 'Lucas Mendez', service_ids: 'S01,S02', work_days: 'Mon-Fri', start_time: '09:00', end_time: '18:00', active: 'TRUE' },
  ],
  appointments: [
    { appointment_id: 'APT-261110-AAAA', phone: '5492230000001', client_name: 'Martina', service_id: 'S01', service_name: "Women's Haircut", staff_id: 'ST01', staff_name: 'Sofia Herrera', date: '2026-11-10', start_time: '10:00', end_time: '10:45', price: 18000, status: 'booked' },
    { appointment_id: 'APT-261110-BBBB', phone: PHONE, client_name: 'Camila', service_id: 'S02', service_name: "Men's Haircut", staff_id: 'ST02', staff_name: 'Lucas Mendez', date: '2026-11-10', start_time: '16:00', end_time: '16:30', price: 12000, status: 'booked' },
    { appointment_id: 'APT-261105-CCCC', phone: PHONE, client_name: 'Camila', service_id: 'S02', service_name: "Men's Haircut", staff_id: 'ST02', staff_name: 'Lucas Mendez', date: '2026-11-05', start_time: '16:00', end_time: '16:30', price: 12000, status: 'booked' },
  ],
  clients: [{ phone: PHONE, name: 'Camila', created_at: '2026-10-01 10:00:00', last_booking_at: '2026-10-01 10:00:00', total_bookings: 2 }],
});

const run = (input) => runBookingEngine(input, data(), NOW);

test('helpers parse sheet formats', () => {
  assert.equal(_internals.normDate('10/11/2026'), '2026-11-10');
  assert.equal(_internals.normDate('2026-11-10'), '2026-11-10');
  assert.equal(_internals.normDate(46336), '2026-11-10'); // Sheets serial
  assert.equal(_internals.toMinutes('3:30 pm'), 930);
  assert.equal(_internals.toMinutes('09:00'), 540);
  assert.deepEqual([..._internals.parseWorkDays('Tue-Sat')].sort(), [2, 3, 4, 5, 6]);
  assert.deepEqual([..._internals.parseWorkDays('Fri-Mon')].sort(), [0, 1, 5, 6]);
  assert.equal(_internals.nowInZone(undefined, NOW).date, '2026-11-05');
  assert.equal(_internals.nowInZone(undefined, NOW).minutes, 14 * 60 + 45);
});

test('get_services lists only active services with their stylists', () => {
  const r = run({ action: 'get_services' });
  assert.equal(r.op, 'none');
  assert.equal(r.response.services.length, 3);
  assert.ok(r.response.services[0].stylists.includes('Sofia Herrera (ST01)'));
});

test('check_availability excludes booked slots and respects duration', () => {
  const r = run({ action: 'check_availability', service_id: 'S01', date: '2026-11-10', staff_id: 'ST01' });
  const slots = r.response.availability[0].slots;
  assert.ok(!slots.includes('10:00'), '10:00 is taken');
  assert.ok(!slots.includes('10:30'), '10:30 would overlap the 10:00-10:45 booking');
  assert.ok(!slots.includes('09:30'), 'before opening');
  assert.ok(slots.includes('11:00'));
  const total = r.response.availability[0].total_free;
  assert.equal(total, 15); // starts 10:00..18:00 every 30' = 17, minus 10:00 and 10:30
});

test('check_availability accepts service names and "any" stylist', () => {
  const r = run({ action: 'check_availability', service_id: 'haircut', date: '2026-11-10', staff_id: 'any' });
  assert.equal(r.response.ok, true);
  assert.equal(r.response.availability.length, 2);
});

test('today only offers slots at least 1 hour from now', () => {
  const r = run({ action: 'check_availability', service_id: 'S02', date: '2026-11-05' });
  const slots = r.response.availability[0].slots;
  assert.equal(slots[0], '16:30'); // 14:45 + 60' -> 15:45, so 16:00 would be next but it is booked
});

test('closed day suggests next available date', () => {
  const r = run({ action: 'check_availability', service_id: 'S05', date: '2026-11-09' }); // Monday, Sofia off
  assert.equal(r.response.availability.length, 0);
  assert.equal(r.response.next_available.date, '2026-11-10');
});

test('rejects past and too-far dates', () => {
  assert.equal(run({ action: 'check_availability', service_id: 'S01', date: '2026-11-01' }).response.ok, false);
  assert.equal(run({ action: 'check_availability', service_id: 'S01', date: '2027-01-30' }).response.ok, false);
  assert.equal(run({ action: 'check_availability', service_id: 'S01', date: '2026-02-30' }).response.ok, false);
});

test('create_appointment books a free slot and returns rows to write', () => {
  const r = run({ action: 'create_appointment', phone: PHONE, service_id: 'S01', date: '2026-11-11', time: '11:00', client_name: '' });
  assert.equal(r.op, 'create');
  assert.equal(r.appointment_row.status, 'booked');
  assert.equal(r.appointment_row.end_time, '11:45');
  assert.equal(r.appointment_row.client_name, 'Camila'); // falls back to the known client name
  assert.match(r.appointment_row.appointment_id, /^APT-261111-[A-Z2-9]{4}$/);
  assert.equal(r.client_row.total_bookings, 3);
  assert.equal(r.client_row.created_at, '2026-10-01 10:00:00');
});

test('create_appointment refuses a taken slot and offers alternatives', () => {
  const r = run({ action: 'create_appointment', phone: '5492239998877', service_id: 'S01', date: '2026-11-10', time: '10:00', staff_id: 'ST01' });
  assert.equal(r.op, 'none');
  assert.equal(r.response.ok, false);
  assert.ok(r.response.alternatives[0].slots.length > 0);
});

test('create_appointment refuses overlapping booking for the same customer', () => {
  const r = run({ action: 'create_appointment', phone: PHONE, service_id: 'S01', date: '2026-11-10', time: '16:00', staff_id: 'ST01' });
  assert.equal(r.response.ok, false);
  assert.match(r.response.message, /already has/);
});

test('list_my_appointments only returns this customer upcoming bookings', () => {
  const r = run({ action: 'list_my_appointments', phone: PHONE });
  assert.deepEqual(r.response.appointments.map((a) => a.code), ['APT-261105-CCCC', 'APT-261110-BBBB']);
});

test('cancel_appointment enforces ownership and the 2-hour rule', () => {
  assert.equal(run({ action: 'cancel_appointment', phone: PHONE, appointment_id: 'APT-261110-AAAA' }).response.ok, false, 'not theirs');
  assert.equal(run({ action: 'cancel_appointment', phone: PHONE, appointment_id: 'APT-261105-CCCC' }).response.ok, false, 'starts in 75 minutes');
  const ok = run({ action: 'cancel_appointment', phone: PHONE, appointment_id: 'apt-261110-bbbb' });
  assert.equal(ok.op, 'cancel');
  assert.deepEqual(ok.update_row, { appointment_id: 'APT-261110-BBBB', status: 'cancelled', updated_at: '2026-11-05 14:45:00' });
});

test('unknown action fails gracefully', () => {
  assert.equal(run({ action: 'drop_tables' }).response.ok, false);
});
