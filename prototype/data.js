// Demo data shared across prototype pages - in-memory, resets on refresh
// Real app will replace this with API calls

// Real specs extracted from sample PDF "Glass Order - 2605011 Inspire --8 Heritage Cove"
// Each piece has its own thumbnail drawing + full-drawing page from the uploaded PDF
const SAMPLE_PIECES_2605011 = [
  { size: '58-3/8" × 83-13/16"', type: 'Clear Tempered', thickness: '10mm', weight: '167.2lb', note: 'Flat Polish · Tempered logo · Irregular Shape' },
  { size: '15-1/4" × 83-3/4"',   type: 'Clear Tempered', thickness: '10mm', weight: '43.6lb',  note: 'Flat Polish · Tempered logo' },
  { size: '30-1/8" × 8"',        type: 'Clear Tempered', thickness: '10mm', weight: '8.2lb',   note: 'Flat Polish · Tempered logo' },
  { size: '30" × 75-1/4"',       type: 'Clear Tempered', thickness: '10mm', weight: '77.1lb',  note: 'Flat Polish · Tempered · 2× Ø1/2" 孔' },
  { size: '16-3/8" × 75-1/4"',   type: 'Mirror Clear Annealed', thickness: '5mm', weight: '18.4lb', note: 'Mirror · Flat Polish' },
  { size: '16-3/8" × 75-1/4"',   type: 'Mirror Clear Annealed', thickness: '5mm', weight: '18.4lb', note: 'Mirror · Flat Polish' },
  { size: '16-3/8" × 75-1/4"',   type: 'Mirror Clear Annealed', thickness: '5mm', weight: '18.4lb', note: 'Mirror · Flat Polish' },
  { size: '16-3/8" × 75-1/4"',   type: 'Mirror Clear Annealed', thickness: '5mm', weight: '18.4lb', note: 'Mirror · Flat Polish' },
];

function randSize(seed) {
  const widths  = [300, 400, 500, 600, 800, 1000, 1200];
  const heights = [400, 600, 800, 1200, 1500, 1800, 2000];
  return `${widths[seed % widths.length]}×${heights[(seed * 3) % heights.length]}mm`;
}

function makePieces(n, opts = {}) {
  // Stages: cut -> edge -> tempered -> finished
  // piece.stage = which stage needs to work on this piece next (or is currently working)
  // piece.stageStatus = 'pending' (not yet started in this stage) | 'in_progress' | 'done' (only used when stage='finished')
  const arr = [];
  for (let i = 1; i <= n; i++) {
    let stage = 'cut';
    let stageStatus = 'pending';
    let broken = false;
    let hold = false;
    let rework = false;

    if (opts.finished || opts.done_all) { stage = 'finished'; stageStatus = 'done'; }
    else if (opts.mix) {
      const r = i / n;
      if (r < 0.3) { stage = 'tempered'; stageStatus = 'pending'; }       // cut+edge done
      else if (r < 0.5) { stage = 'edge'; stageStatus = 'in_progress'; }  // cut done, edge in progress
      else if (r < 0.8) { stage = 'edge'; stageStatus = 'pending'; }      // cut done, edge waiting
      else { stage = 'cut'; stageStatus = 'pending'; }
    }

    if (opts.rework && opts.rework.includes(i)) { rework = true; stage = 'cut'; stageStatus = 'pending'; }
    if (opts.hold && opts.hold.includes(i)) { hold = true; }

    let spec;
    if (opts.realSpecs && i <= SAMPLE_PIECES_2605011.length) {
      spec = SAMPLE_PIECES_2605011[i - 1];
    } else {
      spec = { size: randSize(i), type: 'Clear', thickness: '6mm', weight: '', note: '' };
    }

    arr.push({
      n: i, stage, stageStatus, broken, hold, rework,
      size: spec.size, type: spec.type, thickness: spec.thickness, weight: spec.weight, note: spec.note,
      drawing: (opts.realSpecs && i <= 8) ? `sample-pdf/piece${i}.jpg` : null,
    });
  }
  return arr;
}

