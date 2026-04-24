import { useState, useMemo, useCallback, useRef, useEffect } from "react";

// ═══ SUPABASE CONFIG ═════════════════════════════════════════
const SB_URL  = "https://tgcmlcymjdpjtoxzbuic.supabase.co";
const SB_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRnY21sY3ltamRwanRveHpidWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0OTI4NTEsImV4cCI6MjA5MjA2ODg1MX0.gTG0f8lAvbUb5WtvWxkzNkuBGEVBGJKRW4qSX-JYnbg";
const SB_HEADERS = {
  "Content-Type":  "application/json",
  "apikey":        SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Prefer":        "return=minimal",
};

async function sbSelect(table) {
  const noSort = table.startsWith("maintenance");
  const url = noSort
    ? `${SB_URL}/rest/v1/${table}?select=*`
    : `${SB_URL}/rest/v1/${table}?select=*&order=due_date.asc`;
  const res = await fetch(url, {
    headers: {...SB_HEADERS, "Prefer": ""},
  });
  if (!res.ok) throw new Error(`Supabase select failed: ${res.status}`);
  return res.json();
}

async function sbUpsert(table, rows) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase upsert failed: ${err}`);
  }
}

async function sbDeleteByYear(table, year) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  const res = await fetch(
    `${SB_URL}/rest/v1/${table}?due_date=gte.${from}&due_date=lte.${to}`,
    { method:"DELETE", headers:SB_HEADERS }
  );
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

async function sbUpdateNote(table, id, note) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: SB_HEADERS,
    body: JSON.stringify({ note }),
  });
  if (!res.ok) throw new Error(`Supabase update failed: ${res.status}`);
}

async function sbDelete(table, id) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE", headers: SB_HEADERS
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ═══ GOOGLE SHEET CSV URL ════════════════════════════════════
const SHEET_PRIVATE_URL   = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ4goylPDWkuT9W-lKqINnR75IKrW2k77oYhiF_Oe38G3xS-NLJTkXn7lsL-lZUhHjGizS3JQVAUGF7/pub?output=csv";
const SHEET_BRIEFHERE_URL = ""; // ใส่ URL Sheet งานเพจตรงนี้

// ── CSV parser — รองรับ quoted multiline fields ─────────────
function parseCSV(text) {
  // normalize line endings
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // tokenize: split into fields handling quoted multiline cells
  function tokenize(str) {
    const rows = [];
    let cur = [], field = "", inQ = false, i = 0;
    while (i < str.length) {
      const c = str[i];
      if (inQ) {
        if (c === '"') {
          if (str[i+1] === '"') { field += '"'; i += 2; continue; } // escaped quote
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { cur.push(field.trim()); field = ""; i++; continue; }
      if (c === '\n') {
        cur.push(field.trim()); field = "";
        rows.push(cur); cur = [];
        i++; continue;
      }
      field += c; i++;
    }
    if (field || cur.length) { cur.push(field.trim()); rows.push(cur); }
    return rows;
  }

  const rows = tokenize(raw);
  if (rows.length < 2) return [];

  // skip header (row 0), process data rows
  return rows.slice(1).map((cols, i) => {
    // A=0(ลำดับ) B=1(Status) C=2(Task/Client) D=3(Detail)
    // E=4(PM) F=5(Company) G=6(Start) H=7(End) I=8(Dur)
    // J=9(PayDate) K=10(BillDate) L=11(Total) M=12(Vat) N=13(GrandTotal) O=14(Notice)
    const client  = (cols[2]||"").replace(/\n/g," ").trim();
    const title   = (cols[3]||"").trim();
    const gross   = parseNum(cols[11]);
    const status  = mapStatus((cols[1]||"").trim());

    // skip legend rows and empty rows at bottom
    if (!client && !title && gross === 0) return null;
    if (!cols[0] && !client) return null; // legend rows like "Finish / Paid,,,,..."

    return {
      id:        `csv-${i}`,
      client,
      title,
      gross,
      status,
      start_date: parseDate((cols[6]||"").trim()),
      due_date:   parseDate((cols[7]||"").trim()),
      pay_date:   parseDate((cols[9]||"").trim()),
      bill_date:  parseDate((cols[10]||"").trim()),
      vat:        parseNum(cols[12]),
      grand_total: parseNum(cols[13]),
      pm:         (cols[4]||"").trim(),
      company:    (cols[5]||"").trim(),
      notice:     (cols[14]||"").replace(/\n/g," ").trim(),
      note:       "",
      _fromSheet: true,
    };
  }).filter(Boolean);
}

function mapStatus(raw) {
  const s = raw.toLowerCase().replace(/\s/g,"");
  if (s.includes("cancel"))           return "Cancel";
  if (s.includes("hold"))             return "Hold";
  if (s.includes("paid"))             return "Done";          // Finish/Paid → Done
  if (s.includes("finish"))           return "Finish/Wait";   // Finish/Wait → รอรับ
  if (s.includes("wait"))             return "Finish/Wait";
  if (s.includes("wip"))              return "WIP";
  return "WIP";
}

function parseNum(s) {
  if (!s || s==="-") return 0;
  return parseFloat(String(s).replace(/[^0-9.-]/g,"")) || 0;
}

function parseDate(s) {
  if (!s || s==="-" || s==="") return "";
  s = s.trim();

  // format: dd/mm/yyyy หรือ d/m/yyyy
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) {
    const [d,m,y] = s.split("/");
    const year = y.length===2 ? "20"+y : y;
    return `${year}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  // format: dd-Mon-yyyy เช่น 30-Jan-2026
  const MON = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
               jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
  const m2 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m2) {
    const [,d,mon,y] = m2;
    const mm = MON[mon.toLowerCase()];
    if (mm) return `${y}-${mm}-${d.padStart(2,"0")}`;
  }

  // format: yyyy-mm-dd (already correct)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  return s;
}

// ═══ MOCK DB ════════════════════════════════════════════════
let _private = [];

let _briefhere = [];

let _maintenance = [
  { id: "m1",  type:"home", car:"",               item:"ล้างแอร์ห้องนอน",       last_date:"2025-10-01", next_date:"2026-04-01", interval_label:"6 เดือน", note: "" },
  { id: "m2",  type:"home", car:"",               item:"ล้างแอร์ห้องนั่งเล่น",  last_date:"2025-11-15", next_date:"2026-05-15", interval_label:"6 เดือน", note: "" },
  { id: "m3",  type:"home", car:"",               item:"เปลี่ยนไส้กรองน้ำ",     last_date:"2026-01-10", next_date:"2026-07-10", interval_label:"6 เดือน", note: "" },
  { id: "m4",  type:"home", car:"",               item:"ตรวจระบบไฟฟ้า",         last_date:"2025-06-01", next_date:"2026-06-01", interval_label:"1 ปี",    note: "" },
  { id: "m5",  type:"car",  car:"BYD Sealion 7",  item:"เปลี่ยนน้ำมันเบรก",    last_date:"2025-09-01", next_date:"2026-03-01", interval_label:"6 เดือน", note: "นัด 25 มี.ค." },
  { id: "m6",  type:"car",  car:"BYD Sealion 7",  item:"ตรวจระบบแบตเตอรี่",    last_date:"2026-01-15", next_date:"2026-07-15", interval_label:"6 เดือน", note: "" },
  { id: "m7",  type:"car",  car:"BYD Seal",       item:"เปลี่ยนยาง",            last_date:"2024-06-01", next_date:"2026-06-01", interval_label:"2 ปี",    note: "" },
  { id: "m8",  type:"car",  car:"BYD Seal",       item:"ล้างรถ / Detailing",    last_date:"2026-03-01", next_date:"2026-06-01", interval_label:"3 เดือน", note: "" },
  { id: "m9",  type:"car",  car:"Honda City 2017", item:"เปลี่ยนน้ำมันเครื่อง", last_date:"2026-02-01", next_date:"2026-05-01", interval_label:"3 เดือน", note: "" },
  { id: "m10", type:"car",  car:"Honda City 2017", item:"ตรวจเบรก",              last_date:"2025-12-01", next_date:"2026-04-10", interval_label:"10,000 km", note: "" },
];

const uid = () => Math.random().toString(36).slice(2, 9);

const db = {
  private: {
    list:   ()      => [..._private],
    insert: (row)   => { const r = {...row, id: uid()}; _private = [..._private, r]; return r; },
    update: (id, d) => { _private = _private.map(r => r.id===id ? {...r,...d} : r); },
    delete: (id)    => { _private = _private.filter(r => r.id!==id); },
  },
  briefhere: {
    list:   ()      => [..._briefhere],
    insert: (row)   => { const r = {...row, id: uid()}; _briefhere = [..._briefhere, r]; return r; },
    update: (id, d) => { _briefhere = _briefhere.map(r => r.id===id ? {...r,...d} : r); },
    delete: (id)    => { _briefhere = _briefhere.filter(r => r.id!==id); },
  },
  maintenance: {
    list:   ()      => [..._maintenance],
    insert: (row)   => { const r = {...row, id: uid()}; _maintenance = [..._maintenance, r]; return r; },
    update: (id, d) => { _maintenance = _maintenance.map(r => r.id===id ? {...r,...d} : r); },
    delete: (id)    => { _maintenance = _maintenance.filter(r => r.id!==id); },
  },
};

// ═══ CONSTANTS ══════════════════════════════════════════════
const RATE_CARD = [
  // Social Content
  { category:"Social Content", service:"Design direction for social",                         unit:"ชิ้น",  basePrice:1000  },
  { category:"Social Content", service:"Design 1 Image (Resize, Adapt)",                      unit:"ชิ้น",  basePrice:1000  },
  { category:"Social Content", service:"Design 1 Image (No key visual or resource)",          unit:"ชิ้น",  basePrice:3000  },
  { category:"Social Content", service:"Design 1 Album",                                      unit:"ชุด",   basePrice:8000  },
  { category:"Social Content", service:"Animate Motion 1–15 sec",                             unit:"ชิ้น",  basePrice:8000  },
  { category:"Social Content", service:"Animate Motion 1–30 sec (No key visual or resource)", unit:"ชิ้น",  basePrice:20000 },
  { category:"Social Content", service:"Animate Motion Resize",                               unit:"ชิ้น",  basePrice:0, note:"หารครึ่งจากต้นฉบับ" },
  // Interactive
  { category:"Interactive",    service:"Design direction + UX design (2 Master 6 Page)",      unit:"Package",basePrice:20000 },
  { category:"Interactive",    service:"Design Master page",                                   unit:"หน้า",  basePrice:3000  },
  { category:"Interactive",    service:"Design Page, Resize",                                  unit:"หน้า",  basePrice:1000  },
  { category:"Interactive",    service:"UX Wireframe 1 Page",                                  unit:"หน้า",  basePrice:1000  },
  // Graphic
  { category:"Graphic",        service:"Design direction",                                     unit:"งาน",   basePrice:3000  },
  { category:"Graphic",        service:"Design 1 Layout (Poster, Flag, Vinyl banner etc.)",    unit:"ชิ้น",  basePrice:1000  },
  { category:"Graphic",        service:"Design 1 Layout (No key visual or resource)",          unit:"ชิ้น",  basePrice:3000  },
  { category:"Graphic",        service:"Animated Sticker set of 6",                            unit:"ชุด",   basePrice:12000 },
  { category:"Graphic",        service:"Design Conceptboard",                                  unit:"ชิ้น",  basePrice:5000  },
  { category:"Graphic",        service:"Card design (Business Card etc.)",                     unit:"ชิ้น",  basePrice:5000  },
  { category:"Graphic",        service:"Brochure 1–3 Pages",                                   unit:"ชุด",   basePrice:5000  },
  { category:"Graphic",        service:"Brochure 3–6 Pages",                                   unit:"ชุด",   basePrice:10000 },
  { category:"Graphic",        service:"Campaign Logo Design",                                 unit:"งาน",   basePrice:2000  },
  { category:"Graphic",        service:"Logo Design",                                          unit:"งาน",   basePrice:10000 },
  { category:"Graphic",        service:"Corporate Identity",                                   unit:"Package",basePrice:15000, note:"ขึ้นไปตาม requirement" },
  // Motion Graphic
  { category:"Motion Graphic", service:"Design direction + Storyboard",                       unit:"งาน",   basePrice:8000  },
  { category:"Motion Graphic", service:"Resize Animate Motion <30 sec",                       unit:"ชิ้น",  basePrice:5000  },
  { category:"Motion Graphic", service:"Animate Motion 30–59 sec",                            unit:"ชิ้น",  basePrice:10000 },
  { category:"Motion Graphic", service:"Animate Motion 30–59 sec (No key visual or resource)",unit:"ชิ้น",  basePrice:30000 },
  { category:"Motion Graphic", service:"Animate Motion 1–1.30 min",                           unit:"ชิ้น",  basePrice:15000 },
  { category:"Motion Graphic", service:"Animate Motion 1–1.30 min (No key visual or resource)",unit:"ชิ้น", basePrice:45000 },
  { category:"Motion Graphic", service:"Hourly Rate",                                          unit:"ชั่วโมง",basePrice:1500  },
];
const GOAL_BY_YEAR = { 2022: 600000, 2023: 700000, 2024: 800000, 2025: 1000000, 2026: 1200000 };
const GOAL = GOAL_BY_YEAR[new Date().getFullYear()] || 1200000;
const THIS_YEAR = new Date().getFullYear();

const STATUS_OPTS = ["WIP", "Finish/Wait", "Done"];
const CAR_OPTS    = ["BYD Sealion 7", "BYD Seal", "Honda City 2017"];
const MONTHS_TH   = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

const NAV_GROUPS = [
  {
    group: "ภาพรวม",
    items: [
      { id:"overview",  icon:"⬡", label:"Overview"   },
      { id:"summary",   icon:"◫", label:"สรุปทุกปี"  },
    ]
  },
  {
    group: "รายได้ & รายรับ",
    items: [
      { id:"private",   icon:"◈", label:"งานนอก"     },
      { id:"briefhere", icon:"◉", label:"งานเพจ"     },
      { id:"quotation", icon:"⊞", label:"คำนวณราคา" },
    ]
  },
  {
    group: "Maintenance",
    items: [
      { id:"maint-home", icon:"🏠", label:"บ้าน"       },
      { id:"maint-car",  icon:"🚗", label:"รถยนต์"    },
    ]
  },
];
// flat list for convenience
const NAV = NAV_GROUPS.flatMap(g=>g.items);

// ═══ HELPERS ════════════════════════════════════════════════
const today = new Date(); today.setHours(0,0,0,0);
const diffDays  = (s) => Math.ceil((new Date(s) - today) / 86400000);
const money     = (n) => "฿" + new Intl.NumberFormat("th-TH").format(Math.round(n||0));
const moneyK    = (n) => n>=1000 ? `${Math.round(n/1000)}K` : `${Math.round(n)}`;
const fmtDate   = (s) => { if (!s) return "—"; const d = new Date(s); return `${d.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]} ${d.getFullYear()}`; };
const getYear   = (s) => s ? new Date(s).getFullYear() : null;

