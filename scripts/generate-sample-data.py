"""Generates sheets/salon-booking-db-template.xlsx and sheets/csv/*.csv with fictional sample data.
Usage: pip install openpyxl && python scripts/generate-sample-data.py
"""
import csv, random, datetime as dt, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

random.seed(7)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sheets')

services = [
 ['S01',"Women's Haircut",'Hair',45,18000,'TRUE'],
 ['S02',"Men's Haircut",'Hair',30,12000,'TRUE'],
 ['S03','Blow-dry & Styling','Hair',30,10000,'TRUE'],
 ['S04','Root Color Touch-up','Color',90,35000,'TRUE'],
 ['S05','Balayage','Color',180,85000,'TRUE'],
 ['S06','Gel Manicure','Nails',60,15000,'TRUE'],
 ['S07','Spa Pedicure','Nails',60,16000,'TRUE'],
 ['S08','Brow Design','Brows',30,8000,'TRUE'],
]
staff = [
 ['ST01','Sofia Herrera','S01,S03,S04,S05','Tue-Sat','10:00','19:00','TRUE'],
 ['ST02','Lucas Mendez','S01,S02,S03','Mon-Fri','09:00','18:00','TRUE'],
 ['ST03','Valentina Rios','S06,S07,S08','Tue-Sat','09:00','17:00','TRUE'],
]
clients_base = [
 ['5492230000001','Martina Lopez'],['5492230000002','Julieta Gomez'],['5492230000003','Tomas Fernandez'],
 ['5492230000004','Camila Suarez'],['5492230000005','Agustina Diaz'],['5492230000006','Nicolas Romero'],
 ['5492230000007','Florencia Acosta'],['5492230000008','Mateo Silva'],['5492230000009','Lucia Benitez'],
 ['5492230000010','Carolina Molina'],['5492230000011','Paula Castro'],['5492230000012','Federico Ortiz'],
]
svc = {s[0]: s for s in services}
days = {'Mon':0,'Tue':1,'Wed':2,'Thu':3,'Fri':4,'Sat':5,'Sun':6}
def workdays(spec):
    a,b = spec.split('-'); return set(range(days[a], days[b]+1))
def mins(t): h,m = map(int,t.split(':')); return h*60+m
def fmt(m): return f'{m//60:02d}:{m%60:02d}'

busy = {}
appts = []
today = dt.date(2026,11,5)
start_day = dt.date(2026,10,1); end_day = dt.date(2026,11,14)
d = start_day; n = 0
while d <= end_day:
    for st in staff:
        if d.weekday() not in workdays(st[3]): continue
        per_day = random.randint(1,3) if d > today else random.randint(2,4)
        for _ in range(per_day):
            sid = random.choice(st[2].split(','))
            dur = svc[sid][3]
            for _try in range(20):
                s0 = random.randrange(mins(st[4]), mins(st[5]) - dur + 1, 30)
                e0 = s0 + dur
                key = (st[0], d)
                if any(s0 < b and a < e0 for a,b in busy.get(key, [])): continue
                busy.setdefault(key, []).append((s0,e0)); break
            else: continue
            c = random.choice(clients_base)
            if d < today:
                status = random.choices(['completed','no_show','cancelled'],[85,7,8])[0]
            elif d == today:
                status = 'completed' if s0 < 14*60 else 'booked'
            else:
                status = random.choices(['booked','cancelled'],[92,8])[0]
            n += 1
            code = ''.join(random.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(4))
            created = min(d - dt.timedelta(days=random.randint(1,10)), today - dt.timedelta(days=1))
            appts.append({
              'appointment_id': f'APT-{d.strftime("%y%m%d")}-{code}', 'phone': c[0], 'client_name': c[1],
              'service_id': sid, 'service_name': svc[sid][1], 'staff_id': st[0], 'staff_name': st[1],
              'date': d.isoformat(), 'start_time': fmt(s0), 'end_time': fmt(e0), 'price': svc[sid][4],
              'status': status, 'channel': random.choices(['whatsapp','phone','walk_in'],[70,20,10])[0],
              'created_at': f'{created.isoformat()} {random.randint(9,20):02d}:{random.choice(["05","17","32","48"])}:00',
              'updated_at': f'{created.isoformat()} {random.randint(9,20):02d}:{random.choice(["05","17","32","48"])}:00',
            })
    d += dt.timedelta(days=1)
appts.sort(key=lambda a: (a['date'], a['start_time'], a['staff_id']))

clients = []
for ph, name in clients_base:
    mine = [a for a in appts if a['phone']==ph]
    clients.append({'phone': ph, 'name': name,
        'created_at': min(a['created_at'] for a in mine) if mine else '2026-09-15 10:00:00',
        'last_booking_at': max(a['created_at'] for a in mine) if mine else '',
        'total_bookings': len(mine)})

tables = {
 'Services': (['service_id','name','category','duration_min','price','active'], [dict(zip(['service_id','name','category','duration_min','price','active'], s)) for s in services]),
 'Staff': (['staff_id','name','service_ids','work_days','start_time','end_time','active'], [dict(zip(['staff_id','name','service_ids','work_days','start_time','end_time','active'], s)) for s in staff]),
 'Clients': (['phone','name','created_at','last_booking_at','total_bookings'], clients),
 'Appointments': (list(appts[0].keys()), appts),
 'MessageLog': (['timestamp','phone','profile_name','message_type','incoming_text','bot_reply'], []),
}
NUMERIC = {'duration_min','price','total_bookings'}

wb = Workbook(); wb.remove(wb.active)
head_fill = PatternFill('solid', fgColor='1F2937')
for name,(cols,rows) in tables.items():
    ws = wb.create_sheet(name)
    ws.append(cols)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF'); c.fill = head_fill; c.alignment = Alignment(horizontal='center')
    for r in rows:
        ws.append([r[c] for c in cols])
    for i,col in enumerate(cols, start=1):
        letter = get_column_letter(i)
        width = max([len(col)] + [len(str(r[col])) for r in rows]) + 2
        ws.column_dimensions[letter].width = min(width, 40)
        if col not in NUMERIC:
            for cell in ws[letter][1:]:
                cell.number_format = '@'
    ws.freeze_panes = 'A2'
    with open(f'{ROOT}/csv/{name.lower()}.csv','w',newline='') as f:
        w = csv.writer(f); w.writerow(cols)
        for r in rows: w.writerow([r[c] for c in cols])
wb.save(f'{ROOT}/salon-booking-db-template.xlsx')
from collections import Counter
print(len(appts), Counter(a['status'] for a in appts))
print(clients[0])
