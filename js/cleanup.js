/* =========================================================
   저장 원칙: 이 기기에는 아무것도 영구 저장하지 않음 (localStorage 사용 안 함)
   - 탭 안에서만 필요한 값은 sessionStorage (탭을 닫으면 사라짐)
   - 개인 관리 기록은 본인 메일의 [관리 화면 열기] 링크로만 다시 열림
   이 파일: 예전 버전이 localStorage에 남긴 값을 페이지가 열릴 때 지움 (모든 페이지에서 가장 먼저 실행)
   같은 주소의 다른 값까지 지우지 않게, 우리 서비스가 썼던 이름만 골라서 지움
   ========================================================= */
(function () {
  'use strict';
  var OLD_KEYS = ['myApplications', 'myApplicationsSummary', 'userProfile', 'dontmiss-best', 'dontmiss-sound', 'game-sound'];
  var OLD_PREFIXES = ['docChecklist:'];
  try {
    OLD_KEYS.forEach(function (k) { localStorage.removeItem(k); });
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      if (key && OLD_PREFIXES.some(function (p) { return key.indexOf(p) === 0; })) localStorage.removeItem(key);
    }
  } catch (e) { /* 저장소를 못 쓰는 환경이면 지울 것도 없음 */ }
})();
