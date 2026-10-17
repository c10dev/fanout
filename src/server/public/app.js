// fanout dashboard. Plain browser JS, no build step. All untrusted text goes through textContent.

const $ = (sel) => document.querySelector(sel);

let token = document.querySelector('meta[name="fanout-token"]').content;
if (!token || token === '__FANOUT_TOKEN__') {
  try {
    token = sessionStorage.getItem('fanoutToken') || '';
  } catch {
    token = '';
  }
  if (!token) token = prompt('대시보드 토큰 (fanout serve 출력 참고)') || '';
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
    headers: { 'x-fanout-token': token, ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...opts.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ── Labels ───────────────────────────────────────────────────────

const STATE = {
  queued: ['대기', 'info'],
  transcoding: ['변환 중', 'info'],
  uploading: ['업로드 중', 'info'],
  processing: ['처리 중', 'info'],
  published: ['게시됨', 'ok'],
  handed_off: ['앱에서 마무리', 'warn'],
  failed: ['실패', 'bad'],
  needs_reauth: ['재연결 필요', 'bad'],
};
const VERDICT = {
  as_is: ['원본 그대로', 'ok'],
  transcode: ['변환 후 업로드', 'warn'],
  blocked: ['올릴 수 없음', 'bad'],
};
const fmtTime = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
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
    opt('공개 범위', select('privacy', [['public', '공개'], ['unlisted', '일부 공개'], ['private', '비공개']], { placeholder: '선택하세요' })),
    group('아동용 영상인가요?', radios('madeForKids', [['no', '아니요'], ['yes', '예']])),
    opt('카테고리', select('categoryId', [['22', '인물/블로그', true], ['24', '엔터테인먼트'], ['10', '음악'], ['20', '게임'], ['26', '노하우/스타일'], ['27', '교육'], ['28', '과학기술'], ['19', '여행/이벤트'], ['17', '스포츠'], ['15', '동물']])),
    opt('재생목록 ID (선택)', h('input', { type: 'text', name: 'playlistId', autocomplete: 'off' })),
    checkbox('notifySubscribers', '구독자에게 알림', true),
  ],
  tiktok: () => [
    group('게시 방식', radios('mode', [['inbox', 'TikTok 앱 수신함으로 보내기', true], ['direct', '바로 게시 (Direct Post)']]), true),
    h('p', { class: 'note', 'data-when': 'inbox' }, '업로드 후 TikTok 앱 알림에서 캡션과 공개 범위를 정해 게시를 마무리합니다.'),
    opt('공개 범위', select('privacyLevel', [['PUBLIC_TO_EVERYONE', '모두'], ['MUTUAL_FOLLOW_FRIENDS', '맞팔로우 친구'], ['FOLLOWER_OF_CREATOR', '팔로워'], ['SELF_ONLY', '나만 보기']], { placeholder: '선택하세요' })),
    group('허용할 상호작용', h('div', { class: 'choices' }, checkbox('allowComment', '댓글'), checkbox('allowDuet', '듀엣'), checkbox('allowStitch', '이어찍기'))),
    group('콘텐츠 공개', h('div', { class: 'choices' }, checkbox('brandOrganic', '내 브랜드 홍보'), checkbox('brandedContent', '브랜디드 콘텐츠 (유료 협찬)'))),
    opt('캡션 (비우면 제목·설명·태그로 만듦)', h('textarea', { name: 'caption', rows: 2 }), true),
    h('div', { class: 'opt wide' }, checkbox('musicConsent', '게시하면 TikTok 음악 사용 확인(Music Usage Confirmation)에 동의합니다')),
    h('p', { class: 'note' }, '심사 전 앱은 비공개 계정에 "나만 보기"로만 바로 게시할 수 있습니다.'),
  ],
  instagram: () => [
    checkbox('shareToFeed', '프로필 피드에도 표시', true),
    opt('캡션 (비우면 제목·설명·태그로 만듦)', h('textarea', { name: 'caption', rows: 2 }), true),
  ],
  facebook: () => [
    opt('설명 (비우면 제목·설명·태그로 만듦)', h('textarea', { name: 'caption', rows: 2 }), true),
    h('p', { class: 'note' }, 'Facebook Reels는 9:16, 3~90초 영상만 받습니다.'),
  ],
  x: () => [
    opt('글 (비우면 제목·설명·태그로 만듦, 가중치 280 이하·한글은 2로 셈)', h('textarea', { name: 'text', rows: 2 }), true),
    h('p', { class: 'note' }, 'X API는 종량제입니다. URL이 들어간 게시물은 요금이 훨씬 비쌉니다.'),
  ],
  mastodon: () => [
    opt('공개 범위', select('visibility', [['public', '공개'], ['unlisted', '조용히 공개'], ['private', '팔로워만']], { placeholder: '선택하세요' })),
    opt('글 (비우면 제목·설명·태그로 만듦)', h('textarea', { name: 'text', rows: 2 }), true),
    opt('영상 대체 텍스트 (선택)', h('input', { type: 'text', name: 'alt', autocomplete: 'off' })),
    opt('언어 (선택, 예: ko)', h('input', { type: 'text', name: 'language', autocomplete: 'off' })),
    opt('내용 경고 (선택)', h('input', { type: 'text', name: 'spoilerText', autocomplete: 'off' })),
  ],
  bluesky: () => [
    opt('글 (비우면 제목·설명·태그로 만듦, 300자 이하)', h('textarea', { name: 'text', rows: 2 }), true),
    opt('영상 대체 텍스트 (선택)', h('input', { type: 'text', name: 'alt', autocomplete: 'off' })),
    opt('글 언어 (선택, 예: ko)', h('input', { type: 'text', name: 'langs', autocomplete: 'off' })),
    h('p', { class: 'note' }, 'Bluesky는 mp4 최대 300MB, 자막은 VTT 파일만 붙습니다.'),
  ],
};

