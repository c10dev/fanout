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

// ── Submit ───────────────────────────────────────────────────────

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
  if (errors.length) {
    $('#form-error').textContent = errors.join('\n');
    return;
  }

  const button = $('#submit');
  button.disabled = true;
  try {
    await api('/posts', {
      method: 'POST',
      body: JSON.stringify({
        mediaId: media.id,
        title,
        description: $('#description').value,
        tags: $('#tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        scheduledAt: scheduled ? new Date(scheduled).toISOString() : undefined,
        containsSyntheticMedia: $('#ai').checked,
        targets,
      }),
    });
    $('#post-form').reset();
    $('#drop-label').textContent = '영상 파일을 고르거나 여기에 끌어다 놓으세요';
    $('#form-error').textContent = '';
    media = null;
    renderMedia();
    renderTargets();
    refreshBoard();
  } catch (err) {
    $('#form-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// ── Status board ─────────────────────────────────────────────────

function targetRow(t) {
  const detail = h('div', { class: 'tdetail' });
  if (t.remoteUrl) detail.append(h('a', { href: t.remoteUrl, target: '_blank', rel: 'noopener noreferrer' }, t.remoteUrl));
  else if (t.state === 'queued' && t.notBefore) detail.append(h('span', { class: 'muted' }, `${fmtTime(t.notBefore)}에 시작`));
  if (t.errorCode) detail.append(h('div', { class: 'err' }, `${t.errorCode}: ${t.errorMessage ?? ''}`));
  for (const w of t.warnings) detail.append(h('div', { class: 'warnline' }, `⚠ ${w}`));
  if (t.attempts > 1) detail.append(h('div', { class: 'muted' }, `시도 ${t.attempts}회`));

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

function postCard({ post, targets }) {
  const history = h('details', {}, h('summary', {}, '상태 기록'));
  history.addEventListener(
    'toggle',
    async () => {
      if (!history.open || history.dataset.loaded) return;
      history.dataset.loaded = '1';
      const detail = await api(`/posts/${post.id}`);
      history.append(
        h(
          'ul',
          { class: 'events' },
          detail.targets.flatMap((t) => t.events.map((ev) => h('li', {}, `${fmtTime(ev.at)}  ${t.platform}  ${ev.from ?? '·'} → ${ev.to}${ev.detail ? `  (${ev.detail})` : ''}`))),
        ),
      );
    },
  );
  return h(
    'article',
    { class: 'post' },
    h('div', { class: 'post-head' }, h('span', { class: 'post-title' }, post.title), h('span', { class: 'muted' }, `${fmtTime(post.createdAt)}${post.scheduledAt ? ` · 예약 ${fmtTime(post.scheduledAt)}` : ''}`)),
    targets.map(targetRow),
    history,
  );
}

let boardTimer;
async function refreshBoard() {
  clearTimeout(boardTimer);
  let active = false;
  try {
    const posts = await api('/posts?limit=30');
    // Keep any open history panel open across refreshes by skipping re-render when one is open.
    if (!document.querySelector('#board details[open]')) {
      $('#board').replaceChildren(...(posts.length ? posts.map(postCard) : [h('p', { class: 'empty' }, '아직 게시물이 없습니다')]));
    }
    active = posts.some((p) => p.targets.some((t) => !t.terminal));
    $('#board-updated').textContent = `${new Date().toLocaleTimeString('ko-KR')} 갱신`;
  } catch (err) {
    $('#board-updated').textContent = `갱신 실패: ${err.message}`;
  }
  boardTimer = setTimeout(refreshBoard, active ? 3000 : 15000);
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
}

init();
