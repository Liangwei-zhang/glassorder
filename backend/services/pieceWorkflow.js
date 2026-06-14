const DEFAULT_STEPS = ['cut', 'edge', 'tempered'];
const LEGACY_STEPS = DEFAULT_STEPS;
const ALL_STEPS = ['cut', 'edge', 'tempered', 'polish'];
const DISPLAY_STAGES = ['cut', 'edge', 'tempered', 'polish', 'finished'];

function parseJSON(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function normalizeRequiredSteps(value, options = {}) {
  const fallbackSteps = Array.isArray(options.fallbackSteps) && options.fallbackSteps.length
    ? options.fallbackSteps
    : DEFAULT_STEPS;
  const parsed = parseJSON(value, value);
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.required_steps)
      ? parsed.required_steps
      : fallbackSteps;
  const seen = new Set();
  const out = [];
  for (const step of raw) {
    if (ALL_STEPS.includes(step) && !seen.has(step)) {
      seen.add(step);
      out.push(step);
    }
  }
  return out.length ? out : [...fallbackSteps];
}

function normalizeCompletedSteps(value) {
  const raw = parseJSON(value, []);
  const seen = new Set();
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const step of raw) {
    if (ALL_STEPS.includes(step) && !seen.has(step)) {
      seen.add(step);
      out.push(step);
    }
  }
  return out;
}

function inferCompletedFromStage(stage, requiredSteps) {
  if (stage === 'finished') return [...requiredSteps];
  const idx = ALL_STEPS.indexOf(stage);
  if (idx <= 0) return [];
  return ALL_STEPS.slice(0, idx).filter((step) => requiredSteps.includes(step));
}

function hydratePieceWorkflow(piece) {
  if (!piece) return piece;
  const requiredSteps = normalizeRequiredSteps(piece.process_config, { fallbackSteps: DEFAULT_STEPS });
  let completedSteps = normalizeCompletedSteps(piece.completed_steps);
  if (!completedSteps.length && piece.stage && piece.stage !== 'cut') {
    completedSteps = inferCompletedFromStage(piece.stage, requiredSteps);
  }
  const remainingSteps = requiredSteps.filter((step) => !completedSteps.includes(step));
  return {
    ...piece,
    process_config: { required_steps: requiredSteps },
    completed_steps: completedSteps,
    required_steps: requiredSteps,
    remaining_steps: remainingSteps,
    next_step: remainingSteps[0] || null,
  };
}

function nextStageFor(requiredSteps, completedSteps) {
  const remaining = requiredSteps.filter((step) => !completedSteps.includes(step));
  return remaining[0] || 'finished';
}

function advancePieceState(piece, { completeAll = false } = {}) {
  const hydrated = hydratePieceWorkflow(piece);
  const completed = new Set(hydrated.completed_steps);
  if (completeAll) {
    hydrated.required_steps.forEach((step) => completed.add(step));
  } else if (hydrated.next_step) {
    completed.add(hydrated.next_step);
  }
  const completedSteps = hydrated.required_steps.filter((step) => completed.has(step));
  return {
    stage: nextStageFor(hydrated.required_steps, completedSteps),
    completed_steps: completedSteps,
  };
}

function sendPieceToPolishState(piece) {
  const hydrated = hydratePieceWorkflow(piece);
  if (!hydrated.required_steps.includes('tempered') || !hydrated.completed_steps.includes('tempered')) {
    return null;
  }
  const requiredSteps = hydrated.required_steps.includes('polish')
    ? hydrated.required_steps
    : [...hydrated.required_steps, 'polish'];
  const completedSteps = hydrated.completed_steps.filter((step) => step !== 'polish');
  return {
    stage: 'polish',
    required_steps: requiredSteps,
    completed_steps: completedSteps,
  };
}

function returnPreviousPieceState(piece) {
  const hydrated = hydratePieceWorkflow(piece);
  const completedSteps = [...hydrated.completed_steps];
  if (!completedSteps.length) return null;
  const stage = completedSteps.pop();
  return {
    stage,
    completed_steps: completedSteps,
    required_steps: hydrated.required_steps,
  };
}

function redoPieceState(piece) {
  const hydrated = hydratePieceWorkflow(piece);
  return {
    stage: 'cut',
    completed_steps: [],
    required_steps: hydrated.required_steps,
  };
}

function processConfigJSON(requiredSteps) {
  return JSON.stringify({ required_steps: normalizeRequiredSteps(requiredSteps) });
}

function completedStepsJSON(completedSteps) {
  return JSON.stringify(normalizeCompletedSteps(completedSteps));
}

function workflowSummary(piece) {
  const hydrated = hydratePieceWorkflow(piece);
  return {
    required_steps: hydrated.required_steps,
    completed_steps: hydrated.completed_steps,
    next_step: hydrated.next_step,
  };
}

module.exports = {
  ALL_STEPS,
  DEFAULT_STEPS,
  DISPLAY_STAGES,
  LEGACY_STEPS,
  advancePieceState,
  completedStepsJSON,
  hydratePieceWorkflow,
  normalizeRequiredSteps,
  processConfigJSON,
  redoPieceState,
  returnPreviousPieceState,
  sendPieceToPolishState,
  workflowSummary,
};