/** Read one platform block back into the provider's option object. */
function readOptions(platform, body) {
  const val = (n) => body.querySelector(`[name="${n}"]`);
  const checked = (n) => body.querySelector(`[name="${n}"]:checked`)?.value;
  const on = (n) => Boolean(val(n)?.checked);
  const text = (n) => val(n)?.value.trim() || undefined;
  switch (platform) {
    case 'youtube': {
      const kids = checked('madeForKids');
      return {
        privacy: val('privacy').value || undefined,
        madeForKids: kids === undefined ? undefined : kids === 'yes',
        categoryId: val('categoryId').value,
        playlistId: text('playlistId'),
        notifySubscribers: on('notifySubscribers') ? undefined : false,
      };
    }
    case 'tiktok': {
      const mode = checked('mode');
      if (mode === 'inbox') return { mode };
      return {
        mode,
        privacyLevel: val('privacyLevel').value || undefined,
        allowComment: on('allowComment'),
        allowDuet: on('allowDuet'),
        allowStitch: on('allowStitch'),
        brandOrganic: on('brandOrganic'),
        brandedContent: on('brandedContent'),
        musicConsent: on('musicConsent'),
        caption: text('caption'),
      };
    }
    case 'instagram':
      return { shareToFeed: on('shareToFeed') ? undefined : false, caption: text('caption') };
    case 'facebook':
      return { caption: text('caption') };
    case 'x':
      return { text: text('text') };
    case 'mastodon':
      return { visibility: val('visibility').value || undefined, text: text('text'), alt: text('alt'), language: text('language'), spoilerText: text('spoilerText') };
    case 'bluesky':
      return { text: text('text'), alt: text('alt'), langs: text('langs')?.split(',').map((l) => l.trim()).filter(Boolean) };
    default:
      return {};
  }
}

/** Same required-choice rules the server enforces, shown before anything uploads. */
function missingChoices(platform, o) {
  const out = [];
  if (platform === 'youtube') {
    if (!o.privacy) out.push('YouTube 공개 범위를 고르세요');
    if (o.madeForKids === undefined) out.push('YouTube 아동용 여부를 고르세요');
  }
  if (platform === 'mastodon' && !o.visibility) out.push('Mastodon 공개 범위를 고르세요');
  if (platform === 'tiktok' && o.mode === 'direct') {
    if (!o.privacyLevel) out.push('TikTok 공개 범위를 고르세요');
    if (!o.musicConsent) out.push('TikTok 음악 사용 확인에 동의해야 바로 게시할 수 있습니다');
    if (o.brandedContent && o.privacyLevel === 'SELF_ONLY') out.push('TikTok 브랜디드 콘텐츠는 "나만 보기"로 올릴 수 없습니다');
  }
  return out;
}

