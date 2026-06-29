const DATA_VERSION = '20260626-10';

const state = {
  seeds: {},
  currentKey: 'reference',
  config: null,
  result: null,
  chartVisibility: { growth: true, final: true },
  trendVisibility: { growth: true, avg10: true, avg20: true, avg50: true, avg100: true },
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

function computeModel(config) {
  const levelCount = Math.max(1, Math.round(num(config.levelCount, 300)));
  const guideSet = levelSet(config.specialRules.guideLevels || []);
  const coinSet = levelSet(config.specialRules.coinLevels || []);
  const overrideMap = buildManualOverrideMap(config.manualOverrides || []);
  const weights = normalizeWeights(config.buffModel.weights || []);
  const decay = (config.buffModel.decay || []).map((v, idx) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) {
      return Math.max(0, 1 - idx * 0.08);
    }
    return num(v, 1);
  });

  const rows = [];
  for (let levelId = 1; levelId <= levelCount; levelId += 1) {
    const baseGrowth = evaluateGrowthFormula(config.growth.formulaNumerator || buildGrowthFormula(config.growth), levelId);
    const growth = evaluateGrowthFormula(buildGrowthFormula(config.growth), levelId);
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

    const finalDifficulty = applyRounding(adjusted, config.rounding);

    rows.push({
      levelId,
      growth: baseGrowth,
      formulaGrowth: growth,
      cycleFactor,
      cycleValue,
      adjusted,
      buffed,
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

  rows.forEach((row, idx) => {
    row.avg10 = avg10[idx];
    row.avg20 = avg20[idx];
    row.avg50 = avg50[idx];
    row.avg100 = avg100[idx];
    row.fullBuffProbability = fullBuffProbability[idx];
  });

  return { rows, avg10, avg20, avg50, avg100 };
}

function $(id) {
  return document.getElementById(id);
}

function initEls() {
  [
    'dataSource','resetBtn','saveBtn','exportBtn','levelCount','growthFormulaNumerator','growthFormulaDenominator','cycleLength','cycleValues',
    'guideDifficulty','coinDifficulty','tailCapMax','tailCapWindow','tailCapEnabled','streakEnabled','streakExtraDefault','guideLevels',
    'coinLevels','buffGrid','halfStepThreshold','integerThreshold','halfStep','projectTitle','heroStats',
    'focusStart','focusEnd','focusTable','overrideTable','curveCanvas','trendCanvas','protocolWarning',
    'runtimeWarning','runtimeWarningText','showGrowth','showFinal','showTrendGrowth','showAvg10','showAvg20','showAvg50','showAvg100','exportFocusBtn','cycleAverageValue'
  ].forEach((id) => { els[id] = $(id); });
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
  els.levelCount.value = c.levelCount;
  const growthParts = splitGrowthFormula(c.growth.formula);
  els.growthFormulaNumerator.value = c.growth.formulaNumerator ?? growthParts.numerator;
  els.growthFormulaDenominator.value = c.growth.formulaDenominator ?? growthParts.denominator;
  els.cycleLength.value = c.cycle.length;
  els.guideDifficulty.value = c.specialRules.guideDifficulty;
  els.coinDifficulty.value = c.specialRules.coinDifficulty;
  els.tailCapMax.value = c.specialRules.tailCapMax;
  els.tailCapWindow.value = c.specialRules.tailCapWindow;
  els.tailCapEnabled.checked = !!c.specialRules.tailCapEnabled;
  els.streakEnabled.checked = !!c.specialRules.streakEnabled;
  els.streakExtraDefault.value = c.specialRules.streakExtraDefault ?? 1.1;
  els.guideLevels.value = (c.specialRules.guideLevels || []).join(', ');
  els.coinLevels.value = (c.specialRules.coinLevels || []).join(', ');
  els.halfStepThreshold.value = c.rounding.halfStepThreshold;
  els.integerThreshold.value = c.rounding.integerThreshold;
  els.halfStep.value = c.rounding.halfStep;
  els.focusStart.value = 1;
  els.focusEnd.value = Math.min(c.levelCount, 2200);
  if (els.showGrowth) els.showGrowth.checked = !!state.chartVisibility.growth;
  if (els.showFinal) els.showFinal.checked = !!state.chartVisibility.final;
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
  c.cycle.length = Math.max(1, Math.round(num(els.cycleLength.value, c.cycle.length)));
  c.specialRules.guideDifficulty = num(els.guideDifficulty.value, c.specialRules.guideDifficulty);
  c.specialRules.coinDifficulty = num(els.coinDifficulty.value, c.specialRules.coinDifficulty);
  c.specialRules.tailCapMax = num(els.tailCapMax.value, c.specialRules.tailCapMax);
  c.specialRules.tailCapWindow = Math.round(num(els.tailCapWindow.value, c.specialRules.tailCapWindow));
  c.specialRules.tailCapEnabled = els.tailCapEnabled.checked;
  c.specialRules.streakEnabled = els.streakEnabled.checked;
  c.specialRules.streakExtraDefault = num(els.streakExtraDefault.value, c.specialRules.streakExtraDefault ?? 1.1);
  c.specialRules.guideLevels = parseLevelList(els.guideLevels.value);
  c.specialRules.coinLevels = parseLevelList(els.coinLevels.value);
  c.rounding.halfStepThreshold = num(els.halfStepThreshold.value, c.rounding.halfStepThreshold);
  c.rounding.integerThreshold = num(els.integerThreshold.value, c.rounding.integerThreshold);
  c.rounding.halfStep = num(els.halfStep.value, c.rounding.halfStep);
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
  els.heroStats.innerHTML = `
    <span class="pill">平均难度 ${avg.toFixed(2)}</span>
    <span class="pill">最低 ${min.toFixed(2)}</span>
    <span class="pill">最高 ${max.toFixed(2)}</span>
  `;
}

function getFocusRange() {
  const total = state.result.rows.length;
  let start = Math.max(1, Math.round(num(els.focusStart.value, 1)));
  let end = Math.max(1, Math.round(num(els.focusEnd.value, Math.min(total, start + 19))));
  start = Math.min(start, total);
  end = Math.min(end, total);
  if (end < start) end = start;
  els.focusStart.value = start;
  els.focusEnd.value = end;
  return { start, end };
}

function focusRowsData() {
  const range = getFocusRange();
  return state.result.rows.slice(range.start - 1, range.end);
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
    </tr>
  `).join('');
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
    dataLoop: for (let index = 0; index < entry.data.length; index += 1) {
      const value = entry.data[index];
      if (!Number.isFinite(value)) continue dataLoop;
      const px = x(index);
      const py = y(value);
      if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
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
    const { padding, min, max, pointCount, levelIds, visibleEntries } = meta;
    const usableW = canvas.width - padding.left - padding.right;
    const usableH = canvas.height - padding.top - padding.bottom;
    const inPlot = px >= padding.left && px <= canvas.width - padding.right && py >= padding.top && py <= canvas.height - padding.bottom;
    if (!inPlot) {
      hideChartTooltip();
      return;
    }

    const rawIndex = ((px - padding.left) / Math.max(1, usableW)) * Math.max(1, pointCount - 1);
    const index = Math.min(pointCount - 1, Math.max(0, Math.round(rawIndex)));

    const rows = visibleEntries
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
  const seriesEntries = [
    { key: 'final', name: '最终输出', data: rows.map((r) => r.finalDifficulty), color: '#2f8f72', visible: state.chartVisibility.final, lineWidth: 2.8, decimals: 1 },
    { key: 'growth', name: '基础增长', data: rows.map((r) => r.growth), color: '#d7a300', visible: state.chartVisibility.growth, lineWidth: 2.2 },
  ];
  drawLines(els.curveCanvas, seriesEntries, { levelIds: rows.map((r) => r.levelId) });
}

function renderTrendChart() {
  const rows = focusRowsData();
  if (!rows.length) return;
  const seriesEntries = [
    { name: '近10关', data: rows.map((r) => r.avg10), color: '#cf4f67', lineWidth: 2, visible: state.trendVisibility.avg10, decimals: 2 },
    { name: '近20关', data: rows.map((r) => r.avg20), color: '#1769aa', lineWidth: 2, visible: state.trendVisibility.avg20, decimals: 2 },
    { name: '近50关', data: rows.map((r) => r.avg50), color: '#2f8f72', lineWidth: 2, visible: state.trendVisibility.avg50, decimals: 2 },
    { name: '近100关', data: rows.map((r) => r.avg100), color: '#8a63d2', lineWidth: 2, visible: state.trendVisibility.avg100, decimals: 2 },
    { name: '基础增长曲线', data: rows.map((r) => r.growth), color: '#d7a300', lineWidth: 2.2, visible: state.trendVisibility.growth, decimals: 2 },
  ];
  drawLines(els.trendCanvas, seriesEntries, { levelIds: rows.map((r) => r.levelId) });
}

function syncLegendState() {
  ['showGrowth', 'showFinal', 'showTrendGrowth', 'showAvg10', 'showAvg20', 'showAvg50', 'showAvg100'].forEach((id) => {
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
    renderHero();
    renderFocusTable();
    renderChart();
    renderTrendChart();
    syncLegendState();
    syncSpecialRuleControls();
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
  const header = ['关卡', '基础增长', '周期修正', '特殊关修正', '最终难度', '近10关', '近20关', '近50关', '近100关'];
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
  ].join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const range = getFocusRange();
  a.href = url;
  a.download = `difficulty-focus-${range.start}-${range.end}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function bindBaseInputs() {
  [
    'levelCount','growthFormulaNumerator','growthFormulaDenominator','cycleLength','guideDifficulty','coinDifficulty','tailCapMax',
    'tailCapWindow','tailCapEnabled','streakEnabled','guideLevels','coinLevels','halfStepThreshold',
    'integerThreshold','halfStep','focusStart','focusEnd'
  ].forEach((id) => {
    if (!els[id]) return;
    els[id].addEventListener('input', () => {
      if (id === 'cycleLength') buildCycleValueInputs();
      if (id === 'streakEnabled') {
        if (els.streakEnabled.checked && num(els.streakExtraDefault?.value, 1) === 1) {
          els.streakExtraDefault.value = '1.10';
        }
        syncSpecialRuleControls();
      }
      recompute();
    });
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
    },
    buffModel: {
      weights: referenceSeed.modelSeed?.buffWeights || defaultSeed.buffModel.weights,
      decay: [1, 0.92, 0.84, 0.78, 0.72, 0.66],
      fullBuffBaseShare: 0.1,
    },
    manualOverrides: (referenceSeed.manualOverrides || [])
      .filter((item) => item.targetDifficulty !== null && item.targetDifficulty !== undefined)
      .map((item) => ({ levelId: item.levelId, difficulty: item.targetDifficulty })),
  };

  state.seeds.default = defaultSeed;
  state.seeds.default.specialRules = { ...state.seeds.default.specialRules, streakExtraDefault: 1.1 };
  state.config = cloneConfigForKey(state.currentKey);
  updateProtocolWarning();
  els.dataSource.value = state.currentKey;
  configToForm();
  bindBaseInputs();
  setupChartTooltip(els.curveCanvas);
  setupChartTooltip(els.trendCanvas);
  window.addEventListener('scroll', hideChartTooltip, true);
  window.addEventListener('blur', hideChartTooltip);
  document.addEventListener('mouseleave', hideChartTooltip);
  recompute();
}

init().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#b00020;white-space:pre-wrap;">初始化失败\n${error.message}</pre>`;
});
