/* =========================================================
   설문 (PRD F2) — 받을 수 있는 정책을 거르기 위한 조건 입력 (최대 8문항)
   답변은 sessionStorage "userProfile"에 저장 → result.html에서 사용
   (sessionStorage는 탭·창을 닫으면 사라져서 다음 사람이 흔적을 볼 수 없음)
   들어올 때마다 항상 빈 상태로 시작 (이전 답변을 채우지 않음)
   고른 답은 온통청년 API 코드(schoolCd, jobCd, plcyMajorCd)로도 바꿔서 함께 저장
   ========================================================= */
(function () {
  'use strict';

  // ===== 1. 설정 =====
  const STORAGE_KEY = 'userProfile';
  const NEXT_PAGE = 'result.html';
  const YEAR_FROM = 1986;
  const YEAR_TO = 2008;
  const AUTO_NEXT_MS = 260;   // 버튼을 고르면 이만큼 뒤에 다음 질문으로

  // 시·도 → zipCd(법정 시군구 코드) 앞 2자리
  // data/policies.json에 실제로 들어 있는 zipCd 앞 2자리를 모아서 확인한 값 (2026-11-12 수집 기준)
  // - 강원 51, 전북 52: 특별자치도 전환 후 코드
  // - 광주·전남: 데이터에 29·46이 없고, 둘 다 12(전남광주통합특별시)로 들어옴
  const SIDO = [
    { label: '서울', code: '11' }, { label: '부산', code: '26' }, { label: '대구', code: '27' },
    { label: '인천', code: '28' }, { label: '광주', code: '12' }, { label: '대전', code: '30' },
    { label: '울산', code: '31' }, { label: '세종', code: '36' }, { label: '경기', code: '41' },
    { label: '강원', code: '51' }, { label: '충북', code: '43' }, { label: '충남', code: '44' },
    { label: '전북', code: '52' }, { label: '전남', code: '12' }, { label: '경북', code: '47' },
    { label: '경남', code: '48' }, { label: '제주', code: '50' },
  ];

  const EDUCATION = [
    { label: '고등학교' },
    { label: '전문대(2·3년제)' },
    { label: '4년제 대학' },
    { label: '대학원' },
  ];
  const SCHOOL_STATUS = [
    { label: '재학 중' },
    { label: '졸업 예정(마지막 학기)' },
    { label: '졸업' },
  ];
  // 하는 일 → jobCd (정책취업요건코드)
  const JOB = [
    { label: '구직 중(일 안 함)', code: '0013003' },     // 미취업자
    { label: '일하면서 이직 준비', code: '0013001' },     // 재직자
    { label: '아르바이트·단기 근무', code: '0013007' },   // 단기근로자
  ];
  // 전공 → plcyMajorCd (정책전공요건코드)
  const MAJOR = [
    { label: '인문', code: '0011001' }, { label: '사회', code: '0011002' },
    { label: '상경(경영·경제)', code: '0011003' }, { label: '자연과학', code: '0011004' },
    { label: '공학·IT', code: '0011005' }, { label: '예체능', code: '0011006' },
    { label: '농업·생명', code: '0011007' }, { label: '기타', code: '0011008' },
  ];
  const BENEFIT = [{ label: '예' }, { label: '아니오' }, { label: '잘 모르겠어요' }];
  // 작년 소득 → 만 원 단위 범위 (max가 null이면 상한 없음)
  const INCOME = [
    { label: '소득 없음', min: 0, max: 0 },
    { label: '1,200만 원 미만', min: 0, max: 1200 },
    { label: '1,200~2,400만 원', min: 1200, max: 2400 },
    { label: '2,400~3,600만 원', min: 2400, max: 3600 },
    { label: '3,600~5,000만 원', min: 3600, max: 5000 },
    { label: '5,000만 원 이상', min: 5000, max: null },
  ];

  // 학력(3번) + 학업 상태(4번) → schoolCd (정책학력요건코드)
  function toSchoolCd(education, schoolStatus) {
    if (!education || !schoolStatus) return null;
    if (education === '대학원') return '0049008';
    const idx = SCHOOL_STATUS.findIndex(function (s) { return s.label === schoolStatus; });
    if (idx === -1) return null;
    if (education === '고등학교') return ['0049002', '0049003', '0049004'][idx];
    return ['0049005', '0049006', '0049007'][idx];   // 전문대 · 4년제
  }

  // 질문 목록 (순서대로). showIf가 있으면 조건이 맞을 때만 보여줌
  const QUESTIONS = [
    { key: 'birthYear', type: 'year',
      title: '태어난 해를 골라 주세요',
      help: '나이 조건이 맞는 정책을 찾는 데만 써요' },
    { key: 'sido', type: 'choice', options: SIDO, cols: 'sido',
      title: '어디에 살고 있나요?',
      help: '주민등록상 사는 시·도를 골라 주세요' },
    { key: 'education', type: 'choice', options: EDUCATION, cols: '1',
      title: '최종 학력은 무엇인가요?',
      help: '지금 다니고 있는 학교도 포함해서 골라 주세요' },
    { key: 'schoolStatus', type: 'choice', options: SCHOOL_STATUS, cols: '1',
      title: '학업 상태는 어떤가요?',
      help: '앞에서 고른 학력 기준으로 골라 주세요' },
    { key: 'jobStatus', type: 'choice', options: JOB, cols: '1',
      title: '지금 하는 일은 무엇인가요?',
      help: '취업 상태에 따라 받을 수 있는 정책이 달라요' },
    { key: 'major', type: 'choice', options: MAJOR, cols: '2',
      title: '전공은 무엇인가요?',
      help: '전공 조건이 있는 정책을 거르는 데 써요',
      showIf: function (a) { return !!a.education && a.education !== '고등학교'; } },
    { key: 'unemploymentBenefit', type: 'choice', options: BENEFIT, cols: '1',
      title: '지금 실업급여를 받고 있나요?',
      help: '정책마다 실업급여를 받는 중인지에 따라 조건이 달라요' },
    { key: 'income', type: 'choice', options: INCOME, cols: '2', skippable: true,
      title: '작년 1년 소득(세전)은 얼마였나요?',
      help: '정확한 판정이 아니라 대략적인 확인용이에요. 입력하지 않아도 돼요.<br>입력한 내용은 이 창을 닫으면 사라지고 어디에도 보내지 않아요.' },
  ];

  // ===== 2. 상태 =====
  const answers = {};          // key → 고른 label (출생 연도는 숫자)
  let current = QUESTIONS[0];  // 지금 보고 있는 질문
  let autoTimer = null;
  const thisYear = new Date().getFullYear();

  // ===== 3. 화면 요소 =====
  const $ = function (id) { return document.getElementById(id); };
  const questionsBox = $('questions');
  const btnPrev = $('btn-prev');
  const btnNext = $('btn-next');
  const formError = $('form-error');
  const progressFill = $('progress-fill');
  const progressBar = document.querySelector('.progress');
  const sectionOf = {};        // key → section 요소
  let yearSelect = null;
  let ageHint = null;

  // ===== 4. 도구 =====
  function find(list, label) {
    return list.find(function (o) { return o.label === label; }) || null;
  }
  // 지금 보여줘야 하는 질문들 (전공은 조건부)
  function visibleQuestions() {
    return QUESTIONS.filter(function (q) { return !q.showIf || q.showIf(answers); });
  }
  function isAnswered(q) {
    return answers[q.key] !== undefined && answers[q.key] !== null;
  }
  // 출생 연도만 알아서 만 나이는 범위로: (올해 - 출생연도 - 1) ~ (올해 - 출생연도)
  function ageRange(birthYear) {
    return { min: thisYear - birthYear - 1, max: thisYear - birthYear };
  }

  // ===== 5. 저장 =====
  // 예전 버전이 localStorage에 남긴 답변이 있으면 지움 (게임 최고 점수 등 다른 값은 그대로)
  function clearOldLocalProfile() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 저장소를 못 쓰는 환경이면 무시 */ }
  }

  function buildProfile() {
    const age = ageRange(answers.birthYear);
    const sido = find(SIDO, answers.sido);
    const job = find(JOB, answers.jobStatus);
    const showMajor = QUESTIONS[5].showIf(answers);
    const major = showMajor ? find(MAJOR, answers.major) : null;
    const income = find(INCOME, answers.income);   // 건너뛰면 null
    return {
      birthYear: answers.birthYear,
      ageMin: age.min,
      ageMax: age.max,
      sido: sido.label,
      sidoCode: sido.code,
      education: answers.education,
      schoolStatus: answers.schoolStatus,
      schoolCd: toSchoolCd(answers.education, answers.schoolStatus),
      jobStatus: job.label,
      jobCd: job.code,
      major: major ? major.label : null,
      plcyMajorCd: major ? major.code : null,
      unemploymentBenefit: answers.unemploymentBenefit,
      incomeMin: income ? income.min : null,
      incomeMax: income ? income.max : null,
      savedAt: new Date().toISOString(),
    };
  }

  function saveProfile() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(buildProfile()));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===== 6. 질문 화면 만들기 =====
  function buildQuestions() {
    QUESTIONS.forEach(function (q) {
      const sec = document.createElement('section');
      sec.className = 'q';
      sec.hidden = true;
      sec.setAttribute('aria-labelledby', 'q-title-' + q.key);
      sec.innerHTML =
        '<p class="q-num"></p>' +
        '<h1 class="q-title" id="q-title-' + q.key + '">' + q.title + '</h1>' +
        '<p class="q-help">' + q.help + '</p>';

      if (q.type === 'year') {
        sec.insertAdjacentHTML('beforeend',
          '<div class="select-wrap">' +
          '<label for="birth-year" class="sr-only">출생 연도</label>' +
          '<select id="birth-year" class="year-select"><option value="">출생 연도 선택</option></select>' +
          '</div><p id="age-hint" class="age-hint" aria-live="polite"></p>');
        yearSelect = sec.querySelector('select');
        ageHint = sec.querySelector('.age-hint');
        for (let y = YEAR_TO; y >= YEAR_FROM; y--) {
          const opt = document.createElement('option');
          opt.value = String(y);
          opt.textContent = y + '년';
          yearSelect.appendChild(opt);
        }
        yearSelect.addEventListener('change', function () {
          answers.birthYear = yearSelect.value ? Number(yearSelect.value) : null;
          formError.textContent = '';
          renderAnswers();
          updateNav();
        });
      } else {
        const box = document.createElement('div');
        box.className = 'choices cols-' + q.cols;
        box.setAttribute('role', 'radiogroup');
        box.setAttribute('aria-labelledby', 'q-title-' + q.key);
        q.options.forEach(function (opt) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'choice';
          btn.textContent = opt.label;
          btn.setAttribute('role', 'radio');
          btn.setAttribute('aria-checked', 'false');
          btn.dataset.value = opt.label;
          btn.addEventListener('click', function () { choose(q, opt.label); });
          box.appendChild(btn);
        });
        box.addEventListener('keydown', arrowKeys);
        sec.appendChild(box);
        if (q.skippable) {
          const skip = document.createElement('button');
          skip.type = 'button';
          skip.className = 'btn-skip';
          skip.textContent = '건너뛰기';
          skip.addEventListener('click', function () {
            answers[q.key] = null;   // 입력 안 함
            renderAnswers();
            finish();
          });
          sec.appendChild(skip);
        }
      }
      sectionOf[q.key] = sec;
      questionsBox.appendChild(sec);
    });
  }

  // 방향키로 선택지 이동
  function arrowKeys(e) {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (keys.indexOf(e.key) === -1) return;
    e.preventDefault();
    const items = Array.prototype.slice.call(e.currentTarget.querySelectorAll('.choice'));
    const i = items.indexOf(document.activeElement);
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
    items[(i + dir + items.length) % items.length].focus();
  }

  // ===== 7. 답 고르기 =====
  function choose(q, value) {
    answers[q.key] = value;
    // 학력을 고등학교로 바꾸면 전공 답은 지움
    if (q.key === 'education' && !QUESTIONS[5].showIf(answers)) answers.major = null;
    formError.textContent = '';
    renderAnswers();
    updateNav();
    clearTimeout(autoTimer);
    const list = visibleQuestions();
    if (list.indexOf(q) < list.length - 1) {
      autoTimer = setTimeout(function () { goBy(1); }, AUTO_NEXT_MS);   // 바로 다음 질문으로
    } else {
      btnNext.focus();   // 마지막 질문은 [내 정책 보기 →]를 직접 누름
    }
  }

  function renderAnswers() {
    yearSelect.value = answers.birthYear ? String(answers.birthYear) : '';
    yearSelect.classList.toggle('picked', !!answers.birthYear);
    if (answers.birthYear) {
      const age = ageRange(answers.birthYear);
      ageHint.innerHTML = '올해 기준 <strong>만 ' + age.min + '~' + age.max + '세</strong>예요';
    } else {
      ageHint.textContent = '';
    }
    QUESTIONS.forEach(function (q) {
      if (q.type !== 'choice') return;
      sectionOf[q.key].querySelectorAll('.choice').forEach(function (btn) {
        btn.setAttribute('aria-checked', String(btn.dataset.value === answers[q.key]));
      });
    });
  }

  // ===== 8. 질문 이동 =====
  function updateNav() {
    const list = visibleQuestions();
    const idx = list.indexOf(current);
    const last = idx === list.length - 1;
    btnPrev.classList.toggle('invisible', idx === 0);
    btnNext.textContent = last ? '내 정책 보기 →' : '다음';
    btnNext.disabled = !isAnswered(current);

    // 진행 바 (전공 질문이 빠지면 전체 개수도 줄어듦)
    $('step-now').textContent = idx + 1;
    $('step-total').textContent = list.length;
    progressFill.style.width = ((idx + 1) / list.length * 100) + '%';
    progressBar.setAttribute('aria-valuenow', String(idx + 1));
    progressBar.setAttribute('aria-valuemax', String(list.length));
    sectionOf[current.key].querySelector('.q-num').textContent = '질문 ' + (idx + 1);
  }

  function show(q, forward) {
    clearTimeout(autoTimer);
    current = q;
    QUESTIONS.forEach(function (item) {
      const sec = sectionOf[item.key];
      const on = item === q;
      sec.hidden = !on;
      sec.classList.remove('enter', 'enter-back');
      if (on && forward !== undefined) {
        void sec.offsetWidth;   // 애니메이션 다시 시작
        sec.classList.add(forward ? 'enter' : 'enter-back');
      }
    });
    formError.textContent = '';
    updateNav();
    // 새 질문으로 넘어가면 고른 답(없으면 첫 선택지)에 초점
    const sec = sectionOf[q.key];
    const target = q.type === 'year' ? yearSelect
      : (sec.querySelector('.choice[aria-checked="true"]') || sec.querySelector('.choice'));
    if (target && forward !== undefined) target.focus({ preventScroll: true });
  }

  function goBy(delta) {
    const list = visibleQuestions();
    const next = list[list.indexOf(current) + delta];
    if (next) show(next, delta > 0);
  }

  function finish() {
    const missing = visibleQuestions().find(function (q) { return !q.skippable && !isAnswered(q); });
    if (missing) {
      show(missing, false);
      formError.textContent = '답하지 않은 질문이 있어요.';
      return;
    }
    if (!saveProfile()) {
      formError.textContent = '브라우저 저장 기능이 막혀 있어서 답변을 저장하지 못했어요. 브라우저 설정에서 사이트 데이터 저장을 허용한 뒤 다시 시도해 주세요.';
      return;
    }
    location.href = NEXT_PAGE;
  }

  // ===== 9. 이벤트 =====
  btnPrev.addEventListener('click', function () { goBy(-1); });
  btnNext.addEventListener('click', function () {
    const list = visibleQuestions();
    if (list.indexOf(current) < list.length - 1) goBy(1);
    else finish();
  });

  // ===== 10. 시작 =====
  clearOldLocalProfile();
  buildQuestions();
  renderAnswers();
  show(QUESTIONS[0]);
})();
