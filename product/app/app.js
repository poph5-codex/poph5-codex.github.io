const DATA_VERSION = '20260701-13';

const state = {
  seeds: {},
  currentKey: 'reference',
  config: null,
  result: null,
  chartVisibility: { growth: true, final: true },
  trendVisibility: { growth: true, avg10: true, avg20: true, avg50: true, avg100: true },
  buffExpectationVisibility: { exp10: true, exp20: true, exp50: true, exp100: true },
  buffVisibility: { buff1: true, buff2: true, buff3: true, buff4: true, buff5: true },
};

const els = {};
const SAVED_CONFIG_PREFIX = 'difficultyCurve.savedConfig.';

async function loadJson(path) {
  const separator = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${separator}v=${DATA_VERSION}`);
  if (!res.ok) throw new Error(`读取失败: ${path}`);
  return res.json();
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function parseLevelList(text) {
  return text
    .split(/[，,\s]+/)
    .map((v) => num(v, NaN))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.round(v));
}

function levelSet(list) {
  return new Set((list || []).map((v) => Math.round(v)));
}

function safeExpressionToJs(expr) {
  return expr
    .replace(/\blog\s*\(/g, 'Math.log10(')
    .replace(/\bln\s*\(/g, 'Math.log(')
    .replace(/\bsqrt\s*\(/g, 'Math.sqrt(')
    .replace(/\bpow\s*\(/g, 'Math.pow(')
    .replace(/\babs\s*\(/g, 'Math.abs(')
    .replace(/\bmin\s*\(/g, 'Math.min(')
    .replace(/\bmax\s*\(/g, 'Math.max(')
    .replace(/\^/g, '**');
}

function splitGrowthFormula(formula) {
  const text = String(formula ?? '').trim();
  if (!text) return { numerator: '', denominator: '1' };
  let depth = 0;
  let slashIndex = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    else if (ch === '/' && depth === 0) slashIndex = i;
  }
  if (slashIndex < 0) return { numerator: text, denominator: '1' };
  return {
    numerator: text.slice(0, slashIndex).trim(),
    denominator: text.slice(slashIndex + 1).trim() || '1',
  };
}

function buildGrowthFormula(growth) {
  if (!growth) return '';
  if (growth.formulaNumerator !== undefined || growth.formulaDenominator !== undefined) {
    const numerator = String(growth.formulaNumerator ?? '').trim();
    const denominator = String(growth.formulaDenominator ?? '').trim() || '1';
    return numerator + ' / ' + denominator;
  }
  return String(growth.formula || '').trim();
}

function evaluateGrowthFormula(formula, x) {
  const jsExpr = safeExpressionToJs(formula);
  const fn = new Function('x', 'return ' + jsExpr + ';');
  const result = fn(x);
  if (!Number.isFinite(result)) throw new Error('基础增长公式结果无效。请检查公式写法，当前关卡：' + x);
  return result;
}

function parseOptionalPositiveNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function applyGrowthCap(value, cap) {
  const limit = parseOptionalPositiveNumber(cap);
  return limit === null ? value : Math.min(value, limit);
}

function getDefaultDifficultyPresentation(projectName) {
  const isSh01 = String(projectName || '').toUpperCase() === 'SH01';
  return {
    noItemCoeff: isSh01 ? 5.5 : 1,
    comprehensiveCoeff: isSh01 ? 7.5 : 1,
  };
}

function getDifficultyPresentation(config) {
  const presentation = config?.difficultyPresentation || {};
  const defaults = getDefaultDifficultyPresentation(config?.meta?.projectName);
  const mode = presentation.mode || 'bare';
  if (mode === 'bare') {
    return { mode: 'bare', coeff: null, defaults };
  }
  const rawCoeff = mode === 'noItem' ? presentation.noItemCoeff : presentation.comprehensiveCoeff;
  const coeff = parseOptionalPositiveNumber(rawCoeff)
    ?? (mode === 'noItem' ? defaults.noItemCoeff : defaults.comprehensiveCoeff);
  return { mode, coeff, defaults };
}
function getDifficultyPresentationLabel(mode) {
  if (mode === 'noItem') return '无道具难度';
  if (mode === 'comprehensive') return '综合难度';
  return '裸打难度';
}

function resolveDisplayedDifficulty(bareDifficulty, config) {
  const presentation = getDifficultyPresentation(config);
  if (presentation.mode === 'bare') return bareDifficulty;
  const converted = 1 + ((bareDifficulty - 1) / presentation.coeff);
  return applyRounding(converted, config.rounding);
}

function getDifficultyPresentationSummary(config) {
  const presentation = getDifficultyPresentation(config);
  const label = getDifficultyPresentationLabel(presentation.mode);
  if (presentation.mode === 'bare') return { ...presentation, label, summary: label };
  const coeffKey = presentation.mode === 'noItem' ? 'a' : 'b';
  return {
    ...presentation,
    label,
    coeffKey,
    summary: `${label}（${coeffKey}=${presentation.coeff.toFixed(2)}）`,
  };
}

function syncDifficultyPresentationControls() {
  const presentation = getDifficultyPresentation(state.config);
  if (els.difficultyPresentationMode) els.difficultyPresentationMode.value = presentation.mode;
  if (els.noItemCoeff) els.noItemCoeff.disabled = false;
  if (els.comprehensiveCoeff) els.comprehensiveCoeff.disabled = false;
}

function refreshDifficultyPresentationCopy() {
  const summary = getDifficultyPresentationSummary(state.config);
  if (els.finalDifficultyHeader) els.finalDifficultyHeader.textContent = summary.label;
  if (els.finalDifficultyLegendText) els.finalDifficultyLegendText.textContent = summary.label;
}

function getCycleFactor(levelId, cycle) {
  const length = Math.max(1, Math.round(cycle.length));
  const values = cycle.values || [];
  if (!values.length) throw new Error('周期修正还没有有效数据。');
  const index = (levelId - 1) % length;
  const base = num(values[index], NaN);
  if (!Number.isFinite(base)) throw new Error(`第 ${index + 1} 关的周期值不是有效数字。`);
  return 1 + (base - 1) * num(cycle.strength, 1);
}

function applyRounding(value, rounding) {
  const flooredValue = Math.max(1, value);
  const integerThreshold = num(rounding.integerThreshold, 5);
  const halfStepThreshold = num(rounding.halfStepThreshold, 1.9);
  const halfStep = num(rounding.halfStep, 0.5);
  let roundedValue = flooredValue;
  if (flooredValue > integerThreshold) roundedValue = Math.round(flooredValue);
  else if (flooredValue >= halfStepThreshold) roundedValue = roundToStep(flooredValue, halfStep);
  return Math.round(roundedValue * 10) / 10;
}

function rollingAverage(values, windowSize) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= windowSize) sum -= values[i - windowSize];
    const size = Math.min(i + 1, windowSize);
    out[i] = sum / size;
  }
  return out;
}

function rollingSum(values, windowSize) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const current = Number.isFinite(values[i]) ? values[i] : 0;
    sum += current;
    if (i >= windowSize) {
      const dropped = Number.isFinite(values[i - windowSize]) ? values[i - windowSize] : 0;
      sum -= dropped;
    }
    out[i] = Number.isFinite(values[i]) ? sum : null;
  }
  return out;
}

function normalizeWeights(weights) {
  const raw = weights.map((v) => Math.max(0, num(v, 0)));
  const total = raw.reduce((a, b) => a + b, 0);
  if (!total) return raw.map(() => 0);
  return raw.map((v) => v / total);
}

function buildManualOverrideMap(overrides) {
  const map = new Map();
  (overrides || []).forEach((item) => {
    const levelId = Math.round(num(item.levelId, 0));
    const difficulty = item.difficulty ?? item.targetDifficulty;
    if (levelId > 0 && difficulty !== null && difficulty !== undefined && difficulty !== '') {
      map.set(levelId, num(difficulty));
    }
  });
  return map;
}

function passProbability(difficulty, coeff, itemUseRate = 0) {
  const raw = 1 / Math.max(0.001, ((Math.max(1, difficulty) - 1) * coeff) + 1);
  return Math.min(1, Math.max(0, raw + itemUseRate - itemUseRate * raw));
}

function computeModel(config) {
  const levelCount = Math.max(1, Math.round(num(config.levelCount, 300)));
  const guideSet = levelSet(config.specialRules.guideLevels || []);
  const coinSet = levelSet(config.specialRules.coinLevels || []);
  const overrideMap = buildManualOverrideMap(config.manualOverrides || []);
  const weights = normalizeWeights(config.buffModel.weights || []);
  const growthCap = config.growth?.cap;
  const decay = (config.buffModel.decay || []).map((v, idx) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) {
      return Math.max(0, 1 - idx * 0.08);
    }
    return num(v, 1);
  });

  const rows = [];
  for (let levelId = 1; levelId <= levelCount; levelId += 1) {
    const growthNumerator = evaluateGrowthFormula(
      config.growth.formulaNumerator || buildGrowthFormula(config.growth),
      levelId,
    );
    const cappedNumerator = applyGrowthCap(growthNumerator, growthCap);
    const growthDenominator = num(config.growth.formulaDenominator, 1) || 1;
    const baseGrowth = cappedNumerator / growthDenominator;
    const growth = baseGrowth;
    const cycleFactor = getCycleFactor(levelId, config.cycle);
    const cycleValue = growth * cycleFactor;

    let adjusted = cycleValue;
    if (config.specialRules.streakEnabled && num(config.specialRules.streakExtraDefault, 1) !== 1) {
      adjusted = (Math.max(cycleValue, 1) - 1) * num(config.specialRules.streakExtraDefault, 1) + 1;
    }

    if (config.specialRules.tailCapEnabled) {
      const window = Math.max(1, Math.round(num(config.specialRules.tailCapWindow, 11)));
      const digit = Math.round(num(config.specialRules.tailCapDigit, 1));
      const pos = ((levelId - 1) % Math.max(1, Math.round(num(config.cycle.length, 50)))) + 1;
      if (pos <= window && levelId % 10 === digit) {
        adjusted = Math.min(adjusted, num(config.specialRules.tailCapMax, 2));
      }
    }

    if (guideSet.has(levelId)) {
      const guideCoeff = config.specialRules.streakEnabled ? num(config.specialRules.streakExtraDefault, 1) : 0;
      const guideBase = Math.max(adjusted, 1);
      adjusted = guideCoeff > 0 ? ((guideBase - 1) * guideCoeff) + 1 : 1;
    }
    if (coinSet.has(levelId)) adjusted = num(config.specialRules.coinDifficulty, 1);
    if (overrideMap.has(levelId)) adjusted = overrideMap.get(levelId);

    const buffed = Math.max(0.5, weights.reduce((sum, weight, idx) => {
      const coeff = decay[idx] ?? 1;
      return sum + (((adjusted - 1) * coeff) + 1) * weight;
    }, 0));

        const bareDifficulty = applyRounding(adjusted, config.rounding);
    const finalDifficulty = resolveDisplayedDifficulty(bareDifficulty, config);

    rows.push({
      levelId,
      growth: baseGrowth,
      formulaGrowth: cappedNumerator,
      growthNumerator,
      cappedNumerator,
      growthDenominator,
      cycleFactor,
      cycleValue,
      adjusted,
      buffed,
      bareDifficulty,
      finalDifficulty,
      isGuide: guideSet.has(levelId),
      isCoin: coinSet.has(levelId),
    });
  }
  const finalSeries = rows.map((row) => row.finalDifficulty);
  const avg10 = rollingAverage(finalSeries, 10);
  const avg20 = rollingAverage(finalSeries, 20);
  const avg50 = rollingAverage(finalSeries, 50);
  const avg100 = rollingAverage(finalSeries, 100);
  const fullBuffBaseShare = Math.min(1, Math.max(0, num(config.buffModel.fullBuffBaseShare, 0.1)));
  const fullBuffProbability = rows.map((row, idx) => Math.min(1, fullBuffBaseShare + Math.max(0, row.buffed - 1) / 10 + idx / Math.max(200, rows.length * 2)));
  const itemUseRate = Math.min(1, Math.max(0, num(config.buffModel.fullBuffItemUseRate, 0)));
  const buffStartLevel = Math.max(1, Math.round(num(config.specialRules.buffStartLevel, 31)));
  const theoreticalRows = [];

  rows.forEach((row, idx) => {
    row.avg10 = avg10[idx];
    row.avg20 = avg20[idx];
    row.avg50 = avg50[idx];
    row.avg100 = avg100[idx];
    row.fullBuffProbability = fullBuffProbability[idx];

    if (row.levelId < buffStartLevel) {
      const fail0 = row.levelId === buffStartLevel - 1 ? 1 : 0;
      const buffCounts = [0, 0, 0, 0, 0, 0];
      theoreticalRows.push({ fail0, buffCounts });
      row.theoreticalZeroBuffRate = fail0;
      row.theoreticalBuffDistribution = [fail0, 0, 0, 0, 0, 0];
      row.theoreticalFirstBuffDistribution = [0, 0, 0, 0, 0];
      return;
    }

    const prev = theoreticalRows[idx - 1] || { fail0: 1, buffCounts: [1, 0, 0, 0, 0, 0] };
    const prevDifficulty = rows[idx - 1]?.finalDifficulty ?? row.finalDifficulty;
    const currentDifficulty = row.finalDifficulty;
    const prevPass = decay.map((coeff, buffIndex) => passProbability(prevDifficulty, coeff, buffIndex === 5 ? itemUseRate : 0));
    const currentPass = decay.map((coeff, buffIndex) => passProbability(currentDifficulty, coeff, buffIndex === 5 ? itemUseRate : 0));
    const buffCounts = [
      0,
      prev.fail0,
      prev.buffCounts[1] * prevPass[1],
      prev.buffCounts[2] * prevPass[2],
      prev.buffCounts[3] * prevPass[3],
      (prev.buffCounts[4] * prevPass[4]) + (prev.buffCounts[5] * prevPass[5]),
    ];
    const fail0 = buffCounts[1] * (1 - currentPass[1])
      + buffCounts[2] * (1 - currentPass[2])
      + buffCounts[3] * (1 - currentPass[3])
      + buffCounts[4] * (1 - currentPass[4])
      + buffCounts[5] * (1 - currentPass[5]);
    buffCounts[0] = fail0;
    theoreticalRows.push({ fail0, buffCounts });
    row.theoreticalZeroBuffRate = fail0;
    row.theoreticalBuffDistribution = buffCounts;
    row.theoreticalFirstBuffDistribution = buffCounts.slice(1);
  });

  const fullBuffFirstRates = rows.map((row) => (row.levelId < buffStartLevel ? null : (row.theoreticalFirstBuffDistribution?.[4] || 0)));
  const fullBuffExpected10 = rollingSum(fullBuffFirstRates, 10);
  const fullBuffExpected20 = rollingSum(fullBuffFirstRates, 20);
  const fullBuffExpected50 = rollingSum(fullBuffFirstRates, 50);
  const fullBuffExpected100 = rollingSum(fullBuffFirstRates, 100);
  rows.forEach((row, idx) => {
    row.fullBuffExpected10 = fullBuffExpected10[idx];
    row.fullBuffExpected20 = fullBuffExpected20[idx];
    row.fullBuffExpected50 = fullBuffExpected50[idx];
    row.fullBuffExpected100 = fullBuffExpected100[idx];
  });

  return { rows, avg10, avg20, avg50, avg100 };
}

function $(id) {
  return document.getElementById(id);
}

function initEls() {
  [
    'dataSource','resetBtn','saveBtn','exportBtn','levelCount','growthFormulaNumerator','growthFormulaDenominator','growthCap','cycleLength','cycleValues',
    'difficultyPresentationMode','noItemCoeff','comprehensiveCoeff',
    'guideDifficulty','coinDifficulty','tailCapMax','tailCapWindow','tailCapEnabled','streakEnabled','streakExtraDefault','guideLevels',
    'coinLevels','buffStartLevel','buffGrid','halfStepThreshold','integerThreshold','projectTitle','heroStats',
    'focusStart','focusEnd','focusTable','overrideTable','curveCanvas','trendCanvas','buffExpectationCanvas','protocolWarning',
    'runtimeWarning','runtimeWarningText','showGrowth','showFinal','showTrendGrowth','showAvg10','showAvg20','showAvg50','showAvg100',
    'showBuffExpected10','showBuffExpected20','showBuffExpected50','showBuffExpected100',
    'showBuff1','showBuff2','showBuff3','showBuff4','showBuff5','buffDistributionCanvas','exportFocusBtn','cycleAverageValue',
    'finalDifficultyHeader','finalDifficultyLegendText'
  ].forEach((id) => { els[id] = $(id); });
}

function preventNumberArrowStep(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.type !== "number") return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
  }
}

function savedConfigKey(key = state.currentKey) {
  return `${SAVED_CONFIG_PREFIX}${key}`;
}

function loadSavedConfig(key) {
  try {
    const raw = localStorage.getItem(savedConfigKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('读取本地保存配置失败。', error);
    return null;
  }
}

function saveCurrentConfig() {
  try {
    updateConfigFromForm();
    localStorage.setItem(savedConfigKey(), JSON.stringify(state.config));
    if (els.saveBtn) {
      els.saveBtn.textContent = '已保存';
      window.clearTimeout(els.saveBtn._labelTimer);
      els.saveBtn._labelTimer = window.setTimeout(() => {
        els.saveBtn.textContent = '保存当前配置';
      }, 1400);
    }
  } catch (error) {
    showRuntimeWarning(error.message || '保存失败，请检查当前输入。');
  }
}

function clearSavedConfig(key = state.currentKey) {
  localStorage.removeItem(savedConfigKey(key));
}

function cloneConfigForKey(key) {
  return deepClone(loadSavedConfig(key) || state.seeds[key]);
}

function configToForm() {
  const c = state.config;
  const defaults = getDefaultDifficultyPresentation(c.meta?.projectName);
  const presentation = c.difficultyPresentation || defaults;
  els.levelCount.value = c.levelCount;
  const growthParts = splitGrowthFormula(c.growth.formula);
  els.growthFormulaNumerator.value = c.growth.formulaNumerator ?? growthParts.numerator;
  els.growthFormulaDenominator.value = c.growth.formulaDenominator ?? growthParts.denominator;
  els.growthCap.value = c.growth.cap ?? '';
  els.cycleLength.value = c.cycle.length;
  if (els.difficultyPresentationMode) els.difficultyPresentationMode.value = presentation.mode || 'bare';
  if (els.noItemCoeff) els.noItemCoeff.value = presentation.noItemCoeff ?? defaults.noItemCoeff;
  if (els.comprehensiveCoeff) els.comprehensiveCoeff.value = presentation.comprehensiveCoeff ?? defaults.comprehensiveCoeff;
  els.guideDifficulty.value = c.specialRules.guideDifficulty;
  els.coinDifficulty.value = c.specialRules.coinDifficulty;
  els.tailCapMax.value = c.specialRules.tailCapMax;
  els.tailCapWindow.value = c.specialRules.tailCapWindow;
  els.tailCapEnabled.checked = !!c.specialRules.tailCapEnabled;
  els.streakEnabled.checked = !!c.specialRules.streakEnabled;
  els.streakExtraDefault.value = c.specialRules.streakExtraDefault ?? 1.1;
  els.buffStartLevel.value = c.specialRules.buffStartLevel ?? 31;
  els.guideLevels.value = (c.specialRules.guideLevels || []).join(', ');
  els.coinLevels.value = (c.specialRules.coinLevels || []).join(', ');
  els.halfStepThreshold.value = c.rounding.halfStepThreshold;
  els.integerThreshold.value = c.rounding.integerThreshold;
  els.focusStart.value = 1;
  els.focusEnd.value = Math.min(c.levelCount, 2200);
  if (els.showGrowth) els.showGrowth.checked = !!state.chartVisibility.growth;
  if (els.showFinal) els.showFinal.checked = !!state.chartVisibility.final;
  syncDifficultyPresentationControls();
  refreshDifficultyPresentationCopy();
  syncLegendState();
  buildCycleValueInputs();
  buildBuffInputs();
  buildOverrideTable();
}

function updateConfigFromForm() {
  const c = state.config;
  c.levelCount = Math.round(num(els.levelCount.value, c.levelCount));
  c.growth.formulaNumerator = els.growthFormulaNumerator.value.trim() || c.growth.formulaNumerator || '';
  c.growth.formulaDenominator = String(num(els.growthFormulaDenominator.value, num(c.growth.formulaDenominator, 1))).trim() || String(c.growth.formulaDenominator || 1);
  c.growth.formula = buildGrowthFormula(c.growth);
  c.growth.cap = parseOptionalPositiveNumber(els.growthCap.value);
  c.cycle.length = Math.max(1, Math.round(num(els.cycleLength.value, c.cycle.length)));
  c.difficultyPresentation = {
    version: 1,
    mode: els.difficultyPresentationMode?.value || 'bare',
    noItemCoeff: parseOptionalPositiveNumber(els.noItemCoeff?.value),
    comprehensiveCoeff: parseOptionalPositiveNumber(els.comprehensiveCoeff?.value),
  };
  c.specialRules.guideDifficulty = num(els.guideDifficulty.value, c.specialRules.guideDifficulty);
  c.specialRules.coinDifficulty = num(els.coinDifficulty.value, c.specialRules.coinDifficulty);
  c.specialRules.tailCapMax = num(els.tailCapMax.value, c.specialRules.tailCapMax);
  c.specialRules.tailCapWindow = Math.round(num(els.tailCapWindow.value, c.specialRules.tailCapWindow));
  c.specialRules.tailCapEnabled = els.tailCapEnabled.checked;
  c.specialRules.streakEnabled = els.streakEnabled.checked;
  c.specialRules.streakExtraDefault = num(els.streakExtraDefault.value, c.specialRules.streakExtraDefault ?? 1.1);
  c.specialRules.buffStartLevel = Math.max(1, Math.round(num(els.buffStartLevel.value, c.specialRules.buffStartLevel ?? 31)));
  c.specialRules.guideLevels = parseLevelList(els.guideLevels.value);
  c.specialRules.coinLevels = parseLevelList(els.coinLevels.value);
  c.rounding.halfStepThreshold = num(els.halfStepThreshold.value, c.rounding.halfStepThreshold);
  c.rounding.integerThreshold = num(els.integerThreshold.value, c.rounding.integerThreshold);
  c.rounding.halfStep = num(c.rounding.halfStep, 0.5);
}

function updateCycleAverage() {
  if (!els.cycleAverageValue) return;
  const values = (state.config.cycle.values || []).slice(0, Math.max(1, Math.round(state.config.cycle.length)));
  const avg = values.length ? values.reduce((sum, value) => sum + num(value, 0), 0) / values.length : 0;
  els.cycleAverageValue.textContent = avg.toFixed(2);
}

function syncSpecialRuleControls() {
  if (!els.streakExtraDefault || !els.streakEnabled) return;
  els.streakExtraDefault.disabled = !els.streakEnabled.checked;
}

function buildCycleValueInputs() {
  const length = Math.max(1, Math.round(state.config.cycle.length));
  const values = state.config.cycle.values || [];
  while (values.length < length) values.push(1);
  if (values.length > length) values.length = length;
  els.cycleValues.innerHTML = '';
  values.forEach((value, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `第 ${idx + 1} 关<input type="number" step="0.1" value="${value}">`;
    const input = label.querySelector('input');
    input.addEventListener('input', () => {
      state.config.cycle.values[idx] = num(input.value, value);
      updateCycleAverage();
      recompute();
    });
    els.cycleValues.appendChild(label);
  });
  updateCycleAverage();
}

function buildBuffInputs() {
  els.buffGrid.innerHTML = '';
  for (let i = 0; i < 6; i += 1) {
    const wrap = document.createElement('div');
    wrap.className = 'buff-item';
    wrap.innerHTML = `
      <h2>Buff ${i}</h2>
      <label>占比<input data-kind="weight" data-index="${i}" type="number" step="0.01" value="${state.config.buffModel.weights[i] ?? 0}"></label>
      <label>难度系数<input data-kind="decay" data-index="${i}" type="number" step="0.01" value="${state.config.buffModel.decay[i] ?? 1}"></label>
    `;
    wrap.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number(input.dataset.index);
        const kind = input.dataset.kind;
        state.config.buffModel[kind === 'weight' ? 'weights' : 'decay'][index] = num(input.value, 0);
        recompute();
      });
    });
    els.buffGrid.appendChild(wrap);
  }
}

function buildOverrideTable() {
  const maxRows = 50;
  const existing = buildManualOverrideMap(state.config.manualOverrides);
  els.overrideTable.innerHTML = '';
  for (let levelId = 1; levelId <= maxRows; levelId += 1) {
    const item = document.createElement('label');
    item.className = 'override-item';
    const value = existing.has(levelId) ? existing.get(levelId) : '';
    item.innerHTML = `<span>第 ${levelId} 关</span><input type="number" step="0.1" value="${value}" aria-label="第 ${levelId} 关难度">`;
    const input = item.querySelector('input');
    input.addEventListener('input', () => {
      const idx = state.config.manualOverrides.findIndex((entry) => Math.round(num(entry.levelId, 0)) === levelId);
      const raw = input.value.trim();
      if (raw === '') {
        if (idx >= 0) state.config.manualOverrides.splice(idx, 1);
      } else if (idx >= 0) {
        state.config.manualOverrides[idx].difficulty = num(raw, 0);
      } else {
        state.config.manualOverrides.push({ levelId, difficulty: num(raw, 0) });
      }
      recompute();
    });
    els.overrideTable.appendChild(item);
  }
}

function renderHero() {
  els.projectTitle.textContent = state.config.meta?.projectName || '项目调试面板';
  const rows = state.result.rows;
  const finalSeries = rows.map((r) => r.finalDifficulty);
  const avg = finalSeries.reduce((a, b) => a + b, 0) / finalSeries.length;
  const max = Math.max(...finalSeries);
  const min = Math.min(...finalSeries);
  const summary = getDifficultyPresentationSummary(state.config);
  els.heroStats.innerHTML = `
    <span class="pill">当前口径 ${summary.summary}</span>
    <span class="pill">平均难度 ${avg.toFixed(2)}</span>
    <span class="pill">最低 ${min.toFixed(2)}</span>
    <span class="pill">最高 ${max.toFixed(2)}</span>
  `;
}

function getFocusRange() {
  const total = state.result.rows.length;
  const rawStart = els.focusStart.value.trim();
  const rawEnd = els.focusEnd.value.trim();
  if (rawStart === '' || rawEnd === '') return null;
  const start = Math.round(Number(rawStart));
  const end = Math.round(Number(rawEnd));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 1 || end < 1) return null;
  if (start > end) return null;
  if (start > total) return null;
  return { start, end };
}

function focusRowsData() {
  const range = getFocusRange();
  if (!range) return [];
  return state.result.rows.slice(range.start - 1, range.end);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '-';
}

function renderFocusTable() {
  const rows = focusRowsData();
  els.focusTable.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.levelId}</td>
      <td>${row.growth.toFixed(2)}</td>
      <td>${row.cycleValue.toFixed(2)}</td>
      <td>${row.adjusted.toFixed(2)}</td>
      <td>${row.finalDifficulty.toFixed(1)}</td>
      <td>${row.avg10.toFixed(2)}</td>
      <td>${row.avg20.toFixed(2)}</td>
      <td>${row.avg50.toFixed(2)}</td>
      <td>${row.avg100.toFixed(2)}</td>
      <td>${formatPercent(row.theoreticalZeroBuffRate)}</td>
      <td>${formatPercent(row.theoreticalFirstBuffDistribution?.[0])}</td>
      <td>${formatPercent(row.theoreticalFirstBuffDistribution?.[1])}</td>
      <td>${formatPercent(row.theoreticalFirstBuffDistribution?.[2])}</td>
      <td>${formatPercent(row.theoreticalFirstBuffDistribution?.[3])}</td>
      <td>${formatPercent(row.theoreticalFirstBuffDistribution?.[4])}</td>
    </tr>
  `).join('');
}

