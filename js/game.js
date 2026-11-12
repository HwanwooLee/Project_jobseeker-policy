/* =========================================================
   러너 게임 「신청 그 다음」 (PRD F1) — 16비트 레트로 버전

   그리는 방식
   - 게임 세상은 작은 "픽셀 캔버스"(높이 120픽셀)에 그린 뒤
     화면 캔버스에 2~3배로 확대해서 붙임 (imageSmoothingEnabled = false → 픽셀이 또렷)
   - 픽셀 그림은 모두 아래 문자열 배열(한 글자 = 한 픽셀)로 정의. 이미지 파일 없음
   - 말풍선 글자처럼 읽어야 하는 한글은 확대 후 화면 위에 따로 씀 (Galmuri 폰트)
   ========================================================= */
(function () {
  'use strict';

  // ===== 1. 게임 설정 (숫자를 바꾸면 난이도가 바뀜) =====
  const GAME_SECONDS = 25;
  const TASKS = ['결과 발표 확인', '서류 추가 제출', '이번 달 구직활동', '계좌 개설', '출석 확인'];
  const VH = 120;              // 게임 세상 높이 (픽셀)
  const GROUND_Y = 100;        // 땅 윗면 위치
  const START_SPEED = 100;     // 처음 속도 (초당 픽셀)
  const END_SPEED = 160;       // 마지막 속도
  const GRAVITY = 900;
  const JUMP_POWER = 330;
  const PLAYER_X = 28;         // 캐릭터 가로 위치 (고정, 배경이 움직임)
  const BLOCK = 16;            // 블록 한 칸 크기
  const HIGH_BLOCK_CHANCE = 0.35; // 높은 블록(2칸)이 나올 확률
  const MISS_TEXT = '놓쳤어요! 이번 달 지원 중단';
  const FONT = "'Galmuri11', 'Malgun Gothic', sans-serif";

  // ===== 2. 색 (밝은 16비트 팔레트) =====
  const C = {
    dark: '#1a1c2c', ink: '#333c57', slate: '#566c86', gray: '#94b0c2', white: '#f4f4f4',
    navy: '#29366f', blue: '#3b5dc9', sky: '#41a6f6', cloudShade: '#cfe7fa',
    yellow: '#ffcd75', orange: '#ef7d57', red: '#e43b44', wine: '#b13e53',
    green: '#38b764', lime: '#a7f070', teal: '#257179',
    skin: '#f4c69a', hair: '#3b2a20', dirt: '#a8603c', dirtDark: '#7a4029', stone: '#c98a5e',
    usedBlock: '#a8603c', usedLight: '#c98a5e', usedShade: '#7a4029',
  };

  // ===== 3. 픽셀 그림 (한 글자 = 한 픽셀, '.' = 투명) =====
  // 캐릭터: 정장 입은 취준생 16x16 (오른쪽을 봄)
  const PLAYER_HEAD = [
    '......KKKKK.....',
    '.....KHHHHHK....',
    '....KHHHHHHHK...',
    '....KHHSSSSSK...',
    '....KHSSSKSSK...',
    '....KSSSSSSSK...',
    '.....KSSSSSK....',
  ];
  const PLAYER_BODY = [
    '....KJWTWJK.....',   // 흰 셔츠 + 빨간 넥타이
    '...KJJWTWJJK....',
    '...KJJJTJJJK....',
    '...KSJJJJJSK....',   // 양손
    '....KPPPPPK.....',
  ];
  const LEGS_RUN_A = [
    '...KPPK.KPPK....',
    '..KPPK...KPPK...',
    '..KPK.....KPK...',
    '.KBBK.....KBBK..',
  ];
  const LEGS_RUN_B = [
    '.....KPPPK......',
    '.....KPPPK......',
    '.....KPPK.......',
    '.....KBBBK......',
  ];
  const LEGS_RUN_C = [
    '....KPPKPPK.....',
    '...KPPK.KPPK....',
    '...KPK...KPK....',
    '..KBBK...KBBK...',
  ];
  const LEGS_JUMP = [
    '...KPPPPPPK.....',
    '..KPPK..KPPK....',
    '..KBBK...KBBK...',
    '................',
  ];
  const PLAYER_PALETTE = {
    K: C.dark, H: C.hair, S: C.skin, J: C.navy, W: C.white, T: C.red, P: C.ink, B: C.dirtDark,
  };

  // 할 일 블록 16x16 ("!" 상자)
  const BLOCK_ART = [
    'KKKKKKKKKKKKKKKK',
    'KLLLLLLLLLLLLLLK',
    'KLKYYYYYYYYYYKOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYYYYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYKKYYYYYOK',
    'KLYYYYYYYYYYYYOK',
    'KLKYYYYYYYYYYKOK',
    'KOOOOOOOOOOOOOOK',
    'KKKKKKKKKKKKKKKK',
  ];
  const BLOCK_PALETTE = { K: C.dark, L: '#fff4c2', Y: C.yellow, O: C.orange };
  const BLOCK_USED_PALETTE = { K: C.dark, L: C.usedLight, Y: C.usedBlock, O: C.usedShade }; // 부딪힌 블록

  // 구름 16x6
  const CLOUD_ART = [
    '.....WWWW.......',
    '...WWWWWWWW.....',
    '..WWWWWWWWWWW...',
    '.WWWWWWWWWWWWWW.',
    'WWWWWWWWWWWWWWWW',
    '.AAAAAAAAAAAAAA.',
  ];
  const CLOUD_PALETTE = { W: C.white, A: C.cloudShade };

  // 땅 타일 16x20 (잔디 + 흙)
  const GROUND_ART = [
    'lGGlGGGGlGGGGlGG',
    'GGGGGGlGGGGGGGGG',
    'GGGGGGGGGGGGGGGG',
    'GgGGGgGGGGgGGGgG',
    'gggggggggggggggg',
    'DDDdDDDDDDDDdDDD',
    'DDDDDDDsDDDDDDDD',
    'DdDDDDDDDDDDDDdD',
    'DDDDDDDDDdDDDDDD',
    'DDDsDDDDDDDDDDDD',
    'DDDDDDDDDDDDsDDD',
    'DDDDDdDDDDDDDDDD',
    'DDDDDDDDDDDDDDDD',
    'DdDDDDDDDsDDDdDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDsDDDDDDdDDDD',
    'DDDDDDDDDDDDDDDD',
    'DDdDDDDDDDDDDDsD',
    'DDDDDDDsDDDDDDDD',
    'DDDDDDDDDDDDDDDD',
  ];
  const GROUND_PALETTE = { l: C.lime, G: C.green, g: C.teal, D: C.dirt, d: C.dirtDark, s: C.stone };

  // 픽셀 글자 ("+1", "MISS!")
  const GLYPHS = {
    '+': ['...', '.#.', '###', '.#.', '...'],
    '1': ['.#.', '##.', '.#.', '.#.', '###'],
    'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
    'I': ['###', '.#.', '.#.', '.#.', '###'],
    'S': ['.###', '#...', '.##.', '...#', '###.'],
    '!': ['#', '#', '#', '.', '#'],
  };

  // 문자열 배열 → 작은 캔버스(스프라이트)로 미리 만들어 둠
  function makeSprite(rows, palette) {
    const sprite = document.createElement('canvas');
    sprite.width = rows[0].length;
    sprite.height = rows.length;
    const g = sprite.getContext('2d');
    rows.forEach(function (row, y) {
      if (row.length !== sprite.width) console.warn('픽셀 그림 줄 길이가 달라요:', row);
      for (let x = 0; x < row.length; x++) {
        const color = palette[row[x]];
        if (color) {
          g.fillStyle = color;
          g.fillRect(x, y, 1, 1);
        }
      }
    });
    return sprite;
  }

  const SPR = {
    runA: makeSprite(PLAYER_HEAD.concat(PLAYER_BODY, LEGS_RUN_A), PLAYER_PALETTE),
    runB: makeSprite(PLAYER_HEAD.concat(PLAYER_BODY, LEGS_RUN_B), PLAYER_PALETTE),
    runC: makeSprite(PLAYER_HEAD.concat(PLAYER_BODY, LEGS_RUN_C), PLAYER_PALETTE),
    jump: makeSprite(PLAYER_HEAD.concat(PLAYER_BODY, LEGS_JUMP), PLAYER_PALETTE),
    block: makeSprite(BLOCK_ART, BLOCK_PALETTE),
    blockUsed: makeSprite(BLOCK_ART, BLOCK_USED_PALETTE),
    cloud: makeSprite(CLOUD_ART, CLOUD_PALETTE),
    ground: makeSprite(GROUND_ART, GROUND_PALETTE),
  };
  const RUN_CYCLE = [SPR.runA, SPR.runB, SPR.runC, SPR.runB]; // 달리기 프레임 순서

  // 늘 같은 모양이 나오도록 '씨앗 있는' 랜덤 (배경 생성용)
  function seededRandom(seed) {
    return function () {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  // 배경 1 (맨 뒤): 구름 띠 — 가로로 이어 붙여 반복
  function makeCloudLayer() {
    const layer = document.createElement('canvas');
    layer.width = 320;
    layer.height = 40;
    const g = layer.getContext('2d');
    g.imageSmoothingEnabled = false;
    [[8, 12, 1], [70, 2, 2], [160, 18, 1], [210, 6, 2], [285, 22, 1]].forEach(function (c) {
      g.drawImage(SPR.cloud, c[0], c[1], 16 * c[2], 6 * c[2]);
    });
    return layer;
  }

  // 배경 2 (중간): 도시 빌딩 실루엣 + 창문 불빛
  function makeCityLayer() {
    const layer = document.createElement('canvas');
    layer.width = 256;
    layer.height = 64;
    const g = layer.getContext('2d');
    const rand = seededRandom(7);
    let x = 0;
    let tone = 0;
    while (x < layer.width) {
      let w = 14 + Math.floor(rand() * 10) * 2;
      if (x + w > layer.width) w = layer.width - x;
      const h = 20 + Math.floor(rand() * 40);
      const top = layer.height - h;
      g.fillStyle = tone % 2 ? C.navy : C.blue;
      g.fillRect(x, top, w, h);
      // 옥상 테두리 한 줄 밝게
      g.fillStyle = tone % 2 ? C.blue : C.sky;
      g.fillRect(x, top, w, 1);
      // 가끔 안테나
      if (rand() < 0.3 && w > 6) {
        g.fillStyle = C.navy;
        g.fillRect(x + Math.floor(w / 2), top - 5, 1, 5);
      }
      // 창문: 2x2, 일부만 불 켜짐
      for (let wy = top + 4; wy + 2 < layer.height - 2; wy += 5) {
        for (let wx = x + 3; wx + 2 <= x + w - 3; wx += 4) {
          g.fillStyle = rand() < 0.35 ? C.yellow : (tone % 2 ? C.ink : C.navy);
          g.fillRect(wx, wy, 2, 2);
        }
      }
      x += w;
      tone += 1;
    }
    return layer;
  }

  const LAYER_CLOUD = makeCloudLayer();
  const LAYER_CITY = makeCityLayer();

  // ===== 4. 화면 요소 =====
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('game-stage');
  const screens = {
    intro: document.getElementById('screen-intro'),
    result: document.getElementById('screen-result'),
  };
  const hud = {
    time: document.getElementById('hud-time'),
    timeFill: document.getElementById('hud-time-fill'),
    done: document.getElementById('hud-done'),
    miss: document.getElementById('hud-miss'),
  };
  const soundBtn = document.getElementById('btn-sound');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 작은 픽셀 캔버스 (게임 세상)
  const buf = document.createElement('canvas');
  const g = buf.getContext('2d');

  let S = 3;        // 확대 배율 (PC 3배, 모바일 2배)
  let VW = 200;     // 게임 세상 너비 (화면 폭에 따라 달라짐)
  let cssW = 600, cssH = 360, dpr = 1;

  function resize() {
    cssW = stage.clientWidth;
    S = cssW >= 600 ? 3 : 2;
    cssH = VH * S;
    canvas.style.height = cssH + 'px';
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    VW = Math.ceil(cssW / S);
    buf.width = VW;
    buf.height = VH;
  }

  // ===== 5. 효과음 (Web Audio API로 8비트 소리 만들기) =====
  let audio = null;
  let master = null;
  let soundOn = true;
  try { soundOn = localStorage.getItem('game-sound') !== 'off'; } catch (e) { /* 저장 불가 환경이면 기본값(켜짐) */ }

  function ensureAudio() {
    if (!audio) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      audio = new AudioCtx();
      master = audio.createGain();
      master.gain.value = 0.12; // 전체 음량
      master.connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  // 삑 소리 하나: freq(높이) → to(끝 높이)로 미끄러지며 dur초 동안
  function beep(freq, dur, opts) {
    opts = opts || {};
    if (!soundOn) return;
    const ac = ensureAudio();
    if (!ac) return;
    const t = ac.currentTime + (opts.delay || 0);
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    gain.gain.setValueAtTime(opts.vol || 1, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const sfx = {
    jump: function () { beep(320, 0.12, { to: 720, vol: 0.7 }); },
    success: function () { beep(988, 0.07); beep(1319, 0.16, { delay: 0.07 }); },
    fail: function () { beep(240, 0.35, { type: 'sawtooth', to: 70, vol: 0.9 }); },
    start: function () { beep(523, 0.08); beep(784, 0.12, { delay: 0.08 }); },
    end: function () {
      [523, 659, 784, 1047].forEach(function (f, i) {
        beep(f, i === 3 ? 0.4 : 0.13, { delay: i * 0.13 });
      });
    },
  };

  function renderSoundButton() {
    soundBtn.textContent = soundOn ? '소리 켜짐' : '소리 꺼짐';
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  }

  // ===== 6. 게임 상태 =====
  let running = false;
  let lastTime = performance.now();
  let state = newState();

  function newState() {
    return {
      elapsed: 0,
      distance: 0,         // 달린 거리 (배경 흐름용)
      playerY: 0,          // 땅에서 떠 있는 높이
      velocityY: 0,
      obstacles: [],
      nextSpawnIn: 1.6,    // 첫 블록은 깃발이 보이도록 조금 늦게
      done: 0,
      miss: 0,
      missLeft: 0,         // "MISS!" 남은 표시 시간
      blinkLeft: 0,        // 캐릭터 깜빡임 남은 시간
      shakeLeft: 0,        // 화면 흔들림 남은 시간
      popups: [],          // 튀어오르는 "+1"
      particles: [],       // 반짝이
    };
  }

  function showOverlay(name) {
    screens.intro.classList.toggle('hidden', name !== 'intro');
    screens.result.classList.toggle('hidden', name !== 'result');
  }

  function startGame() {
    ensureAudio(); // 브라우저는 클릭한 순간에만 소리를 켤 수 있어서 여기서 준비
    if (document.activeElement) document.activeElement.blur(); // 스페이스바가 버튼을 누르지 않게
    state = newState();
    showOverlay(null);
    updateHud();
    running = true;
    lastTime = performance.now();
    sfx.start();
  }

  function endGame() {
    running = false;
    // 화면 정리 (깜빡임 도중에 끝나도 캐릭터가 보이게)
    state.obstacles = [];
    state.popups = [];
    state.particles = [];
    state.missLeft = 0;
    state.blinkLeft = 0;
    state.shakeLeft = 0;
    state.playerY = 0;
    state.velocityY = 0;
    document.getElementById('result-done').textContent = state.done;
    document.getElementById('result-miss').textContent = state.miss;
    showOverlay('result');
    sfx.end();
  }

  function jump() {
    if (!running) return;
    if (state.playerY === 0) { // 땅에 있을 때만 점프
      state.velocityY = JUMP_POWER;
      sfx.jump();
    }
  }

  // ===== 7. 매 프레임 계산 =====
  function currentSpeed() {
    const progress = Math.min(state.elapsed / GAME_SECONDS, 1);
    return START_SPEED + (END_SPEED - START_SPEED) * progress;
  }

  function update(dt) {
    state.elapsed += dt;
    const speed = currentSpeed();
    state.distance += speed * dt;

    // 점프 물리
    if (state.playerY > 0 || state.velocityY > 0) {
      state.velocityY -= GRAVITY * dt;
      state.playerY += state.velocityY * dt;
      if (state.playerY <= 0) {
        state.playerY = 0;
        state.velocityY = 0;
      }
    }

    // 블록 만들기 (1.0~1.8초 간격)
    state.nextSpawnIn -= dt;
    if (state.nextSpawnIn <= 0) {
      const high = Math.random() < HIGH_BLOCK_CHANCE;
      state.obstacles.push({
        text: TASKS[Math.floor(Math.random() * TASKS.length)],
        x: VW + 4,
        h: high ? BLOCK * 2 : BLOCK,
        hit: false,
        passed: false,
      });
      state.nextSpawnIn = 1.0 + Math.random() * 0.8;
    }

    // 블록 이동 + 부딪힘 / 넘음 판정
    const p = playerHitbox();
    state.obstacles.forEach(function (ob) {
      ob.x -= speed * dt;
      if (ob.hit || ob.passed) return;

      const obTop = GROUND_Y - ob.h;
      const touching = p.x < ob.x + BLOCK && p.x + p.w > ob.x && p.y + p.h > obTop;
      if (touching) {
        ob.hit = true;
        state.miss += 1;
        state.missLeft = 1;      // 1초 표시
        state.blinkLeft = 0.9;
        state.shakeLeft = 0.3;
        sfx.fail();
      } else if (ob.x + BLOCK < p.x) {
        ob.passed = true;
        state.done += 1;
        addSuccessEffect(ob.x + BLOCK / 2, obTop);
        sfx.success();
      }
    });
    state.obstacles = state.obstacles.filter(function (ob) { return ob.x > -BLOCK - 40; });

    // 효과 시간 줄이기
    state.popups.forEach(function (pop) {
      pop.vy += 160 * dt;
      pop.y += pop.vy * dt;
      pop.life -= dt;
    });
    state.popups = state.popups.filter(function (pop) { return pop.life > 0; });
    state.particles.forEach(function (pt) {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vy += 60 * dt;
      pt.life -= dt;
    });
    state.particles = state.particles.filter(function (pt) { return pt.life > 0; });
    state.missLeft = Math.max(0, state.missLeft - dt);
    state.blinkLeft = Math.max(0, state.blinkLeft - dt);
    state.shakeLeft = Math.max(0, state.shakeLeft - dt);

    updateHud();
  }

  // 캐릭터 몸통 범위 (그림의 빈 칸은 빼서 조금 너그럽게)
  function playerHitbox() {
    return { x: PLAYER_X + 3, y: GROUND_Y - 16 - state.playerY + 1, w: 10, h: 15 };
  }

  function addSuccessEffect(x, y) {
    state.popups.push({ x: x, y: y - 8, vy: -70, life: 0.8 });
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      const power = 25 + Math.random() * 40;
      state.particles.push({
        x: x, y: y - 4,
        vx: Math.cos(angle) * power,
        vy: Math.sin(angle) * power - 20,
        life: 0.35 + Math.random() * 0.3,
        color: Math.random() < 0.5 ? C.yellow : C.white,
      });
    }
  }

  function updateHud() {
    const left = Math.max(0, GAME_SECONDS - state.elapsed);
    hud.time.textContent = Math.ceil(left);
    hud.timeFill.style.width = (left / GAME_SECONDS * 100) + '%';
    hud.timeFill.classList.toggle('low', left <= 5);
    hud.done.textContent = state.done;
    hud.miss.textContent = state.miss;
  }

  // ===== 8. 그리기 =====
  function mod(a, b) { return ((a % b) + b) % b; }

  // 배경 띠를 가로로 반복해서 그림
  function drawRepeat(layer, scroll, y) {
    for (let x = -mod(scroll, layer.width); x < VW; x += layer.width) {
      g.drawImage(layer, Math.round(x), y);
    }
  }

  function drawPixelText(text, x, y, scale, color) {
    // 먼저 어두운 테두리, 그 위에 색
    [C.dark, color].forEach(function (fill, pass) {
      g.fillStyle = fill;
      let cx = x;
      for (const ch of text) {
        const glyph = GLYPHS[ch];
        if (!glyph) continue;
        glyph.forEach(function (row, gy) {
          for (let gx = 0; gx < row.length; gx++) {
            if (row[gx] !== '#') continue;
            const px = cx + gx * scale;
            const py = y + gy * scale;
            if (pass === 0) g.fillRect(px - 1, py - 1, scale + 2, scale + 2);
            else g.fillRect(px, py, scale, scale);
          }
        });
        cx += (glyph[0].length + 1) * scale;
      }
    });
  }

  function pixelTextWidth(text, scale) {
    let w = 0;
    for (const ch of text) if (GLYPHS[ch]) w += (GLYPHS[ch][0].length + 1) * scale;
    return w - scale;
  }

  function overlayFontSize() { return S >= 3 ? 16 : 12; }

  // "신청 완료!" 깃발 (픽셀 부분) — 깃발 천 크기는 글자 길이에 맞춤
  function flagLayout() {
    ctx.font = overlayFontSize() + 'px ' + FONT;
    const textW = ctx.measureText('신청 완료!').width;
    return {
      poleX: Math.round(10 - state.distance),
      clothW: Math.ceil((textW + 12) / S),
      clothH: Math.ceil((overlayFontSize() + 10) / S),
      top: GROUND_Y - 48,
    };
  }

  function drawFlagPixels(f, now) {
    if (f.poleX + f.clothW < -4) return;
    // 깃대
    g.fillStyle = C.dark;
    g.fillRect(f.poleX - 1, f.top, 4, GROUND_Y - f.top);
    g.fillStyle = C.gray;
    g.fillRect(f.poleX, f.top, 2, GROUND_Y - f.top);
    // 꼭대기 공
    g.fillStyle = C.dark;
    g.fillRect(f.poleX - 2, f.top - 4, 6, 5);
    g.fillStyle = C.yellow;
    g.fillRect(f.poleX - 1, f.top - 3, 4, 3);
    // 깃발 천 (빨강) — 끝부분 3픽셀이 위아래로 움직여 펄럭이는 느낌
    const cx = f.poleX + 2;
    const cy = f.top + 1;
    const mainW = f.clothW - 3;
    const wave = Math.floor(now / 250) % 2;
    g.fillStyle = C.dark;
    g.fillRect(cx, cy, mainW, f.clothH + 2);
    g.fillRect(cx + mainW, cy + wave, 4, f.clothH + 2);
    g.fillStyle = C.red;
    g.fillRect(cx, cy + 1, mainW, f.clothH);
    g.fillRect(cx + mainW, cy + 1 + wave, 3, f.clothH);
    g.fillStyle = C.wine;
    g.fillRect(cx, cy + f.clothH, mainW, 1);
    g.fillRect(cx + mainW, cy + f.clothH + wave, 3, 1);
  }

  function render(now) {
    const t = now / 1000;
    const speedFactor = state.distance;

    // ---- (1) 작은 픽셀 캔버스에 세상 그리기 ----
    g.imageSmoothingEnabled = false;
    g.fillStyle = C.sky;                                     // 하늘
    g.fillRect(0, 0, VW, VH);
    drawRepeat(LAYER_CLOUD, speedFactor * 0.1 + t * 3, 4);   // 맨 뒤: 구름 (아주 느리게)
    drawRepeat(LAYER_CITY, speedFactor * 0.35, GROUND_Y - LAYER_CITY.height); // 중간: 빌딩
    const flag = flagLayout();
    drawFlagPixels(flag, now);
    drawRepeat(SPR.ground, speedFactor, GROUND_Y);           // 앞: 잔디·흙 (빠르게)

    // 블록 (낮은 블록 1칸 / 높은 블록 2칸)
    state.obstacles.forEach(function (ob) {
      const sprite = ob.hit ? SPR.blockUsed : SPR.block;
      for (let i = 0; i < ob.h / BLOCK; i++) {
        g.drawImage(sprite, Math.round(ob.x), GROUND_Y - BLOCK * (i + 1));
      }
    });

    // 캐릭터 (부딪히면 깜빡임)
    const blinkHide = state.blinkLeft > 0 && Math.floor(state.blinkLeft * 14) % 2 === 0;
    if (!blinkHide) {
      let sprite = SPR.runB; // 서 있는 모습
      if (running) {
        sprite = state.playerY > 0 ? SPR.jump : RUN_CYCLE[Math.floor(state.distance / 6) % RUN_CYCLE.length];
      }
      g.drawImage(sprite, PLAYER_X, Math.round(GROUND_Y - 16 - state.playerY));
    }

    // 반짝이 파티클
    state.particles.forEach(function (pt) {
      g.fillStyle = pt.color;
      const px = Math.round(pt.x), py = Math.round(pt.y);
      g.fillRect(px, py, 1, 1);
      if (pt.life > 0.3) { // 처음엔 십자 모양
        g.fillRect(px - 1, py, 3, 1);
        g.fillRect(px, py - 1, 1, 3);
      }
    });

    // 튀어오르는 노란 "+1"
    state.popups.forEach(function (pop) {
      if (pop.life < 0.25 && Math.floor(pop.life * 20) % 2 === 0) return; // 사라질 때 깜빡
      const w = pixelTextWidth('+1', 2);
      drawPixelText('+1', Math.round(pop.x - w / 2), Math.round(pop.y), 2, C.yellow);
    });

    // 빨간 "MISS!"
    if (state.missLeft > 0) {
      const w = pixelTextWidth('MISS!', 3);
      const bounce = state.missLeft > 0.85 ? -2 : 0;
      drawPixelText('MISS!', Math.round(VW / 2 - w / 2), 8 + bounce, 3, C.red);
    }

    // ---- (2) 화면 캔버스에 확대해서 붙이기 (흔들림 포함) ----
    let shakeX = 0, shakeY = 0;
    if (state.shakeLeft > 0 && !reduceMotion) {
      shakeX = Math.round(Math.random() * 4 - 2) * S;
      shakeY = Math.round(Math.random() * 4 - 2) * S;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false; // 픽셀 또렷하게
    ctx.fillStyle = C.dark;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0, VW, VH, shakeX * dpr, shakeY * dpr, VW * S * dpr, VH * S * dpr);

    // ---- (3) 읽어야 하는 한글은 확대한 화면 위에 직접 쓰기 ----
    ctx.setTransform(dpr, 0, 0, dpr, shakeX * dpr, shakeY * dpr);
    const fs = overlayFontSize();
    ctx.font = fs + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 깃발 글자
    if (flag.poleX + flag.clothW > -4) {
      outlinedText('신청 완료!', (flag.poleX + 2 + flag.clothW / 2) * S, (flag.top + 1.5 + flag.clothH / 2) * S, C.white);
    }

    // 블록 위 말풍선
    state.obstacles.forEach(function (ob) {
      drawBubble(ob.text, (Math.round(ob.x) + BLOCK / 2) * S, (GROUND_Y - ob.h) * S - 6, fs, ob.hit);
    });

    // 부딪혔을 때 한글 안내 (MISS! 아래)
    if (state.missLeft > 0) {
      ctx.font = 'bold ' + fs + 'px ' + FONT;
      outlinedText(MISS_TEXT, (VW * S) / 2, 8 * S + 19 * S + fs / 2, C.red);
    }
  }

  // 글자 테두리(어두운색) + 글자
  function outlinedText(text, x, y, color) {
    ctx.fillStyle = C.dark;
    [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]].forEach(function (o) {
      ctx.fillText(text, Math.round(x) + o[0], Math.round(y) + o[1]);
    });
    ctx.fillStyle = color;
    ctx.fillText(text, Math.round(x), Math.round(y));
  }

  // 픽셀 느낌 말풍선 (꼬리가 블록을 가리킴)
  function drawBubble(text, centerX, bottomY, fs, hit) {
    const b = S >= 3 ? 3 : 2;               // 테두리 두께
    const w = Math.ceil(ctx.measureText(text).width) + 14;
    const h = fs + 12;
    const x = Math.round(centerX - w / 2);
    const y = Math.round(bottomY - h - 6);
    ctx.fillStyle = C.dark;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.white;
    ctx.fillRect(x + b, y + b, w - b * 2, h - b * 2);
    // 꼬리 (계단 모양)
    const tx = Math.round(centerX);
    ctx.fillStyle = C.dark;
    ctx.fillRect(tx - 4, y + h - b, 8, 4);
    ctx.fillRect(tx - 2, y + h + 2, 4, 4);
    ctx.fillStyle = C.white;
    ctx.fillRect(tx - 4 + b, y + h - b, 8 - b * 2, 3);
    ctx.fillStyle = hit ? C.red : C.dark;
    ctx.fillText(text, x + w / 2, y + h / 2 + 1);
  }

  // ===== 9. 반복 실행 (게임 중이 아닐 때도 구름·깃발은 움직임) =====
  function frame(now) {
    // 탭 전환 등으로 프레임이 크게 밀려도 한 번에 튀지 않게 최대 0.05초로 제한
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    if (running) {
      update(dt);
      if (state.elapsed >= GAME_SECONDS) endGame();
    }
    render(now);
    requestAnimationFrame(frame);
  }

  // ===== 10. 입력 =====
  function isButtonLike(el) {
    return el && (el.tagName === 'BUTTON' || el.tagName === 'A');
  }

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (running) {
      e.preventDefault(); // 화면 스크롤·버튼 눌림 방지
      if (!e.repeat) jump();
    } else if (!screens.intro.classList.contains('hidden') && !isButtonLike(e.target)) {
      e.preventDefault();
      startGame(); // 시작 화면에서는 스페이스바로도 시작
    }
  });
  document.addEventListener('keyup', function (e) {
    if (running && (e.code === 'Space' || e.key === ' ')) e.preventDefault();
  });
  canvas.addEventListener('pointerdown', function (e) {
    if (!running) return;
    e.preventDefault();
    jump();
  });

  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-retry').addEventListener('click', startGame);
  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    try { localStorage.setItem('game-sound', soundOn ? 'on' : 'off'); } catch (e) { /* 무시 */ }
    renderSoundButton();
    soundBtn.blur();
    if (soundOn) beep(880, 0.08);
  });
  window.addEventListener('resize', resize);

  // ===== 시작 =====
  if (document.fonts && document.fonts.load) document.fonts.load('16px Galmuri11'); // 캔버스 글자용 폰트 미리 불러오기
  resize();
  renderSoundButton();
  updateHud();
  requestAnimationFrame(frame);
})();
