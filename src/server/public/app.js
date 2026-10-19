// fanout dashboard. Plain browser JS, no build step. All untrusted text goes through textContent.

const $ = (sel) => document.querySelector(sel);

let token = document.querySelector('meta[name="fanout-token"]').content;
if (!token || token === '__FANOUT_TOKEN__') {
  try {
    token = sessionStorage.getItem('fanoutToken') || '';
  } catch {
    token = '';
  }
  if (!token) token = prompt(tr('대시보드 토큰 (fanout serve 출력 참고)')) || '';
  try {
    sessionStorage.setItem('fanoutToken', token);
  } catch {
    // private mode: ask again next time
  }
}

/** Tiny element builder: h('div', { class: 'x', onclick }, 'text', child). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    // x-fanout-lang: the server translates its own messages (errors, warnings, guides) too.
    headers: { 'x-fanout-token': token, 'x-fanout-lang': LANG, ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...opts.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body });
  return body;
}

// ── Labels ───────────────────────────────────────────────────────

const STATE = {
  queued: [tr('대기'), 'info'],
  transcoding: [tr('변환 중'), 'info'],
  uploading: [tr('업로드 중'), 'info'],
  processing: [tr('처리 중'), 'info'],
  published: [tr('게시됨'), 'ok'],
  handed_off: [tr('앱에서 마무리'), 'warn'],
  failed: [tr('실패'), 'bad'],
  needs_reauth: [tr('재연결 필요'), 'bad'],
  removed: [tr('삭제됨'), 'info'],
  canceled: [tr('취소됨'), 'info'],
};
const VERDICT = {
  as_is: [tr('원본 그대로'), 'ok'],
  transcode: [tr('변환 후 업로드'), 'warn'],
  blocked: [tr('올릴 수 없음'), 'bad'],
};
const fmtTime = (iso) => new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' });
const badge = ([text, kind]) => h('span', { class: `badge ${kind}` }, text);

// ── Per-platform option forms ────────────────────────────────────
// Field rules follow each platform's policy: YouTube visibility and "made for kids" have no default;
// TikTok direct posts need an explicit privacy level, interactions start off, music consent is explicit.

function select(name, options, { placeholder } = {}) {
  return h(
    'select',
    { name },
    placeholder ? h('option', { value: '' }, placeholder) : null,
    options.map(([value, label, selected]) => h('option', { value, selected }, label)),
  );
}

function radios(name, options) {
  return h('div', { class: 'choices', role: 'radiogroup' }, options.map(([value, label, checked]) => h('label', { class: 'check' }, h('input', { type: 'radio', name, value, checked }), label)));
}

function checkbox(name, label, checked = false) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), label);
}

const opt = (label, control, wide = false) => h('label', { class: `opt${wide ? ' wide' : ''}` }, label, control);
const group = (label, control, wide = false) => h('div', { class: `opt${wide ? ' wide' : ''}` }, h('span', {}, label), control);

const OPTION_FORMS = {
  youtube: () => [
    opt(tr('공개 범위'), select('privacy', [['public', tr('공개')], ['unlisted', tr('일부 공개')], ['private', tr('비공개')]], { placeholder: tr('선택하세요') })),
    group(tr('아동용 영상인가요?'), radios('madeForKids', [['no', tr('아니요')], ['yes', tr('예')]])),
    opt(tr('카테고리'), select('categoryId', [['22', tr('인물/블로그'), true], ['24', tr('엔터테인먼트')], ['10', tr('음악')], ['20', tr('게임')], ['26', tr('노하우/스타일')], ['27', tr('교육')], ['28', tr('과학기술')], ['19', tr('여행/이벤트')], ['17', tr('스포츠')], ['15', tr('동물')]])),
    opt(tr('재생목록 (선택)'), playlistInput()),
    checkbox('notifySubscribers', tr('구독자에게 알림'), true),
    h(
      'details',
      { class: 'opt wide more' },
      h('summary', {}, tr('더 보기: 언어, 라이선스, 다른 언어 제목')),
      h(
        'div',
        { class: 'opts' },
        opt(tr('제목·설명 언어 (예: ko)'), h('input', { type: 'text', name: 'defaultLanguage', autocomplete: 'off' })),
        opt(tr('라이선스'), select('license', [['', tr('표준 YouTube 라이선스')], ['creativeCommon', tr('크리에이티브 커먼즈 - 저작자 표시')]])),
        opt(tr('촬영일 (선택)'), h('input', { type: 'date', name: 'recordingDate' })),
        opt(tr('세로 9:16으로 맞추기 (Shorts)'), select('fit', [['', tr('그대로')], ['pad', tr('흐린 배경으로 채우기')], ['crop', tr('가운데 자르기')]])),
        h('div', { class: 'choices' }, checkbox('embeddable', tr('퍼가기 허용'), true), checkbox('publicStatsViewable', tr('확장 통계 공개 (조회수·좋아요는 늘 공개)'), true)),
        localizationRows(),
      ),
    ),
  ],
  tiktok: () => [
    opt(tr('세로 9:16으로 맞추기'), select('fit', [['', tr('그대로')], ['pad', tr('흐린 배경으로 채우기')], ['crop', tr('가운데 자르기')]])),
    group(tr('게시 방식'), radios('mode', [['inbox', tr('TikTok 앱 수신함으로 보내기'), true], ['direct', tr('바로 게시 (Direct Post)')]]), true),
    h('p', { class: 'note', 'data-when': 'inbox' }, tr('업로드 후 TikTok 앱 알림에서 캡션과 공개 범위를 정해 게시를 마무리합니다.')),
    opt(tr('공개 범위'), select('privacyLevel', [['PUBLIC_TO_EVERYONE', tr('모두')], ['MUTUAL_FOLLOW_FRIENDS', tr('맞팔로우 친구')], ['FOLLOWER_OF_CREATOR', tr('팔로워')], ['SELF_ONLY', tr('나만 보기')]], { placeholder: tr('선택하세요') })),
    group(tr('허용할 상호작용'), h('div', { class: 'choices' }, checkbox('allowComment', tr('댓글')), checkbox('allowDuet', tr('듀엣')), checkbox('allowStitch', tr('이어찍기')))),
    group(tr('콘텐츠 공개'), h('div', { class: 'choices' }, checkbox('brandOrganic', tr('내 브랜드 홍보')), checkbox('brandedContent', tr('브랜디드 콘텐츠 (유료 협찬)')))),
    opt(tr('캡션 (비우면 제목·설명·태그로 만듦)'), h('textarea', { name: 'caption', rows: 2 }), true),
    opt(tr('커버로 쓸 장면 (초, 선택)'), h('input', { type: 'number', name: 'coverSec', min: 0, step: 0.1, inputmode: 'decimal' })),
    h('div', { class: 'opt wide' }, checkbox('musicConsent', tr('게시하면 TikTok 음악 사용 확인(Music Usage Confirmation)에 동의합니다'))),
    h('p', { class: 'note' }, tr('심사 전 앱은 비공개 계정에 "나만 보기"로만 바로 게시할 수 있습니다.')),
  ],
  instagram: () => [
    opt(tr('세로 9:16으로 맞추기'), select('fit', [['', tr('그대로')], ['pad', tr('흐린 배경으로 채우기')], ['crop', tr('가운데 자르기')]])),
    checkbox('shareToFeed', tr('프로필 피드에도 표시'), true),
    opt(tr('캡션 (비우면 제목·설명·태그로 만듦)'), h('textarea', { name: 'caption', rows: 2 }), true),
    opt(tr('공동 작업자 (선택, 쉼표로 구분, 3명까지)'), h('input', { type: 'text', name: 'collaborators', autocomplete: 'off', placeholder: 'user1, user2' })),
    opt(tr('오디오 이름 (선택)'), h('input', { type: 'text', name: 'audioName', autocomplete: 'off' })),
    opt(tr('커버로 쓸 장면 (초, 선택)'), h('input', { type: 'number', name: 'coverSec', min: 0, step: 0.1, inputmode: 'decimal' })),
    opt(tr('시험 릴스 (팔로워가 아닌 사람에게 먼저)'), select('trialReel', [['', tr('쓰지 않음')], ['manual', tr('앱에서 직접 공유')], ['auto', tr('반응이 좋으면 자동 공유')]])),
    checkbox('paidPartnership', tr('유료 파트너십 표시')),
    opt(tr('사람 태그 (선택, 쉼표로 구분)'), h('input', { type: 'text', name: 'userTags', autocomplete: 'off', placeholder: 'user1, user2' })),
    opt(tr('장소 페이지 ID (선택)'), h('input', { type: 'text', name: 'locationId', autocomplete: 'off', inputmode: 'numeric' })),
  ],
  facebook: () => [
    opt(tr('세로 9:16으로 맞추기'), select('fit', [['', tr('그대로')], ['pad', tr('흐린 배경으로 채우기')], ['crop', tr('가운데 자르기')]])),
    opt(tr('설명 (비우면 제목·설명·태그로 만듦)'), h('textarea', { name: 'caption', rows: 2 }), true),
    opt(tr('릴스 제목 (선택)'), h('input', { type: 'text', name: 'title', autocomplete: 'off' })),
    checkbox('draft', tr('게시하지 않고 초안으로 저장 (Meta Business Suite에서 마무리)')),
    opt(tr('공동 작업자 페이지 ID (선택, 쉼표로 구분)'), h('input', { type: 'text', name: 'collaborators', autocomplete: 'off', placeholder: '1234567890' })),
    opt(tr('장소 페이지 ID (선택)'), h('input', { type: 'text', name: 'placeId', autocomplete: 'off', inputmode: 'numeric' })),
    h('p', { class: 'note' }, tr('Facebook Reels는 9:16, 3~90초 영상만 받습니다.')),
  ],
  x: () => [
    opt(tr('글 (비우면 제목·설명·태그로 만듦, 가중치 280 이하·한글은 2로 셈)'), h('textarea', { name: 'text', rows: 2 }), true),
    opt(
      tr('답글 허용'),
      select('replySettings', [['', tr('모두')], ['following', tr('내가 팔로우하는 계정')], ['mentionedUsers', tr('언급한 계정만')], ['verified', tr('인증된 계정')], ['subscribers', tr('구독자')]]),
    ),
    checkbox('paidPartnership', tr('유료 파트너십 표시')),
    opt(tr('영상 대체 텍스트 (선택)'), h('input', { type: 'text', name: 'alt', autocomplete: 'off', maxlength: 1000 })),
    opt(tr('사람 태그 (선택, 쉼표로 구분, 10명까지)'), h('input', { type: 'text', name: 'tagUsers', autocomplete: 'off', placeholder: 'user1, user2' })),
    opt(tr('커뮤니티 ID (선택)'), h('input', { type: 'text', name: 'communityId', autocomplete: 'off', inputmode: 'numeric' })),
    h('p', { class: 'note' }, tr('X API는 종량제입니다. URL이 들어간 게시물은 요금이 훨씬 비쌉니다.')),
  ],
  mastodon: () => [
    opt(tr('공개 범위'), select('visibility', [['public', tr('공개')], ['unlisted', tr('조용히 공개')], ['private', tr('팔로워만')]], { placeholder: tr('선택하세요') })),
    opt(tr('글 (비우면 제목·설명·태그로 만듦)'), h('textarea', { name: 'text', rows: 2 }), true),
    opt(tr('영상 대체 텍스트 (선택)'), h('input', { type: 'text', name: 'alt', autocomplete: 'off' })),
    opt(tr('언어 (선택, 예: ko)'), h('input', { type: 'text', name: 'language', autocomplete: 'off' })),
    opt(tr('내용 경고 (선택)'), h('input', { type: 'text', name: 'spoilerText', autocomplete: 'off' })),
  ],
  peertube: () => [
    opt(tr('공개 범위'), select('privacy', [['public', tr('공개')], ['unlisted', tr('링크가 있는 사람만')], ['private', tr('비공개')], ['internal', tr('인스턴스 사용자만')]], { placeholder: tr('선택하세요') })),
    opt(tr('채널 (선택, 비우면 첫 채널)'), h('input', { type: 'text', name: 'channel', autocomplete: 'off' })),
    opt(tr('댓글'), select('commentsPolicy', [['', tr('인스턴스 기본')], ['enabled', tr('허용')], ['approval', tr('승인 후 공개')], ['disabled', tr('막기')]])),
    opt(tr('언어 (선택, 예: ko)'), h('input', { type: 'text', name: 'language', autocomplete: 'off' })),
    checkbox('nsfw', tr('민감한 콘텐츠(NSFW)')),
    h('p', { class: 'note' }, tr('PeerTube 제목은 3~120자, 태그는 5개까지(각 2~30자)만 올라갑니다. 예약하면 비공개로 올렸다가 그 시각에 공개 범위를 바꿉니다.')),
  ],
  bluesky: () => [
    opt(tr('글 (비우면 제목·설명·태그로 만듦, 300자 이하)'), h('textarea', { name: 'text', rows: 2 }), true),
    opt(tr('영상 대체 텍스트 (선택)'), h('input', { type: 'text', name: 'alt', autocomplete: 'off' })),
    opt(tr('글 언어 (선택, 예: ko)'), h('input', { type: 'text', name: 'langs', autocomplete: 'off' })),
    h('p', { class: 'note' }, tr('Bluesky는 mp4 최대 300MB, 자막은 VTT 파일만 붙습니다.')),
  ],
};

/** Read one platform block back into the provider's option object. */
function readOptions(platform, body) {
  const val = (n) => body.querySelector(`[name="${n}"]`);
  const checked = (n) => body.querySelector(`[name="${n}"]:checked`)?.value;
  const on = (n) => Boolean(val(n)?.checked);
  const text = (n) => val(n)?.value.trim() || undefined;
  // A frame picked in seconds, sent in milliseconds.
  const seconds = (n) => (text(n) === undefined || Number.isNaN(Number(text(n))) ? undefined : Math.round(Number(text(n)) * 1000));
  switch (platform) {
    case 'youtube': {
      const kids = checked('madeForKids');
      return {
        privacy: val('privacy').value || undefined,
        madeForKids: kids === undefined ? undefined : kids === 'yes',
        categoryId: val('categoryId').value,
        playlistId: text('playlistId'),
        notifySubscribers: on('notifySubscribers') ? undefined : false,
        defaultLanguage: text('defaultLanguage'),
        license: val('license').value || undefined,
        embeddable: on('embeddable') ? undefined : false,
        publicStatsViewable: on('publicStatsViewable') ? undefined : false,
        localizations: readLocalizations(body),
        recordingDate: val('recordingDate').value || undefined,
        fit: val('fit').value || undefined,
      };
    }
    case 'tiktok': {
      const mode = checked('mode');
      const fit = val('fit').value || undefined;
      if (mode === 'inbox') return { mode, fit };
      return {
        mode,
        fit,
        privacyLevel: val('privacyLevel').value || undefined,
        allowComment: on('allowComment'),
        allowDuet: on('allowDuet'),
        allowStitch: on('allowStitch'),
        brandOrganic: on('brandOrganic'),
        brandedContent: on('brandedContent'),
        musicConsent: on('musicConsent'),
        caption: text('caption'),
        coverTimestampMs: seconds('coverSec'),
      };
    }
    case 'instagram':
      return {
        shareToFeed: on('shareToFeed') ? undefined : false,
        caption: text('caption'),
        collaborators: text('collaborators')?.split(',').map((u) => u.trim()).filter(Boolean),
        audioName: text('audioName'),
        thumbOffsetMs: seconds('coverSec'),
        trialReel: val('trialReel').value || undefined,
        paidPartnership: on('paidPartnership') || undefined,
        fit: val('fit').value || undefined,
        userTags: text('userTags')?.split(',').map((u) => u.trim()).filter(Boolean),
        locationId: text('locationId'),
      };
    case 'facebook':
      return { caption: text('caption'), title: text('title'), draft: on('draft') || undefined, fit: val('fit').value || undefined, collaborators: text('collaborators')?.split(',').map((p) => p.trim()).filter(Boolean), placeId: text('placeId') };
    case 'x':
      return { text: text('text'), replySettings: val('replySettings').value || undefined, paidPartnership: on('paidPartnership') || undefined, alt: text('alt'), tagUsers: text('tagUsers')?.split(',').map((u) => u.trim()).filter(Boolean), communityId: text('communityId') };
    case 'mastodon':
      return { visibility: val('visibility').value || undefined, text: text('text'), alt: text('alt'), language: text('language'), spoilerText: text('spoilerText') };
    case 'peertube':
      return { privacy: val('privacy').value || undefined, channel: text('channel'), commentsPolicy: val('commentsPolicy').value || undefined, language: text('language'), nsfw: on('nsfw') || undefined };
    case 'bluesky':
      return { text: text('text'), alt: text('alt'), langs: text('langs')?.split(',').map((l) => l.trim()).filter(Boolean) };
    default:
      return {};
  }
}