function drawBuffDistributionBars(canvas, rows) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 20, right: 22, bottom: 46, left: 48 };
  const colors = ['#8fcf00', '#f04d44', '#ffd64d', '#9a45a0', '#55b878'];
  const names = ['\u9996\u95ef1\u7ea7buff\u7387', '\u9996\u95ef2\u7ea7buff\u7387', '\u9996\u95ef3\u7ea7buff\u7387', '\u9996\u95ef4\u7ea7buff\u7387', '\u9996\u95ef5\u7ea7buff\u7387'];
  const visible = names.map((_, idx) => state.buffVisibility[`buff${idx + 1}`] !== false);
  hideChartTooltip();
  ctx.clearRect(0, 0, width, height);
  canvas.__chartMeta = null;
  window.__chartMetaById = window.__chartMetaById || {};
  window.__chartMetaById[canvas.id] = null;
  if (!rows.length || !visible.some(Boolean)) return;

  const usableW = width - padding.left - padding.right;
  const usableH = height - padding.top - padding.bottom;
  const pointCount = rows.length;
  const gap = pointCount > 80 ? 1 : 2;
  const barW = Math.max(1, (usableW / pointCount) - gap);
  const y = (value) => padding.top + usableH - value * usableH;

  ctx.strokeStyle = '#d7e0e8';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#66788a';
  ctx.font = '12px Arial';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i += 1) {
    const value = i / 5;
    const py = y(value);
    ctx.beginPath();
    ctx.moveTo(padding.left, py);
    ctx.lineTo(width - padding.right, py);
    ctx.stroke();
    ctx.fillText(`${Math.round(value * 100)}%`, padding.left - 8, py);
  }

  rows.forEach((row, index) => {
    const distribution = row.theoreticalFirstBuffDistribution || [0, 0, 0, 0, 0];
    let stackTop = 0;
    const x = padding.left + (index / pointCount) * usableW + gap / 2;
    distribution.forEach((value, buffIndex) => {
      if (!visible[buffIndex]) return;
      const share = Math.max(0, value);
      const yTop = y(stackTop + share);
      const yBottom = y(stackTop);
      ctx.fillStyle = colors[buffIndex];
      ctx.fillRect(x, yTop, barW, Math.max(1, yBottom - yTop));
      stackTop += share;
    });
  });

  const levelIds = rows.map((row) => row.levelId);
  const desiredTicks = Math.min(14, Math.max(2, Math.floor(usableW / 72)));
  const tickEvery = Math.max(1, Math.ceil(pointCount / desiredTicks));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#66788a';
  for (let index = 0; index < pointCount; index += tickEvery) {
    const px = padding.left + (index / Math.max(1, pointCount - 1)) * usableW;
    ctx.strokeStyle = '#edf2f6';
    ctx.beginPath();
    ctx.moveTo(px, padding.top);
    ctx.lineTo(px, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = '#66788a';
    ctx.fillText(String(levelIds[index]), px, height - padding.bottom + 12);
  }
  if ((pointCount - 1) % tickEvery !== 0) {
    const px = width - padding.right;
    ctx.fillText(String(levelIds[pointCount - 1]), px, height - padding.bottom + 12);
  }

  const visibleEntries = names.map((name, idx) => ({ name, color: colors[idx], visible: visible[idx], decimals: 1 }));
  const meta = { type: 'stackedPercent', padding, pointCount, levelIds, rows, visibleEntries };
  canvas.__chartMeta = meta;
  window.__chartMetaById[canvas.id] = meta;
}

