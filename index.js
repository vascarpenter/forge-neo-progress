/**
 * @local/forge-neo-progress (Host half)
 *
 * DSH webserver に same-origin の JSON ルートを 1 本登録し、Forge Neo の
 * `/sdapi/v1/progress` を中継します。ブラウザ（Client 側）は Tailscale 到達性も
 * CORS も不要で、このルートをポーリングするだけです。
 *
 * - forgeUrl   : 中継先（DSH ホストから到達できる Forge API の URL）
 * - path       : DSH webserver に登録する exact ルート（SPA の fallback と衝突しない一意なパス）
 * - timeoutMs  : Forge 側の progress 取得のタイムアウト
 * - cacheMs    : 同一リクエストの短時間キャッシュ（複数タブ・高頻度ポーリング対策）
 * - includeImage : true のとき生成途中のプレビュー画像（base64）を通す
 * - idleIntervalMs / activeIntervalMs : Client へ戻り値で返すポーリング間隔
 *
 * 描画は Client モジュール（client.js）が担当し、Host 側は JSON を返すだけに徹します。
 *
 * なぜ `export const Config`（schemastery スキーマ）を置かないか:
 * ローカルディレクトリInstall は checkout を link するため、Host 半分の index.js は
 * checkout の実パスから Node ESM で読まれます。そこでは `@deepseek-ai/schemastery` のような
 * ホスト同梱の bare specifier が解決できず、import 時点で有効化が失敗します
 * （公式の装飾テンプレの index.js が import を 1 つも持たないのも同じ理由）。
 * そこで既定値と型 coercion をこの中の readConfig() で自前で行い、依存をゼロにしています。
 * 設定値自体は cordis.patch.yml の config から素のオブジェクトとして届きます。
 */

/** Cordis 上の安定したプラグイン名（cordis.patch.yml の row id と揃える）。 */
export const name = 'forge-neo-progress'

/** ルート登録に WebServer だけが必要。他サービスには依存しない。 */
export const inject = ['webServer']

/** 設定の既定値（config が欠いた場合に使う）。 */
const DEFAULTS = {
  forgeUrl: 'http://127.0.0.1:7865',
  path: '/forge-progress',
  timeoutMs: 4000,
  cacheMs: 700,
  includeImage: true,
  auth: '',
  idleIntervalMs: 10000,
  activeIntervalMs: 2000,
}

/** 整数を [min, max] に収める。数値でなければ既定値。 */
const clampInt = (value, def, min, max) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

/** patch から届いた素の config を、既定値適用＋軽い coercion で正規化する。
 *  （schemastery を import できないため、検証はこの関数で担う。） */
function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const forgeUrl = typeof c.forgeUrl === 'string' && c.forgeUrl.trim() !== '' ? c.forgeUrl.trim() : DEFAULTS.forgeUrl
  const path = typeof c.path === 'string' && /^\/[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(c.path) ? c.path : DEFAULTS.path
  return {
    forgeUrl,
    path,
    timeoutMs: clampInt(c.timeoutMs, DEFAULTS.timeoutMs, 200, 60000),
    cacheMs: clampInt(c.cacheMs, DEFAULTS.cacheMs, 0, 60000),
    includeImage: c.includeImage === undefined ? DEFAULTS.includeImage : Boolean(c.includeImage),
    auth: typeof c.auth === 'string' ? c.auth : DEFAULTS.auth,
    idleIntervalMs: clampInt(c.idleIntervalMs, DEFAULTS.idleIntervalMs, 1000, 600000),
    activeIntervalMs: clampInt(c.activeIntervalMs, DEFAULTS.activeIntervalMs, 250, 60000),
  }
}

/** Forge の progress 応答を、Client がそのまま描画できる形に正規化する。
 *  Forge Neo は `{ progress, eta_relative, state: {...}, current_image }`、
 *  古い SD-WebUI 系は `[progress, eta, job, job_count]` を返すため両方受け取る。 */