// ── State ────────────────────────────────────────────────────────

let overview = { platforms: [] };
let media = null; // { id, name, media, isShort, assessments }

function renderAccounts() {
  $('#accounts').replaceChildren(
    ...overview.platforms.map((p) =>
      h('li', { class: `chip${p.accounts.length ? ' on' : ''}`, title: p.accounts.length ? '' : `fanout connect ${p.id}` }, p.displayName, p.accounts.length ? ` · ${p.accounts.map((a) => a.label).join(', ')}` : ' · 연결 안 됨'),
    ),
  );
}

function renderTargets() {
  $('#targets').replaceChildren(
    ...overview.platforms.map((p) => {
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
          ? h('select', { name: 'account', 'aria-label': `${p.displayName} 계정` }, p.accounts.map((a) => h('option', { value: a.name }, a.label)))
          : h('span', { class: 'muted', 'data-account': p.accounts[0].name }, `→ ${p.accounts[0].label}`)
        : h('span', { class: 'muted' }, `연결 안 됨 · 터미널에서 fanout setup ${p.id}`);
      const head = h(
        'div',
        { class: 'target-head' },
        h('label', { class: 'check' }, toggle, p.displayName),
        account,
        assessment ? badge(VERDICT[assessment.verdict]) : null,
        p.id === 'youtube' && media?.isShort ? badge(['Shorts', 'info']) : null,
      );
      const reasons = assessment?.violations.length
        ? h('p', { class: 'note' }, assessment.violations.map((v) => `${v.fixable ? '변환' : '불가'}: ${v.message}`).join(' · '))
        : null;
      const block = h('div', { class: `target${connected && !blocked ? '' : ' disabled'}`, 'data-platform': p.id }, head, reasons, body);
      if (p.id === 'tiktok') wireTikTokMode(body);
      return block;
    }),
  );
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
  body.addEventListener('change', (e) => e.target.name === 'mode' && sync());
  sync();
}

function renderMedia() {
  const box = $('#media-info');
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
      `${v.width}×${v.height} · ${v.codec} · ${v.fps.toFixed(0)}fps · ${m.durationSec.toFixed(1)}초 · ${(m.sizeBytes / 1048576).toFixed(1)}MB · ${m.audio ? `${m.audio.codec} ${m.audio.sampleRate / 1000}kHz` : '오디오 없음'}`,
    ),
  );
}

// ── Upload ───────────────────────────────────────────────────────

