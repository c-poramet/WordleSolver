 (() => {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────
    const MAX_GUESSES = 5;        // max constraint rows the user can input
    const TOTAL_GUESSES = 6;      // wordle default

    let submittedGuesses = [];    // [{word, colors:[gray|yellow|green]}]
    let guessesLeft = TOTAL_GUESSES;

    // Aggregate constraint knowledge
    let knownGreen  = {};         // pos → letter
    let knownYellow = {};         // letter → Set of positions where it can't be
    let knownGray   = new Set();  // letters that don't appear
    let minCount    = {};         // letter → min occurrences (from yellow+green)

    // Current row state
    let currentWord   = '';
    let currentColors = ['gray','gray','gray','gray','gray'];

    // Possible answers cache
    let possibleAnswers = [...ANSWERS];

    // ── Options ──────────────────────────────────────────────────────
    const opts = { lookahead: true, urgency: true, hardMode: false, minimax: false, contrast: 50, saturation: 50 };

    // ── Persist / restore settings ────────────────────────────────────
    function saveSettings() {
      localStorage.setItem('wordleSolverOpts', JSON.stringify(opts));
    }

    function readSavedOpts() {
      try {
        const saved = JSON.parse(localStorage.getItem('wordleSolverOpts'));
        if (saved && typeof saved === 'object') {
          if (typeof saved.lookahead   === 'boolean') opts.lookahead   = saved.lookahead;
          if (typeof saved.urgency     === 'boolean') opts.urgency     = saved.urgency;
          if (typeof saved.hardMode    === 'boolean') opts.hardMode    = saved.hardMode;
          if (typeof saved.minimax     === 'boolean') opts.minimax     = saved.minimax;
          if (typeof saved.contrast    === 'number')  opts.contrast    = saved.contrast;
          if (typeof saved.saturation  === 'number')  opts.saturation  = saved.saturation;
        }
      } catch (_) {}
      // Apply CSS custom properties immediately — no form-state race
      applyContrast(opts.contrast);
      applySaturation(opts.saturation);
    }
    readSavedOpts(); // apply CSS vars as early as possible
    saveSettings();    // ensure localStorage always has a record on first load
    // ── Saturation application ─────────────────────────────────────────
    function applySaturation(v) {
      // v: 0–100. 50 = default. mult: 0→0×, 50→1×, 100→2×
      const root = document.documentElement;
      const mult = v / 50;
      const sat  = (base) => Math.round(Math.min(100, base * mult));
      root.style.setProperty('--clr-green',  `hsl(114,${sat(38)}%,60%)`);
      root.style.setProperty('--clr-yellow', `hsl(50,${sat(59)}%,59%)`);
      root.style.setProperty('--clr-gray',   `hsl(197,${sat(3)}%,56%)`);
      root.style.setProperty('--clr-red',    `hsl(0,${sat(100)}%,63%)`);
    }

    // ── Contrast application ──────────────────────────────────────────
    function applyContrast(v) {
      // v: 0–100.  Interpolate between low (0), default (50) and high (100) presets.
      const r = document.documentElement;
      const lerp = (a, b, t) => +(a + (b - a) * t).toFixed(3);
      // two-segment: 0-50 = dark→default, 50-100 = default→vivid
      let t, textSec, textDim, border, borderMd;
      if (v <= 50) {
        t        = v / 50;
        textSec  = lerp(0.30, 0.60, t);
        textDim  = lerp(0.14, 0.35, t);
        border   = lerp(0.06, 0.13, t);
        borderMd = lerp(0.09, 0.22, t);
      } else {
        t        = (v - 50) / 50;
        textSec  = lerp(0.60, 0.88, t);
        textDim  = lerp(0.35, 0.60, t);
        border   = lerp(0.13, 0.38, t);
        borderMd = lerp(0.22, 0.55, t);
      }
      r.style.setProperty('--text-sec',   `rgba(255,255,255,${textSec})`);
      r.style.setProperty('--text-dim',   `rgba(255,255,255,${textDim})`);
      r.style.setProperty('--border',     `rgba(255,255,255,${border})`);
      r.style.setProperty('--border-md',  `rgba(255,255,255,${borderMd})`);
      r.style.setProperty('--clr-empty-border', `rgba(255,255,255,${borderMd})`);
    }

    function loadSettings() {
      // opts already populated by readSavedOpts(); just stamp the DOM controls
      optLookahead.checked = opts.lookahead;
      optUrgency.checked   = opts.urgency;
      optHardMode.checked  = opts.hardMode;
      optMinimax.checked   = opts.minimax;
      optContrast.value    = opts.contrast;
      optSaturation.value  = opts.saturation;
    }

    // ── Debug state ──────────────────────────────────────────────────
    const dbg = {
      computeMs: null,
      mode: 'idle',
      remaining: 0,
      candidates: 0,
      rows: [],          // [{ word, score, score1, score2, isAnswer }]
      constraints: {},
    };

    // DOM refs
    const guessesContainer = document.getElementById('guessesContainer');
    const wordInput         = document.getElementById('wordInput');
    const btnAnalyze        = document.getElementById('btnAnalyze');
    const btnReset          = document.getElementById('btnReset');
    const btnUndo           = document.getElementById('btnUndo');
    const placeholderState  = document.getElementById('placeholderState');
    const resultsArea       = document.getElementById('resultsArea');
    const knownStrip        = document.getElementById('knownStrip');
    const guessesLeftBadge  = document.getElementById('guessesLeftBadge');
    const btnOpts           = document.getElementById('btnOpts');
    const btnDbg            = document.getElementById('btnDbg');
    const panelOpts         = document.getElementById('panelOpts');
    const panelDbg          = document.getElementById('panelDbg');
    const optLookahead      = document.getElementById('optLookahead');
    const optUrgency        = document.getElementById('optUrgency');
    const optHardMode       = document.getElementById('optHardMode');
    const optMinimax        = document.getElementById('optMinimax');
    const optContrast       = document.getElementById('optContrast');
    const optSaturation     = document.getElementById('optSaturation');

    // Stamp DOM controls from opts (opts already populated by readSavedOpts above)
    loadSettings();
    // Re-stamp after browser form-restore (fires before window load; 50ms catches mid-parse restores)
    setTimeout(loadSettings, 50);
    window.addEventListener('load', loadSettings);

    // ── Options / Debug panel toggle logic ───────────────────────────
    function togglePanel(btn, panel) {
      const isOpen = panel.classList.contains('open');
      // Close all first
      [panelOpts, panelDbg].forEach(p => p.classList.remove('open'));
      [btnOpts, btnDbg].forEach(b => b.classList.remove('active'));
      if (!isOpen) {
        panel.classList.add('open');
        btn.classList.add('active');
      }
    }
    btnOpts.addEventListener('click', () => togglePanel(btnOpts, panelOpts));
    btnDbg.addEventListener('click',  () => togglePanel(btnDbg,  panelDbg));
    document.addEventListener('click', e => {
      if (!e.target.closest('.float-panel') && !e.target.closest('.icon-btn') && !e.target.closest('.btn-open-opts')) {
        panelOpts.classList.remove('open');
        panelDbg.classList.remove('open');
        btnOpts.classList.remove('active');
        btnDbg.classList.remove('active');
      }
    });
    function applyHardModeTag(on) { /* handled by CSS :has() */ }
    function updateSettingTags() { /* handled by CSS :has() */ }
    optLookahead.addEventListener('change', () => { opts.lookahead = optLookahead.checked; saveSettings(); updateSettingTags(); });
    optUrgency.addEventListener('change',   () => { opts.urgency   = optUrgency.checked;   saveSettings(); updateSettingTags(); });
    optMinimax.addEventListener('change',   () => { opts.minimax   = optMinimax.checked;   saveSettings(); updateSettingTags(); });
    optHardMode.addEventListener('change',  () => {
      opts.hardMode = optHardMode.checked;
      saveSettings();
      applyHardModeTag(optHardMode.checked);
    });
    optContrast.addEventListener('input', () => {
      opts.contrast = +optContrast.value;
      applyContrast(opts.contrast);
      saveSettings();
    });
    optSaturation.addEventListener('input', () => {
      opts.saturation = +optSaturation.value;
      applySaturation(opts.saturation);
      saveSettings();
    });

    // Re-apply saved settings if page is restored from bfcache (back/forward nav)
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        applyContrast(opts.contrast);
        applySaturation(opts.saturation);
        loadSettings();
        setTimeout(loadSettings, 50);
      }
    });

    // ── Initialise rows ────────────────────────────────────────────────
    function initRows() {
      guessesContainer.innerHTML = '';
      for (let r = 0; r < MAX_GUESSES; r++) {
        const row = document.createElement('div');
        row.className = 'guess-row' + (r === 0 ? ' active' : ' empty-row');
        row.id = `row-${r}`;
        row.innerHTML = `
          <span class="row-num">${r + 1}</span>
          <div class="tiles" id="tiles-${r}">
            ${[0,1,2,3,4].map(i => `
              <div class="tile" id="tile-${r}-${i}" data-row="${r}" data-pos="${i}"></div>
            `).join('')}
          </div>
        `;
        guessesContainer.appendChild(row);
      }
    }

    // ── Tile click handler ─────────────────────────────────────────────
    guessesContainer.addEventListener('click', e => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      const row = +tile.dataset.row;
      const pos = +tile.dataset.pos;
      const activeRow = submittedGuesses.length;
      if (row !== activeRow) return;
      if (!currentWord[pos]) return;
      if (tile.classList.contains('auto-gray')) return;

      // Cycle: gray → yellow → green → gray
      const cycle = { gray: 'yellow', yellow: 'green', green: 'gray' };
      currentColors[pos] = cycle[currentColors[pos]] || 'gray';
      refreshActiveTiles();
      wordInput.focus();
    });

    // ── Refresh active row tiles ───────────────────────────────────────
    function refreshActiveTiles() {
      const r = submittedGuesses.length;
      for (let i = 0; i < 5; i++) {
        const tile = document.getElementById(`tile-${r}-${i}`);
        if (!tile) continue;
        const letter = currentWord[i] || '';

        tile.textContent = letter.toUpperCase();

        // Reset classes
        tile.classList.remove('has-letter','state-gray','state-yellow','state-green','auto-gray');

        if (!letter) { continue; }

        tile.classList.add('has-letter');

        // Auto-gray if letter is known gray (from past guesses)
        if (knownGray.has(letter) && currentColors[i] !== 'green' && currentColors[i] !== 'yellow') {
          tile.classList.add('auto-gray');
          currentColors[i] = 'gray';
        } else {
          tile.classList.add(`state-${currentColors[i]}`);
        }
      }

      // Enable/disable analyze button
      btnAnalyze.disabled = currentWord.length !== 5;
    }

    // ── Global keypress redirect ──────────────────────────────────────
    // When the input is not focused, capture letter / Backspace keys and
    // route them directly into the input so the user never has to click first.
    document.addEventListener('keydown', e => {
      if (document.activeElement === wordInput) return;  // already focused — let it handle normally
      // Ignore modifier-heavy combos (Ctrl/Meta/Alt shortcuts)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const isLetter    = e.key.length === 1 && /^[a-zA-Z]$/.test(e.key);
      const isBackspace = e.key === 'Backspace';
      const isEnter     = e.key === 'Enter';
      if (!isLetter && !isBackspace && !isEnter) return;

      // Bring focus to the input first
      wordInput.focus();

      if (isLetter) {
        e.preventDefault();
        if (wordInput.value.length < 5) {
          wordInput.value += e.key.toUpperCase();
          wordInput.dispatchEvent(new Event('input'));
        }
      } else if (isBackspace) {
        e.preventDefault();
        wordInput.value = wordInput.value.slice(0, -1);
        wordInput.dispatchEvent(new Event('input'));
      }
      // Enter: focus is set — the input's own keydown listener will fire next
    });

    // ── Word input handler ─────────────────────────────────────────────
    let prevWord = '';
    wordInput.addEventListener('input', () => {
      // If tips page is showing but results exist, switch back to results
      if (placeholderState.style.display !== 'none' && resultsArea.innerHTML.trim()) {
        placeholderState.style.display = 'none';
        resultsArea.style.display = '';
      }

      const val = wordInput.value.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 5);
      wordInput.value = val.toUpperCase();

      // Reset color when the letter at a position changes or is cleared
      for (let i = 0; i < 5; i++) {
        if (!val[i]) {
          currentColors[i] = 'gray';
        } else if (val[i] !== prevWord[i]) {
          // Letter changed at this position — start fresh at gray
          currentColors[i] = 'gray';
        }
        // If letter is known gray, force it regardless
        if (val[i] && knownGray.has(val[i])) {
          currentColors[i] = 'gray';
        }
      }

      prevWord    = val;
      currentWord = val;
      refreshActiveTiles();
    });

    function toggleTileColor(pos1Based) {
      const i = pos1Based - 1;
      if (!currentWord[i]) return;
      const tile = document.getElementById(`tile-${submittedGuesses.length}-${i}`);
      if (!tile || tile.classList.contains('auto-gray')) return;
      const cycle = { gray: 'yellow', yellow: 'green', green: 'gray' };
      currentColors[i] = cycle[currentColors[i]] || 'gray';
      refreshActiveTiles();
    }

    wordInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && currentWord.length === 5) {
        btnAnalyze.click();
        return;
      }
      // Keys 1–5 toggle the corresponding tile colour
      const pos = parseInt(e.key, 10);
      if (pos >= 1 && pos <= 5) {
        e.preventDefault();
        toggleTileColor(pos);
      }
    });

    // Keys 1–5 pressed from anywhere — focus input and toggle tile
    document.addEventListener('keydown', e => {
      if (document.activeElement === wordInput) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const pos = parseInt(e.key, 10);
      if (pos >= 1 && pos <= 5) {
        e.preventDefault();
        wordInput.focus();
        toggleTileColor(pos);
      }
    });

    // ── Lock a row (after submit) ──────────────────────────────────────
    function lockRow(rowIdx, word, colors) {
      const row = document.getElementById(`row-${rowIdx}`);
      row.classList.remove('active', 'empty-row');
      row.classList.add('locked');
      for (let i = 0; i < 5; i++) {
        const tile = document.getElementById(`tile-${rowIdx}-${i}`);
        tile.textContent = word[i].toUpperCase();
        tile.className = 'tile';
        if (colors[i] === 'gray')   tile.classList.add('state-gray');
        if (colors[i] === 'yellow') tile.classList.add('state-yellow');
        if (colors[i] === 'green')  tile.classList.add('state-green');
      }
    }

    // ── Activate next row ──────────────────────────────────────────────
    function activateRow(rowIdx) {
      if (rowIdx >= MAX_GUESSES) return;
      const row = document.getElementById(`row-${rowIdx}`);
      row.classList.remove('empty-row');
      row.classList.add('active');
    }

    // ── Update global constraint knowledge ────────────────────────────
    function updateConstraints(word, colors) {
      // Count letter occurrences by color
      const letterColorMap = {};
      for (let i = 0; i < 5; i++) {
        const l = word[i];
        if (!letterColorMap[l]) letterColorMap[l] = [];
        letterColorMap[l].push({ pos: i, color: colors[i] });
      }

      for (const [letter, entries] of Object.entries(letterColorMap)) {
        const greenCount  = entries.filter(e => e.color === 'green').length;
        const yellowCount = entries.filter(e => e.color === 'yellow').length;
        const grayCount   = entries.filter(e => e.color === 'gray').length;

        const minNeeded = greenCount + yellowCount;
        if (!minCount[letter] || minCount[letter] < minNeeded) {
          minCount[letter] = minNeeded;
        }

        // If any gray exists AND (green+yellow count < total appearances):
        // The gray means the word has exactly (green+yellow) of this letter
        if (grayCount > 0 && minNeeded === 0) {
          // Letter doesn't appear at all
          knownGray.add(letter);
        }
        // (exact count constraint is handled in filterAnswers)

        for (const { pos, color } of entries) {
          if (color === 'green') {
            knownGreen[pos] = letter;
          } else if (color === 'yellow') {
            if (!knownYellow[letter]) knownYellow[letter] = new Set();
            knownYellow[letter].add(pos);
          }
        }
      }
    }

    // ── Filter answers based on all constraints ────────────────────────
    function filterAnswers(candidates) {
      return candidates.filter(word => {
        // Green constraints
        for (const [pos, letter] of Object.entries(knownGreen)) {
          if (word[+pos] !== letter) return false;
        }
        // Yellow constraints
        for (const [letter, badPositions] of Object.entries(knownYellow)) {
          if (!word.includes(letter)) return false;
          for (const pos of badPositions) {
            if (word[pos] === letter) return false;
          }
        }
        // Gray constraints (letter not in word unless accounted for by green/yellow)
        for (const letter of knownGray) {
          if (word.includes(letter)) return false;
        }
        // Min-count constraints (for duplicate letters)
        for (const [letter, min] of Object.entries(minCount)) {
          if (min > 0) {
            const count = word.split('').filter(c => c === letter).length;
            if (count < min) return false;
          }
        }
        // Exact-count constraints (when a letter appears green/yellow AND gray in same guess)
        for (let g = 0; g < submittedGuesses.length; g++) {
          const gWord   = submittedGuesses[g].word;
          const gColors = submittedGuesses[g].colors;
          const letterColorMap = {};
          for (let i = 0; i < 5; i++) {
            const l = gWord[i];
            if (!letterColorMap[l]) letterColorMap[l] = [];
            letterColorMap[l].push(gColors[i]);
          }
          for (const [letter, colorList] of Object.entries(letterColorMap)) {
            const hasGray    = colorList.includes('gray');
            const nonGray    = colorList.filter(c => c !== 'gray').length;
            if (hasGray && nonGray > 0) {
              // Exact count: word must have exactly nonGray occurrences of this letter
              const count = word.split('').filter(c => c === letter).length;
              if (count !== nonGray) return false;
            }
          }
        }
        return true;
      });
    }

    // ── Compute pattern of a guess against a target ───────────────────
    function getPattern(guess, target) {
      const pattern = ['gray','gray','gray','gray','gray'];
      const targetArr = target.split('');
      const used = [false,false,false,false,false];

      // First pass: greens
      for (let i = 0; i < 5; i++) {
        if (guess[i] === target[i]) {
          pattern[i] = 'green';
          used[i] = true;
        }
      }
      // Second pass: yellows
      for (let i = 0; i < 5; i++) {
        if (pattern[i] === 'green') continue;
        for (let j = 0; j < 5; j++) {
          if (!used[j] && guess[i] === targetArr[j]) {
            pattern[i] = 'yellow';
            used[j] = true;
            break;
          }
        }
      }
      return pattern.join(',');
    }

    // ── Entropy score for a candidate guess ───────────────────────────
    function entropyScore(guess, remaining) {
      if (remaining.length === 0) return 0;
      const counts = {};
      for (const answer of remaining) {
        const pat = getPattern(guess, answer);
        counts[pat] = (counts[pat] || 0) + 1;
      }
      let entropy = 0;
      const total = remaining.length;
      for (const c of Object.values(counts)) {
        const p = c / total;
        entropy -= p * Math.log2(p);
      }
      return entropy;
    }

    // ── Get best guesses ──────────────────────────────────────────────
    async function computeBestGuesses(remaining, guessesLeftNow) {
      const t0 = performance.now();

      // Edge cases
      if (remaining.length === 0) {
        dbg.mode = 'no-answers'; dbg.computeMs = 0; dbg.rows = [];
        return [];
      }
      if (remaining.length === 1) {
        dbg.mode = 'solved'; dbg.computeMs = 0;
        dbg.rows = [{ word: remaining[0], score: Infinity, score1: Infinity, score2: 0, isAnswer: true }];
        return dbg.rows;
      }
      // If last guess — only possible answers are valid plays
      if (guessesLeftNow <= 1) {
        dbg.mode = 'last-guess'; dbg.computeMs = 0;
        dbg.rows = remaining.slice(0, 15).map(w => ({ word: w, score: Infinity, score1: Infinity, score2: 0, isAnswer: true }));
        return dbg.rows;
      }

      const remainingSet = new Set(remaining);

      // ── STEP 1: 1-ply entropy for all candidate words ───────────────
      const step1 = [];
      const batchSize = 600;
      const guessPool = opts.hardMode ? remaining : ALL_WORDS;
      for (let start = 0; start < guessPool.length; start += batchSize) {
        const batch = guessPool.slice(start, start + batchSize);
        for (const word of batch) {
          // Compute pattern bucket counts once — derive both entropy and maxBucket
          const counts = {};
          for (const answer of remaining) {
            const pat = getPattern(word, answer);
            counts[pat] = (counts[pat] || 0) + 1;
          }
          let entropy = 0;
          let maxBucket = 0;
          const total = remaining.length;
          for (const c of Object.values(counts)) {
            if (c > maxBucket) maxBucket = c;
            const p = c / total;
            entropy -= p * Math.log2(p);
          }
          const isAnswer = remainingSet.has(word);
          step1.push({ word, score1: entropy, maxBucket, isAnswer });
        }
        await new Promise(r => setTimeout(r, 0));
      }
      step1.sort((a, b) => b.score1 - a.score1);

      const N_LOOKAHEAD = 50;   // candidates to pass into 2-ply
      const LOOKAHEAD_CAP = 150; // max remaining before falling back to 1-ply

      // ── MINIMAX branch: minimise worst-case remaining bucket ─────────
      if (opts.minimax) {
        dbg.mode = 'minimax';
        // step1 already has maxBucket per candidate;
        // score = remaining.length - maxBucket  →  higher is better (smaller worst case)
        // ties broken by entropy (score1)
        const mmResults = step1
          .map(c => ({ ...c, score: remaining.length - c.maxBucket, score2: 0 }))
          .sort((a, b) => a.maxBucket - b.maxBucket || b.score1 - a.score1);
        // Re-derive score from sorted order so bar widths are meaningful
        dbg.computeMs  = Math.round(performance.now() - t0);
        dbg.remaining  = remaining.length;
        dbg.candidates = step1.length;
        dbg.rows       = mmResults.slice(0, 20);
        return dbg.rows;
      }

      const useLookahead = opts.lookahead && remaining.length <= LOOKAHEAD_CAP;
      const useUrgency   = opts.urgency;

      // Urgency factor: how much to bonus a possible answer
      // Grows as remaining/guessesLeft ratio climbs
      function answerBonus(isAnswer) {
        if (!isAnswer || !useUrgency) return 0;
        const ratio = remaining.length / guessesLeftNow;
        if (ratio <= 1) return 0.01;           // plenty of guesses — tiny tie-break
        return Math.min(0.45, Math.log2(ratio) * 0.18); // scale with urgency
      }

      let results;

      if (useLookahead) {
        // ── STEP 2: 2-ply lookahead on top-N candidates ────────────────
        dbg.mode = '2-ply';
        const top = step1.slice(0, N_LOOKAHEAD);
        const plyResults = [];

        for (const c of top) {
          // Partition remaining by outcome pattern
          const buckets = {};
          for (const ans of remaining) {
            const pat = getPattern(c.word, ans);
            if (!buckets[pat]) buckets[pat] = [];
            buckets[pat].push(ans);
          }

          // For each non-singleton bucket, find best next entropy (searching remaining answers)
          let expectedNext = 0;
          const total = remaining.length;
          for (const bucket of Object.values(buckets)) {
            if (bucket.length <= 1) continue;
            const p = bucket.length / total;
            let bestNext = 0;
            for (const w of remaining) {           // restrict 2nd-ply pool to remaining answers
              const e = entropyScore(w, bucket);
              if (e > bestNext) bestNext = e;
            }
            expectedNext += p * bestNext;
          }

          const score2 = expectedNext;
          const rawScore = c.score1 + score2 + answerBonus(c.isAnswer);
          plyResults.push({ word: c.word, score: rawScore, score1: c.score1, score2, isAnswer: c.isAnswer });
          await new Promise(r => setTimeout(r, 0));
        }

        plyResults.sort((a, b) => b.score - a.score);
        results = plyResults;
      } else {
        // ── Greedy 1-ply with urgency bonus ────────────────────────────
        dbg.mode = useLookahead ? '2-ply' : (opts.lookahead ? '1-ply (capped)' : '1-ply');
        results = step1.map(c => ({
          ...c,
          score: c.score1 + answerBonus(c.isAnswer),
          score2: 0,
        }));
      }

      dbg.computeMs    = Math.round(performance.now() - t0);
      dbg.remaining    = remaining.length;
      dbg.candidates   = step1.length;
      dbg.rows         = results.slice(0, 20);

      return dbg.rows;
    }

    // ── Render debug panel ────────────────────────────────────────────
    function renderDebug() {
      const content = document.getElementById('dbgContent');
      const badge   = document.getElementById('dbgModeBadge');
      if (!content) return;

      badge.textContent = dbg.mode;
      badge.style.color = dbg.mode === '2-ply'         ? 'var(--clr-green)'
                        : dbg.mode === 'minimax'       ? 'var(--clr-yellow)'
                        : dbg.mode === '1-ply (capped)' ? 'var(--accent)'
                        : 'var(--text-dim)';

      const constraintLines = [
        Object.entries(knownGreen).map(([p,l]) => `${l.toUpperCase()}@${+p+1}`).join(' '),
        Object.entries(knownYellow).map(([l]) => l.toUpperCase()+'?').join(' '),
        [...knownGray].sort().map(l=>l.toUpperCase()).join(' '),
      ].filter(Boolean).join(' | ') || '—';

      const is2ply    = dbg.mode === '2-ply';
      const isMinimax = dbg.mode === 'minimax';

      content.innerHTML = `
        <div class="dbg-row"><span class="dbg-key">mode</span><span class="dbg-val hi">${dbg.mode}</span></div>
        <div class="dbg-row"><span class="dbg-key">lookahead opt</span><span class="dbg-val">${opts.lookahead ? 'on' : 'off'}</span></div>
        <div class="dbg-row"><span class="dbg-key">urgency opt</span><span class="dbg-val">${opts.urgency ? 'on' : 'off'}</span></div>
        <div class="dbg-row"><span class="dbg-key">minimax opt</span><span class="dbg-val">${opts.minimax ? 'on' : 'off'}</span></div>
        <div class="dbg-row"><span class="dbg-key">remaining answers</span><span class="dbg-val hi">${dbg.remaining}</span></div>
        <div class="dbg-row"><span class="dbg-key">guesses left</span><span class="dbg-val">${guessesLeft}</span></div>
        <div class="dbg-row"><span class="dbg-key">candidates scored</span><span class="dbg-val">${dbg.candidates.toLocaleString()}</span></div>
        <div class="dbg-row"><span class="dbg-key">compute time</span><span class="dbg-val ${dbg.computeMs > 1000 ? 'warn' : ''}">${
          dbg.computeMs != null ? dbg.computeMs + ' ms' : '—'
        }</span></div>
        <div class="dbg-row"><span class="dbg-key">constraints</span><span class="dbg-val" style="font-size:9px;max-width:160px;text-align:right">${constraintLines}</span></div>
        <div class="dbg-section">Top Candidates</div>
        <table class="dbg-table">
          <thead><tr>
            <th>Word</th>
            ${isMinimax ? '<th>Worst</th><th>H₁</th>' : '<th>H₁</th>'}
            ${is2ply ? '<th>H₂</th>' : ''}
            <th>${isMinimax ? 'Rank' : 'Score'}</th>
          </tr></thead>
          <tbody>
            ${dbg.rows.slice(0, 8).map(r => `
              <tr>
                <td>${r.word}</td>
                ${isMinimax
                  ? `<td style="color:var(--clr-yellow)">${r.maxBucket}</td><td style="color:var(--text-dim)">${r.score1.toFixed(2)}</td>`
                  : `<td>${r.score1 === Infinity ? '—' : r.score1.toFixed(3)}</td>`
                }
                ${is2ply ? `<td style="color:var(--clr-yellow)">${r.score2.toFixed(3)}</td>` : ''}
                <td style="color:var(--clr-green)">${
                  isMinimax
                    ? r.maxBucket
                    : (r.score === Infinity ? '∞' : r.score.toFixed(3))
                }</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    // ── Render results ────────────────────────────────────────────────
    function renderResults(possible, bestGuesses, guessesLeftNow, loading = false) {
      placeholderState.style.display = 'none';
      resultsArea.innerHTML = '';

      // Solved?
      if (possible.length === 1) {
        const solved = document.createElement('div');
        solved.className = 'solved-banner animate-in';
        solved.innerHTML = `
          <div class="solved-word">${possible[0]}</div>
          <div class="solved-msg">Only one possible answer remaining</div>
        `;
        resultsArea.appendChild(solved);
      }

      // Stats bar
      const stats = document.createElement('div');
      stats.className = 'stats-bar animate-in';
      stats.innerHTML = `
        <div class="stat-chip stat-possible">
          <span class="stat-val">${possible.length}</span>
          <span class="stat-lbl">Possible Answers</span>
        </div>
        <div class="stat-chip stat-guesses">
          <span class="stat-val">${guessesLeftNow}</span>
          <span class="stat-lbl">Guesses Left</span>
        </div>
      `;
      resultsArea.appendChild(stats);

      // Warning if answers > guesses (need to be smart)
      if (possible.length > Math.pow(2, guessesLeftNow) && possible.length > 2 && guessesLeftNow > 1) {
        const warn = document.createElement('div');
        warn.className = 'warn-banner animate-in';
        warn.textContent = `⚠ ${possible.length} answers with ${guessesLeftNow} guesses left — prioritize high-entropy eliminations.`;
        resultsArea.appendChild(warn);
      }

      // Possible answers
      const answersPanel = document.createElement('div');
      answersPanel.className = 'answers-panel panel animate-in';
      const SHOW_MAX = 30;
      const showing = possible.slice(0, SHOW_MAX);
      const overflow = possible.length - SHOW_MAX;
      answersPanel.innerHTML = `
        <div class="section-label">Possible Answers (${possible.length})</div>
        <div class="answers-grid" id="answersGrid">
          ${showing.map(w => `<span class="answer-chip">${w}</span>`).join('')}
        </div>
        ${overflow > 0 ? `
          <div class="answers-overflow">
            +${overflow} more &nbsp;
            <button class="show-all-btn" id="showAllBtn">show all</button>
          </div>` : ''}
      `;
      resultsArea.appendChild(answersPanel);

      // Show all answers
      if (overflow > 0) {
        document.getElementById('showAllBtn').addEventListener('click', () => {
          const grid = document.getElementById('answersGrid');
          const extra = possible.slice(SHOW_MAX);
          extra.forEach(w => {
            const chip = document.createElement('span');
            chip.className = 'answer-chip';
            chip.textContent = w;
            grid.appendChild(chip);
          });
          answersPanel.querySelector('.answers-overflow').remove();
        });
      }

      // Best guesses panel
      const guessesPanel = document.createElement('div');
      guessesPanel.className = 'guesses-panel panel animate-in';
      guessesPanel.id = 'bestGuessesPanel';

      if (loading) {
        guessesPanel.innerHTML = `
          <div class="section-label">Best Next Guesses</div>
          <div class="loading-state"><div class="spinner"></div>Computing optimal guesses…</div>
        `;
      } else if (possible.length === 1) {
        guessesPanel.innerHTML = `
          <div class="section-label">Best Next Guesses</div>
          <div class="guess-item animate-in">
            <span class="guess-rank">1</span>
            <span class="guess-word">${possible[0]}</span>
            <span class="badge-answer">answer</span>
          </div>
        `;
      } else {
        const maxScore = bestGuesses[0]?.score ?? 1;
        const lastGuess = guessesLeftNow <= 1;
        guessesPanel.innerHTML = `
          <div class="section-label">Best Next Guesses${lastGuess ? ' — must pick possible answer' : ''}</div>
          ${bestGuesses.map((g, i) => `
            <div class="guess-item animate-in" style="animation-delay:${i * 0.025}s">
              <span class="guess-rank">${i + 1}</span>
              <span class="guess-word">${g.word}</span>
              <div class="score-bar">
                <div class="score-fill" style="width:${Math.min(100,(g.score/maxScore)*100)}%"></div>
              </div>
              <span class="guess-score">${
                opts.minimax
                  ? `${g.maxBucket} <span style="color:var(--text-dim);font-size:9px">worst</span>`
                  : `${g.score === Infinity ? '—' : g.score.toFixed(2)} <span style="color:var(--text-dim);font-size:9px">bits</span>`
              }</span>
              ${g.isAnswer
                ? `<span class="badge-answer">answer</span>`
                : `<span class="badge-guess-only">elim</span>`}
            </div>
          `).join('')}
        `;
      }
      resultsArea.appendChild(guessesPanel);

      // Click any guess-item to load that word into the input
      guessesPanel.querySelectorAll('.guess-item').forEach(item => {
        const wordEl = item.querySelector('.guess-word');
        if (!wordEl) return;
        item.addEventListener('click', () => {
          const word = wordEl.textContent.trim().toLowerCase();
          wordInput.value  = word.toUpperCase();
          currentWord      = word;
          currentColors    = ['gray','gray','gray','gray','gray'];
          prevWord         = word;
          refreshActiveTiles();
          btnAnalyze.disabled = word.length !== 5;
          wordInput.focus();
        });
      });
    }

    // ── Analyze button ────────────────────────────────────────────────
    btnAnalyze.addEventListener('click', async () => {
      if (currentWord.length !== 5) return;
      if (submittedGuesses.length >= MAX_GUESSES) return;

      // Validate word
      const w = currentWord.toLowerCase();
      if (!ALL_WORDS.includes(w)) {
        wordInput.style.border = '1px solid rgba(200,80,80,0.6)';
        wordInput.placeholder = 'Not a valid word!';
        wordInput.value = '';
        currentWord = '';
        currentColors = ['gray','gray','gray','gray','gray'];
        setTimeout(() => {
          wordInput.style.border = '';
          wordInput.placeholder = 'Type a 5-letter guess…';
          refreshActiveTiles();
          wordInput.focus();
        }, 1400);
        return;
      }

      const colors = [...currentColors];
      const rowIdx = submittedGuesses.length;

      // Lock the current row
      lockRow(rowIdx, w, colors);
      submittedGuesses.push({ word: w, colors });

      // Update constraints
      updateConstraints(w, colors);

      // Filter possible answers
      possibleAnswers = filterAnswers(ANSWERS);

      // Decrement guesses left
      guessesLeft = TOTAL_GUESSES - submittedGuesses.length;
      guessesLeftBadge.textContent = `${guessesLeft} / ${TOTAL_GUESSES} GUESSES`;

      // Activate next row (if available)
      const nextRow = submittedGuesses.length;
      if (nextRow < MAX_GUESSES) {
        activateRow(nextRow);
      }

      // Reset input
      wordInput.value = '';
      currentWord      = '';
      currentColors    = ['gray','gray','gray','gray','gray'];
      prevWord         = '';
      refreshActiveTiles();

      // Update known strip
      renderKnownStrip();

      // Maintain input focus throughout
      wordInput.focus();

      // Show loading state first
      renderResults(possibleAnswers, [], guessesLeft, true);

      // Compute best guesses asynchronously
      const best = await computeBestGuesses(possibleAnswers, guessesLeft);
      renderResults(possibleAnswers, best, guessesLeft, false);
      renderDebug();

      // Scroll results back to top
      document.getElementById('rightPanel').scrollTop = 0;

      // If no more input rows or game solved
      if (nextRow >= MAX_GUESSES || possibleAnswers.length === 0) {
        wordInput.disabled = true;
        btnAnalyze.disabled = true;
        btnUndo.disabled    = false;  // still allow undo even if max rows reached
        wordInput.placeholder = possibleAnswers.length === 0
          ? 'No valid answers found — check your inputs.'
          : 'Maximum guesses reached.';
      } else {
        btnUndo.disabled = false;
        wordInput.focus();
      }
    });

    // ── Known strip renderer ──────────────────────────────────────────
    function renderKnownStrip() {
      knownStrip.innerHTML = '<span class="known-label">Known constraints</span>';
      let hasInfo = false;

      // Green
      for (const [pos, letter] of Object.entries(knownGreen)) {
        const chip = document.createElement('span');
        chip.className = 'known-chip chip-green';
        chip.textContent = `${letter.toUpperCase()}${+pos + 1}`;
        chip.title = `Green: ${letter.toUpperCase()} at position ${+pos + 1}`;
        knownStrip.appendChild(chip);
        hasInfo = true;
      }

      // Yellow
      const yellowAdded = {};
      for (const [letter, positions] of Object.entries(knownYellow)) {
        if (yellowAdded[letter]) continue;
        yellowAdded[letter] = true;
        const chip = document.createElement('span');
        chip.className = 'known-chip chip-yellow';
        chip.textContent = letter.toUpperCase();
        chip.title = `Yellow: ${letter.toUpperCase()} exists, not at positions [${[...positions].map(p => p+1).join(',')}]`;
        knownStrip.appendChild(chip);
        hasInfo = true;
      }

      // Gray
      const sortedGray = [...knownGray].sort();
      for (const letter of sortedGray) {
        const chip = document.createElement('span');
        chip.className = 'known-chip chip-gray';
        chip.textContent = letter.toUpperCase();
        knownStrip.appendChild(chip);
        hasInfo = true;
      }

      knownStrip.style.display = hasInfo ? 'flex' : 'none';
    }

    // ── Rebuild constraints from scratch (used by undo) ─────────────
    function rebuildConstraints() {
      knownGreen  = {};
      knownYellow = {};
      knownGray   = new Set();
      minCount    = {};
      for (const g of submittedGuesses) {
        updateConstraints(g.word, g.colors);
      }
    }

    // ── Undo last guess ──────────────────────────────────────────────
    btnUndo.addEventListener('click', () => {
      if (submittedGuesses.length === 0) return;

      const undoneIdx   = submittedGuesses.length - 1;
      const undoneGuess = submittedGuesses[undoneIdx];
      submittedGuesses.pop();

      // Rebuild constraints and possible answers
      rebuildConstraints();
      possibleAnswers = filterAnswers(ANSWERS);

      // Update guesses left
      guessesLeft = TOTAL_GUESSES - submittedGuesses.length;
      guessesLeftBadge.textContent = `${guessesLeft} / ${TOTAL_GUESSES} GUESSES`;

      // The row that was "next active" becomes empty again
      const nextIdx = undoneIdx + 1;
      if (nextIdx < MAX_GUESSES) {
        const nextRow = document.getElementById(`row-${nextIdx}`);
        if (nextRow) {
          nextRow.classList.remove('active');
          nextRow.classList.add('empty-row');
        }
      }

      // Restore undone row to active + clear its tiles
      const undoneRow = document.getElementById(`row-${undoneIdx}`);
      undoneRow.classList.remove('locked');
      undoneRow.classList.add('active');
      for (let i = 0; i < 5; i++) {
        const tile = document.getElementById(`tile-${undoneIdx}-${i}`);
        tile.textContent = '';
        tile.className = 'tile';
      }

      // Re-enable input and restore the undone word
      wordInput.disabled     = false;
      wordInput.placeholder  = 'Type a 5-letter guess…';
      wordInput.style.border = '';
      wordInput.value        = undoneGuess.word.toUpperCase();
      currentWord    = undoneGuess.word;
      currentColors  = [...undoneGuess.colors];
      prevWord       = undoneGuess.word;
      refreshActiveTiles();
      btnAnalyze.disabled = undoneGuess.word.length !== 5;
      btnUndo.disabled    = submittedGuesses.length === 0;

      renderKnownStrip();

      if (submittedGuesses.length > 0) {
        renderResults(possibleAnswers, [], guessesLeft, true);
        computeBestGuesses(possibleAnswers, guessesLeft).then(best => {
          renderResults(possibleAnswers, best, guessesLeft, false);
          renderDebug();
          document.getElementById('rightPanel').scrollTop = 0;
        });
      } else {
        placeholderState.style.display = '';
        resultsArea.innerHTML = '';
        document.getElementById('rightPanel').scrollTop = 0;
      }

      wordInput.focus();
    });

    // ── Shift+T keyboard shortcut — toggle tips panel
    document.addEventListener('keydown', e => {
      if (e.key === 'T' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const tipsHidden = placeholderState.style.display === 'none';
        if (tipsHidden) {
          // Show tips, hide results
          placeholderState.style.display = '';
          resultsArea.style.display = 'none';
        } else if (resultsArea.innerHTML.trim()) {
          // Hide tips, show results
          placeholderState.style.display = 'none';
          resultsArea.style.display = '';
        }
      }
    });

    // ── Ctrl+Z keyboard shortcut for undo ────────────────────────────
    document.addEventListener('keydown', e => {
      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        // Only intercept when not typing in a text input
        if (document.activeElement === wordInput) return;
        if (!btnUndo.disabled) {
          e.preventDefault();
          btnUndo.click();
        }
      }
    });

    // ── Reset ────────────────────────────────────────────────────────
    btnReset.addEventListener('click', () => {
      submittedGuesses = [];
      guessesLeft      = TOTAL_GUESSES;
      knownGreen       = {};
      knownYellow      = {};
      knownGray        = new Set();
      minCount         = {};
      possibleAnswers  = [...ANSWERS];
      currentWord      = '';
      currentColors    = ['gray','gray','gray','gray','gray'];

      wordInput.value       = '';
      wordInput.disabled    = false;
      wordInput.placeholder = 'Type a 5-letter guess…';
      wordInput.style.border = '';
      btnAnalyze.disabled   = true;
      prevWord              = '';
      btnUndo.disabled      = true;
      guessesLeftBadge.textContent = `${TOTAL_GUESSES} / ${TOTAL_GUESSES} GUESSES`;

      placeholderState.style.display = '';
      resultsArea.innerHTML          = '';
      knownStrip.style.display       = 'none';
      knownStrip.innerHTML           = '';
      document.getElementById('rightPanel').scrollTop = 0;

      initRows();
      wordInput.focus();
    });

    // ── Boot ────────────────────────────────────────────────────────
    initRows();
    wordInput.focus();

  })();