function normalizePayload(raw) {
  if (Array.isArray(raw)) {
    const [progress = 0, eta = 0, job = '', jobCount = 0] = raw
    return { progress: num(progress), etaSeconds: numOrNull(eta), job: str(job), jobCount: num(jobCount), jobNo: 0, step: 0, steps: 0, skipped: false, interrupted: false, image: null }
  }
  const state = (raw && typeof raw === 'object' && raw.state) || {}
  const image = raw && raw.current_image
  return {
    progress: num(raw && raw.progress),
    etaSeconds: numOrNull(raw && raw.eta_relative),
    job: str(state.job),
    jobCount: num(state.job_count),
    jobNo: num(state.job_no),
    step: num(state.sampling_step),
    steps: num(state.sampling_steps),
    skipped: state.skipped === true,
    interrupted: state.interrupted === true,
    image: toDataUrl(image),
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
/** 数値でなければ null（不明な ETA を 0:00 に化かさないため、ETA 専用）。 */
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value) => (typeof value === 'string' ? value : '')
/** Forge の current_image は data: 接頭辞なしの裸の base64 で返ることが多い。
 *  <img src> にそのまま渡すと相対 URL として解決され画像が壊れるため、ここで補う。 */
const toDataUrl = (value) => {
  if (typeof value !== 'string' || value === '') return null
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`
}

/** 生成が動いているか。Forge は idle 時に job_count 0 を返し、チェックポイント読み込み中は
 *  job_count -1（progress は 0.01、eta は読み込み時間ぶん無限に伸びる）を返す。
 *  progress と sampling_steps は完了後も残値があるので job_count を主信号にする。 */
const isActive = (state) => state.jobCount !== 0 || (state.progress > 0 && state.progress < 1 && !state.skipped)
/** 読み込み・前処理中（ステップが進んでおらず、eta が当てにできない状態）。 */
const isLoading = (state) => state.jobCount < 0 || (isActive(state) && state.steps > 0 && state.step === 0)

export function apply(ctx, config) {
  const cfg = readConfig(config)
  const forgeBase = cfg.forgeUrl.replace(/\/+$/, '').replace(/^(https?:\/\/[^/]*?)\/.*$/, '$1')
  const target = new URL('/sdapi/v1/progress', `${forgeBase}/`).toString()
  const headers = { accept: 'application/json' }
  if (cfg.auth !== '') headers.authorization = `Basic ${Buffer.from(cfg.auth).toString('base64')}`

  /** 直近応答の文字列キャッシュ（Response は 1 回しか body を読めないため本文で保持）。 */
  let cache = { at: 0, status: 0, body: '' }
  let lastFailure = ''

  /** status/body から応答を組み立てる（キャッシュ命中でも同じ形が必要）。 */
  const resp = (status, body) => () =>
    new Response(status === 204 ? null : body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

  const json = (payload, status) => {
    const body = JSON.stringify(payload)
    return { status, body, response: resp(status, body) }
  }

  const readUpstream = async () => {
    const now = Date.now()
    if (cfg.cacheMs > 0 && now - cache.at < cfg.cacheMs && cache.body !== '') {
      return { status: cache.status, body: cache.body, response: resp(cache.status, cache.body) }
    }
    let result
    try {
      const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(cfg.timeoutMs) })
      if (!upstream.ok) {
        result = json({ ok: false, error: `forge-responded-${upstream.status}`, fetchedAt: now }, 502)
      } else {
        const state = normalizePayload(await upstream.json())
        const payload = {
          ok: true,
          fetchedAt: now,
          active: isActive(state),
          loading: isLoading(state),
          ...state,
          image: cfg.includeImage ? state.image : null,
          intervals: { idleMs: cfg.idleIntervalMs, activeMs: cfg.activeIntervalMs },
        }
        result = json(payload, 200)
      }
    } catch (error) {
      result = json({ ok: false, error: String((error && error.name) || 'unreachable'), fetchedAt: now }, 502)
    }
    cache = { at: Date.now(), status: result.status, body: result.body }
    return result
  }

  const route = {
    kind: 'exact',
    path: cfg.path,
    resource: async () => {
      const result = await readUpstream()
      const failed = result.status !== 200
      const signature = failed ? result.body : ''
      if (failed && signature !== lastFailure) {
        ctx.logger.warn(`forge-neo-progress: ${cfg.path} → ${target} 取得失敗 (${result.status}): ${result.body.slice(0, 200)}`)
      } else if (!failed && lastFailure !== '') {
        ctx.logger.info('forge-neo-progress: 取得が再開しました')
      }
      lastFailure = failed ? signature : ''
      return result.response()
    },
  }

  // ルートパスは設定で変わるため、页面の起動時に global で伝えて Client の取り違えを防ぐ。
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_FORGE_PROGRESS__', value: { path: cfg.path } })
  })

  ctx.effect(() => ctx.webServer.register(route), `forge-neo-progress: ${cfg.path} progress route`)
}