const DEMO_ORDERS = [
  {
    id: '2605011',
    company: 'Inspire Homes',
    project: '8 Heritage Cove',
    createdAt: '2026-05-09 09:14',
    deadline: '2026-05-14',
    priority: 'rush',                // normal | rush | rework
    status: 'in_production',         // new | in_production | ready_pickup | picked_up
    totalPieces: 8,
    note: '客户要求靠窗大片优先。第 3 片 HOLD 等尺寸确认。',
    pieces: makePieces(8, { rework: [6], hold: [3], realSpecs: true }),
  },
  {
    id: '2605008',
    company: 'Coastline Glass Co.',
    project: '32 Ocean Ave',
    createdAt: '2026-05-09 14:20',
    deadline: '2026-05-15',
    priority: 'normal',
    status: 'in_production',
    totalPieces: 12,
    note: '',
    pieces: makePieces(12, { done_all: true }),
  },
  {
    id: '2605003',
    company: 'Northgate Developments',
    project: '12 Maple Rd',
    createdAt: '2026-05-08 11:05',
    deadline: '2026-05-13',
    priority: 'normal',
    status: 'ready_pickup',
    totalPieces: 8,
    note: '取货时携带合同副本',
    pieces: makePieces(8, { done_all: true, finished: true }),
  },
  {
    id: '2604099',
    company: 'Inspire Homes',
    project: '5 Harbour St',
    createdAt: '2026-05-01 10:00',
    deadline: '2026-05-06',         // already overdue
    priority: 'normal',
    status: 'in_production',
    totalPieces: 16,
    note: '超过计划完工 5 天',
    pieces: makePieces(16, { mix: true }),
  },
];

// Piece state -> CSS class for the grid
function pieceClass(p) {
  if (p.broken) return 'piece broken';
  if (p.rework) return 'piece rework';
  if (p.hold)   return 'piece hold';
  if (p.stageStatus === 'done') return 'piece done';
  if (p.stageStatus === 'in_progress') return 'piece current';
  return 'piece pending';
}

// Rush/overdue helpers
function daysUntil(dateStr) {
  const today = new Date('2026-05-11');
  const d = new Date(dateStr);
  return Math.round((d - today) / 86400000);
}
function isOverdue(o) { return daysUntil(o.deadline) < 0 && o.status !== 'ready_pickup' && o.status !== 'picked_up'; }

function findOrder(id) { return DEMO_ORDERS.find(o => o.id === id); }

// Progress percentage — each piece moves from cut (0) to finished (3)
const STAGES = ['cut', 'edge', 'tempered', 'finished'];
function orderProgress(o) {
  let units = 0;
  o.pieces.forEach(p => {
    let idx = STAGES.indexOf(p.stage);
    if (idx < 0) idx = 0;
    units += idx;
  });
  return Math.round((units / (o.pieces.length * (STAGES.length - 1))) * 100);
}

function reworkCount(o) { return o.pieces.filter(p => p.rework).length; }
function brokenCount(o) { return o.pieces.filter(p => p.broken).length; }

// Pieces shown to the worker at a given stage:
// - Any piece whose current stage === the selected stage (pending OR in_progress) is shown
// - Not broken
function piecesForStage(o, stage) {
  return o.pieces.filter(p => !p.broken && p.stage === stage);
}

// Advance a piece to the next stage (called when worker taps "本工序完成")
function advancePieceStage(piece) {
  const idx = STAGES.indexOf(piece.stage);
  if (idx < 0 || idx >= STAGES.length - 1) {
    piece.stage = 'finished';
    piece.stageStatus = 'done';
  } else {
    piece.stage = STAGES[idx + 1];
    piece.stageStatus = 'pending';
  }
  piece.rework = false;
}

// Persist between pages via sessionStorage for demo interactions
// Bump this when DEMO_ORDERS schema changes so old cached data is invalidated
const STORAGE_KEY = 'glassfactory_demo_v4';
function loadState() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  return { orders: DEMO_ORDERS };
}
function saveState(state) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function resetState() { sessionStorage.removeItem(STORAGE_KEY); }

// Stage display
const STAGE_ZH = { cut: '切玻璃', edge: '开切口', tempered: '钢化', finished: '完成' };