function calcYear(year) {
  const priv = _private.filter(r => getYear(r.pay_date||r.due_date)===year && r.status!=="Cancel");
  const bh   = _briefhere.filter(r => getYear(r.pay_date||r.due_date)===year && r.status!=="Cancel");
  const privNet  = priv.reduce((a,r)=>a+r.gross*0.97, 0);
  const bhNet    = bh.reduce((a,r)=>a+(r.grand_total||r.gross*0.97)/2, 0);
  const total    = privNet + bhNet;
  const goal     = GOAL_BY_YEAR[year] || 1200000;
  const prog     = Math.min((total/goal)*100, 100);
  const wipN     = [..._private,..._briefhere].filter(r=>getYear(r.pay_date||r.due_date)===year && r.status==="WIP").length;
  const waitN    = [..._private,..._briefhere].filter(r=>getYear(r.pay_date||r.due_date)===year && r.status==="Finish/Wait").length;
  return { privNet, bhShare: bhNet, total, goal, prog, wipN, waitN };
}

function getAllYears() {
  // ดึงปีจากข้อมูลจริง + GOAL_BY_YEAR เรียงจากมากไปน้อย
  const fromData = new Set([..._private,..._briefhere].map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean));
  const fromGoal = new Set(Object.keys(GOAL_BY_YEAR).map(Number));
  return [...new Set([...fromData,...fromGoal])].sort((a,b)=>b-a);
}

function maintStatus(d) {
  if (!d || d==="-" || d==="") return { label:"ไม่มีกำหนด", t:"none" };
  const n = diffDays(d);
  if (n < 0)   return { label:"เลยกำหนด",    t:"overdue" };
  if (n <= 30) return { label:`อีก ${n} วัน`, t:"warn"    };
  return               { label:`อีก ${n} วัน`, t:"ok"      };
}
function statusVariant(s) {
  if (s==="Done")         return "done";
  if (s==="WIP")          return "wip";
  if (s==="Finish/Wait")  return "wait";
  if (s==="Cancel" || s?.startsWith("Cancel")) return "cancel";
  if (s==="Hold")         return "hold";
  return "wip";
}

// ═══ SHARED UI ══════════════════════════════════════════════
function Chip({ label, variant }) {
  return <span className={`chip chip-${variant}`}>{label}</span>;
}