/** Inverse of readOptions: put saved option values back into a platform block's controls. */
function applyOptions(platform, body, options) {
  for (const [key, raw] of Object.entries(options ?? {})) {
    // undefined means "left at the form's default" (e.g. notifySubscribers on): don't touch it.
    if (raw === undefined) continue;
    if (key === 'thumbOffsetMs' || key === 'coverTimestampMs') {
      const input = body.querySelector('[name="coverSec"]');
      if (input) input.value = String(raw / 1000);
      continue;
    }
    if (platform === 'youtube' && key === 'localizations') {
      body.querySelector('[data-localizations]')?.replaceWith(localizationRows(raw));
      continue;
    }
    const value = platform === 'youtube' && key === 'madeForKids' ? (raw ? 'yes' : 'no') : Array.isArray(raw) ? raw.join(', ') : raw;
    const radios = body.querySelectorAll(`input[type="radio"][name="${key}"]`);
    if (radios.length) {
      for (const r of radios) r.checked = r.value === String(value);
      continue;
    }
    const el = body.querySelector(`[name="${key}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  }
  // TikTok shows direct-post fields only in direct mode.
  body.dispatchEvent(new Event('change', { bubbles: true }));
}

let presets = [];

function renderPresets() {
  const sel = $('#preset-select');
  const current = sel.value;
  sel.replaceChildren(h('option', { value: '' }, tr('프리셋 불러오기…')), ...presets.map((p) => h('option', { value: p.name, selected: p.name === current }, p.name)));
  $('#preset-delete').hidden = !sel.value;
}

async function loadPresets() {
  try {
    presets = (await api('/presets')).presets;
  } catch {
    presets = [];
  }
  renderPresets();
}

function applyPreset(preset) {
  $('#targets').replaceChildren();
  renderTargets();
  const missing = [];
  for (const t of preset.targets) {
    const block = document.querySelector(`.target[data-platform="${t.platform}"]`);
    const toggle = block?.querySelector('[name="enabled"]');
    if (!block || !toggle || toggle.disabled) continue;
    const select = block.querySelector('select[name="account"]');
    const accounts = select ? [...select.options].map((o) => o.value) : [block.querySelector('[data-account]')?.dataset.account];
    // Never fall back to another account than the one saved in the preset.
    if (!accounts.includes(t.account)) {
      missing.push(`${t.platform}/${t.account}`);
      continue;
    }
    if (select) select.value = t.account;
    toggle.checked = true;
    const body = block.querySelector('.target-body');
    body.hidden = false;
    applyOptions(t.platform, body, t.options);
  }
  // In add mode the text belongs to the post being added to.
  if (!addingTo && preset.tags?.length) $('#tags').value = preset.tags.join(', ');
  if (!addingTo && preset.description) $('#description').value = preset.description;
  hideConfirm();
  $('#form-error').textContent = missing.length ? tr('연결돼 있지 않아 건너뛴 계정: {list}', { list: missing.join(', ') }) : '';
}

$('#preset-select').addEventListener('change', (e) => {
  e.stopPropagation();
  const preset = presets.find((p) => p.name === e.target.value);
  $('#preset-delete').hidden = !preset;
  if (preset) applyPreset(preset);
});

$('#preset-save').addEventListener('click', async () => {
  const targets = [];
  for (const block of document.querySelectorAll('.target')) {
    if (!block.querySelector('[name="enabled"]').checked) continue;
    const platform = block.dataset.platform;
    const account = block.querySelector('select[name="account"]')?.value ?? block.querySelector('[data-account]')?.dataset.account;
    targets.push({ platform, account, options: JSON.parse(JSON.stringify(readOptions(platform, block.querySelector('.target-body')))) });
  }
  if (!targets.length) {
    $('#form-error').textContent = tr('프리셋에 넣을 플랫폼을 먼저 고르세요');
    return;
  }
  const name = prompt(tr('프리셋 이름 (같은 이름이면 덮어씁니다)'), $('#preset-select').value || '');
  if (!name?.trim()) return;
  try {
    presets = (
      await api(`/presets/${encodeURIComponent(name.trim())}`, {
        method: 'PUT',
        body: JSON.stringify({ targets, tags: $('#tags').value.split(',').map((t) => t.trim()).filter(Boolean), description: $('#description').value }),
      })
    ).presets;
    $('#preset-select').value = name.trim();
    renderPresets();
    $('#form-error').textContent = '';
  } catch (err) {
    $('#form-error').textContent = err.message;
  }
});

$('#preset-delete').addEventListener('click', async () => {
  const name = $('#preset-select').value;
  if (!name || !confirm(tr('프리셋 "{name}"을 지울까요?', { name }))) return;
  presets = (await api(`/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })).presets;
  $('#preset-select').value = '';
  renderPresets();
});

/** Same required-choice rules the server enforces, shown before anything uploads. */
function missingChoices(platform, o) {
  const out = [];
  if (platform === 'youtube') {
    if (!o.privacy) out.push(tr('YouTube 공개 범위를 고르세요'));
    if (o.madeForKids === undefined) out.push(tr('YouTube 아동용 여부를 고르세요'));
  }
  if (platform === 'mastodon' && !o.visibility) out.push(tr('Mastodon 공개 범위를 고르세요'));
  if (platform === 'peertube' && !o.privacy) out.push(tr('PeerTube 공개 범위를 고르세요'));
  if (platform === 'tiktok' && o.mode === 'direct') {
    if (!o.privacyLevel) out.push(tr('TikTok 공개 범위를 고르세요'));
    if (!o.musicConsent) out.push(tr('TikTok 음악 사용 확인에 동의해야 바로 게시할 수 있습니다'));
    if (o.brandedContent && o.privacyLevel === 'SELF_ONLY') out.push(tr('TikTok 브랜디드 콘텐츠는 "나만 보기"로 올릴 수 없습니다'));
  }
  return out;
}

// ── State ────────────────────────────────────────────────────────

let overview = { platforms: [] };
let media = null; // { id, name, media, isShort, assessments }

function renderAccounts() {
  // Connected platforms only; the rest fold into one chip so the header stays about what you use.
  const connected = overview.platforms.filter((p) => p.accounts.length);
  const others = overview.platforms.filter((p) => !p.accounts.length);
  $('#accounts').replaceChildren(
    ...connected.map((p) => h('li', { class: 'chip on' }, p.displayName, ` · ${p.accounts.map((a) => a.label).join(', ')}`)),
    others.length ? h('li', { class: 'chip', title: others.map((p) => p.displayName).join(', ') }, tr('연결 안 됨 {count}곳', { count: others.length })) : null,
  );
}

/** What the user picked in each platform block, so re-rendering (e.g. after choosing a video) keeps it. */
function snapshotTargets() {
  const snap = new Map();
  for (const block of document.querySelectorAll('.target')) {
    const enabled = block.querySelector('[name="enabled"]')?.checked;
    if (!enabled) continue;
    const platform = block.dataset.platform;
    snap.set(platform, {
      account: block.querySelector('select[name="account"]')?.value,
      options: readOptions(platform, block.querySelector('.target-body')),
    });
  }
  return snap;
}

function restoreTargets(snap) {
  for (const [platform, t] of snap) {
    const block = document.querySelector(`.target[data-platform="${platform}"]`);
    const toggle = block?.querySelector('[name="enabled"]');
    if (!block || !toggle || toggle.disabled) continue;
    const select = block.querySelector('select[name="account"]');
    if (select && t.account) select.value = t.account;
    toggle.checked = true;
    const body = block.querySelector('.target-body');
    body.hidden = false;
    applyOptions(platform, body, t.options);
  }
}

function renderTargets() {
  const snap = snapshotTargets();
  const blocks = overview.platforms.map((p) => {
      const connected = p.accounts.length > 0;
      const assessment = media?.assessments.find((a) => a.platform === p.id);
      const blocked = assessment?.verdict === 'blocked';
      const body = h('div', { class: 'target-body', hidden: true }, OPTION_FORMS[p.id]?.() ?? []);
      const toggle = h('input', {
        type: 'checkbox',
        name: 'enabled',
        disabled: !connected || blocked,
        onchange: (e) => (body.hidden = !e.target.checked),
      });
      const account = connected
        ? p.accounts.length > 1
          ? h('select', { name: 'account', 'aria-label': tr('{platform} 계정', { platform: p.displayName }) }, p.accounts.map((a) => h('option', { value: a.name }, a.label)))
          : h('span', { class: 'muted', 'data-account': p.accounts[0].name }, `→ ${p.accounts[0].label}`)
        : h('span', { class: 'muted' }, tr('연결 안 됨 · 터미널에서 fanout setup {id}', { id: p.id }));
      const head = h(
        'div',
        { class: 'target-head' },
        h('label', { class: 'check' }, toggle, p.displayName),
        account,
        assessment ? badge(VERDICT[assessment.verdict]) : null,
        p.id === 'youtube' && media?.isShort ? badge(['Shorts', 'info']) : null,
      );
      const reasons = assessment?.violations.length
        ? h('p', { class: 'note' }, assessment.violations.map((v) => `${v.fixable ? tr('변환') : tr('불가')}: ${v.message}`).join(' · '))
        : null;
      const block = h('div', { class: `target${connected && !blocked ? '' : ' disabled'}`, 'data-platform': p.id }, head, reasons, body);
      if (p.id === 'tiktok') {
        if (connected) wireTikTokRules(block, body);
        wireTikTokMode(body);
      }
      return { block, connected };
  });
  // Platforms you can post to come first; the ones not connected yet fold away below them.
  const unconnected = blocks.filter((b) => !b.connected).map((b) => b.block);
  $('#targets').replaceChildren(
    ...blocks.filter((b) => b.connected).map((b) => b.block),
    unconnected.length ? h('details', { class: 'unconnected' }, h('summary', {}, tr('연결 안 된 플랫폼 {count}곳', { count: unconnected.length })), ...unconnected) : null,
  );
  restoreTargets(snap);
  if (addingTo) lockCoveredTargets();
}

// ── Adding platforms to an existing post ─────────────────────────
// The upload form doubles as the "add platforms" form: the post's video and text are loaded and
// locked, platform accounts already on the post can't be picked, and preview/confirm go to the
// post's own endpoints.

/** { postId, title, covered: Set<"platform/account"> } while adding to a post. */
let addingTo = null;
const COVERING = new Set(['queued', 'transcoding', 'uploading', 'processing', 'published', 'handed_off', 'needs_reauth']);
const LOCKED_FIELDS = ['#file', '#title', '#description', '#tags', '#scheduled', '#ai', '#thumbnail', '#thumbnail-at', '#add-caption'];

function lockCoveredTargets() {
  for (const block of document.querySelectorAll('.target')) {
    const platform = block.dataset.platform;
    const toggle = block.querySelector('[name="enabled"]');
    const select = block.querySelector('select[name="account"]');
    const single = block.querySelector('[data-account]')?.dataset.account;
    if (select) {
      for (const o of [...select.options]) if (addingTo.covered.has(`${platform}/${o.value}`)) o.remove();
      if (!select.options.length) {
        toggle.checked = false;
        toggle.disabled = true;
        block.querySelector('.target-body').hidden = true;
        block.classList.add('disabled');
      }
    } else if (single && addingTo.covered.has(`${platform}/${single}`)) {
      toggle.checked = false;
      toggle.disabled = true;
      block.querySelector('.target-body').hidden = true;
      block.classList.add('disabled');
    }
  }
}

