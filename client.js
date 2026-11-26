/* global window, document, navigator */
/**
 * @local/forge-neo-progress (Client 側)
 *
 * Host 側（index.js）が登録した same-origin JSON ルートをポーリングし、
 * 生成進捗を composer.dock にアンビエントな 1 行バーとして描画します。
 *
 * - ルートパスは Host が index-inject で流す `window.__DSH_FORGE_PROGRESS__.path`
 *   から読む（設定で変わるためハードコードしない）。
 * - 文言は locale 名前空間 `forge-progress` 経由。登録時に `locale` を宣言して
 *   注入される `t` を使い、locale 切替に追随させる（注入されなければ
 *   `ctx.locale.bind` の関数でフォールバック）。
 * - ポーリング間隔は戻り値の `intervals`（アイドル時／生成中）に従う。
 */
window.__ModuleLoader__.load({
  id: '@local/forge-neo-progress',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'forge-progress';
    const ID = 'forge-neo-progress';
    const DEFAULT_PATH = '/forge-progress';

    /** 最低限の bilingual バランス（en/zh）を満たし、ja を追加。キーは英小文字。 */
    const DICT = {
      en: {
        title: 'Forge Neo generation progress',
        idle: 'Idle',
        generating: 'Generating',
        loading: 'Preparing',
        interrupted: 'Interrupted',
        skipped: 'Skipped',
        offline: 'Forge unreachable',
        eta: 'ETA',
      },
      zh: {
        title: 'Forge Neo 生成进度',
        idle: '空闲',
        generating: '生成中',
        loading: '准备中',
        interrupted: '已中断',
        skipped: '已跳过',
        offline: '无法连接 Forge',
        eta: '预计',
      },
      ja: {
        title: 'Forge Neo 生成進捗',
        idle: '待機中',
        generating: '生成中',
        loading: '準備中',
        interrupted: '中断されました',
        skipped: 'スキップ',
        offline: 'Forge に接続できません',
        eta: '残り',
      },
    };

    /** Host が index-inject で注入したパスを読む。無ければ既定値。 */
    function readPath() {
      const injected = typeof window !== 'undefined' ? window.__DSH_FORGE_PROGRESS__ : null;
      const path = injected && typeof injected.path === 'string' ? injected.path : '';
      return path === '' ? DEFAULT_PATH : path;
    }

    const clamp01 = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

    /** 残り時間を m:ss に。当てにできない値は null。 */
    function formatEta(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
      const total = Math.round(seconds);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    /** フェーズに応じた状態色（テーマトークン）。 */
    const DOT_COLOR = {
      generating: 'var(--dsw-alias-state-success-primary)',
      loading: 'var(--dsw-alias-state-business-primary)',
      interrupted: 'var(--dsw-alias-state-warn-primary)',
      skipped: 'var(--dsw-alias-state-warn-primary)',
      offline: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-label-tertiary)',
    };

    function ForgeProgress({ t }) {
      const translate = typeof t === 'function' ? t : (key) => (DICT.en[key] != null ? DICT.en[key] : key);

      // { phase, data } — phase: idle | generating | loading | interrupted | skipped | offline
      const [state, setState] = React.useState({ phase: 'idle', data: null });

      React.useEffect(() => {
        const path = readPath();
        let stopped = false;
        let timer = 0;
        let controller = null;

        const tick = async () => {
          if (controller) controller.abort();
          controller = new AbortController();
          let payload;
          try {
            const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
            payload = await res.json();
          } catch (error) {
            payload = { ok: false, error: String((error && error.name) || 'fetch-failed') };
          }
          if (stopped) return;

          const intervals = (payload && payload.intervals) || {};
          if (payload && payload.ok) {
            let phase = 'idle';
            if (payload.active) phase = payload.interrupted ? 'interrupted' : payload.loading ? 'loading' : payload.skipped ? 'skipped' : 'generating';
            setState({ phase, data: payload });
            const delay = payload.active ? (intervals.activeMs || 2000) : (intervals.idleMs || 10000);
            timer = setTimeout(tick, delay);
          } else {
            // 中継が Forge に到達できない: 低頻度で再試行しつつ静かに表示。
            setState({ phase: 'offline', data: payload });
            timer = setTimeout(tick, 10000);
          }
        };

        tick();
        return () => {
          stopped = true;
          clearTimeout(timer);
          if (controller) controller.abort();
        };
      }, []);

      const data = state.data || {};
      const phase = state.phase;
      const active = phase === 'generating' || phase === 'loading' || phase === 'interrupted' || phase === 'skipped';

      const labelKey = phase === 'idle' ? 'idle' : phase === 'offline' ? 'offline' : phase;
      const label = translate(labelKey);

      const progress = clamp01(data.progress);
      const pct = Math.round(progress * 100);
      const showBar = phase !== 'idle' && phase !== 'offline';
      const indeterminate = phase === 'loading';

      const stepText = data.steps > 0 ? `${data.step}/${data.steps}` : null;
      const etaClock = phase === 'generating' ? formatEta(data.etaSeconds) : null;

      const labelColor = phase === 'idle' ? 'var(--dsw-alias-label-tertiary)'
        : phase === 'offline' || phase === 'interrupted' || phase === 'skipped' ? 'var(--dsw-alias-state-warn-label)'
        : 'var(--dsw-alias-label-primary)';

      const fill = indeterminate
        ? { position: 'absolute', top: 0, bottom: 0, left: 0, width: '45%', borderRadius: 'inherit', background: DOT_COLOR.loading, animation: 'fnp-indeterminate 1.1s cubic-bezier(0.65,0.05,0.36,1) infinite' }
        : { position: 'absolute', top: 0, bottom: 0, left: 0, width: `${pct}%`, borderRadius: 'inherit', background: DOT_COLOR[phase] || DOT_COLOR.idle, transition: 'width 200ms linear' };

      return h('div', {
        role: 'status',
        'aria-live': 'polite',
        'aria-label': translate('title'),
        title: translate('title'),
        style: {
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          width: '100%',
          flex: '1 1 100%',
          minWidth: 0,
          overflow: 'hidden',
          padding: '6px 10px',
          borderRadius: '8px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: '12px',
          lineHeight: '16px',
          fontFamily: 'inherit',
        },
      },
        // プレビューサムネイル（生成中のみ）
        active && typeof data.image === 'string' && data.image !== ''
          ? h('img', {
              src: data.image,
              alt: '',
              'aria-hidden': true,
              style: { width: '26px', height: '26px', flex: 'none', borderRadius: '4px', objectFit: 'cover', background: 'var(--dsw-alias-bg-layer-2)', border: '0.5px solid var(--dsw-alias-border-l2)' },
            })
          : null,

        // 状態ドット + ラベル
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flex: '0 1 auto', minWidth: 0 } },
          h('span', { 'aria-hidden': true, style: { width: '8px', height: '8px', flex: 'none', borderRadius: '50%', background: DOT_COLOR[phase] || DOT_COLOR.idle } }),
          h('span', { style: { color: labelColor, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: active ? 500 : 400 } }, label),
        ),

        // 進捗バー
        showBar
          ? h('span', {
              'aria-hidden': true,
              style: { position: 'relative', flex: '1 1 auto', minWidth: '48px', height: '6px', borderRadius: '3px', overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2)' },
            }, h('span', { className: indeterminate ? 'fnp-bar' : undefined, style: fill }))
          : h('span', { style: { flex: '1 1 auto' } }),

        // メタ: ステップ / 割合 / 残り（aria-live の洪水を防ぐため読み上げ対象外）
        h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'baseline', gap: '8px', flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
          stepText ? h('span', null, stepText) : null,
          showBar && !indeterminate ? h('span', null, `${pct}%`) : null,
          etaClock ? h('span', null, `${translate('eta')} ${etaClock}`) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 語彙を登録（en/zh 必須 + ja）。登録は revision を上げるので、
        // 既に描画済みの出口にも後から届く。
        ctx.effect(() => ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh, ja: DICT.ja }), 'forge-progress: dictionaries');

        // `locale` を宣言して注入される `t` を優先。未対応のビルドでは
        // bind 済みの関数（呼び出し時にアクティブ locale を読む）で補う。
        const boundT = ctx.locale.bind(NS);
        const render = (props) => ForgeProgress({ t: typeof props.t === 'function' ? props.t : boundT });

        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => {
          try {
            return ctx.slots.register({ name: 'conversation.composer.dock', id: ID, order: 20, locale: NS }, render);
          } catch (error) {
            // このビルドが register の locale オプションを拒否した場合の退路。
            return ctx.slots.register({ name: 'conversation.composer.dock', id: ID, order: 20 }, render);
          }
        }), 'forge-progress: composer dock entry');

        // 準備中バーの不確定アニメーション用 keyframes（apply ライフタイムで 1 回）。
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const STYLE_ID = 'fnp-indeterminate-style';
          let el = document.getElementById(STYLE_ID);
          if (el === null) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            el.textContent = '@keyframes fnp-indeterminate{0%{left:-45%}100%{left:100%}}@media (prefers-reduced-motion:reduce){.fnp-bar{animation:none!important}}';
            document.head.appendChild(el);
          }
          return () => { if (el != null && el.parentNode !== null) el.parentNode.removeChild(el); };
        }, 'forge-progress: indeterminate keyframes');
      },
    };
  },
});