function drawLines(canvas, seriesEntries, options = {}) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = options.padding || { top: 20, right: 24, bottom: 42, left: 40 };
  hideChartTooltip();
  ctx.clearRect(0, 0, width, height);

  const visibleEntries = seriesEntries.filter((entry) => entry.visible !== false && entry.data.length);
  canvas.__chartMeta = null;
  window.__chartMetaById = window.__chartMetaById || {};
  window.__chartMetaById[canvas.id] = null;
  if (!visibleEntries.length) return;

  const allValues = visibleEntries.flatMap((entry) => entry.data);
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const pointCount = Math.max(...visibleEntries.map((entry) => entry.data.length));
  const usableW = width - padding.left - padding.right;
  const usableH = height - padding.top - padding.bottom;
  const levelIds = options.levelIds || Array.from({ length: pointCount }, (_, idx) => idx + 1);

  function x(i) { return padding.left + (i / Math.max(1, pointCount - 1)) * usableW; }

function y(v) { return padding.top + usableH - ((v - min) / Math.max(0.001, max - min)) * usableH; }

  ctx.strokeStyle = '#d7e0e8';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const py = padding.top + (usableH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, py);
    ctx.lineTo(width - padding.right, py);
    ctx.stroke();
  }

  const tickStep = Math.max(1, Math.round(num(options.tickLevelStep, 250)));
  const tickIndexes = [];
  levelIds.forEach((levelId, index) => {
    const roundedLevel = Math.round(num(levelId, index + 1));
    if (roundedLevel % tickStep === 0) tickIndexes.push(index);
  });
  if (!tickIndexes.includes(0)) tickIndexes.unshift(0);
  if (!tickIndexes.includes(pointCount - 1)) tickIndexes.push(pointCount - 1);

  ctx.fillStyle = '#66788a';
  ctx.font = '12px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  tickIndexes.forEach((index) => {
    const px = x(index);
    ctx.strokeStyle = '#edf2f6';
    ctx.beginPath();
    ctx.moveTo(px, padding.top);
    ctx.lineTo(px, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = '#66788a';
    ctx.fillText(String(levelIds[index] ?? index + 1), px, height - padding.bottom + 12);
  });

  visibleEntries.forEach((entry) => {
    ctx.beginPath();
    ctx.lineWidth = entry.lineWidth || 2;
    ctx.strokeStyle = entry.color;
    let hasPoint = false;
    dataLoop: for (let index = 0; index < entry.data.length; index += 1) {
      const value = entry.data[index];
      if (!Number.isFinite(value)) continue dataLoop;
      const px = x(index);
      const py = y(value);
      if (!hasPoint) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      hasPoint = true;
    }
    if (hasPoint) ctx.stroke();
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#66788a';
  ctx.font = '12px Arial';
  ctx.fillText(max.toFixed(1), 6, padding.top + 4);
  ctx.fillText(min.toFixed(1), 6, height - padding.bottom);

  const meta = { padding, min, max, pointCount, levelIds, visibleEntries };
  canvas.__chartMeta = meta;
  window.__chartMetaById[canvas.id] = meta;
}

function getChartTooltip() {
  if (els.chartTooltip?.isConnected) return els.chartTooltip;
  let tooltip = document.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    document.body.appendChild(tooltip);
  }
  tooltip.hidden = true;
  tooltip.style.display = 'none';
  els.chartTooltip = tooltip;
  return tooltip;
}