async function startAddMode(postId) {
  let m;
  try {
    m = await api(`/posts/${postId}/media`);
  } catch (err) {
    alert(err.message);
    return;
  }
  hideConfirm();
  // Start from nothing picked: a platform checked for some other post must not carry over.
  for (const t of document.querySelectorAll('#targets [name="enabled"]')) t.checked = false;
  showView('new');
  addingTo = { postId, title: m.post.title, covered: new Set(m.onPost.filter((t) => COVERING.has(t.state)).map((t) => `${t.platform}/${t.account}`)) };
  media = { id: null, name: m.name, media: m.media, isShort: m.isShort, assessments: m.assessments };
  $('#title').value = m.post.title;
  $('#description').value = m.post.description ?? '';
  $('#tags').value = (m.post.tags ?? []).join(', ');
  $('#scheduled').value = '';
  $('#thumbnail').value = '';
  $('#thumbnail-at').value = '';
  $('#captions').replaceChildren();
  $('#ai').checked = Boolean(m.post.containsSyntheticMedia);
  for (const q of LOCKED_FIELDS) $(q).disabled = true;
  $('#drop-label').textContent = tr('{name} (이 게시물의 영상)', { name: m.name });
  const banner = $('#add-banner');
  banner.replaceChildren(
    h('span', {}, tr('게시물 '), h('strong', {}, `"${m.post.title}"`), tr('에 플랫폼을 추가합니다. 제목·설명·예약·첨부는 원래 게시물 그대로입니다.')),
    h('button', { type: 'button', class: 'small', onclick: exitAddMode }, tr('그만두기')),
  );
  banner.hidden = false;
  $('#form-error').textContent = '';
  renderMedia();
  renderTargets();
  $('#post-form').scrollIntoView?.({ block: 'start' });
}

function exitAddMode() {
  addingTo = null;
  for (const q of LOCKED_FIELDS) $(q).disabled = false;
  $('#add-banner').hidden = true;
  $('#post-form').reset();
  $('#captions').replaceChildren();
  $('#drop-label').textContent = tr('영상 파일을 고르거나 여기에 끌어다 놓으세요');
  $('#form-error').textContent = '';
  hideConfirm();
  media = null;
  renderMedia();
  renderTargets();
}

/**
 * Hide a comment (reversible: YouTube holds it for review, Meta hides it), or show it again. The state
 * lives on the cached comment, so it survives the board redrawing.
 */
function hideButton(targetId, c) {
  const onclick = async (e) => {
    const button = e.target;
    const hidden = !c.hidden;
    if (hidden && !confirm(tr('이 댓글을 숨길까요? 나중에 다시 보이게 할 수 있습니다.'))) return;
    button.disabled = true;
    try {
      await api(`/targets/${targetId}/hide-comment`, { method: 'POST', body: JSON.stringify({ commentId: c.id, hidden }) });
      c.hidden = hidden;
      button.closest('.comment').classList.toggle('hidden-comment', hidden);
      button.replaceWith(hideButton(targetId, c));
    } catch (err) {
      alert(err.message);
      button.disabled = false;
    }
  };
  return h('button', { class: 'small link', type: 'button', onclick }, c.hidden ? tr('다시 보이기') : tr('숨기기'));
}

/** The playlist id field, with the account's playlists offered once it gets focus. */
function playlistInput() {
  const list = h('datalist', { id: `playlists-${Math.random().toString(36).slice(2)}` });
  const input = h('input', { type: 'text', name: 'playlistId', autocomplete: 'off', list: list.id, placeholder: tr('목록에서 고르거나 ID 입력') });
  let loaded = '';
  input.addEventListener('focus', async () => {
    const block = input.closest('.target');
    const name = block?.querySelector('select[name="account"]')?.value ?? block?.querySelector('[data-account]')?.dataset.account;
    if (!name || loaded === name) return;
    loaded = name;
    try {
      const { playlists } = await api(`/accounts/youtube/${encodeURIComponent(name)}/playlists`);
      list.replaceChildren(...playlists.map((p) => h('option', { value: p.id, label: p.title }, p.title)));
    } catch {
      loaded = '';
    }
  });
  return h('div', {}, input, list);
}

/** Other-language titles and descriptions for YouTube: one row per language, added on demand. */
function localizationRows(values = {}) {
  const rows = h('div', { class: 'loc-rows' });
  const add = (lang = '', title = '', description = '') =>
    rows.append(
      h(
        'div',
        { class: 'loc-row' },
        h('input', { type: 'text', 'data-loc': 'lang', value: lang, placeholder: tr('언어 (예: en)'), 'aria-label': tr('언어'), size: 6 }),
        h('input', { type: 'text', 'data-loc': 'title', value: title, placeholder: tr('제목'), 'aria-label': tr('제목') }),
        h('textarea', { 'data-loc': 'description', rows: 1, placeholder: tr('설명 (선택)'), 'aria-label': tr('설명') }, description),
      ),
    );
  for (const [lang, l] of Object.entries(values)) add(lang, l.title, l.description ?? '');
  return h('div', { class: 'opt wide', 'data-localizations': '' }, h('span', {}, tr('다른 언어 제목·설명')), rows, h('button', { class: 'small', type: 'button', onclick: () => add() }, tr('+ 언어 추가')));
}