function uploadFile(file) {
  const bar = $('#upload-progress');
  const label = $('#drop-label');
  bar.hidden = false;
  bar.value = 0;
  label.textContent = `${file.name} 올리는 중…`;
  $('#form-error').textContent = '';
  media = null;
  renderMedia();
  renderTargets();

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/media');
  xhr.setRequestHeader('x-fanout-token', token);
  xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => e.lengthComputable && (bar.value = e.loaded / e.total);
  xhr.onload = () => {
    bar.hidden = true;
    let body = {};
    try {
      body = JSON.parse(xhr.responseText);
    } catch {}
    if (xhr.status >= 300) {
      label.textContent = '영상 파일을 고르거나 여기에 끌어다 놓으세요';
      $('#form-error').textContent = body.error || `업로드 실패 (HTTP ${xhr.status})`;
      return;
    }
    media = body;
    label.textContent = `${file.name} · 다른 파일로 바꾸려면 다시 고르세요`;
    if (!$('#title').value) $('#title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
    renderMedia();
    renderTargets();
  };
  xhr.onerror = () => {
    bar.hidden = true;
    $('#form-error').textContent = '업로드 중 연결이 끊겼습니다';
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
    h('input', { name: 'language', value: language, 'aria-label': '자막 언어 코드', placeholder: 'ko' }),
    h('input', { type: 'file', name: 'file', accept: '.srt,.vtt,.sbv,.scc,.ttml,.dfxp', 'aria-label': '자막 파일' }),
    h('button', { type: 'button', class: 'small', onclick: () => row.remove() }, '빼기'),
  );
  $('#captions').append(row);
}
$('#add-caption').addEventListener('click', () => addCaptionRow($('#captions').children.length ? '' : 'ko'));

async function uploadAsset(kind, file) {
  const res = await fetch(`/api/assets/${kind}`, {
    method: 'POST',
    headers: { 'x-fanout-token': token, 'x-filename': encodeURIComponent(file.name) },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.id;
}

// ── Submit ───────────────────────────────────────────────────────

/** Read and check the form; returns errors, or everything needed to preview and post. */
function collectForm() {
  const errors = [];
  if (!media) errors.push('먼저 영상을 고르세요');
  const title = $('#title').value.trim();
  if (!title) errors.push('제목을 입력하세요');
  const targets = [];
  for (const block of document.querySelectorAll('.target')) {
    if (!block.querySelector('[name="enabled"]').checked) continue;
    const platform = block.dataset.platform;
    const account = block.querySelector('select[name="account"]')?.value ?? block.querySelector('[data-account]')?.dataset.account;
    const options = readOptions(platform, block.querySelector('.target-body'));
    errors.push(...missingChoices(platform, options));
    targets.push({ platform, account, options: JSON.parse(JSON.stringify(options)) });
  }
  if (!targets.length) errors.push('올릴 곳을 하나 이상 고르세요');
  const scheduled = $('#scheduled').value;
  const thumbnail = $('#thumbnail').files[0];
  if (thumbnail && thumbnail.size > 2 * 1024 * 1024) errors.push('썸네일은 2MB 이하여야 합니다');
  const captionRows = [...document.querySelectorAll('.caption-row')]
    .map((r) => ({ language: r.querySelector('[name="language"]').value.trim(), file: r.querySelector('[name="file"]').files[0] }))
    .filter((c) => c.file || c.language);
  for (const c of captionRows) if (!c.file || !c.language) errors.push('자막은 언어 코드와 파일을 모두 넣어 주세요');
  // Which platforms actually use these files (capabilities in the providers).
  const uses = (list) => targets.some((t) => list.includes(t.platform));
  if (thumbnail && !uses(['youtube', 'mastodon'])) errors.push('썸네일은 YouTube·Mastodon에만 적용됩니다. 해당 플랫폼을 고르거나 썸네일을 비워 주세요');
  if (captionRows.length && !uses(['youtube', 'bluesky'])) errors.push('자막은 YouTube·Bluesky에만 적용됩니다. 해당 플랫폼을 고르거나 자막을 비워 주세요');
  const payload = {
    mediaId: media?.id,
    title,
    description: $('#description').value,
    tags: $('#tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    scheduledAt: scheduled ? new Date(scheduled).toISOString() : undefined,
    containsSyntheticMedia: $('#ai').checked,
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
      p.transcode.length ? h('div', { class: 'muted' }, `변환: ${p.transcode.join(', ')}`) : null,
    ),
  );
  const box = $('#confirm');
  box.replaceChildren(
    h('h3', { class: 'sub' }, blocked ? '이대로는 올릴 수 없습니다' : '이렇게 올립니다'),
    h('ul', { class: 'confirm-list' }, rows),
    h(
      'div',
      { class: 'actions' },
      blocked ? null : h('button', { type: 'button', class: 'primary', id: 'confirm-post', onclick: () => post(form) }, '이대로 업로드'),
      h('button', { type: 'button', class: 'small', onclick: hideConfirm }, blocked ? '고치기' : '취소'),
    ),
  );
  box.hidden = false;
  $('#submit').hidden = true;
  box.scrollIntoView?.({ block: 'nearest' });
}

// Step 2: upload assets, create the post, reset the form.
async function post(form) {
  const button = $('#confirm-post');
  button.disabled = true;
  try {
    const thumbnailId = form.thumbnail ? await uploadAsset('thumbnail', form.thumbnail) : undefined;
    const captions = [];
    for (const c of form.captionRows) captions.push({ language: c.language, assetId: await uploadAsset('caption', c.file) });
    await api('/posts', { method: 'POST', body: JSON.stringify({ ...form.payload, thumbnailId, captions }) });
    $('#post-form').reset();
    $('#captions').replaceChildren();
    $('#drop-label').textContent = '영상 파일을 고르거나 여기에 끌어다 놓으세요';
    $('#form-error').textContent = '';
    hideConfirm();
    media = null;
    renderMedia();
    renderTargets();
    refreshBoard();
  } catch (err) {
    $('#form-error').textContent = err.message;
    button.disabled = false;
  }
}

// ── Status board ─────────────────────────────────────────────────

const fmtNum = (n) => (n === undefined || n === null ? '-' : Number(n).toLocaleString('ko-KR'));

function statsLine(st) {
  const parts = [['조회', st.views], ['좋아요', st.likes], ['댓글', st.comments], ['공유', st.shares]].filter(([, v]) => v !== undefined && v !== null);
  return h(
    'div',
    { class: 'stats', title: st.note ?? '' },
    parts.map(([k, v]) => h('span', {}, `${k} `, h('strong', {}, fmtNum(v)))),
    h('span', { class: 'muted' }, ` · ${fmtTime(st.fetchedAt)} 기준`),
    st.note && !parts.length ? h('span', { class: 'muted' }, ` · ${st.note}`) : null,
  );
}

function targetRow(t) {
  const detail = h('div', { class: 'tdetail' });
  if (t.remoteUrl) detail.append(h('a', { href: t.remoteUrl, target: '_blank', rel: 'noopener noreferrer' }, t.remoteUrl));
  else if (t.state === 'queued' && t.notBefore) detail.append(h('span', { class: 'muted' }, `${fmtTime(t.notBefore)}에 시작`));
  if (t.errorCode) detail.append(h('div', { class: 'err' }, `${t.errorCode}: ${t.errorMessage ?? ''}`));
  for (const w of t.warnings) detail.append(h('div', { class: 'warnline' }, `⚠ ${w}`));
  if (t.attempts > 1) detail.append(h('div', { class: 'muted' }, `시도 ${t.attempts}회`));
  if (t.stats) detail.append(statsLine(t.stats));
  if (t.state === 'published' && t.statsCost) {
    detail.append(
      h(
        'button',
        {
          class: 'small',
          type: 'button',
          title: t.statsCost,
          onclick: async (e) => {
            if (!confirm(`${t.statsCost}. 이 게시물의 반응을 가져올까요?`)) return;
            e.target.disabled = true;
            await api(`/posts/${t.postId}/stats`, { method: 'POST', body: JSON.stringify({ includePaid: true, platform: t.platform }) }).catch((err) => alert(err.message));
            refreshBoard();
          },
        },
        '반응 가져오기 (요금)',
      ),
    );
  }

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
          '다시 시도',
        )
      : h('span');
  return h('div', { class: 'trow' }, h('span', { class: 'tname' }, `${t.platform}/${t.account}`), badge(STATE[t.state] ?? [t.state, 'info']), detail, retry);
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

function postCard({ post, targets }) {
  const wasOpen = openHistory.has(post.id);
  // Show the cached list at once so a re-render doesn't flicker; the toggle handler then refreshes it.
  const history = h('details', { open: wasOpen }, h('summary', {}, '상태 기록'), wasOpen ? historyCache.get(post.id)?.cloneNode(true) : null);
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
            e.target.textContent = '가져오는 중…';
            await api(`/posts/${post.id}/stats`, { method: 'POST', body: '{}' }).catch((err) => alert(err.message));
            refreshBoard();
          },
        },
        '반응 새로고침',
      )
    : null;
  return h(
    'article',
    { class: 'post' },
    h('div', { class: 'post-head' }, h('span', { class: 'post-title' }, post.title), h('span', { class: 'muted' }, [fmtTime(post.createdAt), post.scheduledAt && `예약 ${fmtTime(post.scheduledAt)}`, post.hasThumbnail && '썸네일', post.captionLanguages?.length && `자막 ${post.captionLanguages.join(', ')}`].filter(Boolean).join(' · '))),
    targets.map(targetRow),
    h('div', { class: 'post-foot' }, history, refreshStats),
  );
}