function PageHeader({ title, sub, action }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        <div className="page-sub">{sub}</div>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

function SecTitle({ children }) {
  return <div className="sec-title">{children}</div>;
}

// ═══ MODAL ══════════════════════════════════════════════════
function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function ConfirmModal({ msg, onOk, onCancel }) {
  return (
    <Modal title="ยืนยันการลบ" onClose={onCancel}>
      <p style={{color:"var(--muted)",fontSize:14,marginBottom:20}}>{msg}</p>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button className="btn-danger" onClick={onOk}>ลบ</button>
      </div>
    </Modal>
  );
}

// ═══ FORMS ══════════════════════════════════════════════════
function Field({ label, children }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

function ProjectForm({ initial, onSave, onClose, isBH }) {
  const blank = { client:"", title:"", gross:"", expense:"", status:"WIP", due_date:"", note:"" };
  const [f, setF] = useState(initial ? {...initial} : blank);
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const valid = f.client && f.title && f.gross;
  return (
    <>
      <Field label="Client"><input className="inp" value={f.client} onChange={e=>set("client",e.target.value)} placeholder="ชื่อ Client"/></Field>
      <Field label="ชื่องาน"><input className="inp" value={f.title}  onChange={e=>set("title",e.target.value)}  placeholder="ชื่อโปรเจกต์"/></Field>
      <Field label="Gross (฿)"><input className="inp" type="number" value={f.gross} onChange={e=>set("gross",e.target.value)} placeholder="0"/></Field>
      {isBH && <Field label="ค่าใช้จ่าย (฿)"><input className="inp" type="number" value={f.expense} onChange={e=>set("expense",e.target.value)} placeholder="0"/></Field>}
      <Field label="Status">
        <select className="inp" value={f.status} onChange={e=>set("status",e.target.value)}>
          {STATUS_OPTS.map(s=><option key={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="Due Date"><input className="inp" type="date" value={f.due_date} onChange={e=>set("due_date",e.target.value)}/></Field>
      <Field label="Note">
        <textarea className="inp" rows={3} value={f.note||""} onChange={e=>set("note",e.target.value)}
          placeholder="พิมพ์ note ที่นี่..." style={{resize:"vertical",lineHeight:1.6}}/>
      </Field>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn-primary" disabled={!valid}
          onClick={()=>onSave({...f, gross:+f.gross, expense:+(f.expense||0)})}>บันทึก</button>
      </div>
    </>
  );
}

function MaintForm({ initial, onSave, onClose }) {
  const blank = { type:"home", car:"", item:"", last_date:"", next_date:"", interval_label:"", note:"" };
  const [f, setF] = useState(initial ? {...initial} : blank);
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const valid = f.item && f.next_date;
  return (
    <>
      <Field label="ประเภท">
        <select className="inp" value={f.type} onChange={e=>set("type",e.target.value)}>
          <option value="home">🏠 บ้าน</option>
          <option value="car">🚗 รถ</option>
        </select>
      </Field>
      {f.type==="car" && (
        <Field label="รถ">
          <select className="inp" value={f.car} onChange={e=>set("car",e.target.value)}>
            <option value="">— เลือกรถ —</option>
            {CAR_OPTS.map(c=><option key={c}>{c}</option>)}
          </select>
        </Field>
      )}
      <Field label="รายการ"><input className="inp" value={f.item} onChange={e=>set("item",e.target.value)} placeholder="เช่น ล้างแอร์"/></Field>
      <Field label="ครั้งล่าสุด"><input className="inp" type="date" value={f.last_date} onChange={e=>set("last_date",e.target.value)}/></Field>
      <Field label="กำหนดถัดไป"><input className="inp" type="date" value={f.next_date} onChange={e=>set("next_date",e.target.value)}/></Field>
      <Field label="Interval"><input className="inp" value={f.interval_label} onChange={e=>set("interval_label",e.target.value)} placeholder="เช่น 6 เดือน"/></Field>
      <Field label="Note">
        <textarea className="inp" rows={3} value={f.note||""} onChange={e=>set("note",e.target.value)}
          placeholder="เช่น นัดช่าง / สิ่งที่ต้องจำ..." style={{resize:"vertical",lineHeight:1.6}}/>
      </Field>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn-primary" disabled={!valid} onClick={()=>onSave(f)}>บันทึก</button>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════════════════

function Overview({ setPage, tick, privateSbData, briefhereSbData }) {
  const privData = privateSbData?.length ? privateSbData : _private;
  const bhData   = briefhereSbData?.length ? briefhereSbData : _briefhere;

  const customGoals = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("pa_goals")||"{}"); } catch{ return {}; }
  }, []);
  const getGoal = (y) => customGoals[y] || GOAL_BY_YEAR[y] || 1200000;

  function calcYearFrom(year, priv, bh) {
    const p = priv.filter(r => getYear(r.pay_date||r.due_date)===year && r.status!=="Cancel");
    const b = bh.filter(r => getYear(r.pay_date||r.due_date)===year && r.status!=="Cancel");
    const privNet = p.reduce((a,r)=>a+r.gross*0.97, 0);
    const bhNet   = b.reduce((a,r)=>a+(r.grand_total||r.gross*0.97)/2, 0);
    const total   = privNet + bhNet;
    const goal    = getGoal(year);
    const prog    = Math.min((total/goal)*100, 100);
    const wipN    = [...priv,...bh].filter(r=>getYear(r.pay_date||r.due_date)===year && r.status==="WIP").length;
    const waitN   = [...priv,...bh].filter(r=>getYear(r.pay_date||r.due_date)===year && r.status==="Finish/Wait").length;
    return { privNet, bhShare:bhNet, total, goal, prog, wipN, waitN };
  }

  const allDataYears = new Set([...privData,...bhData].map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean));
  const allGoalYears = new Set(Object.keys(GOAL_BY_YEAR).map(Number));
  // รวมทุกปีที่มีข้อมูล ไม่จำกัดแค่ GOAL_BY_YEAR
  const allYears = [...new Set([...allDataYears,...allGoalYears])].sort((a,b)=>b-a);
  const [selYear, setSelYear] = useState(THIS_YEAR);
  const maint = db.maintenance.list();

  const d = calcYearFrom(selYear, privData, bhData);
  const priv = privData.filter(r=>getYear(r.pay_date||r.due_date)===selYear);
  const bh   = bhData.filter(r=>getYear(r.pay_date||r.due_date)===selYear);
  const debtTotal = priv.filter(p=>p.status==="Finish/Wait").reduce((a,p)=>a+p.gross*0.97,0)
                  + bh.filter(p=>p.status==="Finish/Wait").reduce((a,p)=>a+(p.grand_total||0)/2,0);

  const cards = [
    { label:"งานนอก (Private)",  value:money(d.privNet),   sub:"Net หัก 3%",                  icon:"◈", page:"private"     },
    { label:"งานเพจ (BriefHere)",value:money(d.bhShare),   sub:"ส่วนตัว 50%",                 icon:"◉", page:"briefhere"   },
    { label:"รวมส่วนตัว",        value:money(d.total),     sub:`${d.prog.toFixed(1)}% ของเป้า`,icon:"◇", page:"income",accent:true },
    { label:"รอรับเงิน",         value:money(debtTotal),   sub:`${d.waitN} รายการ`,            icon:"⏳", page:"income"      },
    { label:"WIP",               value:`${d.wipN} งาน`,    sub:"อยู่ระหว่างดำเนินการ",         icon:"◌", page:"private"     },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-sub">สรุปรายได้และงาน — เลือกปีย้อนหลังได้</div>
        </div>
        {/* Year selector */}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {allYears.map(y=>(
            <button key={y}
              className={`yr-sel-btn${selYear===y?" yr-sel-active":""}`}
              onClick={()=>setSelYear(y)}>{y}</button>
          ))}
        </div>
      </div>

      <div className="ov-grid">
        {cards.map(c=>(
          <button key={c.label} className={`ov-card${c.accent?" ov-accent":""}${c.warn?" ov-warn":""}`}
            onClick={()=>setPage(c.page)}>
            <div className="ovc-icon">{c.icon}</div>
            <div className="ovc-label">{c.label}</div>
            <div className="ovc-val">{c.value}</div>
            <div className="ovc-sub">{c.sub}</div>
            <span className="ovc-arrow">→</span>
          </button>
        ))}
      </div>

      <SecTitle>Progress เป้าหมาย {selYear}</SecTitle>
      <div className="prog-card">
        <div className="prog-rows">
          <div className="prog-row"><span>งานนอก Net</span><span className="mono">{money(d.privNet)}</span></div>
          <div className="prog-row"><span>งานเพจ 50%</span><span className="mono">{money(d.bhShare)}</span></div>
          <hr className="prog-hr"/>
          <div className="prog-row prog-total"><span>รวม</span><span className="mono accent">{money(d.total)}</span></div>
        </div>
        <div className="prog-bar-row">
          <div className="prog-bar"><div className="prog-fill" style={{width:`${d.prog}%`}}/></div>
          <span className="prog-pct">{d.prog.toFixed(1)}%</span>
        </div>
        <div className="prog-goal">เป้า {money(d.goal)} · ขาดอีก {money(Math.max(0,d.goal-d.total))}</div>
      </div>

      <SecTitle>ไปยังส่วนต่าง ๆ</SecTitle>
      <div className="ql-row">
        {NAV.filter(n=>n.id!=="overview").map(n=>(
          <button key={n.id} className="ql-btn" onClick={()=>setPage(n.id)}>
            <span>{n.icon}</span><span>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── SUMMARY PAGE — กราฟรายได้ทุกปี ─────────────────────────
function SvgBarChart({ years, data }) {
  const maxVal = Math.max(...data.map(d=>d.total), 1);
  const W = 560, H = 200, barW = Math.min(60, (W-40)/years.length - 12);
  const gap = (W-40) / years.length;

  return (
    <svg viewBox={`0 0 ${W} ${H+40}`} style={{width:"100%",height:"auto"}}>
      {[0,0.25,0.5,0.75,1].map((p,i)=>(
        <g key={i}>
          <line x1="36" y1={H-p*H} x2={W-4} y2={H-p*H} stroke="var(--bdr)" strokeWidth="1" strokeDasharray={p===0?"none":"4,3"}/>
          <text x="32" y={H-p*H+4} fill="var(--muted)" fontSize="9" textAnchor="end" fontFamily="monospace">{moneyK(maxVal*p)}</text>
        </g>
      ))}
      {years.map((y,i)=>{
        const d = data[i];
        const x = 40 + i*gap + gap/2 - barW/2;
        const pH = (d.privNet/maxVal)*H;
        const bH = (d.bhShare/maxVal)*H;
        const isThis = y===THIS_YEAR;
        return (
          <g key={y}>
            {/* BriefHere bar (bottom) */}
            <rect x={x} y={H-bH} width={barW} height={bH} rx="4"
              fill="var(--acc2)" opacity={isThis?1:0.7}/>
            {/* Private bar (top) */}
            <rect x={x} y={H-bH-pH} width={barW} height={pH} rx="4"
              fill="var(--accent)" opacity={isThis?1:0.7}/>
            {/* total label — แสดงเสมอแม้ total = 0 */}
            <text x={x+barW/2} y={d.total>0 ? H-bH-pH-5 : H-8} fill={d.total>0?"var(--txt)":"var(--muted)"} fontSize="9" textAnchor="middle" fontFamily="monospace" fontWeight={isThis?"bold":"normal"}>
              {d.total>0 ? moneyK(d.total) : "฿0"}
            </text>
            {/* year label */}
            <text x={x+barW/2} y={H+16} fill={isThis?"var(--accent)":"var(--muted)"} fontSize="11" textAnchor="middle" fontFamily="monospace" fontWeight={isThis?"bold":"normal"}>
              {y}
            </text>
          </g>
        );
      })}
      {/* legend */}
      <rect x="40" y={H+42} width="10" height="7" fill="var(--accent)" rx="2"/>
      <text x="54" y={H+49} fill="var(--muted)" fontSize="9" fontFamily="monospace">งานนอก</text>
      <rect x="110" y={H+42} width="10" height="7" fill="var(--acc2)" rx="2"/>
      <text x="124" y={H+49} fill="var(--muted)" fontSize="9" fontFamily="monospace">งานเพจ</text>
    </svg>
  );
}

function SummaryPage({ setPage, privateSbData, briefhereSbData }) {
  const privData = privateSbData?.length ? privateSbData : _private;
  const bhData   = briefhereSbData?.length ? briefhereSbData : _briefhere;

  function calcYearFrom(year) {
    const p = privData.filter(r => getYear(r.pay_date||r.due_date)===year && r.status!=="Cancel");
    const b = bhData.filter(r => getYear(r.pay_date||r.due_date)===year && r.status!=="Cancel");
    const privNet = p.reduce((a,r)=>a+r.gross*0.97, 0);
    const bhNet   = b.reduce((a,r)=>a+(r.grand_total||r.gross*0.97)/2, 0);
    const total   = privNet + bhNet;
    const goal    = GOAL_BY_YEAR[year] || 1200000;
    const prog    = Math.min((total/goal)*100, 100);
    return { privNet, bhShare:bhNet, total, goal, prog };
  }

  const dataYears = new Set([...privData,...bhData].map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean));
  const goalYears = new Set(Object.keys(GOAL_BY_YEAR).map(Number));
  const allYears = [...new Set([...dataYears,...goalYears])].sort((a,b)=>b-a);
  const data = allYears.map(y => calcYearFrom(y));
  const best = data.reduce((a,d,i)=>d.total>a.val?{val:d.total,year:allYears[i]}:a,{val:0,year:0});

  // Editable goals — เก็บใน state (persist ด้วย localStorage ถ้ามี)
  const [customGoals, setCustomGoals] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pa_goals")||"{}"); } catch{ return {}; }
  });
  const [editGoal, setEditGoal] = useState(null); // {year, val}

  const saveGoal = () => {
    if (!editGoal) return;
    const updated = {...customGoals, [editGoal.year]: +editGoal.val};
    setCustomGoals(updated);
    try { localStorage.setItem("pa_goals", JSON.stringify(updated)); } catch{}
    setEditGoal(null);
  };

  const getGoal = (y) => customGoals[y] || GOAL_BY_YEAR[y] || 1200000;

  const getCount = (y) =>
    privData.filter(r=>getYear(r.pay_date||r.due_date)===y).length
    + bhData.filter(r=>getYear(r.pay_date||r.due_date)===y).length;

  // recalc with custom goals
  const calcWithGoal = (y) => {
    const d = calcYearFrom(y);
    const goal = getGoal(y);
    return {...d, goal, prog: Math.min((d.total/goal)*100,100)};
  };

  return (
    <div className="page">
      <PageHeader title="สรุปรายได้ทุกปี" sub="เปรียบเทียบรายได้ทุกปีที่ผ่านมา"/>

      {/* Year summary cards — ปีล่าสุดอยู่ซ้าย */}
      <div style={{display:"flex",flexWrap:"wrap",gap:14,marginBottom:28}}>
        {allYears.map((y)=>{
          const d = calcWithGoal(y);
          const isThis = y===THIS_YEAR;
          const cnt = getCount(y);
          return (
            <div key={y} className={`prog-card${isThis?" prog-card-accent":""}`} style={{margin:0,minWidth:200,flex:"1 1 200px",maxWidth:280}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <span style={{fontSize:20,fontWeight:800,fontFamily:"monospace",color:isThis?"var(--accent)":"var(--txt)"}}>{y}</span>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {isThis && <span style={{fontSize:10,background:"var(--accent)",color:"#fff",padding:"2px 8px",borderRadius:99,fontWeight:700}}>ปัจจุบัน</span>}
                  {y===best.year && !isThis && <span style={{fontSize:10,background:"var(--acc2)",color:"#fff",padding:"2px 8px",borderRadius:99,fontWeight:700}}>สูงสุด</span>}
                </div>
              </div>
              <div style={{fontSize:22,fontWeight:800,fontFamily:"monospace",color:"var(--accent)",marginBottom:4}}>{money(d.total)}</div>

              {/* Editable goal */}
              {editGoal?.year===y ? (
                <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center"}}>
                  <input type="number" value={editGoal.val}
                    onChange={e=>setEditGoal({...editGoal,val:e.target.value})}
                    onKeyDown={e=>e.key==="Enter"&&saveGoal()}
                    style={{width:120,padding:"3px 8px",borderRadius:6,border:"1px solid var(--accent)",
                      background:"var(--sur2)",color:"var(--txt)",fontSize:12,fontFamily:"monospace"}}
                    autoFocus/>
                  <button onClick={saveGoal} style={{fontSize:11,padding:"3px 10px",borderRadius:6,border:"none",background:"var(--accent)",color:"#fff",cursor:"pointer"}}>✓</button>
                  <button onClick={()=>setEditGoal(null)} style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--bdr)",background:"transparent",color:"var(--muted)",cursor:"pointer"}}>✕</button>
                </div>
              ) : (
                <div style={{fontSize:11,color:"var(--muted)",marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
                  เป้า {money(d.goal)}
                  <button onClick={()=>setEditGoal({year:y,val:d.goal})}
                    style={{fontSize:10,padding:"1px 6px",borderRadius:5,border:"1px solid var(--bdr)",background:"transparent",color:"var(--muted)",cursor:"pointer"}}>✎</button>
                </div>
              )}

              <div className="prog-bar"><div className="prog-fill" style={{width:`${d.prog}%`}}/></div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:11,color:"var(--muted)"}}>
                <span>{d.prog.toFixed(1)}%</span>

                <span>{cnt} งาน</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bar chart */}
      <SecTitle>กราฟเปรียบเทียบรายได้รายปี</SecTitle>
      <div className="prog-card" style={{padding:24}}>
        <SvgBarChart years={allYears} data={allYears.map(y=>calcWithGoal(y))}/>
      </div>

      {/* Table comparison */}
      <SecTitle>ตารางเปรียบเทียบ</SecTitle>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr>
            <th>ปี</th><th className="r">งานนอก Net</th><th className="r">งานเพจ</th>
            <th className="r">รวม</th><th className="r">เป้าหมาย</th><th className="r">%</th><th>จำนวนงาน</th>
          </tr></thead>
          <tbody>
            {allYears.map(y=>{
              const d = calcWithGoal(y);
              const cnt = getCount(y);
              const isThis = y===THIS_YEAR;
              return (
                <tr key={y} style={isThis?{background:"rgba(99,102,241,.05)"}:{}}>
                  <td><span style={{fontFamily:"monospace",fontWeight:isThis?800:600,color:isThis?"var(--accent)":"var(--txt)"}}>{y}{isThis?" ✦":""}</span></td>
                  <td className="r mono">{money(d.privNet)}</td>
                  <td className="r mono">{money(d.bhShare)}</td>
                  <td className="r mono accent fw6">{money(d.total)}</td>
                  <td className="r mono muted" style={{cursor:"pointer"}} onClick={()=>setEditGoal({year:y,val:d.goal})}>
                    {money(d.goal)} <span style={{fontSize:10,opacity:.5}}>✎</span>
                  </td>
                  <td className="r mono">
                    <span style={{color:d.prog>=100?"var(--ok)":d.prog>=70?"var(--accent)":"var(--warn)"}}>{d.prog.toFixed(1)}%</span>
                  </td>
                  <td>{cnt} งาน</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── PROJECT TABLE (reused by Private + BriefHere) ────────
// ── NOTE CELL ────────────────────────────────────────────
function NoteCell({ row, onEdit }) {
  const hasNote = row.note && row.note.trim();
  return (
    <td style={{maxWidth:180, verticalAlign:"top"}}>
      {hasNote
        ? <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.6,whiteSpace:"pre-wrap",wordBreak:"break-word",marginBottom:3}}>{row.note}</div>
        : <span style={{fontSize:11,color:"var(--bdr)",fontStyle:"italic"}}>ว่าง</span>
      }
      <button onClick={()=>onEdit(row)}
        style={{display:"block",marginTop:2,fontSize:11,color:"var(--accent)",background:"none",border:"none",padding:0,cursor:"pointer",textDecoration:"underline"}}>
        {hasNote ? "แก้ไข" : "+ Note"}
      </button>
    </td>
  );
}

function ProjectTable({ data, isBH, onEdit, onDelete }) {
  if (!data.length) return <div className="empty">ไม่มีรายการ</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Client</th><th>งาน</th>
            <th className="r">Gross</th>
            {isBH && <th className="r">ค่าใช้จ่าย</th>}
            {isBH && <th className="r">หลังหัก</th>}
            <th className="r">{isBH?"ส่วนคุณ 50%":"Net (หัก 3%)"}</th>
            <th>Due</th><th>Status</th><th>Note</th><th></th>
          </tr>
        </thead>
        <tbody>
          {data.map(r => {
            const net = isBH ? (r.gross-r.expense)*0.5 : r.gross*0.97;
            return (
              <tr key={r.id}>
                <td className="fw6">{r.client}</td>
                <td>{r.title}</td>
                <td className="r mono">{money(r.gross)}</td>
                {isBH && <td className="r mono muted">{money(r.expense)}</td>}
                {isBH && <td className="r mono">{money(r.gross-r.expense)}</td>}
                <td className="r mono accent">{money(net)}</td>
                <td className="mono-sm">{fmtDate(r.due_date)}</td>
                <td><Chip label={r.status} variant={statusVariant(r.status)}/></td>
                <NoteCell row={r} onEdit={onEdit}/>
                <td>
                  <div className="row-actions">
                    <button className="act-btn" onClick={()=>onEdit(r)}>✎</button>
                    <button className="act-btn act-del" onClick={()=>onDelete(r)}>✕</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── YEAR GROUP HEADER ────────────────────────────────────
function YearHeader({ year, items, isBH }) {
  const net = isBH
    ? items.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+(r.grand_total||r.gross*0.97)/2,0)
    : items.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+r.gross*0.97,0);
  const wip  = items.filter(r=>r.status==="WIP").length;
  const wait = items.filter(r=>r.status==="Finish/Wait").length;
  const done = items.filter(r=>r.status==="Done").length;
  return (
    <div className="yr-hdr">
      <div className="yr-num">{year}</div>
      <div className="yr-stats">
        <div className="yr-stat"><div className="yr-lbl">ทั้งหมด</div><div className="yr-val">{items.length} งาน</div></div>
        <div className="yr-sep"/>
        <div className="yr-stat"><div className="yr-lbl">Net รวม</div><div className="yr-val accent">{money(net)}</div></div>
        <div className="yr-sep"/>
        <div className="yr-stat"><div className="yr-lbl">WIP</div><div className="yr-val" style={{color:wip>0?"var(--warn)":"var(--muted)"}}>{wip}</div></div>
        <div className="yr-sep"/>
        <div className="yr-stat"><div className="yr-lbl">รอรับเงิน</div><div className="yr-val" style={{color:wait>0?"var(--acc2)":"var(--muted)"}}>{wait}</div></div>
        <div className="yr-sep"/>
        <div className="yr-stat"><div className="yr-lbl">Done</div><div className="yr-val" style={{color:"var(--ok)"}}>{done}</div></div>
      </div>
    </div>
  );
}

// ── INLINE NOTE — edit inline, save to Supabase ──────────────
function InlineNote({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  if (editing) return (
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      <textarea value={draft} onChange={e=>setDraft(e.target.value)}
        style={{fontSize:11,padding:"4px 6px",borderRadius:6,border:"1px solid var(--accent)",
          background:"var(--sur2)",color:"var(--txt)",resize:"vertical",minHeight:52,width:160,lineHeight:1.5}}
        autoFocus/>
      <div style={{display:"flex",gap:4}}>
        <button onClick={()=>{onSave(draft);setEditing(false);}}
          style={{fontSize:10,padding:"2px 8px",borderRadius:5,border:"none",background:"var(--accent)",color:"#fff",cursor:"pointer"}}>บันทึก</button>
        <button onClick={()=>{setDraft(value);setEditing(false);}}
          style={{fontSize:10,padding:"2px 8px",borderRadius:5,border:"1px solid var(--bdr)",background:"transparent",color:"var(--muted)",cursor:"pointer"}}>ยกเลิก</button>
      </div>
    </div>
  );
  return (
    <div style={{fontSize:11,color:"var(--muted)",cursor:"pointer",minWidth:80}} onClick={()=>{setDraft(value);setEditing(true);}}>
      {value ? <span style={{whiteSpace:"pre-wrap",color:"var(--txt)"}}>{value}</span>
             : <span style={{color:"var(--bdr)",fontStyle:"italic"}}>+ Note</span>}
    </div>
  );
}

// ── PRIVATE MODAL (เพิ่ม/แก้ไข งานนอก) ──────────────────────
function PrivateModal({ initial, onClose, onSave }) {
  const blank = { client:"", title:"", gross:"", status:"WIP", start_date:"", due_date:"", pay_date:"", note:"" };
  const [f, setF] = useState(initial ? {...initial, gross: initial.gross||""} : blank);
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const valid = f.client && f.gross;
  return (
    <Modal title={initial ? `แก้ไข — ${initial.client}` : "เพิ่มงานนอก"} onClose={onClose}>
      <Field label="Client"><input className="inp" value={f.client} onChange={e=>set("client",e.target.value)} placeholder="ชื่อ Client"/></Field>
      <Field label="Detail / ชื่องาน"><textarea className="inp" rows={3} value={f.title} onChange={e=>set("title",e.target.value)} placeholder="รายละเอียดงาน" style={{resize:"vertical"}}/></Field>
      <Field label="Total (฿)"><input className="inp" type="number" value={f.gross} onChange={e=>set("gross",e.target.value)} placeholder="0"/></Field>
      <Field label="Status">
        <select className="inp" value={f.status} onChange={e=>set("status",e.target.value)}>
          {["WIP","Finish/Wait","Done","Cancel","Hold"].map(s=><option key={s}>{s}</option>)}
        </select>
      </Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Start"><input className="inp" type="date" value={f.start_date||""} onChange={e=>set("start_date",e.target.value)}/></Field>
        <Field label="End"><input className="inp" type="date" value={f.due_date||""} onChange={e=>set("due_date",e.target.value)}/></Field>
        <Field label="Pay Date"><input className="inp" type="date" value={f.pay_date||""} onChange={e=>set("pay_date",e.target.value)}/></Field>
      </div>
      <Field label="Note"><textarea className="inp" rows={2} value={f.note||""} onChange={e=>set("note",e.target.value)} placeholder="Note / Notice" style={{resize:"vertical"}}/></Field>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn-primary" disabled={!valid} onClick={()=>onSave(f)}>บันทึก</button>
      </div>
    </Modal>
  );
}

// ── BRIEFHERE MODAL (เพิ่ม/แก้ไข งานเพจ) ────────────────────
function BriefhereModal({ initial, onClose, onSave }) {
  const blank = { client:"", title:"", gross:"", vat:"", grand_total:"", status:"WIP", start_date:"", due_date:"", pay_date:"", bill_date:"", company:"", note:"" };
  const [f, setF] = useState(initial ? {...initial, gross:initial.gross||"", vat:initial.vat||"", grand_total:initial.grand_total||""} : blank);
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  // auto-calc vat and grand_total from gross
  const handleGross = (v) => {
    const g = parseFloat(v)||0;
    setF(p=>({...p, gross:v, vat:Math.round(g*0.03), grand_total:Math.round(g*0.97)}));
  };
  const valid = f.client && f.gross;
  return (
    <Modal title={initial ? `แก้ไข — ${initial.client}` : "เพิ่มงานเพจ"} onClose={onClose}>
      <Field label="Client / Task"><input className="inp" value={f.client} onChange={e=>set("client",e.target.value)} placeholder="ชื่อ Client"/></Field>
      <Field label="Detail"><textarea className="inp" rows={3} value={f.title} onChange={e=>set("title",e.target.value)} placeholder="รายละเอียดงาน" style={{resize:"vertical"}}/></Field>
      <Field label="Company"><input className="inp" value={f.company||""} onChange={e=>set("company",e.target.value)} placeholder="เช่น Faceblog"/></Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        <Field label="Total (฿)"><input className="inp" type="number" value={f.gross} onChange={e=>handleGross(e.target.value)} placeholder="0"/></Field>
        <Field label="Vat 3%"><input className="inp" type="number" value={f.vat} onChange={e=>set("vat",e.target.value)} placeholder="0"/></Field>
        <Field label="Grand Total"><input className="inp" type="number" value={f.grand_total} onChange={e=>set("grand_total",e.target.value)} placeholder="0"/></Field>
      </div>
      <Field label="Status">
        <select className="inp" value={f.status} onChange={e=>set("status",e.target.value)}>
          {["WIP","Finish/Wait","Done","Cancel","Hold"].map(s=><option key={s}>{s}</option>)}
        </select>
      </Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Start"><input className="inp" type="date" value={f.start_date||""} onChange={e=>set("start_date",e.target.value)}/></Field>
        <Field label="End"><input className="inp" type="date" value={f.due_date||""} onChange={e=>set("due_date",e.target.value)}/></Field>
        <Field label="Pay Date"><input className="inp" type="date" value={f.pay_date||""} onChange={e=>set("pay_date",e.target.value)}/></Field>
        <Field label="Bill Date"><input className="inp" type="date" value={f.bill_date||""} onChange={e=>set("bill_date",e.target.value)}/></Field>
      </div>
      <Field label="Note / Notice"><textarea className="inp" rows={2} value={f.note||""} onChange={e=>set("note",e.target.value)} placeholder="Note / Notice" style={{resize:"vertical"}}/></Field>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn-primary" disabled={!valid} onClick={()=>onSave(f)}>บันทึก</button>
      </div>
    </Modal>
  );
}

// ── TOAST NOTIFICATION ───────────────────────────────────
function Toast({ msg, type="info" }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 10000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!visible || !msg) return null;
  const colors = {
    info:  { bg:"rgba(99,102,241,.12)",  border:"rgba(99,102,241,.3)",  color:"var(--accent)" },
    ok:    { bg:"rgba(16,185,129,.1)",   border:"rgba(16,185,129,.3)",  color:"var(--ok)"     },
    error: { bg:"rgba(239,68,68,.1)",    border:"rgba(239,68,68,.3)",   color:"var(--danger)" },
  };
  const c = colors[type] || colors.info;
  return (
    <div style={{
      position:"fixed", bottom:"calc(64px + 16px)", right:16, zIndex:9999,
      padding:"10px 18px", borderRadius:12,
      background:c.bg, border:`1px solid ${c.border}`,
      color:c.color, fontSize:12, fontWeight:600,
      boxShadow:"0 4px 20px rgba(0,0,0,.2)",
      display:"flex", alignItems:"center", gap:8,
      animation:"fadeUp .2s ease",
      maxWidth:360,
    }}>
      <span>{type==="ok"?"✅":type==="error"?"⚠":"☁"}</span>
      <span>{msg}</span>
      <button onClick={()=>setVisible(false)}
        style={{marginLeft:"auto",background:"none",border:"none",color:"inherit",cursor:"pointer",fontSize:14,opacity:.6}}>✕</button>
    </div>
  );
}

function PrivatePage({ tick, triggerRefresh, onDataLoad }) {
  const [sbData,   setSbData]   = useState([]);
  const [sbStatus, setSbStatus] = useState("idle");
  const [sbMsg,    setSbMsg]    = useState("");
  const [statusF,  setStatusF]  = useState("all");
  const [yearF,    setYearF]    = useState(String(THIS_YEAR));
  const [addModal,   setAddModal]   = useState(false);
  const [csvConfirm, setCsvConfirm] = useState(null);
  const [editRow,  setEditRow]  = useState(null);
  const [delRow,   setDelRow]   = useState(null);
  const fileRef = useRef();

  useEffect(() => { if(sbData.length) onDataLoad?.(sbData); }, [sbData]);

  // โหลด mock เป็น base เสมอ + merge กับ Supabase (SB override mock ถ้า id เดิม)
  const loadFromSB = useCallback(async () => {
    setSbStatus("loading"); setSbMsg("");
    const mock = db.private.list();
    try {
      const sbRows = await sbSelect("private_jobs");
      // ใช้ map เพื่อ override mock ถ้า id ตรงกัน
      const sbMap = new Map(sbRows.map(r=>[r.id, r]));
      const merged = [
        ...mock.map(r => sbMap.has(r.id) ? sbMap.get(r.id) : r),
        ...sbRows.filter(r => !mock.find(m=>m.id===r.id))
      ];
      setSbData(merged); setSbStatus("ok");
      setSbMsg(`📋 ${mock.length} mock + ☁ ${sbRows.filter(r=>!mock.find(m=>m.id===r.id)).length} SB = ${merged.length} รายการ`);
      onDataLoad?.(merged);
    } catch(e) {
      setSbData(mock); setSbStatus("ok");
      setSbMsg(`📋 Offline · ${mock.length} รายการ`);
      onDataLoad?.(mock);
    }
  }, []);

  useEffect(() => { loadFromSB(); }, []);

  // อ่าน CSV → ถามลบปีเก่า → upsert ไป Supabase
  const handleCSVFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSbStatus("loading"); setSbMsg("กำลังอ่านไฟล์...");
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const rows = parseCSV(ev.target.result);
        if (!rows.length) throw new Error("ไม่พบข้อมูล — ตรวจสอบ format CSV");
        const sbRows = rows.map(r => ({
          id: r.id, client: r.client, title: r.title,
          gross: r.gross, vat: r.vat, grand_total: r.grand_total,
          status: r.status, start_date: r.start_date||null,
          due_date: r.due_date||null, pay_date: r.pay_date||null,
          bill_date: r.bill_date||null, pm: r.pm, company: r.company,
          notice: r.notice, note: r.note||"",
        }));
        // หาปีที่มีใน CSV
        const csvYears = [...new Set(sbRows.map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean))];
        setSbStatus("idle");
        // ถามก่อนว่าจะลบข้อมูลเดิมมั้ย
        setCsvConfirm({ rows: sbRows, years: csvYears });
      } catch(err) {
        setSbStatus("error"); setSbMsg(err.message);
      }
    };
    reader.readAsText(file, "UTF-8");
    e.target.value = "";
  };

  // ดำเนินการหลังยืนยัน
  const doCSVImport = async (shouldDelete) => {
    const { rows, years } = csvConfirm;
    setCsvConfirm(null);
    setSbStatus("loading");
    try {
      if (shouldDelete) {
        setSbMsg(`กำลังลบข้อมูลเดิมปี ${years.join(", ")}...`);
        for (const y of years) await sbDeleteByYear("private_jobs", y);
      }
      setSbMsg(`กำลัง upsert ${rows.length} รายการ...`);
      await sbUpsert("private_jobs", rows);
      await loadFromSB();
      setSbMsg(`✅ บันทึก ${rows.length} รายการเรียบร้อย${shouldDelete?" (ลบข้อมูลเดิมก่อน)":""}`);
    } catch(err) {
      setSbStatus("error"); setSbMsg(err.message);
    }
  };

  // Push mock → Supabase
  const syncMockToSB = async () => {
    setSbStatus("loading"); setSbMsg("กำลัง sync mock → Supabase...");
    try {
      const mockRows = db.private.list().map(r=>({
        id:r.id, client:r.client, title:r.title,
        gross:r.gross, vat:r.vat||Math.round(r.gross*0.03),
        grand_total:r.grand_total||Math.round(r.gross*0.97),
        status:r.status, start_date:r.start_date||null,
        due_date:r.due_date||null, pay_date:r.pay_date||null,
        bill_date:r.bill_date||null,
        pm:r.pm||"", company:r.company||"",
        notice:r.notice||"", note:r.note||"",
      }));
      await sbUpsert("private_jobs", mockRows);
      await loadFromSB();
      setSbMsg(`✅ Sync สำเร็จ ${mockRows.length} รายการ`);
    } catch(e) {
      setSbStatus("error"); setSbMsg(e.message);
    }
  };

  // บันทึก note ลง Supabase
  const handleNoteUpdate = useCallback(async (id, note) => {
    try {
      await sbUpdateNote("private_jobs", id, note);
      setSbData(prev => prev.map(r => r.id===id ? {...r, note} : r));
    } catch(e) {
      alert("บันทึก note ไม่ได้: " + e.message);
    }
  }, []);

  const years = useMemo(()=>[...new Set(sbData.map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean))].sort((a,b)=>b-a),[sbData]);

  const filtered = useMemo(()=>{
    let rows = sbData;
    if (statusF !== "all") rows = rows.filter(r=>r.status===statusF);
    if (yearF   !== "all") rows = rows.filter(r=>getYear(r.pay_date||r.due_date)===+yearF);
    return rows;
  },[sbData, statusF, yearF]);

  const grouped = useMemo(()=>{
    const map = {};
    filtered.forEach(r=>{
      const y = getYear(r.pay_date||r.due_date) || "ไม่ระบุ";
      if(!map[y]) map[y]=[];
      map[y].push(r);
    });
    return Object.entries(map).sort((a,b)=>b[0]-a[0]);
  },[filtered]);

  const gross = filtered.reduce((a,r)=>a+r.gross,0);
  const net   = filtered.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+r.gross*0.97,0);
  const wait  = filtered.filter(r=>r.status==="Finish/Wait").reduce((a,r)=>a+r.gross*0.97,0);
  const yearLabel = yearF==="all" ? "ทุกปี" : `ปี ${yearF}`;

  return (
    <div className="page">
      <PageHeader title="งานนอก (Private)" sub="รายได้ส่วนตัว — Net หัก 3% · แยกตามปี"
        action={<button className="btn-primary" onClick={()=>setAddModal(true)}>+ เพิ่มงาน</button>}/>

      {/* Stat cards */}
      <div style={{marginBottom:6,fontSize:11,color:"var(--muted)",fontFamily:"monospace"}}>
        สรุป{yearLabel} · {filtered.length} รายการ
      </div>
      <div className="stat-row">
        <div className="stat-box">
          <div className="stat-lbl">Gross — {yearLabel}</div>
          <div className="stat-val">{money(gross)}</div>
        </div>
        <div className="stat-box stat-accent">
          <div className="stat-lbl">Net (หัก 3%) — {yearLabel}</div>
          <div className="stat-val accent">{money(net)}</div>
        </div>
        <div className="stat-box stat-warn">
          <div className="stat-lbl">รอรับเงิน — {yearLabel}</div>
          <div className="stat-val">{money(wait)}</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        <div className="filter-row" style={{marginBottom:0}}>
          <span style={{fontSize:11,color:"var(--muted)",alignSelf:"center",marginRight:4}}>ปี:</span>
          {["all",...years.map(String)].map(y=>(
            <button key={y} className={`filter-btn${yearF===y?" active":""}`} onClick={()=>setYearF(y)}>
              {y==="all"?"ทั้งหมด":y}
            </button>
          ))}
        </div>
        <div className="filter-row" style={{marginBottom:0}}>
          <span style={{fontSize:11,color:"var(--muted)",alignSelf:"center",marginRight:4}}>Status:</span>
          {["all","Done","Finish/Wait","WIP","Cancel","Hold"].map(f=>(
            <button key={f} className={`filter-btn${statusF===f?" active":""}`} onClick={()=>setStatusF(f)}>
              {f==="all"?"ทั้งหมด":f}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped by year */}
      {sbStatus==="loading"
        ? <div className="empty">⏳ กำลังโหลดข้อมูล...</div>
        : grouped.length===0
        ? <div className="empty">ไม่พบรายการ — กด Upload CSV หรือ + เพิ่มงาน</div>
        : grouped.map(([year, items])=>(
          <div key={year} style={{marginBottom:16}}>
            <YearHeader year={year} items={items} isBH={false}/>
            <div className="tbl-wrap" style={{borderRadius:"0 0 9px 9px"}}>
              <table className="tbl">
                <thead><tr>
                  <th>Client</th><th>Detail</th>
                  <th className="r">Total</th><th className="r">Net (97%)</th>
                  <th>Start</th><th>End</th><th>Pay Date</th>
                  <th>Status</th><th>Note / Notice</th><th></th>
                </tr></thead>
                <tbody>
                  {items.map(r=>(
                    <tr key={r.id} style={r.status==="Cancel"?{opacity:.5}:{}}>
                      <td className="fw6" style={{whiteSpace:"nowrap"}}>{r.client}</td>
                      <td style={{fontSize:11,maxWidth:200,whiteSpace:"pre-wrap"}}>{r.title}</td>
                      <td className="r mono">{money(r.gross)}</td>
                      <td className="r mono accent">{money(r.gross*0.97)}</td>
                      <td className="mono-sm">{fmtDate(r.start_date)}</td>
                      <td className="mono-sm">{fmtDate(r.due_date)}</td>
                      <td className="mono-sm">{fmtDate(r.pay_date)}</td>
                      <td><Chip label={r.status} variant={statusVariant(r.status)}/></td>
                      <td style={{maxWidth:200,verticalAlign:"top"}}>
                        <InlineNote
                          value={r.note || r.notice || ""}
                          onSave={note=>handleNoteUpdate(r.id,note)}/>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="act-btn" onClick={()=>setEditRow(r)}>✎</button>
                          <button className="act-btn act-del" onClick={()=>setDelRow(r)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  <tr className="yr-subtotal">
                    <td colSpan={3} style={{fontSize:11,color:"var(--muted)",fontFamily:"monospace"}}>{items.length} รายการ</td>
                    <td className="r mono accent fw6">{money(items.filter(r=>r.status!=="Cancel"&&r.status!=="Cancel").reduce((a,r)=>a+r.gross*0.97,0))}</td>
                    <td colSpan={6}/>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))
      }

      {/* CSV Confirm Modal */}
      {csvConfirm && (
        <Modal title="📂 ยืนยันการ Import CSV" onClose={()=>setCsvConfirm(null)}>
          <div style={{fontSize:14,lineHeight:1.8,color:"var(--txt)"}}>
            พบข้อมูล <strong>{csvConfirm.rows.length} รายการ</strong> จากไฟล์ CSV<br/>
            ปีที่มีข้อมูล: <strong style={{color:"var(--accent)"}}>{csvConfirm.years.join(", ")}</strong>
          </div>
          <div style={{marginTop:16,padding:"12px 16px",background:"rgba(245,158,11,.08)",borderRadius:8,border:"1px solid rgba(245,158,11,.25)",fontSize:13,color:"var(--warn)"}}>
            ⚠ ต้องการลบข้อมูลเดิมของปี <strong>{csvConfirm.years.join(", ")}</strong> ก่อน import มั้ย?<br/>
            <span style={{fontSize:11,color:"var(--muted)"}}>ถ้าไม่ลบ จะ merge กับข้อมูลเดิม (อาจซ้ำ)</span>
          </div>
          <div className="modal-actions" style={{gap:8}}>
            <button className="btn-ghost" onClick={()=>setCsvConfirm(null)}>ยกเลิก</button>
            <button className="btn-ghost" style={{borderColor:"var(--accent)",color:"var(--accent)"}}
              onClick={()=>doCSVImport(false)}>
              Merge (ไม่ลบเดิม)
            </button>
            <button className="btn-danger" onClick={()=>doCSVImport(true)}>
              ลบเดิม + Import ใหม่
            </button>
          </div>
        </Modal>
      )}

      {/* Modal เพิ่ม/แก้ไข */}
      {(addModal||editRow) && (
        <PrivateModal
          initial={editRow}
          onClose={()=>{setAddModal(false);setEditRow(null);}}
          onSave={async(form)=>{
            try {
              const row = {
                ...(editRow || {}),
                id: editRow?.id || `m-${Date.now()}`,
                client:form.client, title:form.title,
                gross:+form.gross, vat:Math.round(+form.gross*0.03),
                grand_total:Math.round(+form.gross*0.97),
                status:form.status, start_date:form.start_date||null,
                due_date:form.due_date||null, pay_date:form.pay_date||null,
                note:form.note||"",
              };
              await sbUpsert("private_jobs",[row]);
              // update local state ทันที ไม่ต้อง reload ทั้งหมด
              if (editRow) {
                setSbData(prev => prev.map(r=>r.id===row.id?row:r));
              } else {
                setSbData(prev => [...prev, row]);
              }
              setAddModal(false); setEditRow(null);
            } catch(e){ alert("บันทึกไม่ได้: "+e.message); }
          }}/>
      )}
      {delRow && (
        <ConfirmModal msg={`ลบ "${delRow.client} — ${delRow.title?.substring(0,40)}" ?`}
          onOk={async()=>{
            try {
              await sbDelete("private_jobs", delRow.id);
            } catch(e) { /* ignore if not in SB */ }
            setSbData(prev => prev.filter(r => r.id !== delRow.id));
            setDelRow(null);
          }}
          onCancel={()=>setDelRow(null)}/>
      )}
    </div>
  );
}

function BriefherePage({ tick, triggerRefresh, onDataLoad }) {
  const [sbData,   setSbData]   = useState([]);
  const [sbStatus, setSbStatus] = useState("idle");
  const [sbMsg,    setSbMsg]    = useState("");
  const [statusF,  setStatusF]  = useState("all");
  const [yearF,    setYearF]    = useState(String(THIS_YEAR));
  const [addModal,   setAddModal]   = useState(false);
  const [editRow,    setEditRow]    = useState(null);
  const [delRow,     setDelRow]     = useState(null);
  const [csvConfirm, setCsvConfirm] = useState(null);
  const fileRef = useRef();

  useEffect(() => { if(sbData.length) onDataLoad?.(sbData); }, [sbData]);

  const loadFromSB = useCallback(async () => {
    setSbStatus("loading"); setSbMsg("");
    const mock = db.briefhere.list();
    try {
      const sbRows = await sbSelect("briefhere_jobs");
      const sbMap = new Map(sbRows.map(r=>[r.id, r]));
      const merged = [
        ...mock.map(r => sbMap.has(r.id) ? sbMap.get(r.id) : r),
        ...sbRows.filter(r => !mock.find(m=>m.id===r.id))
      ];
      setSbData(merged); setSbStatus("ok");
      setSbMsg(`📋 ${mock.length} mock + ☁ ${sbRows.filter(r=>!mock.find(m=>m.id===r.id)).length} SB = ${merged.length} รายการ`);
      onDataLoad?.(merged);
    } catch(e) {
      setSbData(mock); setSbStatus("ok");
      setSbMsg(`📋 Offline · ${mock.length} รายการ`);
      onDataLoad?.(mock);
    }
  }, []);

  useEffect(() => { loadFromSB(); }, []);

  const handleCSVFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSbStatus("loading"); setSbMsg("กำลังอ่านไฟล์...");
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const rows = parseCSV(ev.target.result);
        if (!rows.length) throw new Error("ไม่พบข้อมูล");
        const sbRows = rows.map(r => ({
          id: r.id, client: r.client, title: r.title,
          gross: r.gross, vat: r.vat, grand_total: r.grand_total,
          status: r.status, start_date: r.start_date||null,
          due_date: r.due_date||null, pay_date: r.pay_date||null,
          bill_date: r.bill_date||null, pm: r.pm, company: r.company,
          notice: r.notice, note: r.note||"",
        }));
        const csvYears = [...new Set(sbRows.map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean))];
        setSbStatus("idle");
        setCsvConfirm({ rows: sbRows, years: csvYears });
      } catch(err) { setSbStatus("error"); setSbMsg(err.message); }
    };
    reader.readAsText(file, "UTF-8");
    e.target.value = "";
  };

  const doCSVImport = async (shouldDelete) => {
    const { rows, years } = csvConfirm;
    setCsvConfirm(null);
    setSbStatus("loading");
    try {
      if (shouldDelete) {
        setSbMsg(`กำลังลบข้อมูลเดิมปี ${years.join(", ")}...`);
        for (const y of years) await sbDeleteByYear("briefhere_jobs", y);
      }
      setSbMsg(`กำลัง upsert ${rows.length} รายการ...`);
      await sbUpsert("briefhere_jobs", rows);
      await loadFromSB();
      setSbMsg(`✅ บันทึก ${rows.length} รายการเรียบร้อย${shouldDelete?" (ลบข้อมูลเดิมก่อน)":""}`);
    } catch(err) { setSbStatus("error"); setSbMsg(err.message); }
  };

  const handleNoteUpdate = useCallback(async (id, note) => {
    try {
      await sbUpdateNote("briefhere_jobs", id, note);
      setSbData(prev => prev.map(r => r.id===id ? {...r, note} : r));
    } catch(e) { alert("บันทึก note ไม่ได้: " + e.message); }
  }, []);

  const years = useMemo(()=>[...new Set(sbData.map(r=>getYear(r.pay_date||r.due_date)).filter(Boolean))].sort((a,b)=>b-a),[sbData]);

  const filtered = useMemo(()=>{
    let rows = sbData;
    if (statusF !== "all") rows = rows.filter(r=>r.status===statusF);
    if (yearF   !== "all") rows = rows.filter(r=>getYear(r.pay_date||r.due_date)===+yearF);
    return rows;
  },[sbData, statusF, yearF]);

  const grouped = useMemo(()=>{
    const map = {};
    filtered.forEach(r=>{ const y=getYear(r.pay_date||r.due_date)||"ไม่ระบุ"; if(!map[y])map[y]=[]; map[y].push(r); });
    return Object.entries(map).sort((a,b)=>b[0]-a[0]);
  },[filtered]);

  const gross   = filtered.reduce((a,r)=>a+r.gross,0);
  const netStat = filtered.filter(r=>r.status!=="Cancel"&&r.status!=="Cancel").reduce((a,r)=>a+(r.grand_total||r.gross*0.97),0);
  const waitAmt = filtered.filter(r=>r.status==="Finish/Wait").reduce((a,r)=>a+(r.grand_total||0),0);
  const yearLabel = yearF==="all"?"ทุกปี":`ปี ${yearF}`;

  return (
    <div className="page">
      <PageHeader title="งานเพจ (BriefHere)" sub="รายรับส่วนตัว (Grand Total ÷ 2) · แยกตามปี"
        action={
          <button className="btn-primary" onClick={()=>setAddModal(true)}>+ เพิ่มงาน</button>
        }/>

      <div style={{marginBottom:6,fontSize:11,color:"var(--muted)",fontFamily:"monospace"}}>สรุป{yearLabel} · {filtered.length} รายการ</div>
      <div className="stat-row">
        <div className="stat-box"><div className="stat-lbl">Total — {yearLabel}</div><div className="stat-val">{money(gross)}</div></div>
        <div className="stat-box stat-accent"><div className="stat-lbl">รายรับส่วนตัว — {yearLabel}</div><div className="stat-val accent">{money(netStat/2)}</div></div>
        <div className="stat-box stat-warn"><div className="stat-lbl">รายรับส่วนตัว (รอรับ) — {yearLabel}</div><div className="stat-val">{money(waitAmt/2)}</div></div>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        <div className="filter-row" style={{marginBottom:0}}>
          <span style={{fontSize:11,color:"var(--muted)",alignSelf:"center",marginRight:4}}>ปี:</span>
          {["all",...years.map(String)].map(y=>(
            <button key={y} className={`filter-btn${yearF===y?" active":""}`} onClick={()=>setYearF(y)}>{y==="all"?"ทั้งหมด":y}</button>
          ))}
        </div>
        <div className="filter-row" style={{marginBottom:0}}>
          <span style={{fontSize:11,color:"var(--muted)",alignSelf:"center",marginRight:4}}>Status:</span>
          {["all","Done","Finish/Wait","WIP","Cancel","Hold"].map(f=>(
            <button key={f} className={`filter-btn${statusF===f?" active":""}`} onClick={()=>setStatusF(f)}>{f==="all"?"ทั้งหมด":f}</button>
          ))}
        </div>
      </div>

      {sbStatus==="loading"&&sbData.length===0
        ? <div className="empty">⏳ กำลังโหลดจาก Supabase...</div>
        : grouped.length===0
        ? <div className="empty">ไม่พบรายการ — กด Upload CSV หรือ + เพิ่มงาน</div>
        : grouped.map(([year,items])=>(
          <div key={year} style={{marginBottom:16}}>
            <YearHeader year={year} items={items} isBH={true}/>
            <div className="tbl-wrap" style={{borderRadius:"0 0 9px 9px"}}>
              <table className="tbl">
                <thead><tr>
                  <th>Client</th><th>Detail</th><th>Company</th>
                  <th className="r">Total</th><th className="r">Vat</th><th className="r">Grand Total</th>
                  <th>Start</th><th>End</th><th>Pay Date</th>
                  <th>Status</th><th>Note / Notice</th><th></th>
                </tr></thead>
                <tbody>
                  {items.map(r=>(
                    <tr key={r.id} style={r.status==="Cancel"?{opacity:.5}:{}}>
                      <td className="fw6" style={{whiteSpace:"nowrap"}}>{r.client}</td>
                      <td style={{fontSize:11,maxWidth:200,whiteSpace:"pre-wrap"}}>{r.title}</td>
                      <td style={{fontSize:12,color:"var(--muted)"}}>{r.company||"—"}</td>
                      <td className="r mono">{money(r.gross)}</td>
                      <td className="r mono muted">{money(r.vat)}</td>
                      <td className="r mono accent">{money(r.grand_total)}</td>
                      <td className="mono-sm">{fmtDate(r.start_date)}</td>
                      <td className="mono-sm">{fmtDate(r.due_date)}</td>
                      <td className="mono-sm">{fmtDate(r.pay_date)}</td>
                      <td><Chip label={r.status} variant={statusVariant(r.status)}/></td>
                      <td style={{maxWidth:200,verticalAlign:"top"}}>
                        <InlineNote value={r.note||r.notice||""} onSave={note=>handleNoteUpdate(r.id,note)}/>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="act-btn" onClick={()=>setEditRow(r)}>✎</button>
                          <button className="act-btn act-del" onClick={()=>setDelRow(r)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  <tr className="yr-subtotal">
                    <td colSpan={5} style={{fontSize:11,color:"var(--muted)",fontFamily:"monospace"}}>{items.length} รายการ</td>
                    <td className="r mono accent fw6">{money(items.filter(r=>r.status!=="Cancel"&&r.status!=="Cancel").reduce((a,r)=>a+(r.grand_total||0),0))}</td>
                    <td colSpan={6}/>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))
      }

      {/* CSV Confirm Modal */}
      {csvConfirm && (
        <Modal title="📂 ยืนยันการ Import CSV" onClose={()=>setCsvConfirm(null)}>
          <div style={{fontSize:14,lineHeight:1.8,color:"var(--txt)"}}>
            พบข้อมูล <strong>{csvConfirm.rows.length} รายการ</strong> จากไฟล์ CSV<br/>
            ปีที่มีข้อมูล: <strong style={{color:"var(--accent)"}}>{csvConfirm.years.join(", ")}</strong>
          </div>
          <div style={{marginTop:16,padding:"12px 16px",background:"rgba(245,158,11,.08)",borderRadius:8,border:"1px solid rgba(245,158,11,.25)",fontSize:13,color:"var(--warn)"}}>
            ⚠ ต้องการลบข้อมูลเดิมของปี <strong>{csvConfirm.years.join(", ")}</strong> ก่อน import มั้ย?<br/>
            <span style={{fontSize:11,color:"var(--muted)"}}>ถ้าไม่ลบ จะ merge กับข้อมูลเดิม (อาจซ้ำ)</span>
          </div>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={()=>setCsvConfirm(null)}>ยกเลิก</button>
            <button className="btn-ghost" style={{borderColor:"var(--accent)",color:"var(--accent)"}}
              onClick={()=>doCSVImport(false)}>Merge (ไม่ลบเดิม)</button>
            <button className="btn-danger" onClick={()=>doCSVImport(true)}>ลบเดิม + Import ใหม่</button>
          </div>
        </Modal>
      )}

      {/* Modal เพิ่ม/แก้ไข */}
      {(addModal||editRow) && (
        <BriefhereModal
          initial={editRow}
          onClose={()=>{setAddModal(false);setEditRow(null);}}
          onSave={async(form)=>{
            try {
              const row = {
                ...(editRow || {}),
                id: editRow?.id || `bh-${Date.now()}`,
                client:form.client, title:form.title,
                company:form.company||"",
                gross:+form.gross, vat:+form.vat||Math.round(+form.gross*0.03),
                grand_total:+form.grand_total||Math.round(+form.gross*0.97),
                status:form.status,
                start_date:form.start_date||null, due_date:form.due_date||null,
                pay_date:form.pay_date||null, bill_date:form.bill_date||null,
                note:form.note||"",
              };
              await sbUpsert("briefhere_jobs",[row]);
              if (editRow) {
                setSbData(prev => prev.map(r=>r.id===row.id?row:r));
              } else {
                setSbData(prev => [...prev, row]);
              }
              setAddModal(false); setEditRow(null);
            } catch(e){ alert("บันทึกไม่ได้: "+e.message); }
          }}/>
      )}
      {delRow && (
        <ConfirmModal msg={`ลบ "${delRow.client} — ${delRow.title?.substring(0,30)}" ?`}
          onOk={async()=>{
            try {
              await sbDelete("briefhere_jobs", delRow.id);
            } catch(e) { /* ignore */ }
            setSbData(prev => prev.filter(r => r.id !== delRow.id));
            setDelRow(null);
          }}
          onCancel={()=>setDelRow(null)}/>
      )}
    </div>
  );
}

function IncomePage({ tick }) {
  const priv = db.private.list();
  const bh   = db.briefhere.list();

  const privGross  = priv.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+r.gross,0);
  const privNet    = priv.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+r.gross*0.97,0);
  const bhAfterExp = bh.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+(r.gross-r.expense),0);
  const bhShare    = bh.filter(r=>r.status!=="Cancel").reduce((a,r)=>a+(r.gross-r.expense)*0.5,0);
  const total      = privNet + bhShare;
  const prog       = Math.min((total/GOAL)*100,100);

  const debtPriv = priv.filter(r=>r.status==="Finish/Wait");
  const debtBH   = bh.filter(r=>r.status==="Finish/Wait");
  const debtTotal = debtPriv.reduce((a,r)=>a+r.gross*0.97,0)
                  + debtBH.reduce((a,r)=>a+(r.gross-r.expense)*0.5,0);

  return (
    <div className="page">
      <PageHeader title="รายได้รวม" sub="สรุปรายได้ทุกแหล่ง — ปี 2026"/>

      <div className="income-blocks">
        <div className="income-block">
          <div className="ib-head"><span className="ib-icon">◈</span><span>งานนอก (Private)</span></div>
          <div className="ib-row"><span className="muted">Gross</span><span className="mono">{money(privGross)}</span></div>
          <div className="ib-row"><span className="muted">Net หัก 3%</span><span className="mono accent fw6">{money(privNet)}</span></div>
        </div>
        <div className="income-plus">+</div>
        <div className="income-block">
          <div className="ib-head"><span className="ib-icon">◉</span><span>งานเพจ (BriefHere)</span></div>
          <div className="ib-row"><span className="muted">หลังหักค่าใช้จ่าย</span><span className="mono">{money(bhAfterExp)}</span></div>
          <div className="ib-row"><span className="muted">ส่วนคุณ 50%</span><span className="mono accent fw6">{money(bhShare)}</span></div>
        </div>
        <div className="income-plus">=</div>
        <div className="income-block income-block-total">
          <div className="ib-head"><span className="ib-icon">◇</span><span>รวมส่วนตัว</span></div>
          <div className="ib-total">{money(total)}</div>
          <div className="ib-goal muted">เป้า {money(GOAL)}</div>
        </div>
      </div>

      <div className="prog-card">
        <div className="prog-bar-row">
          <div className="prog-bar"><div className="prog-fill" style={{width:`${prog}%`}}/></div>
          <span className="prog-pct accent">{prog.toFixed(1)}%</span>
        </div>
        <div className="prog-goal">ขาดอีก {money(Math.max(0,GOAL-total))}</div>
      </div>

      <SecTitle>รายการรอรับเงิน (Finish/Wait) — รวม {money(debtTotal)}</SecTitle>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>แหล่ง</th><th>Client</th><th>งาน</th><th className="r">ยอดที่รับ</th><th>Due</th><th>Note</th></tr></thead>
          <tbody>
            {[...debtPriv.map(r=>({...r,src:"Private",amt:r.gross*0.97})),
               ...debtBH.map(r=>({...r,src:"BriefHere",amt:(r.gross-r.expense)*0.5}))
             ].map(r=>(
              <tr key={r.id}>
                <td><Chip label={r.src} variant={r.src==="Private"?"priv":"bh"}/></td>
                <td className="fw6">{r.client}</td>
                <td>{r.title}</td>
                <td className="r mono accent">{money(r.amt)}</td>
                <td className="mono-sm">{fmtDate(r.due_date)}</td>
                <td style={{fontSize:11,color:"var(--muted)",maxWidth:160,whiteSpace:"pre-wrap"}}>
                  {r.note ? r.note : <span style={{color:"var(--bdr)",fontStyle:"italic"}}>ว่าง</span>}
                </td>
              </tr>
            ))}
            {debtPriv.length+debtBH.length===0 && <tr><td colSpan={6} className="empty">ไม่มีรายการรอรับเงิน</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── SHARED MAINT ROW & FORM ──────────────────────────────
function useMaintPage(typeFilter, triggerRefresh) {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [confirm, setConfirm] = useState(null);

  const table = typeFilter==="home" ? "maintenance_home" : "maintenance_car";
  const tableRef = useRef(table);
  tableRef.current = table;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await sbSelect(tableRef.current);
      setData(rows);
    } catch(e) {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSave = async (form) => {
    const f = {...form, type: typeFilter};
    const row = {
      id: modal.mode==="edit" ? modal.row.id : `mnt-${Date.now()}`,
      type: f.type, car: f.car||"", item: f.item||"",
      last_date: f.last_date||null, next_date: f.next_date||null,
      interval_label: f.interval_label||"", note: f.note||"",
    };
    try {
      await sbUpsert(tableRef.current, [row]);
    } catch(e) { alert("บันทึกไม่ได้: "+e.message); return; }
    await loadData();
    triggerRefresh(); setModal(null);
  };

  const doDelete = async () => {
    try {
      await sbDelete(tableRef.current, confirm.id);
    } catch(e) { alert("ลบไม่ได้: "+e.message); return; }
    await loadData();
    triggerRefresh(); setConfirm(null);
  };

  return { data, loading, modal, setModal, confirm, setConfirm, handleSave, doDelete };
}

function MaintTable({ data, loading, onEdit, onConfirm }) {
  if (loading) return <div className="empty">⏳ กำลังโหลด...</div>;
  if (!data.length) return <div className="empty">ยังไม่มีรายการ — กด + เพิ่มได้เลย</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>รายการ</th><th>ครั้งล่าสุด</th><th>กำหนดถัดไป</th><th>Interval</th><th>สถานะ</th><th>Note</th><th></th></tr></thead>
        <tbody>
          {data.map(m=>{
            const st = maintStatus(m.next_date);
            const hasNote = m.note && m.note.trim();
            return (
              <tr key={m.id} className={st.t==="overdue"?"row-danger":st.t==="warn"?"row-warn":""}>
                <td className="fw6">{m.item}</td>
                <td className="mono-sm">{fmtDate(m.last_date)}</td>
                <td className="mono-sm">{fmtDate(m.next_date)}</td>
                <td className="muted">{m.interval_label}</td>
                <td><span className={`mst mst-${st.t}`}>{st.label}</span></td>
                <td style={{maxWidth:160,verticalAlign:"top"}}>
                  {hasNote
                    ? <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.6,whiteSpace:"pre-wrap",wordBreak:"break-word",marginBottom:3}}>{m.note}</div>
                    : <span style={{fontSize:11,color:"var(--bdr)",fontStyle:"italic"}}>ว่าง</span>
                  }

                </td>
                <td>
                  <div className="row-actions">
                    <button className="act-btn" onClick={()=>onEdit(m)}>✎</button>
                    <button className="act-btn act-del" onClick={()=>onConfirm(m)}>✕</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── MAINT HOME PAGE ──────────────────────────────────────
function MaintHomePage({ tick, triggerRefresh }) {
  const { data, loading, modal, setModal, confirm, setConfirm, handleSave, doDelete } = useMaintPage("home", triggerRefresh);

  const mainItems = data.filter(m=>!m.item?.includes("ประกัน"));
  const insurItems = data.filter(m=>m.item?.includes("ประกัน"));

  const overdue = data.filter(m=>m.next_date&&m.next_date!=="-"&&diffDays(m.next_date)<0).length;
  const warn    = data.filter(m=>m.next_date&&m.next_date!=="-"&&(()=>{const d=diffDays(m.next_date);return d>=0&&d<=30;})()).length;
  const ok      = data.length - overdue - warn;

  return (
    <div className="page">
      <PageHeader title="🏠 บ้าน — Maintenance" sub="ระบบและอุปกรณ์ภายในบ้าน"
        action={<button className="btn-primary" onClick={()=>setModal({mode:"add",row:{type:"home"}})}>+ เพิ่มรายการ</button>}/>

      <div className="stat-row" style={{gridTemplateColumns:"repeat(3,1fr)"}}>
        <div className="stat-box stat-warn">
          <div className="stat-lbl">เลยกำหนด</div>
          <div className="stat-val" style={{color:"var(--danger)"}}>{overdue} รายการ</div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">ใน 30 วัน</div>
          <div className="stat-val" style={{color:"var(--warn)"}}>{warn} รายการ</div>
        </div>
        <div className="stat-box stat-accent">
          <div className="stat-lbl">ปกติ</div>
          <div className="stat-val" style={{color:"var(--ok)"}}>{ok} รายการ</div>
        </div>
      </div>

      <div className="maint-legend">
        <span className="mst mst-overdue">เลยกำหนด</span>
        <span className="mst mst-warn">ภายใน 30 วัน</span>
        <span className="mst mst-ok">ปกติ</span>
      </div>

      <MaintTable data={mainItems} loading={loading} onEdit={m=>setModal({mode:"edit",row:m})} onConfirm={m=>setConfirm(m)}/>

      {insurItems.length > 0 && <>
        <SecTitle>🛡 ประกัน</SecTitle>
        <MaintTable data={insurItems} loading={false} onEdit={m=>setModal({mode:"edit",row:m})} onConfirm={m=>setConfirm(m)}/>
      </>}

      {modal && (
        <Modal title={modal.mode==="add"?"เพิ่มรายการบ้าน":"แก้ไขรายการบ้าน"} onClose={()=>setModal(null)}>
          <MaintForm initial={modal.row} onSave={handleSave} onClose={()=>setModal(null)}/>
        </Modal>
      )}
      {confirm && <ConfirmModal msg={`ลบ "${confirm.item}" ?`} onOk={doDelete} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

// ── MAINT CAR PAGE ───────────────────────────────────────
function MaintCarPage({ tick, triggerRefresh }) {
  const { data, loading, modal, setModal, confirm, setConfirm, handleSave, doDelete } = useMaintPage("car", triggerRefresh);
  const [selCar, setSelCar] = useState("all");
  const cars = [...new Set(data.map(m=>m.car).filter(Boolean))];

  const overdue = data.filter(m=>m.next_date&&m.next_date!=="-"&&diffDays(m.next_date)<0).length;
  const warn    = data.filter(m=>m.next_date&&m.next_date!=="-"&&(()=>{const d=diffDays(m.next_date);return d>=0&&d<=30;})()).length;
  const ok      = data.length - overdue - warn;
  const filtered = selCar==="all" ? data : data.filter(m=>m.car===selCar);

  return (
    <div className="page">
      <PageHeader title="🚗 รถยนต์ — Maintenance" sub="BYD Sealion 7 / BYD Seal / Honda City 2017"
        action={<button className="btn-primary" onClick={()=>setModal({mode:"add",row:{type:"car"}})}>+ เพิ่มรายการ</button>}/>

      <div className="stat-row" style={{gridTemplateColumns:"repeat(3,1fr)"}}>
        <div className="stat-box stat-warn">
          <div className="stat-lbl">เลยกำหนด</div>
          <div className="stat-val" style={{color:"var(--danger)"}}>{overdue} รายการ</div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">ใน 30 วัน</div>
          <div className="stat-val" style={{color:"var(--warn)"}}>{warn} รายการ</div>
        </div>
        <div className="stat-box stat-accent">
          <div className="stat-lbl">ปกติ</div>
          <div className="stat-val" style={{color:"var(--ok)"}}>{ok} รายการ</div>
        </div>
      </div>

      {/* Car filter tabs */}
      <div className="filter-row">
        <button className={`filter-btn${selCar==="all"?" active":""}`} onClick={()=>setSelCar("all")}>ทุกคัน</button>
        {cars.map(c=>(
          <button key={c} className={`filter-btn${selCar===c?" active":""}`} onClick={()=>setSelCar(c)}>{c}</button>
        ))}
      </div>

      <div className="maint-legend">
        <span className="mst mst-overdue">เลยกำหนด</span>
        <span className="mst mst-warn">ภายใน 30 วัน</span>
        <span className="mst mst-ok">ปกติ</span>
      </div>

      {/* Per-car grouped when "all" selected */}
      {selCar==="all"
        ? cars.map(car=>{
            const carMain = data.filter(m=>m.car===car&&!m.item?.includes("ประกัน"));
            const carInsur = data.filter(m=>m.car===car&&m.item?.includes("ประกัน"));
            return (
              <div key={car} style={{marginBottom:20}}>
                <SecTitle>🚗 {car}</SecTitle>
                <MaintTable data={carMain} loading={loading} onEdit={m=>setModal({mode:"edit",row:m})} onConfirm={m=>setConfirm(m)}/>
                {carInsur.length>0 && <>
                  <SecTitle>🛡 ประกัน — {car}</SecTitle>
                  <MaintTable data={carInsur} loading={false} onEdit={m=>setModal({mode:"edit",row:m})} onConfirm={m=>setConfirm(m)}/>
                </>}
              </div>
            );
          })
        : <MaintTable data={filtered} loading={loading} onEdit={m=>setModal({mode:"edit",row:m})} onConfirm={m=>setConfirm(m)}/>
      }

      {modal && (
        <Modal title={modal.mode==="add"?"เพิ่มรายการรถ":"แก้ไขรายการรถ"} onClose={()=>setModal(null)}>
          <MaintForm initial={modal.row} onSave={handleSave} onClose={()=>setModal(null)}/>
        </Modal>
      )}
      {confirm && <ConfirmModal msg={`ลบ "${confirm.item}" ?`} onOk={doDelete} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

// ── RESIZE SOURCE OPTIONS ────────────────────────────────
const RESIZE_SOURCES = [
  { label:"Animate Motion 1–15 sec",                              price:8000  },
  { label:"Animate Motion 1–30 sec (No key visual or resource)",  price:20000 },
  { label:"Resize Animate Motion <30 sec (Motion Graphic)",       price:5000  },
  { label:"Animate Motion 30–59 sec",                             price:10000 },
  { label:"Animate Motion 30–59 sec (No key visual or resource)", price:30000 },
  { label:"Animate Motion 1–1.30 min",                            price:15000 },
  { label:"Animate Motion 1–1.30 min (No key visual or resource)",price:45000 },
];

function QuotationPage() {
  const [rows,        setRows]        = useState(RATE_CARD.map(r=>({...r,qty:0})));
  const [disc,        setDisc]        = useState(0);
  // Resize special state
  const [resizeSrc,   setResizeSrc]   = useState(0);  // index in RESIZE_SOURCES
  const [resizeQty,   setResizeQty]   = useState(0);

  const resizePrice = Math.round(RESIZE_SOURCES[resizeSrc].price / 2);
  const resizeTotal = resizePrice * resizeQty;

  // lines for normal rows (skip Animate Motion Resize — handled separately)
  const normalRows = rows.filter(r=>r.service!=="Animate Motion Resize");
  const normalLines = normalRows.map(r=>r.basePrice*r.qty);
  const normalGross = normalLines.reduce((a,b)=>a+b,0);

  const gross     = normalGross + resizeTotal;
  const afterDisc = gross*(1-disc/100);
  const net       = afterDisc * 0.97;
  const reset     = () => { setRows(RATE_CARD.map(r=>({...r,qty:0}))); setResizeQty(0); };

  const categories = [...new Set(RATE_CARD.map(r=>r.category))];

  const setQty = (service, val) =>
    setRows(rw=>rw.map(x=>x.service===service?{...x,qty:Math.max(0,+val||0)}:x));

  return (
    <div className="page">
      <PageHeader title="คำนวณราคา" sub="Rate Card — ใส่จำนวน → ได้ยอดทันที"/>

      <div className="quote-ctrl">
        <div className="qc-grp">
          <div className="qc-lbl">ส่วนลด %</div>
          <input className="disc-inp" type="number" min="0" max="100" value={disc}
            onChange={e=>setDisc(Math.max(0,Math.min(100,+e.target.value)))}/>
        </div>
        <button className="btn-ghost" onClick={reset}>รีเซ็ต</button>
      </div>

      {categories.map(cat => {
        const catRows = rows.filter(r=>r.category===cat);
        const catGross = catRows.filter(r=>r.service!=="Animate Motion Resize")
          .reduce((a,r)=>a+r.basePrice*r.qty, 0)
          + (cat==="Social Content" ? resizeTotal : 0);

        return (
          <div key={cat} style={{marginBottom:16}}>
            {/* Category header */}
            <div style={{
              display:"flex",justifyContent:"space-between",alignItems:"center",
              padding:"9px 14px",background:"var(--sur2)",border:"1px solid var(--bdr)",
              borderBottom:"none",borderRadius:"9px 9px 0 0",
            }}>
              <span style={{fontSize:12,fontWeight:700,color:"var(--accent)",textTransform:"uppercase",letterSpacing:".06em"}}>{cat}</span>
              {catGross>0 && <span style={{fontSize:12,fontFamily:"monospace",color:"var(--acc2)"}}>subtotal {money(catGross)}</span>}
            </div>
            <div className="tbl-wrap" style={{borderRadius:"0 0 9px 9px"}}>
              <table className="tbl">
                <thead><tr>
                  <th>บริการ</th><th>Unit</th>
                  <th className="r">ราคา/หน่วย</th>
                  <th className="r">จำนวน</th>
                  <th className="r">รวม</th>
                </tr></thead>
                <tbody>
                  {catRows.map(r=>{
                    // ── Animate Motion Resize — special row ──
                    if (r.service==="Animate Motion Resize") {
                      return (
                        <tr key={r.service} className={resizeQty>0?"row-active":""}>
                          <td>
                            <div style={{fontWeight:600}}>Animate Motion Resize</div>
                            <div style={{marginTop:4,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                              <span style={{fontSize:11,color:"var(--muted)"}}>หารครึ่งจาก:</span>
                              <select
                                value={resizeSrc}
                                onChange={e=>setResizeSrc(+e.target.value)}
                                style={{fontSize:11,padding:"3px 6px",borderRadius:6,border:"1px solid var(--bdr)",
                                  background:"var(--sur2)",color:"var(--txt)",maxWidth:320}}>
                                {RESIZE_SOURCES.map((s,i)=>(
                                  <option key={i} value={i}>{s.label} — {money(s.price)}</option>
                                ))}
                              </select>
                            </div>
                          </td>
                          <td className="muted">ชิ้น</td>
                          <td className="r mono accent">
                            {money(resizePrice)}
                            <div style={{fontSize:10,color:"var(--muted)"}}>({money(RESIZE_SOURCES[resizeSrc].price)} ÷ 2)</div>
                          </td>
                          <td className="r">
                            <input className="qty-inp" type="number" min="0"
                              value={resizeQty||""} placeholder="0"
                              onChange={e=>setResizeQty(Math.max(0,+e.target.value||0))}/>
                          </td>
                          <td className="r mono">
                            {resizeQty>0
                              ? <span style={{color:"var(--accent)",fontWeight:600}}>{money(resizeTotal)}</span>
                              : <span className="muted">—</span>
                            }
                          </td>
                        </tr>
                      );
                    }

                    // ── Normal row ──
                    const line = r.basePrice * r.qty;
                    return (
                      <tr key={r.service} className={r.qty>0?"row-active":""}>
                        <td>
                          {r.service}
                          {r.note && <span style={{fontSize:10,color:"var(--muted)",marginLeft:6,fontStyle:"italic"}}>({r.note})</span>}
                        </td>
                        <td className="muted">{r.unit}</td>
                        <td className="r mono">
                          {r.basePrice===0
                            ? <span className="muted">—</span>
                            : money(r.basePrice)
                          }
                        </td>
                        <td className="r">
                          <input className="qty-inp" type="number" min="0"
                            value={r.qty||""} placeholder="0"
                            onChange={e=>setQty(r.service,e.target.value)}/>
                        </td>
                        <td className="r mono">
                          {r.qty>0 && r.basePrice>0
                            ? money(line)
                            : <span className="muted">—</span>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {gross>0 && (
        <div className="qr-card">
          <div className="qr-row"><span>Gross Total</span><span className="mono">{money(gross)}</span></div>
          {disc>0 && <div className="qr-row muted"><span>หลังส่วนลด {disc}%</span><span className="mono">{money(afterDisc)}</span></div>}
          <hr className="qr-hr"/>
          <div className="qr-row qr-net">
            <span>Net (หัก VAT 3%)</span>
            <span className="mono accent fw6">{money(net)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ APP ════════════════════════════════════════════════════
export default function App() {
  const [page, setPage] = useState("overview");
  const [dark, setDark] = useState(true);
  const [tick, setTick] = useState(0);
  const trigger = () => setTick(t=>t+1);
  const [sharedPrivate,   setSharedPrivate]   = useState([]);
  const [sharedBriefhere, setSharedBriefhere] = useState([]);

  // โหลดข้อมูลจาก Supabase ตอน app เริ่ม
  useEffect(() => {
    const loadAll = async () => {
      try {
        const [privRows, bhRows] = await Promise.all([
          sbSelect("private_jobs"),
          sbSelect("briefhere_jobs"),
        ]);
        setSharedPrivate(privRows);
        setSharedBriefhere(bhRows);
      } catch(e) {
        console.error("Load failed:", e);
      }
    };
    loadAll();
  }, []);

  const [badges, setBadges] = useState({wait:0, overdueHome:0, overdueCar:0});
  useEffect(()=>{
    const loadBadges = async () => {
      try {
        const [home, car, priv, bh] = await Promise.all([
          sbSelect("maintenance_home"),
          sbSelect("maintenance_car"),
          sbSelect("private_jobs"),
          sbSelect("briefhere_jobs"),
        ]);
        setBadges({
          overdueHome: home.filter(m=>m.next_date&&diffDays(m.next_date)<0).length,
          overdueCar:  car.filter(m=>m.next_date&&diffDays(m.next_date)<0).length,
          wait: [...priv,...bh].filter(r=>r.status==="Finish/Wait").length,
        });
      } catch(e) {}
    };
    loadBadges();
  },[tick]);

  const renderPage = () => {
    if (page==="overview")    return <Overview    setPage={setPage} tick={tick} privateSbData={sharedPrivate} briefhereSbData={sharedBriefhere}/>;
    if (page==="summary")     return <SummaryPage setPage={setPage} privateSbData={sharedPrivate} briefhereSbData={sharedBriefhere}/>;
    if (page==="private")     return <PrivatePage tick={tick} triggerRefresh={trigger} onDataLoad={setSharedPrivate}/>;
    if (page==="briefhere")   return <BriefherePage tick={tick} triggerRefresh={trigger} onDataLoad={setSharedBriefhere}/>;
    if (page==="income")      return <IncomePage   tick={tick} privateSbData={sharedPrivate} briefhereSbData={sharedBriefhere}/>;
    if (page==="maint-home")  return <MaintHomePage tick={tick} triggerRefresh={trigger}/>;
    if (page==="maint-car")   return <MaintCarPage  tick={tick} triggerRefresh={trigger}/>;
    if (page==="quotation")   return <QuotationPage/>;
  };

  return (
    <div className={`shell ${dark?"dark":"light"}`}>
      <style>{CSS}</style>
      <aside className="sidebar">
        <div>
          <div className="sb-brand">
            <div className="sb-logo">PA</div>
            <div><div className="sb-name">Ultimate PA</div><div className="sb-sub">Dashboard 2026</div></div>
          </div>
          <nav className="sb-nav">
            {NAV_GROUPS.map(g=>(
              <div key={g.group}>
                <div className="nav-group-label">{g.group}</div>
                {g.items.map(n=>(
                  <button key={n.id} className={`nav-btn${page===n.id?" nav-active":""}`} onClick={()=>setPage(n.id)}>
                    <span className="nav-icon">{n.icon}</span>
                    <span className="nav-lbl">{n.label}</span>
                    {n.id==="income"     && badges.wait>0        && <span className="nav-badge">{badges.wait}</span>}
                    {n.id==="maint-home" && badges.overdueHome>0 && <span className="nav-badge nav-bdanger">{badges.overdueHome}</span>}
                    {n.id==="maint-car"  && badges.overdueCar>0  && <span className="nav-badge nav-bdanger">{badges.overdueCar}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </div>
        <button className="mode-btn" onClick={()=>setDark(d=>!d)}>{dark?"☀ Light":"◗ Dark"}</button>
      </aside>
      <main className="content">{renderPage()}</main>

      {/* Bottom Nav — mobile only */}
      <nav className="bottom-nav" style={{display:"none"}}>
        {[
          {id:"overview",   icon:"⬡", label:"Overview"},
          {id:"private",    icon:"◈", label:"งานนอก"},
          {id:"briefhere",  icon:"◉", label:"งานเพจ"},
          {id:"maint-home", icon:"🏠", label:"บ้าน"},
          {id:"maint-car",  icon:"🚗", label:"รถ"},
        ].map(n=>(
          <button key={n.id} className={`bn-item${page===n.id?" active":""}`} onClick={()=>setPage(n.id)}>
            <span className="bn-icon">{n.icon}</span>
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ═══ CSS ════════════════════════════════════════════════════
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
button{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit}
html{-webkit-text-size-adjust:100%}

.shell{display:flex;height:100vh;overflow:hidden;font-family:'Noto Sans Thai',sans-serif}
.bottom-nav{display:none} /* hidden by default, shown via media query */

/* ── LIGHT (default) ── */
.light{
  --bg:#f4f6fb;
  --sur:#ffffff;
  --sur2:#f8f9fc;
  --bdr:#e8ecf4;
  --txt:#1a2035;
  --muted:#8b96b0;
  --accent:#6366f1;
  --acc2:#f59e0b;
  --danger:#ef4444;
  --warn:#f59e0b;
  --ok:#10b981;
  --sb:#ffffff;
  --sb-bdr:#eef0f7;
  background:var(--bg);color:var(--txt)
}

/* ── DARK (default) ── */
.dark{
  --bg:#0f1117;
  --sur:#181c25;
  --sur2:#1e2230;
  --bdr:#252b3b;
  --txt:#e2e8f8;
  --muted:#4a5468;
  --accent:#818cf8;
  --acc2:#fbbf24;
  --danger:#f87171;
  --warn:#fbbf24;
  --ok:#34d399;
  --sb:#181c25;
  --sb-bdr:#252b3b;
  background:var(--bg);color:var(--txt)
}

/* ── SIDEBAR ── */
.sidebar{
  width:220px;flex-shrink:0;
  background:var(--sb);
  border-right:1px solid var(--sb-bdr);
  display:flex;flex-direction:column;justify-content:space-between;
  padding:24px 0;position:sticky;top:0;height:100vh;overflow-y:auto
}
.sb-brand{display:flex;align-items:center;gap:12px;padding:0 20px 22px;border-bottom:1px solid var(--sb-bdr);margin-bottom:8px}
.sb-logo{
  width:36px;height:36px;border-radius:10px;
  background:linear-gradient(135deg,var(--accent),#a855f7);
  color:#fff;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
  box-shadow:0 4px 12px rgba(99,102,241,.35)
}
.sb-name{font-size:13px;font-weight:700;color:var(--txt)}
.sb-sub{font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:1px}
.sb-nav{padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.nav-group-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding:14px 10px 5px;opacity:.7}
.nav-btn{
  display:flex;align-items:center;gap:10px;padding:10px 12px;
  border-radius:10px;border:none;background:transparent;
  color:var(--muted);font-size:13px;text-align:left;transition:all .15s;width:100%
}
.nav-btn:hover{background:var(--sur2);color:var(--txt)}
.nav-active{background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(168,85,247,.08))!important;color:var(--accent)!important;font-weight:600}
.nav-icon{font-size:15px;width:18px;text-align:center;flex-shrink:0}
.nav-lbl{flex:1}
.nav-badge{font-family:'JetBrains Mono',monospace;font-size:10px;background:var(--accent);color:#fff;padding:1px 6px;border-radius:99px;font-weight:700}
.nav-bdanger{background:var(--danger)!important;color:#fff!important}
.mode-btn{margin:0 12px;padding:9px;border-radius:10px;border:1px solid var(--bdr);background:transparent;color:var(--muted);font-size:11px;font-family:'JetBrains Mono',monospace;transition:all .15s}
.mode-btn:hover{border-color:var(--accent);color:var(--accent)}

/* ── CONTENT ── */
.content{flex:1;min-width:0;overflow-y:auto;height:100vh}
.page{padding:32px 36px;width:100%;animation:fadeUp .2s ease;box-sizing:border-box}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;gap:16px}
.page-title{font-size:26px;font-weight:700;color:var(--txt)}
.page-sub{font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:3px}
.sec-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:28px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--bdr)}

/* ── OV CARDS ── */
.ov-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:28px}
.ov-card{
  background:var(--sur);border:1px solid var(--bdr);border-radius:16px;
  padding:20px;text-align:left;display:flex;flex-direction:column;gap:4px;
  transition:all .2s;position:relative;overflow:hidden;width:100%;
  box-shadow:0 1px 4px rgba(0,0,0,.04)
}
.ov-card:hover{transform:translateY(-3px);box-shadow:0 8px 28px rgba(99,102,241,.12);border-color:var(--accent)}
.ov-accent{background:linear-gradient(135deg,rgba(99,102,241,.08),rgba(168,85,247,.06));border-color:rgba(99,102,241,.3)}
.ov-warn{border-color:rgba(239,68,68,.3)}
.ovc-icon{font-size:20px;color:var(--accent);margin-bottom:8px}
.ovc-label{font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.05em}
.ovc-val{font-size:22px;font-weight:700;margin:4px 0;color:var(--txt)}
.ovc-sub{font-size:12px;color:var(--muted)}
.ovc-arrow{position:absolute;right:16px;top:50%;transform:translateY(-50%);font-size:16px;color:var(--bdr);transition:color .15s}
.ov-card:hover .ovc-arrow{color:var(--accent)}

/* ── PROGRESS ── */
.prog-card{background:var(--sur);border:1px solid var(--bdr);border-radius:16px;padding:22px;margin-bottom:26px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.prog-rows{display:flex;flex-direction:column;gap:2px;margin-bottom:16px}
.prog-row{display:flex;justify-content:space-between;padding:5px 0;font-size:14px}
.prog-total{font-weight:700;font-size:16px}
.prog-hr{border:none;border-top:1px solid var(--bdr);margin:10px 0}
.prog-bar-row{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.prog-bar{flex:1;height:8px;background:var(--sur2);border-radius:99px;overflow:hidden}
.prog-fill{height:100%;background:linear-gradient(90deg,var(--accent),#a855f7);border-radius:99px;transition:width .8s cubic-bezier(.4,0,.2,1)}
.prog-pct{font-family:'JetBrains Mono',monospace;font-size:13px;min-width:48px;text-align:right;color:var(--accent)}
.prog-goal{font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace;text-align:right}

/* ── QUICK LINKS ── */
.ql-row{display:flex;gap:8px;flex-wrap:wrap}
.ql-btn{display:flex;align-items:center;gap:7px;padding:9px 16px;border-radius:10px;border:1px solid var(--bdr);background:var(--sur);font-size:13px;transition:all .15s;color:var(--txt);box-shadow:0 1px 3px rgba(0,0,0,.04)}
.ql-btn:hover{border-color:var(--accent);color:var(--accent);box-shadow:0 4px 12px rgba(99,102,241,.1)}

/* ── STAT ROW ── */
.stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
.stat-box{background:var(--sur);border:1px solid var(--bdr);border-radius:14px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.stat-warn{border-color:rgba(245,158,11,.4)}
.stat-accent{border-color:rgba(99,102,241,.35)}
.stat-lbl{font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-bottom:7px;text-transform:uppercase;letter-spacing:.05em}
.stat-val{font-size:22px;font-weight:700;font-family:'JetBrains Mono',monospace}

/* ── INCOME ── */
.income-blocks{display:flex;align-items:stretch;gap:12px;margin-bottom:22px;flex-wrap:wrap}
.income-block{flex:1;min-width:180px;background:var(--sur);border:1px solid var(--bdr);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:8px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.income-block-total{border-color:rgba(99,102,241,.35);background:linear-gradient(135deg,rgba(99,102,241,.06),rgba(168,85,247,.04))}
.ib-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.ib-icon{color:var(--accent);font-size:16px}
.ib-row{display:flex;justify-content:space-between;font-size:13px}
.ib-total{font-size:28px;font-weight:800;font-family:'JetBrains Mono',monospace;color:var(--accent)}
.ib-goal{font-size:12px}
.income-plus{display:flex;align-items:center;font-size:24px;color:var(--muted);padding:0 4px;flex-shrink:0}

/* ── FILTERS ── */
.filter-row{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}
.filter-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--bdr);background:transparent;color:var(--muted);font-size:12px;transition:all .15s}
.filter-btn:hover{border-color:var(--accent);color:var(--accent)}
.filter-btn.active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}

/* ── TABLE ── */
.tbl-wrap{overflow-x:auto;border-radius:14px;border:1px solid var(--bdr);margin-bottom:8px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--bdr);background:var(--sur2);font-family:'JetBrains Mono',monospace;white-space:nowrap}
.tbl td{padding:11px 14px;border-bottom:1px solid var(--bdr);vertical-align:middle}
.tbl tr:last-child td{border-bottom:none}
.tbl tbody tr:hover td{background:rgba(99,102,241,.03)}
.r{text-align:right}
.row-active td{background:rgba(99,102,241,.04)}
.row-danger td{background:rgba(239,68,68,.05)!important}
.row-warn td{background:rgba(245,158,11,.05)!important}

/* ── CHIPS ── */
.chip{font-size:10px;font-family:'JetBrains Mono',monospace;padding:3px 8px;border-radius:6px;white-space:nowrap;font-weight:600}
.chip-priv{background:rgba(16,185,129,.12);color:#059669}
.chip-bh{background:rgba(245,158,11,.12);color:#d97706}
.chip-done{background:rgba(16,185,129,.12);color:#059669}
.chip-wip{background:rgba(99,102,241,.12);color:#6366f1}
.chip-wait{background:rgba(245,158,11,.12);color:#d97706}
.chip-cancel{background:rgba(239,68,68,.1);color:#dc2626;text-decoration:line-through}
.chip-hold{background:rgba(148,163,184,.15);color:#64748b}

/* ── MAINTENANCE ── */
.maint-legend{display:flex;gap:8px;margin-bottom:16px}
.mst{font-size:11px;font-family:'JetBrains Mono',monospace;padding:3px 10px;border-radius:6px;white-space:nowrap;font-weight:600}
.mst-overdue{background:rgba(239,68,68,.12);color:#dc2626}
.mst-warn{background:rgba(245,158,11,.12);color:#d97706}
.mst-ok{background:rgba(16,185,129,.12);color:#059669}
.mst-none{background:rgba(100,116,139,.12);color:#64748b}

/* ── ROW ACTIONS ── */
.row-actions{display:flex;gap:4px;justify-content:flex-end}
.act-btn{padding:5px 9px;border-radius:7px;border:1px solid var(--bdr);background:transparent;color:var(--muted);font-size:12px;transition:all .15s}
.act-btn:hover{border-color:var(--accent);color:var(--accent);background:rgba(99,102,241,.06)}
.act-del:hover{border-color:var(--danger)!important;color:var(--danger)!important;background:rgba(239,68,68,.06)!important}

/* ── BUTTONS ── */
.btn-primary{padding:9px 20px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:13px;font-weight:600;transition:all .15s;box-shadow:0 4px 12px rgba(99,102,241,.3)}
.btn-primary:hover{opacity:.88;box-shadow:0 6px 16px rgba(99,102,241,.4)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.btn-ghost{padding:9px 16px;border-radius:10px;border:1px solid var(--bdr);background:transparent;color:var(--muted);font-size:13px;transition:all .15s}
.btn-ghost:hover{border-color:var(--txt);color:var(--txt)}
.btn-danger{padding:9px 18px;border-radius:10px;border:none;background:var(--danger);color:#fff;font-size:13px;font-weight:600}
.btn-danger:hover{opacity:.85}

/* ── MODAL ── */
.modal-overlay{position:fixed;inset:0;background:rgba(15,17,23,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-box{background:var(--sur);border:1px solid var(--bdr);border-radius:20px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.15)}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:20px 24px;border-bottom:1px solid var(--bdr)}
.modal-title{font-size:15px;font-weight:700}
.modal-close{padding:5px 10px;border-radius:8px;border:1px solid var(--bdr);background:transparent;color:var(--muted);transition:all .15s}
.modal-close:hover{border-color:var(--danger);color:var(--danger)}
.modal-body{padding:22px 24px;display:flex;flex-direction:column;gap:14px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}

/* ── FORM ── */
.field{display:flex;flex-direction:column;gap:5px}
.field-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.inp{padding:10px 13px;border-radius:10px;border:1.5px solid var(--bdr);background:var(--sur2);color:var(--txt);font-size:13px;transition:border-color .15s;width:100%}
.inp:focus{outline:none;border-color:var(--accent)}
textarea.inp{resize:vertical;min-height:70px;line-height:1.6}

/* ── QUOTATION ── */
.quote-ctrl{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;background:var(--sur);border:1px solid var(--bdr);border-radius:14px;padding:18px 22px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.qc-grp{display:flex;flex-direction:column;gap:7px}
.qc-lbl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.disc-inp{width:80px;padding:8px 10px;border-radius:8px;border:1.5px solid var(--bdr);background:var(--sur2);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:14px;text-align:center}
.disc-inp:focus{outline:none;border-color:var(--accent)}
.qty-inp{width:64px;padding:6px 8px;border-radius:7px;border:1.5px solid var(--bdr);background:var(--sur2);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;text-align:center;transition:border-color .15s}
.qty-inp:focus{outline:none;border-color:var(--accent)}
.qr-card{background:linear-gradient(135deg,rgba(99,102,241,.06),rgba(168,85,247,.04));border:1px solid rgba(99,102,241,.2);border-radius:14px;padding:22px;margin-top:16px}
.qr-row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px}
.qr-hr{border:none;border-top:1px solid var(--bdr);margin:10px 0}
.qr-net{font-size:18px;font-weight:700}

/* ── YEAR HEADER ── */
.yr-hdr{display:flex;align-items:center;padding:14px 18px;background:var(--sur2);border:1px solid var(--bdr);border-bottom:none;border-radius:14px 14px 0 0;flex-wrap:wrap;gap:8px}
.yr-num{font-size:22px;font-weight:800;font-family:'JetBrains Mono',monospace;color:var(--accent);min-width:64px}
.yr-stats{display:flex;align-items:center;flex:1;flex-wrap:wrap}
.yr-stat{display:flex;flex-direction:column;gap:2px;padding:0 14px}
.yr-lbl{font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.06em}
.yr-val{font-size:14px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--txt)}
.yr-sep{width:1px;height:28px;background:var(--bdr);flex-shrink:0}
.yr-subtotal td{padding:9px 14px;background:var(--sur2);border-top:2px solid var(--bdr)}

/* ── UTILS ── */
.mono{font-family:'JetBrains Mono',monospace}
.mono-sm{font-family:'JetBrains Mono',monospace;font-size:12px}
.muted{color:var(--muted)}
.accent{color:var(--accent)}
.fw6{font-weight:600}
.empty{text-align:center;padding:32px;color:var(--muted);font-style:italic}

/* ── ALERT (kept for maintenance etc, but hidden in overview) ── */
.alert-bar{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-left:4px solid var(--warn);color:var(--warn);padding:12px 16px;border-radius:10px;font-size:13px;margin-bottom:14px}
.alert-danger{background:rgba(239,68,68,.08)!important;border-color:rgba(239,68,68,.3)!important;border-left-color:var(--danger)!important;color:var(--danger)!important}

.btn-sheet{padding:8px 16px;border-radius:10px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-size:12px;font-weight:600;transition:all .15s;cursor:pointer}
.btn-sheet:hover{background:rgba(129,140,248,.1)}
.btn-sheet:disabled{opacity:.5;cursor:not-allowed}
.btn-sheet-active{background:rgba(129,140,248,.15);border-color:var(--accent)}

/* ── YEAR SELECTOR (Overview) ── */
.yr-sel-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--bdr);background:transparent;color:var(--muted);font-size:13px;font-family:'JetBrains Mono',monospace;font-weight:500;transition:all .15s}
.yr-sel-btn:hover{border-color:var(--accent);color:var(--accent)}
.yr-sel-active{background:var(--accent)!important;border-color:var(--accent)!important;color:#fff!important;font-weight:700}

/* ── PROG CARD ACCENT (summary) ── */
.prog-card-accent{border-color:rgba(129,140,248,.4)!important;background:linear-gradient(135deg,rgba(129,140,248,.08),rgba(168,85,247,.05))!important}

/* ══ RESPONSIVE — TABLET (≤1024px) ══════════════════════════ */
@media(max-width:1024px){
  .sidebar{width:64px}
  .nav-lbl,.sb-name,.sb-sub{display:none}
  .nav-badge,.nav-bdanger{display:none}
  .sb-brand{justify-content:center;padding:0 0 16px}
  .nav-group-label{display:none}
  .nav-btn{justify-content:center;padding:10px}
  .nav-icon{width:auto;font-size:18px}
  .stat-val{font-size:18px}
  .ov-grid{grid-template-columns:repeat(3,1fr)}
}

/* ══ RESPONSIVE — MOBILE (≤768px) ═══════════════════════════ */
@media(max-width:768px){
  /* ── Layout: ซ่อน sidebar ซ้าย ใช้ bottom nav แทน ── */
  .shell{flex-direction:column;padding-bottom:64px}
  .sidebar{
    display:none  /* ซ่อน sidebar ปกติบน mobile */
  }
  .content{overflow-y:auto;height:100dvh}

  /* ── Bottom Navigation ── */
  .bottom-nav{
    display:flex!important;
    position:fixed;bottom:0;left:0;right:0;
    background:var(--sur);border-top:1px solid var(--bdr);
    z-index:100;height:64px;
    align-items:stretch;
    box-shadow:0 -4px 20px rgba(0,0,0,.12);
  }
  .bn-item{
    flex:1;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:3px;border:none;background:transparent;
    color:var(--muted);font-size:9px;font-weight:500;cursor:pointer;
    padding:6px 2px;transition:color .15s;position:relative;
  }
  .bn-item.active{color:var(--accent)}
  .bn-item.active::after{
    content:'';position:absolute;top:0;left:20%;right:20%;
    height:2px;background:var(--accent);border-radius:0 0 2px 2px;
  }
  .bn-icon{font-size:18px;line-height:1}
  .bn-badge{
    position:absolute;top:6px;right:calc(50% - 14px);
    background:var(--danger);color:#fff;
    font-size:9px;padding:1px 4px;border-radius:99px;font-weight:700;
    min-width:14px;text-align:center;
  }

  /* ── Page padding ── */
  .page{padding:16px 12px 12px}
  .page-header{flex-direction:column;gap:10px;margin-bottom:16px}
  .page-title{font-size:20px}
  .page-sub{font-size:11px}

  /* ── Cards grid ── */
  .ov-grid{grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
  .stat-row{grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .ovc-val{font-size:17px}
  .stat-val{font-size:17px}
  .stat-lbl{font-size:10px}

  /* ── Income blocks ── */
  .income-blocks{flex-direction:column;gap:8px}
  .income-plus{display:none}

  /* ── Filters — scroll horizontal ── */
  .filter-row{flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px;
    -webkit-overflow-scrolling:touch;scrollbar-width:none}
  .filter-row::-webkit-scrollbar{display:none}
  .filter-btn{white-space:nowrap;flex-shrink:0;padding:5px 12px;font-size:11px}

  /* ── Table — scroll horizontal ── */
  .tbl-wrap{border-radius:10px;-webkit-overflow-scrolling:touch}
  .tbl{font-size:12px;min-width:600px}
  .tbl th{padding:8px 10px;font-size:9px}
  .tbl td{padding:9px 10px}

  /* ── Year header ── */
  .yr-hdr{padding:10px 12px}
  .yr-num{font-size:18px;min-width:50px}
  .yr-sep{display:none}
  .yr-stat{padding:0 8px}
  .yr-lbl{font-size:9px}
  .yr-val{font-size:12px}

  /* ── Prog card ── */
  .prog-card{padding:14px}

  /* ── Modal ── */
  .modal-overlay{align-items:flex-end;padding:0}
  .modal-box{border-radius:20px 20px 0 0;max-height:85vh;max-width:100%}

  /* ── Buttons ── */
  .btn-primary,.btn-ghost,.btn-sheet{font-size:12px;padding:7px 12px}
  .btn-sheet{font-size:11px;padding:6px 10px}

  /* ── Page header action wrap ── */
  .page-header > div:last-child{display:flex;flex-wrap:wrap;gap:6px;width:100%}
  .page-header > div:last-child button{flex:1;min-width:120px;text-align:center;justify-content:center}

  /* ── Summary chart ── */
  .ov-grid{grid-template-columns:1fr 1fr}
}

/* ══ RESPONSIVE — SMALL MOBILE (≤480px) ═════════════════════ */
@media(max-width:480px){
  .ov-grid{grid-template-columns:1fr}
  .stat-row{grid-template-columns:1fr}
  .page{padding:12px 10px 10px}
  .page-title{font-size:18px}
  .ovc-val{font-size:16px}
  .stat-val{font-size:16px}
  .ib-total{font-size:22px}
}
`;