function readLocalizations(body) {
  const out = {};
  for (const row of body.querySelectorAll('.loc-row')) {
    const get = (k) => row.querySelector(`[data-loc="${k}"]`).value.trim();
    // A language without a title is kept (as an empty title) so the preview says what's missing.
    if (get('lang')) out[get('lang')] = { title: get('title'), ...(get('description') ? { description: get('description') } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** TikTok creator_info per account, fetched once per page. */
const tiktokRules = new Map();

/**
 * Shape the TikTok form from the account's own rules (TikTok's content sharing guidelines ask for
 * this): show who it posts as, offer only the visibility values the account allows, and turn off
 * the interactions its settings disable. Follows the account select when there are several.
 */
function wireTikTokRules(block, body) {
  const info = h('p', { class: 'note', 'data-when': 'direct' });
  body.prepend(info);
  const accountName = () => block.querySelector('select[name="account"]')?.value ?? block.querySelector('[data-account]')?.dataset.account;
  const apply = async () => {
    const name = accountName();
    if (!name) return;
    // Another account's rules (or none) must never stay on screen: start from the plain form.
    info.textContent = '';
    for (const o of body.querySelector('[name="privacyLevel"]')?.options ?? []) o.hidden = o.disabled = false;
    for (const n of ['allowComment', 'allowDuet', 'allowStitch']) {
      const box = body.querySelector(`[name="${n}"]`);
      if (box) {
        box.disabled = false;
        box.closest('label').title = '';
      }
    }
    if (!tiktokRules.has(name)) {
      // A failed read isn't kept: the next pick of direct mode or of the account asks again.
      tiktokRules.set(name, api(`/accounts/tiktok/${encodeURIComponent(name)}/rules`).then((r) => r.rules).catch(() => (tiktokRules.delete(name), null)));
    }
    const rules = await tiktokRules.get(name);
    if (!rules || accountName() !== name) return;
    info.textContent = [
      rules.username ? tr('@{username} ({nickname}) 계정에 바로 게시합니다', { username: rules.username, nickname: rules.nickname ?? '' }) : '',
      rules.maxDurationSec ? tr('이 계정은 {max}초까지 올릴 수 있습니다.', { max: rules.maxDurationSec }) : '',
    ].filter(Boolean).join(' ');
    const privacy = body.querySelector('[name="privacyLevel"]');
    if (privacy && rules.privacyOptions?.length) {
      for (const o of privacy.options) if (o.value) o.hidden = o.disabled = !rules.privacyOptions.includes(o.value);
      if (privacy.selectedOptions[0]?.disabled) privacy.value = '';
    }
    for (const name of ['allowComment', 'allowDuet', 'allowStitch']) {
      const box = body.querySelector(`[name="${name}"]`);
      if (!box) continue;
      const off = rules.disabled?.includes(name);
      box.disabled = Boolean(off);
      if (off) box.checked = false;
      box.closest('label').title = off ? tr('계정 설정에서 꺼져 있음') : '';
    }
  };
  block.querySelector('select[name="account"]')?.addEventListener('change', apply);
  // Read only when direct posting is chosen: inbox uploads don't need the account's rules.
  body.addEventListener('change', () => {
    if (body.querySelector('[name="mode"]:checked')?.value === 'direct') apply();
  });
}

/** Show direct-post fields only in direct mode. */
function wireTikTokMode(body) {
  const sync = () => {
    const direct = body.querySelector('[name="mode"]:checked')?.value === 'direct';
    for (const el of body.children) {
      if (el.querySelector?.('[name="mode"]')) continue;
      el.hidden = el.dataset.when === 'inbox' ? direct : !direct;
    }
  };
  // Any change, not just the radio: applyOptions fires one on the block after setting the mode.
  body.addEventListener('change', sync);
  sync();
}

/**
 * Until a video is picked, the new-post screen is just the compose box (video + title), centred;
 * picking one (or adding platforms to a post) opens the rest of the form at the column's width.
 */
function updateCompose() {
  $('#compose-panel').classList.toggle('empty', !media && !addingTo);
}

function renderMedia() {
  const box = $('#media-info');
  updateCompose();
  if (!media) {
    box.hidden = true;
    return;
  }
  const m = media.media;
  const v = m.video;
  box.hidden = false;
  box.replaceChildren(
    h('div', {}, h('strong', {}, media.name)),
    h(
      'div',
      { class: 'spec' },
      `${v.width}×${v.height} · ${v.codec} · ${v.fps.toFixed(0)}fps · ${tr('{n}초', { n: m.durationSec.toFixed(1) })} · ${(m.sizeBytes / 1048576).toFixed(1)}MB · ${m.audio ? `${m.audio.codec} ${m.audio.sampleRate / 1000}kHz` : tr('오디오 없음')}`,
    ),
  );
}

// ── Upload ───────────────────────────────────────────────────────

function uploadFile(file) {
  if (addingTo) {
    $('#form-error').textContent = tr('플랫폼 추가 중입니다. 새 영상을 올리려면 먼저 "그만두기"를 누르세요');
    return;
  }
  const bar = $('#upload-progress');
  const label = $('#drop-label');
  bar.hidden = false;
  bar.value = 0;
  label.textContent = tr('{name} 올리는 중…', { name: file.name });
  $('#form-error').textContent = '';
  media = null;
  renderMedia();
  renderTargets();

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/media');
  xhr.setRequestHeader('x-fanout-token', token);
  xhr.setRequestHeader('x-fanout-lang', LANG);
  xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => e.lengthComputable && (bar.value = e.loaded / e.total);
  xhr.onload = () => {
    bar.hidden = true;
    let body = {};
    try {
      body = JSON.parse(xhr.responseText);
    } catch {}
    if (xhr.status >= 300) {
      label.textContent = tr('영상 파일을 고르거나 여기에 끌어다 놓으세요');
      $('#form-error').textContent = body.error || tr('업로드 실패 (HTTP {status})', { status: xhr.status });
      return;
    }
    media = body;
    label.textContent = tr('{name} · 다른 파일로 바꾸려면 다시 고르세요', { name: file.name });
    if (!$('#title').value) $('#title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
    renderMedia();
    renderTargets();
    // A new video starts a new draft: the one offered from before gives way.
    $('#draft-banner').hidden = true;
    saveDraft();
  };
  xhr.onerror = () => {
    bar.hidden = true;
    $('#form-error').textContent = tr('업로드 중 연결이 끊겼습니다');
  };
  xhr.send(file);
}

$('#file').addEventListener('change', (e) => e.target.files[0] && uploadFile(e.target.files[0]));
const drop = $('#drop');
drop.addEventListener('dragover', () => drop.classList.add('over'));
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', () => drop.classList.remove('over'));

// ── Thumbnail and captions ───────────────────────────────────────

function addCaptionRow(language = 'ko') {
  const row = h(
    'div',
    { class: 'caption-row' },
    h('input', { name: 'language', value: language, 'aria-label': tr('자막 언어 코드'), placeholder: 'ko' }),
    h('input', { type: 'file', name: 'file', accept: '.srt,.vtt,.sbv,.scc,.ttml,.dfxp', 'aria-label': tr('자막 파일') }),
    h('button', { type: 'button', class: 'small', onclick: () => { row.remove(); hideConfirm(); } }, tr('빼기')),
  );
  $('#captions').append(row);
}
$('#add-caption').addEventListener('click', () => addCaptionRow($('#captions').children.length ? '' : 'ko'));

async function uploadAsset(kind, file) {
  const res = await fetch(`/api/assets/${kind}`, {
    method: 'POST',
    headers: { 'x-fanout-token': token, 'x-fanout-lang': LANG, 'x-filename': encodeURIComponent(file.name) },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.id;
}

// ── Suggested times ──────────────────────────────────────────────

/** The chosen accounts as platform/account. */
function chosenAccounts() {
  return [...document.querySelectorAll('.target')]
    .filter((block) => block.querySelector('[name="enabled"]').checked)
    .map((block) => `${block.dataset.platform}/${block.querySelector('select[name="account"]')?.value ?? block.querySelector('[data-account]')?.dataset.account}`);
}

// Read-only: fills the schedule field when one is picked; nothing is scheduled until the post is made.
$('#best-times-btn').addEventListener('click', async () => {
  const list = $('#best-times-list');
  const accounts = chosenAccounts();
  if (!accounts.length) return list.replaceChildren(h('p', { class: 'muted' }, tr('올릴 곳을 하나 이상 고르세요')));
  list.replaceChildren(h('p', { class: 'muted' }, tr('불러오는 중…')));
  try {
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
    const r = await api(`/best-times?accounts=${encodeURIComponent(accounts.join(','))}&lang=${LANG}&tz=${tz}`);
    const why = h('p', { class: 'muted best-times-why' });
    const pick = (s) => {
      $('#scheduled').value = s.local;
      $('#scheduled').dispatchEvent(new Event('input', { bubbles: true }));
      for (const b of list.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b.dataset.local === s.local));
      why.textContent = s.reasons.join(' · ');
    };
    list.replaceChildren(
      r.suggestions.length
        ? h('div', { class: 'chips' }, ...r.suggestions.map((s) => h('button', { type: 'button', class: 'chip', 'data-local': s.local, 'aria-pressed': String($('#scheduled').value === s.local), onclick: () => pick(s) }, s.label)))
        : h('p', { class: 'muted' }, tr('앞으로 2주 안에 비어 있는 시간이 없습니다')),
      why,
      r.note ? h('p', { class: 'muted' }, r.note) : null,
    );
  } catch (err) {
    list.replaceChildren(h('p', { class: 'form-error' }, err.message));
  }
});

// ── Draft ────────────────────────────────────────────────────────
// The form as it's typed, kept in this browser so a reload or a closed tab doesn't lose it. Files
// other than the video (thumbnail, captions) can't be kept; the video is kept by its upload id.

const DRAFT_KEY = 'fanout.draft';
let draftTimer;

function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    return d && d.v === 1 ? d : null;
  } catch {
    return null;
  }
}

function clearDraft() {
  clearTimeout(draftTimer);
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {}
  $('#draft-banner').hidden = true;
}

function saveDraft() {
  // Adding to a post already made isn't a draft; nor is an offer to restore still waiting.
  if (addingTo || !$('#draft-banner').hidden) return;
  const title = $('#title').value;
  const description = $('#description').value;
  if (!media && !title.trim() && !description.trim()) return clearDraft();
  const targets = [];
  for (const block of document.querySelectorAll('.target')) {
    if (!block.querySelector('[name="enabled"]')?.checked) continue;
    const platform = block.dataset.platform;
    const account = block.querySelector('select[name="account"]')?.value ?? block.querySelector('[data-account]')?.dataset.account;
    targets.push({ platform, account, options: JSON.parse(JSON.stringify(readOptions(platform, block.querySelector('.target-body')))) });
  }
  const draft = { v: 1, savedAt: new Date().toISOString(), media, title, description, tags: $('#tags').value, scheduled: $('#scheduled').value, ai: $('#ai').checked, thumbnailAt: $('#thumbnail-at').value, targets };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {}
}

for (const type of ['input', 'change']) {
  $('#post-form').addEventListener(type, () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  });
}

async function restoreDraft(d) {
  $('#draft-banner').hidden = true;
  let note = '';
  if (d.media?.id) {
    try {
      await api(`/media/${encodeURIComponent(d.media.id)}`);
      media = d.media;
      $('#drop-label').textContent = tr('{name} · 다른 파일로 바꾸려면 다시 고르세요', { name: d.media.name });
    } catch (err) {
      note = err.message;
    }
  }
  $('#title').value = d.title ?? '';
  $('#description').value = d.description ?? '';
  $('#tags').value = d.tags ?? '';
  $('#scheduled').value = d.scheduled ?? '';
  $('#ai').checked = Boolean(d.ai);
  $('#thumbnail-at').value = d.thumbnailAt ?? '';
  renderMedia();
  applyPreset({ targets: d.targets ?? [] });
  if (note) $('#form-error').textContent = note;
  saveDraft();
}

/** On load: offer the draft left behind, if there is one. */
function offerDraft() {
  const d = readDraft();
  if (!d || media || addingTo) return;
  const box = $('#draft-banner');
  box.replaceChildren(
    h('span', {}, tr('저장하지 않은 게시물이 있습니다: {title} ({time})', { title: d.title?.trim() || d.media?.name || tr('제목 없음'), time: fmtTime(d.savedAt) })),
    h('span', { class: 'actions' }, h('button', { type: 'button', class: 'small', onclick: () => restoreDraft(d) }, tr('이어서 쓰기')), h('button', { type: 'button', class: 'small', onclick: clearDraft }, tr('버리기'))),
  );
  box.hidden = false;
}

// ── Submit ───────────────────────────────────────────────────────

/** Read and check the form; returns errors, or everything needed to preview and post. */
function collectForm() {
  const errors = [];
  if (!media) errors.push(tr('먼저 영상을 고르세요'));
  const title = $('#title').value.trim();
  if (!title) errors.push(tr('제목을 입력하세요'));
  const targets = [];
  for (const block of document.querySelectorAll('.target')) {
    if (!block.querySelector('[name="enabled"]').checked) continue;
    const platform = block.dataset.platform;
    const account = block.querySelector('select[name="account"]')?.value ?? block.querySelector('[data-account]')?.dataset.account;
    const options = readOptions(platform, block.querySelector('.target-body'));
    errors.push(...missingChoices(platform, options));
    targets.push({ platform, account, options: JSON.parse(JSON.stringify(options)) });
  }
  if (!targets.length) errors.push(tr('올릴 곳을 하나 이상 고르세요'));
  const scheduled = $('#scheduled').value;
  const thumbnail = $('#thumbnail').files[0];
  if (thumbnail && thumbnail.size > 2 * 1024 * 1024) errors.push(tr('썸네일은 2MB 이하여야 합니다'));
  const captionRows = [...document.querySelectorAll('.caption-row')]
    .map((r) => ({ language: r.querySelector('[name="language"]').value.trim(), file: r.querySelector('[name="file"]').files[0] }))
    .filter((c) => c.file || c.language);
  for (const c of captionRows) if (!c.file || !c.language) errors.push(tr('자막은 언어 코드와 파일을 모두 넣어 주세요'));
  const thumbAtText = $('#thumbnail-at').value.trim();
  const thumbnailAt = thumbAtText === '' ? undefined : Number(thumbAtText);
  if (thumbnailAt !== undefined && !(thumbnailAt >= 0)) errors.push(tr('썸네일 장면은 0초 이상이어야 합니다'));
  if (thumbnail && thumbnailAt !== undefined) errors.push(tr('썸네일 이미지와 장면 중 하나만 고르세요'));
  // Which platforms actually use these files (the providers' capabilities).
  const able = (cap) => (overview?.platforms ?? []).filter((p) => p.capabilities?.[cap]);
  const uses = (cap) => targets.some((t) => able(cap).some((p) => p.id === t.platform));
  const names = (cap) => able(cap).map((p) => p.displayName).join('·');
  // A frame also sets the Instagram/TikTok cover, so it is useful there too.
  if ((thumbnail || (thumbnailAt !== undefined && !targets.some((t) => ['instagram', 'tiktok'].includes(t.platform)))) && !uses('thumbnail')) {
    errors.push(tr('썸네일은 {names}에만 적용됩니다. 해당 플랫폼을 고르거나 썸네일을 비워 주세요', { names: names('thumbnail') }));
  }
  if (captionRows.length && !uses('captions')) errors.push(tr('자막은 {names}에만 적용됩니다. 해당 플랫폼을 고르거나 자막을 비워 주세요', { names: names('captions') }));
  const payload = {
    mediaId: media?.id,
    title,
    description: $('#description').value,
    tags: $('#tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    scheduledAt: scheduled ? new Date(scheduled).toISOString() : undefined,
    containsSyntheticMedia: $('#ai').checked,
    thumbnailAt,
    targets,
  };
  return { errors, payload, thumbnail, captionRows };
}

function hideConfirm() {
  $('#confirm').hidden = true;
  $('#confirm').replaceChildren();
  $('#submit').hidden = false;
}

// Any edit after a preview makes it stale.
$('#post-form').addEventListener('input', hideConfirm);
$('#post-form').addEventListener('change', (e) => e.target.id !== 'file' && hideConfirm());

// Step 1: preview. Shows the destination account and visibility for every target (YouTube policy)
// and anything the upload would trip over, before a single byte goes out.
$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = collectForm();
  if (form.errors.length) {
    $('#form-error').textContent = form.errors.join('\n');
    return;
  }
  $('#form-error').textContent = '';
  const button = $('#submit');
  button.disabled = true;
  try {
    if (addingTo) {
      const { targets } = await api(`/posts/${addingTo.postId}/targets/preview`, { method: 'POST', body: JSON.stringify({ targets: form.payload.targets }) });
      renderConfirm(targets, form);
      return;
    }
    // Attachments go up first so the preview covers them too (e.g. "X doesn't take thumbnails").
    form.payload.thumbnailId = form.thumbnail ? await uploadAsset('thumbnail', form.thumbnail) : undefined;
    form.payload.captions = [];
    for (const c of form.captionRows) form.payload.captions.push({ language: c.language, assetId: await uploadAsset('caption', c.file) });
    const { targets } = await api('/preview', { method: 'POST', body: JSON.stringify(form.payload) });
    renderConfirm(targets, form);
  } catch (err) {
    $('#form-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

function renderConfirm(previews, form) {
  const blocked = previews.some((p) => p.errors.length);
  const rows = previews.map((p) =>
    h(
      'li',
      { class: 'confirm-row' },
      h('div', { class: 'confirm-head' }, h('strong', {}, p.platform), ` → ${p.accountLabel ?? p.account}`, h('span', { class: 'muted' }, ` · ${p.visibility}`), badge(VERDICT[p.verdict])),
      p.errors.map((m) => h('div', { class: 'err' }, `✗ ${m}`)),
      p.warnings.map((m) => h('div', { class: 'warnline' }, `⚠ ${m}`)),
      p.transcode.length ? h('div', { class: 'muted' }, tr('변환: {list}', { list: p.transcode.join(', ') })) : null,
    ),
  );
  const box = $('#confirm');
  box.replaceChildren(
    h('h3', { class: 'sub' }, blocked ? tr('이대로는 올릴 수 없습니다') : tr('이렇게 올립니다')),
    h('ul', { class: 'confirm-list' }, rows),
    h(
      'div',
      { class: 'actions' },
      blocked ? null : h('button', { type: 'button', class: 'primary', id: 'confirm-post', onclick: () => post(form) }, tr('이대로 업로드')),
      h('button', { type: 'button', class: 'small', onclick: hideConfirm }, blocked ? tr('고치기') : tr('취소')),
    ),
  );
  box.hidden = false;
  $('#submit').hidden = true;
  box.scrollIntoView?.({ block: 'nearest' });
}

// Step 2: create the post with exactly what was previewed, then reset the form.
async function post(form) {
  const button = $('#confirm-post');
  button.disabled = true;
  try {
    if (addingTo) {
      await api(`/posts/${addingTo.postId}/targets`, { method: 'POST', body: JSON.stringify({ targets: form.payload.targets }) });
      exitAddMode();
      refreshBoard();
      return;
    }
    await api('/posts', { method: 'POST', body: JSON.stringify(form.payload) });
    clearDraft();
    $('#post-form').reset();
    $('#captions').replaceChildren();
    $('#drop-label').textContent = tr('영상 파일을 고르거나 여기에 끌어다 놓으세요');
    $('#form-error').textContent = '';
    hideConfirm();
    media = null;
    renderMedia();
    renderTargets();
    refreshBoard();
    reloadCalendar?.();
    showView('board');
  } catch (err) {
    $('#form-error').textContent = err.message;
    button.disabled = false;
  }
}

// ── Status board ─────────────────────────────────────────────────

const fmtNum = (n) => (n === undefined || n === null ? '-' : Number(n).toLocaleString(LOCALE));

function statsLine(st, trend) {
  const parts = [
    [tr('조회'), st.views, trend?.views],
    [tr('좋아요'), st.likes, trend?.likes],
    [tr('댓글'), st.comments, trend?.comments],
    [tr('공유'), st.shares, trend?.shares],
    [tr('도달'), st.reach],
    [tr('저장 수'), st.saves],
    [tr('구독 증가'), st.subscribersGained],
  ].filter(([, v]) => v !== undefined && v !== null);
  const pct = st.avgViewPct !== undefined && st.avgViewPct !== null ? ` (${tr('평균 {p}% 시청', { p: fmtNum(st.avgViewPct) })})` : '';
  const watch = st.avgWatchSec !== undefined && st.avgWatchSec !== null ? tr('평균 시청 {s}초', { s: fmtNum(st.avgWatchSec) }) + pct : null;
  // Growth since the reading a day ago (the worker records one every few hours).
  const delta = (d) => (d === undefined || d === null || d === 0 ? null : h('span', { class: d > 0 ? 'up' : 'down' }, ` ${d > 0 ? '+' : ''}${fmtNum(d)}`));
  return h(
    'div',
    { class: 'stats', title: [trend ? tr('+/- 숫자: {time} 이후 변화', { time: fmtTime(trend.since) }) : '', st.note ?? ''].filter(Boolean).join('\n') },
    parts.map(([k, v, d]) => h('span', {}, `${k} `, h('strong', {}, fmtNum(v)), delta(d))),
    watch ? h('span', { title: st.watchTimeSec ? tr('총 시청 {h}시간', { h: fmtNum(Math.round(st.watchTimeSec / 360) / 10) }) : '' }, watch) : null,
    h('span', { class: 'muted' }, ` · ${tr('{time} 기준', { time: fmtTime(st.fetchedAt) })}`),
    st.note && !parts.length ? h('span', { class: 'muted' }, ` · ${st.note}`) : null,
  );
}

function targetRow(t) {
  const detail = h('div', { class: 'tdetail' });
  if (t.remoteUrl) detail.append(webUrl(t.remoteUrl) ? h('a', { href: t.remoteUrl, target: '_blank', rel: 'noopener noreferrer' }, t.remoteUrl) : h('span', {}, t.remoteUrl));
  else if (t.state === 'queued' && t.notBefore) detail.append(h('span', { class: 'muted' }, tr('{time}에 시작', { time: fmtTime(t.notBefore) })));
  if (t.state === 'processing' && t.notBefore) detail.append(h('span', { class: 'muted' }, tr('{time}에 다시 확인', { time: fmtTime(t.notBefore) })));
  if (t.errorCode) detail.append(h('div', { class: 'err' }, `${t.errorCode}: ${t.errorMessage ?? ''}`));
  for (const w of t.warnings) detail.append(h('div', { class: 'warnline' }, `⚠ ${w}`));
  if (t.attempts > 1) detail.append(h('div', { class: 'muted' }, tr('시도 {n}회', { n: t.attempts })));
  if (t.stats) detail.append(statsLine(t.stats, t.trend));
  if (t.state === 'published' && t.statsCost) {
    detail.append(
      h(
        'button',
        {
          class: 'small',
          type: 'button',
          title: t.statsCost,
          onclick: async (e) => {
            if (!confirm(tr('{cost}. 이 게시물의 반응을 가져올까요?', { cost: t.statsCost }))) return;
            e.target.disabled = true;
            await api(`/posts/${t.postId}/stats`, { method: 'POST', body: JSON.stringify({ includePaid: true, platform: t.platform }) }).catch((err) => alert(err.message));
            refreshBoard();
          },
        },
        tr('반응 가져오기 (요금)'),
      ),
    );
  }

  const remove = t.removable
    ? h(
        'button',
        {
          class: 'small danger',
          type: 'button',
          onclick: async (e) => {
            if (!confirm(tr('{target}에서 이 게시물을 삭제할까요?\n플랫폼에서 지워지며 되돌릴 수 없습니다.', { target: `${t.platform}/${t.account}` }))) return;
            e.target.disabled = true;
            await api(`/targets/${t.id}/remove`, { method: 'POST' }).catch((err) => alert(err.message));
            refreshBoard();
          },
        },
        tr('삭제'),
      )
    : null;
  const cancel = ['queued', 'failed', 'needs_reauth'].includes(t.state)
    ? h(
        'button',
        {
          class: 'small',
          type: 'button',
          onclick: async (e) => {
            if (!confirm(tr('{target}에 올리는 것을 취소할까요?', { target: `${t.platform}/${t.account}` }))) return;
            e.target.disabled = true;
            const cancelIt = (confirmedNotPosted) => api(`/targets/${t.id}/cancel`, { method: 'POST', body: JSON.stringify({ confirmedNotPosted }) });
            try {
              await cancelIt(false);
            } catch (err) {
              // It may already be on the platform: only the user can say it isn't.
              if (err.body?.needsConfirm && confirm(`${err.message}\n\n${tr('{platform}에서 직접 확인했고 올라가지 않았나요?', { platform: t.platform })}`)) {
                await cancelIt(true).catch((again) => alert(again.message));
              } else if (!err.body?.needsConfirm) alert(err.message);
            }
            refreshBoard();
          },
        },
        tr('취소'),
      )
    : null;
  const retry =
    t.state === 'failed' || t.state === 'needs_reauth'
      ? h(
          'button',
          {
            class: 'small',
            type: 'button',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api(`/targets/${t.id}/retry`, { method: 'POST' });
              } catch (err) {
                alert(err.message);
              }
              refreshBoard();
            },
          },
          tr('다시 시도'),
        )
      : null;
  // A published video's visibility (YouTube): changing it asks first, the platform does the rest.
  const VISIBILITY = { public: tr('공개'), unlisted: tr('일부 공개'), private: tr('비공개') };
  const visibility = t.visibilities
    ? h(
        'select',
        {
          class: 'small',
          'aria-label': tr('공개 범위'),
          onchange: async (e) => {
            const next = e.target.value;
            if (!confirm(tr('{target}의 공개 범위를 "{visibility}"(으)로 바꿀까요?', { target: `${t.platform}/${t.account}`, visibility: VISIBILITY[next] ?? next }))) {
              e.target.value = t.goesPublicAt ? '' : (t.options.privacy ?? '');
              return;
            }
            e.target.disabled = true;
            await api(`/targets/${t.id}/visibility`, { method: 'POST', body: JSON.stringify({ visibility: next }) }).catch((err) => alert(err.message));
            refreshBoard();
          },
        },
        // Waiting to go public shows as such; picking "public" then publishes it now.
        t.goesPublicAt ? h('option', { value: '', selected: true, disabled: true }, tr('{time}에 공개 예약됨', { time: fmtTime(t.goesPublicAt) })) : null,
        t.visibilities.map((v) => h('option', { value: v, selected: !t.goesPublicAt && v === t.options.privacy }, VISIBILITY[v] ?? v)),
      )
    : null;
  const actions = h('div', { class: 'row-actions' }, visibility, retry, cancel, remove);
  return h('div', { class: 'trow' }, h('span', { class: 'tname' }, `${t.platform}/${t.account}`), badge(STATE[t.state] ?? [t.state, 'info']), detail, actions);
}

/** Post ids whose history panel is open, and their last event list; both survive board re-renders. */
const openHistory = new Set();
const historyCache = new Map();

function eventList(detail) {
  return h(
    'ul',
    { class: 'events' },
    detail.targets.flatMap((t) => t.events.map((ev) => h('li', {}, `${fmtTime(ev.at)}  ${t.platform}  ${ev.from ?? '·'} → ${ev.to}${ev.detail ? `  (${ev.detail})` : ''}`))),
  );
}

async function fillHistory(details, postId) {
  try {
    const list = eventList(await api(`/posts/${postId}`));
    historyCache.set(postId, list);
    details.querySelector('.events')?.remove();
    details.append(list.cloneNode(true));
  } catch (err) {
    details.querySelector('.events')?.remove();
    details.append(h('ul', { class: 'events' }, h('li', { class: 'err' }, err.message)));
  }
}

/** Open comment panels: post id → last results (null while loading). Survive board re-renders. */
const openComments = new Map();

function commentsPanel(postId) {
  const results = openComments.get(postId);
  const reload = () => loadComments(postId);
  if (results === undefined) return null;
  const body =
    results === null
      ? [h('p', { class: 'muted' }, tr('댓글을 불러오는 중…'))]
      : results.map((r) =>
          h(
            'div',
            { class: 'comment-group' },
            r.platform ? h('div', { class: 'comment-src' }, `${r.platform}/${r.account}`, h('span', { class: 'muted' }, r.comments ? ` · ${tr('{n}개', { n: r.comments.length })}` : '')) : null,
            r.skipped ? h('p', { class: 'muted' }, r.skipped) : null,
            r.error ? h('p', { class: 'err' }, r.error) : null,
            r.comments && !r.comments.length ? h('p', { class: 'muted' }, tr('아직 댓글이 없습니다')) : null,
            (r.comments ?? []).map((c) =>
              h(
                'div',
                { class: c.hidden ? 'comment hidden-comment' : 'comment' },
                h(
                  'div',
                  { class: 'comment-meta' },
                  h('strong', {}, c.author || tr('(이름 없음)')),
                  h('span', { class: 'muted' }, ` · ${c.at ? fmtTime(c.at) : ''}${c.likes ? ` · ♥ ${fmtNum(c.likes)}` : ''}${c.replies ? ` · ${tr('답글 {n}', { n: fmtNum(c.replies) })}` : ''}`),
                  webUrl(c.url) ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', class: 'comment-link' }, tr('열기')) : null,
                ),
                h('div', { class: 'comment-text' }, c.text),
                repliedComments.has(`${r.targetId}:${c.id}`) ? h('div', { class: 'okline' }, tr('✓ 답글을 달았습니다')) : null,
                r.canReply
                  ? h(
                      'button',
                      {
                        class: 'small link',
                        type: 'button',
                        onclick: (e) => {
                          if (editingPost) {
                            alert(tr('수정 중인 게시물이 있습니다. 저장하거나 닫은 뒤 답글을 쓰세요'));
                            return;
                          }
                          // One reply box at a time, like the edit form.
                          for (const other of document.querySelectorAll('#board .reply-box')) other.remove();
                          replyingTo = { postId, key: `${r.targetId}:${c.id}` };
                          const box = replyBox(postId, r.targetId, c);
                          e.target.closest('.comment').append(box);
                          box.querySelector('textarea').focus();
                        },
                      },
                      tr('답글'),
                    )
                  : null,
                r.canHide && (c.hidden || c.hideable !== false) ? hideButton(r.targetId, c) : null,
              ),
            ),
          ),
        );
  return h(
    'div',
    { class: 'comments' },
    h('div', { class: 'comments-head' }, h('strong', {}, tr('댓글')), h('button', { class: 'small', type: 'button', onclick: reload, disabled: results === null }, tr('다시 불러오기'))),
    body,
  );
}

async function loadComments(postId) {
  openComments.set(postId, null);
  refreshBoard();
  let results;
  try {
    results = (await api(`/posts/${postId}/comments?limit=20`)).results;
  } catch (err) {
    results = [{ platform: '', account: '', error: err.message }];
  }
  // Closed while loading: leave it closed.
  if (openComments.has(postId)) openComments.set(postId, results);
  refreshBoard();
}

function toggleComments(postId) {
  // The card being edited isn't re-rendered, so its panel couldn't appear or go away.
  if (editingPost === postId) {
    alert(tr('이 게시물을 수정하는 중입니다. 저장하거나 닫은 뒤 댓글을 여세요'));
    return;
  }
  if (openComments.has(postId)) {
    openComments.delete(postId);
    // A reply box in the closing panel goes with it; one on another post stays.
    if (replyingTo?.postId === postId) closeReplyBox();
    refreshBoard();
    return;
  }
  loadComments(postId);
}

/** Post id whose edit form is open; the board doesn't re-render under it. */
let editingPost = null;
/** The open reply box: its post, and `${targetId}:${commentId}`. That card isn't re-rendered either. */
let replyingTo = null;
/** Replies sent from this page, marked under their comment. */
const repliedComments = new Set();

function closeReplyBox() {
  replyingTo = null;
  for (const box of document.querySelectorAll('#board .reply-box')) box.remove();
}

function replyBox(postId, targetId, comment) {
  const key = `${targetId}:${comment.id}`;
  const status = h('div', { class: 'msg' });
  const text = h('textarea', { rows: 2, maxlength: 5000, 'aria-label': tr('답글 내용') });
  const close = () => {
    if (replyingTo?.key === key) replyingTo = null;
    refreshBoard();
  };
  const sendButton = h(
    'button',
    {
      class: 'small primary',
      type: 'button',
      onclick: async () => {
        sendButton.disabled = true;
        message(status, tr('보내는 중…'), true);
        try {
          await api(`/targets/${targetId}/reply`, { method: 'POST', body: JSON.stringify({ commentId: comment.id, text: text.value }) });
          repliedComments.add(key);
          // Another reply box may have been opened while this one was sending: leave that one be.
          if (replyingTo?.key === key) replyingTo = null;
          else box.replaceWith(h('div', { class: 'okline' }, tr('✓ 답글을 달았습니다')));
          loadComments(postId);
        } catch (err) {
          message(status, err.message, false);
          sendButton.disabled = false;
        }
      },
    },
    tr('답글 달기'),
  );
  const box = h(
    'div',
    { class: 'reply-box' },
    text,
    h('p', { class: 'note' }, tr('연결된 계정 이름으로 바로 공개됩니다.')),
    h('div', { class: 'row-actions' }, sendButton, h('button', { class: 'small', type: 'button', onclick: close }, tr('취소'))),
    status,
  );
  return box;
}

function editForm(post, card) {
  const status = h('div', { class: 'msg' });
  const title = h('input', { name: 'title', value: post.title, maxlength: 100, autocomplete: 'off' });
  const description = h('textarea', { name: 'description', rows: 3 }, post.description ?? '');
  const tags = h('input', { name: 'tags', value: (post.tags ?? []).join(', '), autocomplete: 'off' });
  const close = () => {
    editingPost = null;
    refreshBoard();
  };
  return h(
    'form',
    {
      class: 'edit-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const save = e.target.querySelector('[type="submit"]');
        save.disabled = true;
        try {
          const { results } = await api(`/posts/${post.id}/edit`, {
            method: 'POST',
            body: JSON.stringify({ title: title.value, description: description.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) }),
          });
          const icon = { updated: '✓', skipped: '·', failed: '✗' };
          status.replaceChildren(
            ...results.map((r) => h('div', { class: r.status === 'failed' ? 'err' : r.status === 'updated' ? 'okline' : 'muted' }, `${icon[r.status]} ${r.platform}/${r.account} ${r.status === 'updated' ? tr('반영함') : (r.detail ?? '')}`)),
          );
        } catch (err) {
          message(status, err.message, false);
        } finally {
          save.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, tr('제목'), title),
    h('label', { class: 'field' }, tr('설명'), description),
    h('label', { class: 'field' }, tr('태그'), tags),
    h('p', { class: 'note' }, tr('YouTube·Facebook·Mastodon·PeerTube에 게시된 글에 반영됩니다. 다른 플랫폼은 API로 고칠 수 없습니다.')),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, tr('수정 반영')), h('button', { class: 'small', type: 'button', onclick: close }, tr('닫기'))),
    status,
  );
}

/**
 * Reactions added up across platforms, once two or more of them have numbers: how the video did
 * overall, with the change over the last day where every platform's trend is known.
 */
function postTotals(targets) {
  const KEYS = ['views', 'likes', 'comments', 'shares'];
  // Live posts with at least one number: a deleted one's last stats, or a note alone, don't count.
  const counted = targets.filter((t) => t.state === 'published' && t.stats && KEYS.some((k) => typeof t.stats[k] === 'number'));
  if (counted.length < 2) return null;
  const parts = [
    [tr('조회'), 'views'],
    [tr('좋아요'), 'likes'],
    [tr('댓글'), 'comments'],
    [tr('공유'), 'shares'],
  ]
    .map(([label, key]) => {
      const having = counted.filter((t) => typeof t.stats[key] === 'number');
      if (!having.length) return null;
      const values = having.map((t) => t.stats[key]);
      // A change only when every platform in the sum has one; a partial sum would mislead.
      const deltas = having.map((t) => t.trend?.[key]);
      const delta = deltas.every((v) => typeof v === 'number') ? deltas.reduce((a, b) => a + b, 0) : 0;
      return h('span', {}, `${label} `, h('strong', {}, fmtNum(values.reduce((a, b) => a + b, 0))), delta ? h('span', { class: delta > 0 ? 'up' : 'down' }, ` ${delta > 0 ? '+' : ''}${fmtNum(delta)}`) : null);
    })
    .filter(Boolean);
  if (!parts.length) return null;
  return h('div', { class: 'stats totals', title: tr('플랫폼 {n}곳 합계 (조회수를 공개하지 않는 플랫폼은 빠짐)', { n: counted.length }) }, h('span', { class: 'muted' }, `${tr('합계')} `), parts);
}

function postCard({ post, targets }) {
  const wasOpen = openHistory.has(post.id);
  // Show the cached list at once so a re-render doesn't flicker; the toggle handler then refreshes it.
  const history = h('details', { open: wasOpen }, h('summary', {}, tr('상태 기록')), wasOpen ? historyCache.get(post.id)?.cloneNode(true) : null);
  // Also fires for a panel created open, so re-rendered open panels refetch their events.
  history.addEventListener('toggle', () => {
    if (history.open) {
      openHistory.add(post.id);
      fillHistory(history, post.id);
    } else {
      openHistory.delete(post.id);
    }
  });
  const published = targets.filter((t) => t.state === 'published' && !t.statsCost);
  const refreshStats = published.length
    ? h(
        'button',
        {
          class: 'small',
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = tr('가져오는 중…');
            await api(`/posts/${post.id}/stats`, { method: 'POST', body: '{}' }).catch((err) => alert(err.message));
            refreshBoard();
          },
        },
        tr('반응 새로고침'),
      )
    : null;
  const hasPublished = targets.some((t) => t.state === 'published');
  // Nothing left to show comments for (e.g. just deleted): drop the panel along with its button.
  if (!hasPublished) openComments.delete(post.id);
  const commentsButton = hasPublished
    ? h('button', { class: 'small', type: 'button', onclick: () => toggleComments(post.id) }, openComments.has(post.id) ? tr('댓글 닫기') : tr('댓글'))
    : null;
  const addButton = post.canAddTargets ? h('button', { class: 'small', type: 'button', onclick: () => startAddMode(post.id) }, tr('플랫폼 추가')) : null;
  const editable = targets.some((t) => !['failed', 'removed', 'canceled'].includes(t.state));
  const editButton = editable
    ? h(
        'button',
        {
          class: 'small',
          type: 'button',
          onclick: (e) => {
            if (replyingTo) {
              alert(tr('쓰던 답글이 있습니다. 보내거나 취소한 뒤 수정하세요'));
              return;
            }
            // One edit form at a time: closing one must not leave another unsaved form to be wiped.
            for (const other of document.querySelectorAll('#board .edit-form')) other.remove();
            editingPost = post.id;
            const card = e.target.closest('.post');
            card.querySelector('.edit-form')?.remove();
            card.append(editForm(post, card));
          },
        },
        tr('수정'),
      )
    : null;
  return h(
    'article',
    { class: 'post', 'data-post': post.id },
    h('div', { class: 'post-head' }, h('span', { class: 'post-title' }, post.title), h('span', { class: 'muted' }, [fmtTime(post.createdAt), post.scheduledAt && tr('예약 {time}', { time: fmtTime(post.scheduledAt) }), post.hasThumbnail && tr('썸네일'), post.captionLanguages?.length && tr('자막 {list}', { list: post.captionLanguages.join(', ') })].filter(Boolean).join(' · '))),
    postTotals(targets),
    targets.map(targetRow),
    h('div', { class: 'post-foot' }, history, h('div', { class: 'actions-inline' }, commentsButton, editButton, addButton, refreshStats)),
    commentsPanel(post.id),
  );
}

const BOARD_PAGE = 30;
let boardLimit = BOARD_PAGE;
let boardQuery = '';
let boardScheduled = false;

let boardTimer;
let boardSeq = 0;
async function refreshBoard() {
  clearTimeout(boardTimer);
  let active = false;
  const seq = ++boardSeq;
  try {
    const limit = boardLimit;
    const posts = await api(`/posts?limit=${limit}${boardScheduled ? '&scheduled=1' : boardQuery ? `&q=${encodeURIComponent(boardQuery)}` : ''}`);
    // A newer refresh (another search, a click) started meanwhile: its answer wins.
    if (seq !== boardSeq) return;
    // The sidebar's recent list: the newest posts whatever the board's filter.
    if (!boardScheduled && !boardQuery) renderRecent(posts);
    // A full page means there may be more; set only where the board is actually redrawn.
    const showMore = () => ($('#board-more').hidden = posts.length < limit);
    // Don't wipe an edit form or reply the user is typing in: refresh every other card around it, or
    // wait if the list itself changed.
    const locked = editingPost ?? replyingTo?.postId;
    if (locked) {
      const cards = [...$('#board').children];
      if (cards.map((c) => c.dataset.post).join() !== posts.map((p) => p.post.id).join()) {
        $('#board-updated').textContent = tr('수정·답글을 마치면 목록을 새로 그립니다');
        boardTimer = setTimeout(refreshBoard, 3000);
        return;
      }
      posts.forEach((p, i) => p.post.id !== locked && cards[i].replaceWith(postCard(p)));
      showMore();
    } else {
      showMore();
      const empty = boardScheduled ? tr('앞으로 예약된 게시물이 없습니다') : boardQuery ? tr('"{query}"에 맞는 게시물이 없습니다', { query: boardQuery }) : tr('아직 게시물이 없습니다');
      $('#board').replaceChildren(...(posts.length ? posts.map(postCard) : [h('p', { class: 'empty' }, empty)]));
    }
    active = posts.some((p) => p.targets.some((t) => !t.terminal));
    $('#board-updated').textContent = tr('{time} 갱신', { time: new Date().toLocaleTimeString(LOCALE) });
  } catch (err) {
    $('#board-updated').textContent = tr('갱신 실패: {error}', { error: err.message });
  }
  boardTimer = setTimeout(refreshBoard, active ? 3000 : 15000);
}

// ── Views and banner ─────────────────────────────────────────────

/** The screens behind the sidebar menu; the board, calendar and performance get a wider column. */
const SECTIONS = ['new', 'board', 'calendar', 'inbox', 'insights'];
const WIDE_SECTIONS = new Set(['board', 'calendar', 'insights']);
const sectionTitle = (section) => ({ new: tr('새 게시물'), board: tr('게시 현황'), calendar: tr('달력'), inbox: tr('답을 기다리는 댓글'), insights: tr('성과 요약') })[section];

let lastSection = 'new';

/**
 * Put a screen in the address. A new history entry, so the browser's Back returns to the screen
 * before; `replace` for the first load and redirects, which shouldn't leave an entry to go back to.
 */
function setAddress(hash, replace, state = null) {
  if (location.hash === hash) return;
  if (replace) history.replaceState(state, '', hash);
  else history.pushState(state, '', hash);
}

/** Show one screen (from the sidebar or the address's #hash). `post` is the old name for the new-post screen. */
function showView(view, { replace = false } = {}) {
  // Settings is a dialog over the current screen, its part in the address (#settings/general).
  if (view === 'settings' || view?.startsWith('settings/')) {
    openSettings(view.split('/')[1], { replace });
    return;
  }
  closeSettings(false);
  const section = SECTIONS.includes(view) ? view : view === 'post' ? 'new' : 'new';
  lastSection = section;
  for (const item of document.querySelectorAll('.nav-item[data-section]')) {
    if (item.dataset.section === section) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('#view-post [data-section]')) panel.hidden = panel.dataset.section !== section;
  $('#view-post').classList.toggle('wide', WIDE_SECTIONS.has(section));
  $('#view-title').textContent = sectionTitle(section);
  setAddress(`#${section}`, replace);
  closeSidebar();
}

for (const item of document.querySelectorAll('.nav-item[data-section]')) item.addEventListener('click', () => showView(item.dataset.section));
// Back, Forward, or an address typed in: the entry is already there.
window.addEventListener('hashchange', () => showView(location.hash.slice(1), { replace: true }));

// ── Settings dialog ──────────────────────────────────────────────
let settingsPart = 'general';
let settingsReturnFocus = null;

function openSettings(part, { replace = false } = {}) {
  const modal = $('#settings-modal');
  const opening = modal.hidden;
  if (opening) {
    settingsReturnFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    // Into the dialog, so Tab doesn't wander the page behind it.
    $('#settings-close').focus();
  }
  settingsPart = part || settingsPart || 'general';
  // Opening adds an entry (marked, so closing can step back over it); switching parts doesn't.
  if (opening) setAddress(`#settings/${settingsPart}`, replace, replace ? history.state : { settings: true });
  else setAddress(`#settings/${settingsPart}`, true, history.state);
  for (const item of document.querySelectorAll('.nav-item[data-section]')) {
    if (item.dataset.section === 'settings') item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  closeSidebar(false);
  loadSettings();
}

/** Close the dialog; `restore` puts the address back on the screen behind it. */
function closeSettings(restore = true) {
  const modal = $('#settings-modal');
  if (modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  for (const item of document.querySelectorAll('.nav-item[data-section]')) {
    if (item.dataset.section === lastSection) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (restore) {
    // Opened with its own entry: step back over it, so Forward opens it again.
    if (history.state?.settings) history.back();
    else history.replaceState(null, '', `#${lastSection}`);
  }
  // Back where it was opened from, unless that is now off screen in the closed drawer.
  const hiddenNow = (el) => !el?.isConnected || ($('#sidebar').contains(el) && getComputedStyle($('#sidebar')).visibility === 'hidden');
  (hiddenNow(settingsReturnFocus) ? $('#sidebar-toggle') : settingsReturnFocus)?.focus?.();
}

$('#settings-close').addEventListener('click', () => closeSettings());
$('#settings-modal').addEventListener('mousedown', (e) => e.target === e.currentTarget && closeSettings());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('#settings-modal').hidden) return;
  e.stopPropagation();
  closeSettings();
});
// Keep Tab inside the dialog while it is open.
$('#settings-modal').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const items = [...$('#settings-modal').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const [first, last] = [items[0], items[items.length - 1]];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// On narrow windows the sidebar is a drawer over the page.
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#scrim').hidden = false;
  $('#sidebar-toggle').setAttribute('aria-expanded', 'true');
  $('#sidebar .nav-item[aria-current]')?.focus();
}
/** Close the drawer; focus inside it goes back to the toggle unless `refocus` is false (something else takes it). */
function closeSidebar(refocus = true) {
  const sidebar = $('#sidebar');
  if (!sidebar.classList.contains('open')) return;
  const hadFocus = sidebar.contains(document.activeElement);
  sidebar.classList.remove('open');
  $('#scrim').hidden = true;
  $('#sidebar-toggle').setAttribute('aria-expanded', 'false');
  if (hadFocus && refocus) $('#sidebar-toggle').focus();
}
$('#sidebar-toggle').addEventListener('click', openSidebar);
$('#sidebar-close').addEventListener('click', closeSidebar);
$('#scrim').addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSidebar());