let boardTimer;
async function refreshBoard() {
  clearTimeout(boardTimer);
  let active = false;
  try {
    const posts = await api('/posts?limit=30');
    $('#board').replaceChildren(...(posts.length ? posts.map(postCard) : [h('p', { class: 'empty' }, '아직 게시물이 없습니다')]));
    active = posts.some((p) => p.targets.some((t) => !t.terminal));
    $('#board-updated').textContent = `${new Date().toLocaleTimeString('ko-KR')} 갱신`;
  } catch (err) {
    $('#board-updated').textContent = `갱신 실패: ${err.message}`;
  }
  boardTimer = setTimeout(refreshBoard, active ? 3000 : 15000);
}

// ── Views and banner ─────────────────────────────────────────────

function showView(view) {
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('#view-post').hidden = view !== 'post';
  $('#view-settings').hidden = view !== 'settings';
  if (view === 'settings') loadSettings();
}

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));

function banner(text, kind) {
  const el = $('#banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = !text;
}

// ── Settings ─────────────────────────────────────────────────────

const APP_TITLE = { youtube: 'YouTube', tiktok: 'TikTok', meta: 'Meta (Instagram · Facebook)', bluesky: 'Bluesky', mastodon: 'Mastodon', x: 'X (Twitter)' };
const CHECK_ICON = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' };
const LIVE_NOTICE = {
  youtube: '4초짜리 테스트 영상을 일부 공개로 올려, 공개 업로드가 실제로 되는지 확인하고 바로 삭제합니다. 오늘 업로드 한도 1회를 씁니다. 처리를 기다리느라 몇 분 걸릴 수 있습니다.',
  tiktok: '4초짜리 테스트 영상을 TikTok 앱 수신함으로 보냅니다. 앱 알림에 뜨는 테스트 영상은 게시하지 말고 지우세요.',
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
      `${f.label}${f.optional ? ' (선택)' : ''}`,
      h('input', {
        name: f.key,
        type: f.secret ? 'password' : 'text',
        autocomplete: 'off',
        value: f.secret ? undefined : f.value,
        placeholder: f.secret && f.set ? '저장됨 · 바꿀 때만 입력' : '',
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
          message(status, '저장했습니다', true);
          await refreshAll();
        } catch (err) {
          message(status, err.message, false);
        }
      },
    },
    h('div', { class: 'app-form' }, fields, jsonInput ? h('label', { class: 'field' }, '또는 Google에서 받은 OAuth JSON 파일', jsonInput) : null),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, '앱 정보 저장'), status),
  );
  // Platforms like Bluesky sign in with an app password and need no developer app at all.
  const noApp = app.fields.length === 0;
  const configured = app.fields.filter((f) => !f.optional).every((f) => f.set);
  const connected = platforms.some((p) => p.accounts.length);
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, APP_TITLE[app.key] ?? app.key, badge(noApp ? ['개발자 앱 필요 없음', 'info'] : configured ? ['앱 등록됨', 'ok'] : ['앱 미등록', 'warn'])),
    h('details', { open: noApp ? !connected : !configured }, h('summary', {}, noApp ? '연결 방법' : '내 개발자 앱 만드는 방법'), h('pre', { class: 'guide' }, app.guide)),
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
    rows.length ? rows : h('p', { class: 'muted' }, '연결된 계정이 없습니다'),
    connectForm(p, appReady),
  );
}