function hideChartTooltip() {
  const tooltip = els.chartTooltip || document.querySelector('.chart-tooltip');
  if (!tooltip) return;
  tooltip.hidden = true;
  tooltip.style.display = 'none';
  tooltip.innerHTML = '';
}

function setupChartTooltip(canvas) {
  if (!canvas || canvas.dataset.tooltipReady === '1') return;
  canvas.dataset.tooltipReady = '1';
  const tooltip = getChartTooltip();

  canvas.addEventListener('mousemove', (event) => {
    const meta = canvas.__chartMeta || window.__chartMetaById?.[canvas.id];
    if (!meta) {
      hideChartTooltip();
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (event.clientX - rect.left) * scaleX;
    const py = (event.clientY - rect.top) * scaleY;
    const { padding, pointCount, levelIds, visibleEntries } = meta;
    const usableW = canvas.width - padding.left - padding.right;
    const usableH = canvas.height - padding.top - padding.bottom;
    const inPlot = px >= padding.left && px <= canvas.width - padding.right && py >= padding.top && py <= canvas.height - padding.bottom;
    if (!inPlot) {
      hideChartTooltip();
      return;
    }

    const rawIndex = ((px - padding.left) / Math.max(1, usableW)) * Math.max(1, pointCount - 1);
    const index = Math.min(pointCount - 1, Math.max(0, Math.round(rawIndex)));

    const rows = meta.type === 'stackedPercent'
      ? visibleEntries
        .map((entry, buffIndex) => ({ entry, value: meta.rows[index]?.theoreticalFirstBuffDistribution?.[buffIndex] * 100 }))
        .filter((item) => item.entry.visible !== false && Number.isFinite(item.value))
      : visibleEntries
        .map((entry) => ({ entry, value: entry.data[index] }))
        .filter((item) => Number.isFinite(item.value));

    if (!rows.length) {
      hideChartTooltip();
      return;
    }
    tooltip.innerHTML = `<strong>第 ${levelIds[index] ?? index + 1} 关</strong>${rows.map((item) => `
      <span class="tooltip-row"><i style="background:${item.entry.color}"></i><b>${item.entry.name || '难度'}</b><em>${item.value.toFixed(item.entry.decimals ?? 2)}</em></span>
    `).join('')}`;
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.hidden = false;
    tooltip.style.display = 'grid';
  });

  canvas.addEventListener('mouseleave', hideChartTooltip);
  canvas.addEventListener('mouseout', hideChartTooltip);
  canvas.addEventListener('wheel', hideChartTooltip, { passive: true });
  canvas.addEventListener('pointerdown', hideChartTooltip);
}

function renderChart() {
  const rows = state.result.rows;
  const finalLabel = getDifficultyPresentationLabel(getDifficultyPresentation(state.config).mode);
  const seriesEntries = [
    { key: 'final', name: finalLabel, data: rows.map((r) => r.finalDifficulty), color: '#2f8f72', visible: state.chartVisibility.final, lineWidth: 2.8, decimals: 1 },
    { key: 'growth', name: '基础增长公式', data: rows.map((r) => r.formulaGrowth), color: '#d7a300', visible: state.chartVisibility.growth, lineWidth: 2.2 },
  ];
  drawLines(els.curveCanvas, seriesEntries, { levelIds: rows.map((r) => r.levelId) });
}

function renderBuffDistributionChart() {
  const rows = focusRowsData();
  drawBuffDistributionBars(els.buffDistributionCanvas, rows);
}

function renderTrendChart() {
  const rows = focusRowsData();
  const seriesEntries = [
    { name: '近10关', data: rows.map((r) => r.avg10), color: '#cf4f67', lineWidth: 2, visible: state.trendVisibility.avg10, decimals: 2 },
    { name: '近20关', data: rows.map((r) => r.avg20), color: '#1769aa', lineWidth: 2, visible: state.trendVisibility.avg20, decimals: 2 },
    { name: '近50关', data: rows.map((r) => r.avg50), color: '#2f8f72', lineWidth: 2, visible: state.trendVisibility.avg50, decimals: 2 },
    { name: '近100关', data: rows.map((r) => r.avg100), color: '#8a63d2', lineWidth: 2, visible: state.trendVisibility.avg100, decimals: 2 },
    { name: '基础增长公式曲线', data: rows.map((r) => r.formulaGrowth), color: '#d7a300', lineWidth: 2.2, visible: state.trendVisibility.growth, decimals: 2 },
  ];
  drawLines(els.trendCanvas, seriesEntries, { levelIds: rows.map((r) => r.levelId) });
}

function renderBuffExpectationChart() {
  if (!els.buffExpectationCanvas) return;
  const rows = focusRowsData();
  const seriesEntries = [
    { name: '近10关', data: rows.map((r) => r.fullBuffExpected10), color: '#cf4f67', lineWidth: 2, visible: state.buffExpectationVisibility.exp10, decimals: 2 },
    { name: '近20关', data: rows.map((r) => r.fullBuffExpected20), color: '#1769aa', lineWidth: 2, visible: state.buffExpectationVisibility.exp20, decimals: 2 },
    { name: '近50关', data: rows.map((r) => r.fullBuffExpected50), color: '#2f8f72', lineWidth: 2, visible: state.buffExpectationVisibility.exp50, decimals: 2 },
    { name: '近100关', data: rows.map((r) => r.fullBuffExpected100), color: '#8a63d2', lineWidth: 2, visible: state.buffExpectationVisibility.exp100, decimals: 2 },
  ];
  drawLines(els.buffExpectationCanvas, seriesEntries, { levelIds: rows.map((r) => r.levelId), padding: { top: 20, right: 24, bottom: 42, left: 44 } });
}

function syncLegendState() {
  ['showGrowth', 'showFinal', 'showTrendGrowth', 'showAvg10', 'showAvg20', 'showAvg50', 'showAvg100', 'showBuffExpected10', 'showBuffExpected20', 'showBuffExpected50', 'showBuffExpected100', 'showBuff1', 'showBuff2', 'showBuff3', 'showBuff4', 'showBuff5'].forEach((id) => {
    const input = els[id];
    if (!input) return;
    input.closest('.legend-toggle')?.classList.toggle('off', !input.checked);
  });
}

function showRuntimeWarning(message) {
  if (!els.runtimeWarning || !els.runtimeWarningText) return;
  els.runtimeWarning.hidden = false;
  els.runtimeWarningText.textContent = message;
}

function hideRuntimeWarning() {
  if (!els.runtimeWarning) return;
  els.runtimeWarning.hidden = true;
}

function recompute() {
  try {
    updateConfigFromForm();
    state.result = computeModel(state.config);
    hideRuntimeWarning();
    refreshDifficultyPresentationCopy();
    renderHero();
    renderFocusTable();
    renderChart();
    renderBuffDistributionChart();
    renderTrendChart();
    renderBuffExpectationChart();
    syncLegendState();
    syncSpecialRuleControls();
    syncDifficultyPresentationControls();
    ['growthFormulaNumerator','growthFormulaDenominator'].forEach((id) => {
      if (els[id]) els[id].style.borderColor = '';
    });
  } catch (error) {
    state.result = null;
    ['growthFormulaNumerator','growthFormulaDenominator'].forEach((id) => {
      if (els[id]) els[id].style.borderColor = '#b00020';
    });
    showRuntimeWarning(error.message || '计算失败，请检查当前输入。');
    console.error(error);
  }
}

function exportFocusTable() {
  const rows = focusRowsData();
  const range = getFocusRange();
  const finalLabel = getDifficultyPresentationLabel(getDifficultyPresentation(state.config).mode);
  const header = ['关卡', '基础增长值', '周期修正', '特殊关修正', finalLabel, '近10关', '近20关', '近50关', '近100关', '首输0buff率', '首闯1级buff率', '首闯2级buff率', '首闯3级buff率', '首闯4级buff率', '首闯5级buff率'];
  const lines = [header.join(',')].concat(rows.map((row) => [
    row.levelId,
    row.growth.toFixed(2),
    row.cycleValue.toFixed(2),
    row.adjusted.toFixed(2),
    row.finalDifficulty.toFixed(1),
    row.avg10.toFixed(2),
    row.avg20.toFixed(2),
    row.avg50.toFixed(2),
    row.avg100.toFixed(2),
    formatPercent(row.theoreticalZeroBuffRate),
    formatPercent(row.theoreticalFirstBuffDistribution?.[0]),
    formatPercent(row.theoreticalFirstBuffDistribution?.[1]),
    formatPercent(row.theoreticalFirstBuffDistribution?.[2]),
    formatPercent(row.theoreticalFirstBuffDistribution?.[3]),
    formatPercent(row.theoreticalFirstBuffDistribution?.[4]),
  ].join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  if (!range) {
    URL.revokeObjectURL(url);
    return;
  }
  a.href = url;
  a.download = 'difficulty-focus-' + range.start + '-' + range.end + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function bindBaseInputs() {
  [
    'levelCount','growthFormulaNumerator','growthFormulaDenominator','growthCap','cycleLength','difficultyPresentationMode','noItemCoeff','comprehensiveCoeff',
    'guideDifficulty','coinDifficulty','tailCapMax','tailCapWindow','tailCapEnabled','streakEnabled','buffStartLevel','guideLevels','coinLevels','halfStepThreshold',
    'integerThreshold','focusStart','focusEnd'
  ].forEach((id) => {
    if (!els[id]) return;
    const handler = () => {
      if (id === 'cycleLength') buildCycleValueInputs();
      if (id === 'streakEnabled') {
        if (els.streakEnabled.checked && num(els.streakExtraDefault?.value, 1) === 1) {
          els.streakExtraDefault.value = '1.10';
        }
        syncSpecialRuleControls();
      }
      recompute();
    };
    els[id].addEventListener(id === 'difficultyPresentationMode' ? 'change' : 'input', handler);
  });

  if (els.dataSource) els.dataSource.addEventListener('change', () => {
    state.currentKey = els.dataSource.value;
    state.config = cloneConfigForKey(state.currentKey);
    configToForm();
    recompute();
  });

  if (els.resetBtn) els.resetBtn.addEventListener('click', () => {
    clearSavedConfig();
    state.config = deepClone(state.seeds[state.currentKey]);
    configToForm();
    recompute();
  });

  if (els.saveBtn) els.saveBtn.addEventListener('click', saveCurrentConfig);

  if (els.exportBtn) els.exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `difficulty-curve-${state.currentKey}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  [
    ['showGrowth', 'growth'],
    ['showFinal', 'final'],
  ].forEach(([id, key]) => {
    if (!els[id]) return;
    els[id].addEventListener('change', () => {
      state.chartVisibility[key] = els[id].checked;
      syncLegendState();
      renderChart();
    });
  });

  [
    ['showBuff1', 'buff1'],
    ['showBuff2', 'buff2'],
    ['showBuff3', 'buff3'],
    ['showBuff4', 'buff4'],
    ['showBuff5', 'buff5'],
  ].forEach(([id, key]) => {
    if (!els[id]) return;
    els[id].addEventListener('change', () => {
      state.buffVisibility[key] = els[id].checked;
      syncLegendState();
      renderBuffDistributionChart();
    });
  });

  [
    ['showTrendGrowth', 'growth'],
    ['showAvg10', 'avg10'],
    ['showAvg20', 'avg20'],
    ['showAvg50', 'avg50'],
    ['showAvg100', 'avg100'],
  ].forEach(([id, key]) => {
    if (!els[id]) return;
    els[id].addEventListener('change', () => {
      state.trendVisibility[key] = els[id].checked;
      syncLegendState();
      renderTrendChart();
    });
  });

  [
    ['showBuffExpected10', 'exp10'],
    ['showBuffExpected20', 'exp20'],
    ['showBuffExpected50', 'exp50'],
    ['showBuffExpected100', 'exp100'],
  ].forEach(([id, key]) => {
    if (!els[id]) return;
    els[id].addEventListener('change', () => {
      state.buffExpectationVisibility[key] = els[id].checked;
      syncLegendState();
      renderBuffExpectationChart();
    });
  });

  if (els.exportFocusBtn) els.exportFocusBtn.addEventListener('click', exportFocusTable);
}

function buildReferenceCycleValues() {
  return [
    1.2, 1.5, 2, 2.5, 3, 1.5, 2.5, 1.5, 2.5, 1.5,
    1.2, 1.5, 2, 2.5, 3, 1.5, 2.5, 1.5, 4, 1.5,
    1.2, 1.5, 2, 2.5, 1.5, 1.5, 2.5, 1.5, 4.5, 1.5,
    1.2, 1.5, 2, 2.5, 3, 1.5, 2.5, 1.5, 4, 1.5,
    1.2, 1.5, 2, 2.5, 3, 1.5, 2.5, 1.5, 5, 1.5,
  ];
}

function updateProtocolWarning() {
  if (!els.protocolWarning) return;
  const isFile = window.location.protocol === 'file:';
  els.protocolWarning.hidden = !isFile;
}

async function init() {
  initEls();
  document.addEventListener("keydown", preventNumberArrowStep, true);
  const [referenceSeed, defaultSeed] = await Promise.all([
    loadJson('../../data/model_seed.json'),
    loadJson('../../data/project_seed_default.json'),
  ]);

  state.seeds.reference = {
    meta: {
      projectName: 'PopH5',
      description: '从参考 Excel 提取的结构化种子数据，适合对照旧项目建模思路。',
    },
    levelCount: 3000,
    growth: {
      formula: '((1.08 * ln(x + 78)) - 3.8) / 2',
      cap: null,
    },
    rounding: referenceSeed.modelSeed?.rounding || defaultSeed.rounding,
    cycle: {
      length: 50,
      strength: 1,
      values: buildReferenceCycleValues(),
    },
    specialRules: {
      guideLevels: [1, 4, 7, 11, 16, 21, 31, 41, 51, 61, 71, 81, 91, 101, 121, 141, 161, 181, 201, 231, 261, 301, 351, 401, 451, 501, 551, 601, 651, 701, 751, 801, 851, 901, 951, 1001, 1101, 1201, 1301, 1401, 1501, 1601, 1701, 1801, 1901, 2001],
      coinLevels: [20, 50, 70, 100, 130, 160, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2200],
      guideDifficulty: 1,
      coinDifficulty: 1,
      tailCapEnabled: true,
      tailCapWindow: 11,
      tailCapDigit: 1,
      tailCapMax: 2,
      streakEnabled: !!referenceSeed.modelSeed?.streakEnabled,
      streakExtraDefault: 1.1,
      buffStartLevel: 31,
    },
    buffModel: {
      weights: referenceSeed.modelSeed?.buffWeights || defaultSeed.buffModel.weights,
      decay: [1, 0.6302319468, 0.4392866662, 0.3316306420, 0.1993753807, 0.0771788931],
      fullBuffBaseShare: 0.1,
    },
    difficultyPresentation: getDefaultDifficultyPresentation('PopH5'),
    manualOverrides: (referenceSeed.manualOverrides || [])
      .filter((item) => item.targetDifficulty !== null && item.targetDifficulty !== undefined)
      .map((item) => ({ levelId: item.levelId, difficulty: item.targetDifficulty })),
  };

  state.seeds.default = deepClone(state.seeds.reference);
  state.seeds.default.meta = { ...state.seeds.default.meta, projectName: 'SH01' };
  state.seeds.default.difficultyPresentation = getDefaultDifficultyPresentation('SH01');
  state.config = cloneConfigForKey(state.currentKey);
  updateProtocolWarning();
  els.dataSource.value = state.currentKey;
  configToForm();
  bindBaseInputs();
  setupChartTooltip(els.curveCanvas);
  setupChartTooltip(els.buffDistributionCanvas);
  setupChartTooltip(els.trendCanvas);
  setupChartTooltip(els.buffExpectationCanvas);
  window.addEventListener('scroll', hideChartTooltip, true);
  window.addEventListener('blur', hideChartTooltip);
  document.addEventListener('mouseleave', hideChartTooltip);
  recompute();
}

init().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#b00020;white-space:pre-wrap;">初始化失败\n${error.message}</pre>`;
});