/** The newest posts in the sidebar; each opens the board at its card. */
function renderRecent(posts) {
  const DOT = { published: 'ok', failed: 'bad', needs_reauth: 'bad', handed_off: 'warn' };
  $('#recent').replaceChildren(
    ...posts.slice(0, 12).map((p) => {
      const worst = p.targets.find((t) => t.state === 'failed' || t.state === 'needs_reauth') ?? p.targets.find((t) => !t.terminal) ?? p.targets[0];
      return h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'recent-item',
            title: p.post.title,
            onclick: () => {
              showView('board');
              document.querySelector(`#board [data-post="${CSS.escape(p.post.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
          },
          h('span', { class: `dot ${DOT[worst?.state] ?? (worst && !worst.terminal ? 'busy' : '')}`, 'aria-hidden': 'true' }),
          p.post.title,
        ),
      );
    }),
  );
}

function banner(text, kind) {
  const el = $('#banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = !text;
}

// ── Settings ─────────────────────────────────────────────────────

const APP_TITLE = { youtube: 'YouTube', tiktok: 'TikTok', meta: 'Meta (Instagram · Facebook)', bluesky: 'Bluesky', mastodon: 'Mastodon', peertube: 'PeerTube', x: 'X (Twitter)' };
const CHECK_ICON = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' };
const LIVE_NOTICE = {
  youtube: tr('4초짜리 테스트 영상을 일부 공개로 올려, 공개 업로드가 실제로 되는지 확인하고 바로 삭제합니다. 오늘 업로드 한도 1회를 씁니다. 처리를 기다리느라 몇 분 걸릴 수 있습니다.'),
  tiktok: tr('4초짜리 테스트 영상을 TikTok 앱 수신함으로 보냅니다. 앱 알림에 뜨는 테스트 영상은 게시하지 말고 지우세요.'),
};

function message(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'bad'}`;
}

function appCard(app, platforms) {
  const fields = app.fields.map((f) =>
    h(
      'label',
      { class: 'field' },
      `${f.label}${f.optional ? tr(' (선택)') : ''}`,
      h('input', {
        name: f.key,
        type: f.secret ? 'password' : 'text',
        autocomplete: 'off',
        value: f.secret ? undefined : f.value,
        placeholder: f.secret && f.set ? tr('저장됨 · 바꿀 때만 입력') : '',
      }),
    ),
  );
  const jsonInput = app.key === 'youtube' ? h('input', { type: 'file', accept: '.json,application/json', name: 'clientJson' }) : null;
  const status = h('span', { class: 'msg' });
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const values = {};
        for (const f of app.fields) values[f.key] = form.querySelector(`[name="${f.key}"]`).value;
        const file = jsonInput?.files[0];
        try {
          await api(`/apps/${app.key}`, { method: 'PUT', body: JSON.stringify({ values, clientJson: file ? await file.text() : undefined }) });
          message(status, tr('저장했습니다'), true);
          await refreshAll();
        } catch (err) {
          message(status, err.message, false);
        }
      },
    },
    h('div', { class: 'app-form' }, fields, jsonInput ? h('label', { class: 'field' }, tr('또는 Google에서 받은 OAuth JSON 파일'), jsonInput) : null),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, tr('앱 정보 저장')), status),
  );
  // Platforms like Bluesky sign in with an app password and need no developer app at all.
  const noApp = app.fields.length === 0;
  const configured = app.fields.filter((f) => !f.optional).every((f) => f.set);
  const connected = platforms.some((p) => p.accounts.length);
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, APP_TITLE[app.key] ?? app.key, badge(noApp ? [tr('개발자 앱 필요 없음'), 'info'] : configured ? [tr('앱 등록됨'), 'ok'] : [tr('앱 미등록'), 'warn'])),
    h('details', { open: noApp ? !connected : !configured }, h('summary', {}, noApp ? tr('연결 방법') : tr('내 개발자 앱 만드는 방법')), h('pre', { class: 'guide' }, app.guide)),
    noApp ? null : form,
    platforms.map((p) => platformBlock(p, configured)),
  );
}