function accountRow(p, a) {
  const results = h('ul', { class: 'checks', hidden: true });
  const run = async (live) => {
    if (live && !confirm(LIVE_NOTICE[p.id])) return;
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    results.hidden = false;
    results.replaceChildren(h('li', { class: 'info' }, live ? '실제 업로드로 점검 중… 몇 분 걸릴 수 있습니다' : '점검 중…'));
    try {
      const { checks } = await api(`/doctor/${p.id}`, { method: 'POST', body: JSON.stringify({ account: a.name, live }) });
      results.replaceChildren(...checks.map((c) => h('li', { class: c.status }, `${CHECK_ICON[c.status] ?? ''} ${c.name}: ${c.detail}`)));
    } catch (err) {
      results.replaceChildren(h('li', { class: 'fail' }, `✗ ${err.message}`));
    } finally {
      for (const b of row.querySelectorAll('button')) b.disabled = false;
    }
  };
  const row = h(
    'div',
    { class: 'acct' },
    h('span', { class: 'acct-name' }, `${a.label}`, h('span', { class: 'muted' }, `  ${p.id}/${a.name}`)),
    h('button', { class: 'small', type: 'button', onclick: () => run(false) }, '점검'),
    LIVE_NOTICE[p.id] ? h('button', { class: 'small', type: 'button', onclick: () => run(true) }, '실제 업로드로 점검') : null,
    h(
      'button',
      {
        class: 'small',
        type: 'button',
        onclick: async () => {
          if (!confirm(`${p.displayName} ${a.label} 연결을 해제할까요? 저장된 토큰을 지웁니다.`)) return;
          try {
            await api(`/accounts/${p.id}/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
            await refreshAll();
          } catch (err) {
            alert(err.message);
          }
        },
      },
      '연결 해제',
    ),
    results,
  );
  return row;
}

function connectForm(p, appReady) {
  const status = h('span', { class: 'msg' });
  const name = h('input', { name: 'name', value: p.accounts.some((a) => a.name === 'main') ? '' : 'main', placeholder: '예: main, sub', autocomplete: 'off' });
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
          p.id === 'youtube' ? 'Redirect URI (Google 데스크톱 앱 클라이언트는 따로 등록하지 않아도 됩니다): ' : `${p.displayName} 개발자 포털에 이 Redirect URI를 등록해야 합니다: `,
          h('code', {}, p.redirectUri),
        )
      : null;
  const button = h('button', { class: 'primary', type: 'submit', disabled: !appReady }, p.connectMethod === 'oauth' ? `${{ youtube: 'Google', tiktok: 'TikTok', x: 'X' }[p.id] ?? p.displayName} 계정으로 연결` : '연결');
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
          message(status, `연결됨: ${res.account.label}`, true);
          await refreshAll();
        } catch (err) {
          message(status, err.message, false);
          button.disabled = !appReady;
        }
      },
    },
    h('div', { class: 'connect' }, h('label', { class: 'field' }, '계정 이름', name), inputs.map((i) => h('label', { class: 'field' }, i.label, i.el))),
    redirect,
    h('div', { class: 'actions' }, button, appReady ? null : h('span', { class: 'muted' }, '먼저 위에서 앱 정보를 저장하세요'), status),
  );
}

async function loadSettings() {
  const box = $('#settings');
  if (!overview.settingsEnabled) {
    box.replaceChildren(h('section', { class: 'panel' }, h('p', {}, '설정 화면은 127.0.0.1 전용으로 연 대시보드에서만 쓸 수 있습니다. 이 서버의 터미널에서 fanout app set / fanout connect 를 쓰세요.')));
    return;
  }
  try {
    const settings = await api('/settings');
    box.replaceChildren(...settings.apps.map((app) => appCard(app, settings.platforms.filter((p) => app.platforms.includes(p.id)))));
  } catch (err) {
    box.replaceChildren(h('p', { class: 'form-error' }, err.message));
  }
}

async function refreshAll() {
  overview = await api('/overview');
  renderAccounts();
  renderTargets();
  if (!$('#view-settings').hidden) await loadSettings();
}

async function init() {
  try {
    overview = await api('/overview');
  } catch (err) {
    $('#form-error').textContent = `대시보드에 연결할 수 없습니다: ${err.message}`;
    return;
  }
  renderAccounts();
  renderTargets();
  refreshBoard();

  // Coming back from an OAuth redirect.
  const params = new URLSearchParams(location.search);
  if (params.get('connected')) banner(`연결했습니다: ${params.get('connected')}`, 'ok');
  if (params.get('oauthError')) banner(`연결 실패: ${params.get('oauthError')}`, 'bad');
  if (params.has('view')) history.replaceState(null, '', '/');
  showView(params.get('view') === 'settings' ? 'settings' : 'post');
}

init();