function platformBlock(p, appReady) {
  const rows = p.accounts.map((a) => accountRow(p, a));
  return h(
    'div',
    { class: 'platform-block' },
    h('h3', {}, p.displayName),
    rows.length ? rows : h('p', { class: 'muted' }, tr('연결된 계정이 없습니다')),
    connectForm(p, appReady),
  );
}

/** Each account row's read-only check, for "모든 계정 점검". */
const accountChecks = new Map();
/** A "check all" run is going; a re-rendered settings view must not start another. */
let checkingAll = false;
/** Its progress or last summary, kept so a re-rendered card shows it too. */
let checkAllText = '';
const setCheckAll = (text) => {
  checkAllText = text;
  const el = document.getElementById('check-all-status');
  if (el) el.textContent = text;
};

function accountRow(p, a) {
  const results = h('ul', { class: 'checks', hidden: true });
  const run = async (live) => {
    if (live && !confirm(LIVE_NOTICE[p.id])) return;
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    results.hidden = false;
    results.replaceChildren(h('li', { class: 'info' }, live ? tr('실제 업로드로 점검 중… 몇 분 걸릴 수 있습니다') : tr('점검 중…')));
    try {
      const { checks } = await api(`/doctor/${p.id}`, { method: 'POST', body: JSON.stringify({ account: a.name, live }) });
      results.replaceChildren(...checks.map((c) => h('li', { class: c.status }, `${CHECK_ICON[c.status] ?? ''} ${c.name}: ${c.detail}`)));
    } catch (err) {
      results.replaceChildren(h('li', { class: 'fail' }, `✗ ${err.message}`));
    } finally {
      for (const b of row.querySelectorAll('button')) b.disabled = false;
    }
    return !results.querySelector('li.fail');
  };
  accountChecks.set(`${p.id}/${a.name}`, () => run(false));
  const row = h(
    'div',
    { class: 'acct' },
    h('span', { class: 'acct-name' }, `${a.label}`, h('span', { class: 'muted' }, `  ${p.id}/${a.name}`), a.expiresSoon ? h('span', { class: 'err' }, `  ⚠ ${tr('로그인 만료 {when} — 다시 연결하세요', { when: fmtTime(a.signInExpiresAt) })}`) : null),
    h('button', { class: 'small', type: 'button', onclick: () => run(false) }, tr('점검')),
    LIVE_NOTICE[p.id] ? h('button', { class: 'small', type: 'button', onclick: () => run(true) }, tr('실제 업로드로 점검')) : null,
    h(
      'button',
      {
        class: 'small',
        type: 'button',
        onclick: async () => {
          if (!confirm(tr('{platform} {account} 연결을 해제할까요? 저장된 토큰을 지웁니다.', { platform: p.displayName, account: a.label }))) return;
          try {
            const done = await api(`/accounts/${p.id}/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
            if (done.forgot) alert(done.revoked ? tr('연결을 해제했습니다. 토큰을 철회하고 플랫폼에서 받은 반응 통계도 지웠습니다.') : tr('연결을 해제하고 플랫폼에서 받은 반응 통계를 지웠습니다. 토큰은 철회하지 못했습니다(같은 채널을 다른 이름으로도 연결했거나 요청이 실패함).'));
            await refreshAll();
          } catch (err) {
            alert(err.message);
          }
        },
      },
      tr('연결 해제'),
    ),
    results,
  );
  return row;
}

function connectForm(p, appReady) {
  const status = h('span', { class: 'msg' });
  const name = h('input', { name: 'name', value: p.accounts.some((a) => a.name === 'main') ? '' : 'main', placeholder: tr('예: main, sub'), autocomplete: 'off' });
  // Token-connect providers say which fields they need (Meta: token + page, Bluesky: handle + app password).
  const inputs = (p.connectFields ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    el: f.key === 'token' && !f.secret ? h('textarea', { name: f.key, rows: 2 }) : h('input', { name: f.key, type: f.secret ? 'password' : 'text', autocomplete: 'off' }),
  }));
  const redirect =
    p.connectMethod === 'oauth'
      ? h(
          'p',
          { class: 'redirect' },
          p.id === 'youtube' ? tr('Redirect URI (Google 데스크톱 앱 클라이언트는 따로 등록하지 않아도 됩니다): ') : tr('{platform} 개발자 포털에 이 Redirect URI를 등록해야 합니다: ', { platform: p.displayName }),
          h('code', {}, p.redirectUri),
        )
      : null;
  const button = h('button', { class: 'primary', type: 'submit', disabled: !appReady }, p.connectMethod === 'oauth' ? tr('{service} 계정으로 연결', { service: { youtube: 'Google', tiktok: 'TikTok', x: 'X' }[p.id] ?? p.displayName }) : tr('연결'));
  return h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        try {
          const res = await api(`/connect/${p.id}`, {
            method: 'POST',
            body: JSON.stringify({ name: name.value.trim() || 'main', ...Object.fromEntries(inputs.map((i) => [i.key, i.el.value])) }),
          });
          if (res.authorizeUrl) {
            window.location.href = res.authorizeUrl;
            return;
          }
          message(status, tr('연결됨: {account}', { account: res.account.label }), true);
          await refreshAll();
        } catch (err) {
          message(status, err.message, false);
          button.disabled = !appReady;
        }
      },
    },
    h('div', { class: 'connect' }, h('label', { class: 'field' }, tr('계정 이름'), name), inputs.map((i) => h('label', { class: 'field' }, i.label, i.el))),
    redirect,
    h('div', { class: 'actions' }, button, appReady ? null : h('span', { class: 'muted' }, tr('먼저 위에서 앱 정보를 저장하세요')), status),
  );
}

const NOTIFY_EVENTS = [
  ['published', tr('게시됨')],
  ['handed_off', tr('앱에서 마무리 필요')],
  ['failed', tr('실패')],
  ['needs_reauth', tr('재연결 필요')],
  ['removed', tr('삭제됨')],
  ['alert', tr('게시물 경고 (저작권 차단 등)')],
  ['expiring', tr('로그인 만료 예정')],
  ['digest', tr('주간 요약')],
];

/** Links from platform responses are only followed when they are web links (never javascript:). */
function webUrl(u) {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

/** Remaining posting limits of every account that has them, read when the card is shown. */
function limitsCard() {
  const body = h('div', {}, h('p', { class: 'muted' }, tr('불러오는 중…')));
  const load = async () => {
    try {
      const { accounts } = await api('/limits');
      if (!accounts.length) return body.replaceChildren(h('p', { class: 'muted' }, tr('한도를 알려 주는 플랫폼(YouTube·Instagram·Bluesky·PeerTube)에 연결된 계정이 없습니다.')));
      body.replaceChildren(
        h(
          'table',
          { class: 'limits' },
          h('tbody', {}, accounts.flatMap((a) => (a.error ? [limitRow(a, tr('읽지 못함'), a.error)] : a.limits.map((l) => limitRow(a, l.what, limitText(l), l))))),
        ),
      );
    } catch (err) {
      body.replaceChildren(h('p', { class: 'form-error' }, err.message));
    }
  };
  load();
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, tr('남은 한도'), ' ', h('button', { class: 'small', type: 'button', onclick: load }, tr('새로고침'))),
    h('p', { class: 'muted' }, tr('하루 업로드 수나 저장 용량처럼 플랫폼이 정한 한도입니다. 여러 개를 한꺼번에 올리기 전에 확인하세요.')),
    body,
  );
}

function limitRow(a, what, value, l) {
  const extra = [l?.resetsAt ? tr('{time}에 초기화', { time: new Date(l.resetsAt).toLocaleString(LOCALE) }) : '', l?.note ?? ''].filter(Boolean).join(' · ');
  // Nearly out: under a tenth of the total, or (with no total, e.g. Bluesky bytes) under a typical video.
  const low = l && l.remaining !== undefined && (l.total ? l.remaining / l.total < 0.1 : l.remaining === 0 || (l.unit === 'bytes' && l.remaining < 100e6));
  return h('tr', {}, h('th', {}, `${a.platform}/${a.account}`), h('td', {}, what), h('td', { class: low ? 'warn' : '' }, value), h('td', { class: 'muted' }, extra));
}

function bytesText(v) {
  const [size, unit] = v >= 1e9 ? [v / 1e9, 'GB'] : v >= 1e6 ? [v / 1e6, 'MB'] : [v / 1e3, 'KB'];
  return `${size.toLocaleString(LOCALE, { maximumFractionDigits: size < 10 ? 1 : 0 })}${unit}`;
}

/** "3/100, 97 left". */
function limitText(l) {
  const n = (v) => (l.unit === 'bytes' ? bytesText(v) : v.toLocaleString(LOCALE));
  if (l.unlimited) return l.used === undefined ? tr('무제한') : tr('{used} 씀, 무제한', { used: n(l.used) });
  const parts = [];
  if (l.used !== undefined && l.total !== undefined) parts.push(`${n(l.used)}/${n(l.total)}`);
  if (l.remaining !== undefined) parts.push(tr('남은 {remaining}', { remaining: n(l.remaining) }));
  return parts.join(', ') || '?';
}

function notifyCard(n) {
  const status = h('span', { class: 'msg' });
  const url = h('input', { name: 'url', type: 'password', autocomplete: 'off', placeholder: n.configured ? tr('저장됨 ({host}) · 바꿀 때만 입력', { host: n.host }) : tr('https://hooks.slack.com/… 또는 Discord webhook') });
  const format = select('format', [['', `${tr('주소로 자동 판단')}${n.detectedFormat ? tr(' (지금: {format})', { format: n.detectedFormat }) : ''}`], ['slack', 'Slack'], ['discord', 'Discord'], ['json', 'JSON']]);
  format.value = n.configured && n.format ? n.format : '';
  const boxes = NOTIFY_EVENTS.map(([key, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: key, checked: n.events.includes(key) }), label));
  const act = async (fn, ok) => {
    try {
      await fn();
      message(status, ok, true);
      await loadSettings();
    } catch (err) {
      message(status, err.message, false);
    }
  };
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, tr('알림'), badge(n.configured ? [tr('켜짐 · {host}', { host: n.host }), 'ok'] : [tr('꺼짐'), 'info'])),
    h('p', { class: 'muted' }, tr('감시 폴더나 백그라운드 작업이 끝나거나 실패하면 Slack·Discord 등 webhook으로 알립니다.'), n.fromEnv ? tr(' 지금은 FANOUT_WEBHOOK_URL 환경 변수가 우선합니다.') : ''),
    h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const events = NOTIFY_EVENTS.map(([key]) => key).filter((key) => e.target.querySelector(`[name="${key}"]`).checked);
          act(() => api('/notify', { method: 'PUT', body: JSON.stringify({ url: url.value, events, format: format.value || undefined }) }), tr('저장했습니다'));
        },
      },
      h('div', { class: 'app-form' }, h('label', { class: 'field' }, tr('Webhook 주소'), url), h('label', { class: 'field' }, tr('형식'), format)),
      h('div', { class: 'opt', role: 'group' }, h('span', { class: 'muted' }, tr('알릴 상태')), h('div', { class: 'choices' }, boxes)),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary', type: 'submit' }, tr('저장')),
        n.configured ? h('button', { class: 'small', type: 'button', onclick: () => act(() => api('/notify/test', { method: 'POST' }), tr('테스트 알림을 보냈습니다')) }, tr('테스트 보내기')) : null,
        n.configured ? h('button', { class: 'small', type: 'button', onclick: () => act(() => api('/notify', { method: 'DELETE' }), tr('껐습니다')) }, tr('끄기')) : null,
        status,
      ),
    ),
  );
}

/** Settings, part by part: general (language, notifications), accounts and apps, limits, checks. */
async function loadSettings() {
  const box = $('#settings');
  const nav = $('#settings-nav');
  if (!overview.settingsEnabled) {
    // Limits only read, so they are shown on any dashboard.
    nav.replaceChildren();
    box.replaceChildren(h('section', { class: 'settings-section' }, h('p', {}, tr('설정 화면은 127.0.0.1 전용으로 연 대시보드에서만 쓸 수 있습니다. 이 서버의 터미널에서 fanout app set / fanout connect 를 쓰세요.'))), limitsCard());
    return;
  }
  try {
    const [settings, notify] = await Promise.all([api('/settings'), api('/notify')]);
    accountChecks.clear();
    // One part per app (its accounts sit under it), so a long list of apps never needs scrolling past.
    const parts = [
      ['general', tr('일반'), () => [languageRow(), notifyCard(notify)]],
      ...settings.apps.map((app) => [app.key, APP_TITLE[app.key] ?? app.key, () => [appCard(app, settings.platforms.filter((p) => app.platforms.includes(p.id)))]]),
      ['limits', tr('남은 한도'), () => [limitsCard()]],
      [
        'checks',
        tr('계정 점검'),
        () => {
          // The checks come from the account rows: build them (off screen) so the button has accounts to run.
          for (const app of settings.apps) appCard(app, settings.platforms.filter((p) => app.platforms.includes(p.id)));
          return [checkAllCard()];
        },
      ],
    ];
    // A platform (back from connecting instagram/…) opens the app it belongs to.
    const owner = settings.apps.find((app) => app.platforms.includes(settingsPart));
    if (owner) settingsPart = owner.key;
    if (!parts.some(([key]) => key === settingsPart)) settingsPart = 'general';
    if (location.hash !== `#settings/${settingsPart}`) history.replaceState(history.state, '', `#settings/${settingsPart}`);
    const navFocused = nav.contains(document.activeElement);
    nav.replaceChildren(
      ...parts.map(([key, label]) =>
        h('button', { type: 'button', class: 'modal-nav-item', 'aria-current': key === settingsPart ? 'page' : null, onclick: () => openSettings(key) }, label),
      ),
    );
    const current = nav.querySelector('[aria-current="page"]');
    current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (navFocused) current?.focus();
    const [, label, build] = parts.find(([key]) => key === settingsPart);
    // The page's banner (e.g. the result of a sign-in) is behind the dialog: repeat it here.
    const notice = $('#banner').hidden ? null : h('div', { class: $('#banner').className, role: 'status' }, $('#banner').textContent);
    box.replaceChildren(h('h3', { class: 'settings-heading' }, label), ...(notice ? [notice] : []), ...build());
  } catch (err) {
    box.replaceChildren(h('p', { class: 'form-error' }, err.message));
  }
}

/** The language switch as a settings row (it also sits at the bottom of the sidebar). */
function languageRow() {
  return h(
    'section',
    { class: 'settings-section' },
    h(
      'div',
      { class: 'setting-row' },
      h('div', { class: 'setting-text' }, h('div', { class: 'setting-name' }, tr('언어')), h('div', { class: 'setting-desc' }, tr('대시보드에 쓰는 말'))),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': tr('언어') },
        ...[['ko', '한국어'], ['en', 'English']].map(([code, name]) => // i18n-ignore: each language's own name
          h('button', { type: 'button', 'aria-pressed': String(LANG === code), onclick: () => LANG !== code && setLanguage(code) }, name),
        ),
      ),
    ),
  );
}

/** One button to run every connected account's read-only check, one after another. */
function checkAllCard() {
  const status = h('span', { class: 'muted', id: 'check-all-status' }, checkAllText);
  const button = h(
    'button',
    {
      class: 'small',
      type: 'button',
      id: 'check-all',
      disabled: checkingAll,
      onclick: async () => {
        if (checkingAll) return;
        checkingAll = true;
        button.disabled = true;
        // The accounts as they are now: the view may re-render (and refill the map) meanwhile.
        const checks = [...accountChecks];
        const failed = [];
        try {
          for (const [i, [key, check]] of checks.entries()) {
            setCheckAll(` ${i + 1}/${checks.length} ${tr('{account} 점검 중…', { account: key })}`);
            if (!(await check())) failed.push(key);
          }
        } finally {
          checkingAll = false;
          // The card on screen may be a newer one than this button's.
          for (const b of document.querySelectorAll('#check-all')) b.disabled = false;
        }
        setCheckAll(checks.length ? ` ${tr('{n}개 계정 점검', { n: checks.length })}${failed.length ? tr(', 문제 있음: {list}', { list: failed.join(', ') }) : tr(', 모두 정상')}` : tr(' 연결된 계정이 없습니다'));
      },
    },
    tr('모든 계정 점검'),
  );
  return h('section', { class: 'panel' }, h('div', { class: 'acct' }, button, status), h('p', { class: 'note' }, tr('읽기만 하는 점검입니다. 실제 업로드 점검은 계정마다 따로 실행하세요.')));
}

async function refreshAll() {
  overview = await api('/overview');
  renderAccounts();
  renderTargets();
  if (!$('#settings-modal').hidden) await loadSettings();
  reloadInsights?.();
  reloadCalendar?.();
}

let reloadInsights;

/** This week's posts by day (scheduled and published), with previous/next week; from the store. */
let reloadCalendar;
function calendarPanel() {
  const box = $('#calendar');
  if (!box) return;
  let offset = 0;
  const body = h('div', { class: 'calendar' });
  const label = h('span', { class: 'muted' });
  const ICON = { published: '✓', handed_off: '📲', failed: '✗', needs_reauth: '🔑', canceled: '–', removed: '🗑' };
  const load = async () => {
    try {
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
      const c = await api(`/calendar?weeks=1&offset=${offset}&lang=${LANG}&tz=${tz}`);
      label.textContent = `${c.from} – ${c.to}`;
      body.replaceChildren(
        ...c.days.map((d) =>
          h(
            'div',
            { class: d.today ? 'cal-day today' : 'cal-day' },
            h('div', { class: 'cal-date' }, `${d.weekday} ${d.date.slice(5)}`),
            d.items.length
              ? d.items.map((i) =>
                  h(
                    'div',
                    { class: 'cal-item', title: i.targets.map((t) => `${t.platform}/${t.account}: ${t.state}`).join('\n') },
                    h('span', { class: 'muted' }, `${i.time}${i.scheduled ? '*' : ''} `),
                    i.title,
                    h('span', { class: 'cal-targets' }, ' ' + i.targets.map((t) => `${ICON[t.state] ?? '⏳'}${t.platform}`).join(' ')),
                  ),
                )
              : h('div', { class: 'muted cal-empty' }, '·'),
          ),
        ),
      );
    } catch (err) {
      body.replaceChildren(h('p', { class: 'form-error' }, err.message));
    }
  };
  const move = (by) => () => {
    offset = by === 0 ? 0 : offset + by;
    load();
  };
  reloadCalendar = load;
  box.replaceChildren(
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, tr('달력')),
      h('button', { class: 'small', type: 'button', onclick: move(-1), 'aria-label': tr('지난주') }, '‹'),
      h('button', { class: 'small', type: 'button', onclick: move(0) }, tr('이번 주')),
      h('button', { class: 'small', type: 'button', onclick: move(1), 'aria-label': tr('다음 주') }, '›'),
      label,
    ),
    body,
    h('p', { class: 'muted' }, tr('* 예약 시각 · ✓ 게시됨 · ⏳ 기다림/진행 중 · ✗ 실패')),
  );
  load();
}

/**
 * Comments still waiting for a reply across recent posts. Loaded on request: each post read is a
 * platform call (and YouTube quota).
 */
function inboxPanel() {
  const box = $('#inbox');
  if (!box) return;
  const body = h('div', {}, h('p', { class: 'muted' }, tr('최근 게시물에서 아직 답하지 않은 댓글을 모아 봅니다 (YouTube·Facebook·Instagram).')));
  const days = h('select', { 'aria-label': tr('기간') }, [3, 7, 30].map((d) => h('option', { value: d, selected: d === 7 }, tr('최근 {days}일', { days: d }))));
  const button = h('button', { class: 'small', type: 'button' }, tr('불러오기'));
  const load = async () => {
    button.disabled = true;
    body.replaceChildren(h('p', { class: 'muted' }, tr('불러오는 중…')));
    try {
      const r = await api(`/comment-inbox?days=${days.value}`);
      const head = h('p', { class: 'muted' }, tr('게시물 {posts}개에서 {n}개', { posts: r.posts, n: r.items.length }), r.unknown ? ` · ${tr('답했는지 알 수 없는 {n}개는 빠짐', { n: r.unknown })}` : '');
      body.replaceChildren(
        head,
        ...r.errors.map((e) => h('p', { class: 'err' }, e)),
        ...r.items.map((i) =>
          h(
            'div',
            { class: 'comment' },
            h(
              'div',
              { class: 'comment-meta' },
              h('strong', {}, i.comment.author || tr('(이름 없음)')),
              h('span', { class: 'muted' }, ` · ${i.platform}/${i.account} · ${fmtTime(i.comment.at)} · "${i.title}"`),
              webUrl(i.comment.url) ? h('a', { href: i.comment.url, target: '_blank', rel: 'noopener noreferrer', class: 'comment-link' }, tr('열기')) : null,
            ),
            h('div', { class: 'comment-text' }, i.comment.text),
            h(
              'button',
              {
                class: 'small link',
                type: 'button',
                onclick: () => {
                  // Answer it on the post's own card, with its reply box.
                  showView('board');
                  loadComments(i.postId);
                  document.querySelector(`#board [data-post="${CSS.escape(i.postId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                },
              },
              tr('게시물에서 답하기'),
            ),
          ),
        ),
      );
    } catch (err) {
      body.replaceChildren(h('p', { class: 'form-error' }, err.message));
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener('click', load);
  box.replaceChildren(h('div', { class: 'panel-head' }, h('h2', {}, tr('답을 기다리는 댓글')), days, button), body);
}

/** "What performs" under the board: per platform and account, from the recorded reactions (no platform calls). */
function insightsPanel() {
  const box = $('#insights');
  if (!box) return;
  const body = h('div', {}, h('p', { class: 'muted' }, tr('불러오는 중…')));
  const suggestBox = h('div', {});
  const days = h('select', { 'aria-label': tr('기간') }, [7, 30, 90].map((d) => h('option', { value: d, selected: d === 30 }, tr('최근 {days}일', { days: d }))));
  const fmt = (n) => (n === undefined || n === null ? '-' : Number(n).toLocaleString(LOCALE));
  const load = async () => {
    try {
      // In the viewer's own time zone, which is where "Friday evening" means something.
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
      const r = await api(`/insights?days=${days.value}&lang=${LANG}&tz=${tz}`);
      if (!r.groups.length) return body.replaceChildren(h('p', { class: 'muted' }, tr('이 기간에 게시된 영상이 없습니다')));
      body.replaceChildren(
        ...r.groups.map((g) =>
          h(
            'div',
            { class: 'insight' },
            h('h3', {}, `${g.platform}/${g.account}`),
            h('p', {}, tr('게시물 {posts}개 · 조회 합계 {total} · 중앙값 {median}', { posts: g.posts, total: fmt(g.totalViews), median: fmt(g.medianViews) }), g.likesPer100Views !== undefined ? ` · ${tr('조회 100회당 좋아요 {n}', { n: g.likesPer100Views })}` : ''),
            g.top.length
              ? h('ol', {}, g.top.map((t) => h('li', {}, webUrl(t.url) ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, t.title) : t.title, h('span', { class: 'muted' }, ` · ${tr('조회')} ${fmt(t.views)}`))))
              : null,
            g.bestWeekday ? h('p', {}, tr('잘 되는 요일: {label}', { label: g.bestWeekday.label }), h('span', { class: 'muted' }, ` · ${tr('하루 뒤 조회 중앙값 {views}', { views: fmt(g.bestWeekday.medianViews) })}`)) : null,
            g.bestHours ? h('p', {}, tr('잘 되는 시간: {label}', { label: g.bestHours.label }), h('span', { class: 'muted' }, ` · ${tr('하루 뒤 조회 중앙값 {views}', { views: fmt(g.bestHours.medianViews) })}`)) : null,
            g.note ? h('p', { class: 'muted' }, g.note) : null,
          ),
        ),
        h('p', { class: 'muted' }, tr('요일·시간은 {timeZone} 기준, 기록된 반응으로만 계산합니다', { timeZone: r.timeZone })),
      );
    } catch (err) {
      body.replaceChildren(h('p', { class: 'form-error' }, err.message));
    }
  };
  // Suggestions read the originals (ffprobe), so they load on request.
  const loadSuggestions = async (button) => {
    button.disabled = true;
    try {
      const r = await api(`/insights?days=${days.value}&lang=${LANG}&suggestions=1`);
      suggestBox.replaceChildren(
        ...(r.suggestions?.length
          ? [
              h('h3', {}, tr('다른 곳에도 올려 볼 만한 게시물')),
              ...r.suggestions.map((sg) =>
                h(
                  'div',
                  { class: 'insight' },
                  h('p', {}, sg.title, h('span', { class: 'muted' }, ` · ${tr('{platform}에서 조회 {views}', { platform: sg.platform, views: fmt(sg.views) })} → ${sg.targets.map((t) => `${t.platform}/${t.account}`).join(', ')}`)),
                  sg.needsChoices?.length ? h('p', { class: 'muted' }, sg.needsChoices.join(' · ')) : null,
                  h(
                    'button',
                    {
                      class: 'small',
                      type: 'button',
                      onclick: () => {
                        startAddMode(sg.postId);
                        $('#post-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      },
                    },
                    tr('이 게시물에 플랫폼 추가'),
                  ),
                ),
              ),
            ]
          : [h('p', { class: 'muted' }, tr('지금은 제안할 게시물이 없습니다'))]),
      );
    } catch (err) {
      suggestBox.replaceChildren(h('p', { class: 'form-error' }, err.message));
    } finally {
      button.disabled = false;
    }
  };
  days.addEventListener('change', () => {
    suggestBox.replaceChildren();
    load();
  });
  reloadInsights = load;
  box.replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', {}, tr('성과 요약')), days),
    body,
    h('button', { class: 'small', type: 'button', onclick: (e) => loadSuggestions(e.target) }, tr('다른 곳에도 올려 볼 게시물 찾기')),
    suggestBox,
  );
  load();
}

async function init() {
  translateStatic();
  // The switch names the other language, in that language.
  const toggle = $('#lang-toggle');
  toggle.textContent = LANG === 'ko' ? 'English' : '한국어'; // i18n-ignore: each language's own name
  toggle.setAttribute('lang', LANG === 'ko' ? 'en' : 'ko');
  toggle.addEventListener('click', () => setLanguage(LANG === 'ko' ? 'en' : 'ko'));
  try {
    overview = await api('/overview');
  } catch (err) {
    showView('new', { replace: true });
    banner(tr('대시보드에 연결할 수 없습니다: {error}', { error: err.message }), 'bad');
    return;
  }
  renderAccounts();
  renderTargets();
  refreshBoard();
  calendarPanel();
  inboxPanel();
  insightsPanel();
  loadPresets();
  offerDraft();

  // Coming back from an OAuth redirect.
  const params = new URLSearchParams(location.search);
  if (params.get('connected')) banner(tr('연결했습니다: {account}', { account: params.get('connected') }), 'ok');
  if (params.get('oauthError')) banner(tr('연결 실패: {error}', { error: params.get('oauthError') }), 'bad');
  if (params.has('view')) history.replaceState(null, '', '/');
  // Back from an OAuth redirect (?view=settings): the dialog over the new-post screen.
  if (params.get('view') === 'settings') {
    showView('new', { replace: true });
    showView(`settings/${params.get('connected')?.split('/')[0] || params.get('platform') || 'general'}`);
  } else {
    const start = location.hash.slice(1) || 'new';
    // A #settings/… address opens the dialog over the new-post screen.
    if (start.startsWith('settings')) showView('new', { replace: true });
    showView(start, { replace: true });
  }
}

init();

// ── Board search and paging ──────────────────────────────────────

let searchTimer;
$('#board-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    boardQuery = e.target.value.trim();
    boardLimit = BOARD_PAGE;
    refreshBoard();
  }, 300);
});
// "예약만": upcoming posts by time; the search box doesn't apply there.
$('#board-scheduled').addEventListener('change', (e) => {
  boardScheduled = e.target.checked;
  $('#board-search').disabled = boardScheduled;
  boardLimit = BOARD_PAGE;
  refreshBoard();
});
$('#board-more').addEventListener('click', () => {
  boardLimit += BOARD_PAGE;
  refreshBoard();
});
