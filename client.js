window.__ModuleLoader__.load({
  id: '@local/model-vision-picker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const STATE_URL = '/plugins/model-vision-picker/state'
    const PROBE_URL = '/plugins/model-vision-picker/probe'
    const APPLY_URL = '/plugins/model-vision-picker/apply'
    const ERASE_URL = '/plugins/model-vision-picker/erase'
    const REVERT_URL = '/plugins/model-vision-picker/revert'

    const NS = 'model-vision-picker'

    const zh = {
      nav: '模型与识图',
      cardSummary: '选择模型供应商与模型，真实探测它能否识图，再设为默认模型并写入识图声明。',
      title: '模型与识图',
      intro: '探测会现画一张含随机数字和彩色方块的图片，直连端点问它，并可按次数多采样核对：读对数字才算确认可识图。',
      routeCount: (n) => `共 ${n} 个可用路由`,
      provider: '供应商',
      model: '模型',
      readonly: '只读',
      noModels: '该供应商没有可用模型',
      modelsFailed: '模型列表读取失败',
      declared: '已声明识图',
      notDeclared: '未声明识图',
      setDefault: '设为默认模型',
      declareImage: '写入识图声明 input: [text, image]',
      probing: '探测中…',
      applying: '应用中…',
      probe: '探测识图',
      apply: '应用选择',
      loading: '正在读取供应商列表…',
      verdictLabel: (verdict) => ({
        'vision-confirmed': '确认可识图',
        'vision-partial': '看到图像但读不准',
        'no-vision': '未使用图像内容',
        'refused-image': '端点拒绝图像',
        'bad-credential': '凭据无效',
        'insufficient-credit': '余额或配额不足',
        'rate-limited': '被限流',
        'not-found': '端点或模型不存在',
        'endpoint-gone': '端点已下线',
        'server-error': '上游故障',
        timeout: '请求超时',
        unreachable: '无法连通',
        'bad-response': '返回非 JSON',
        'empty-answer': '没有文本回答',
        refused: '请求被拒绝',
        unsupported: '协议不支持',
        'bad-request': '参数不完整',
        unknown: '结论未知',
      })[verdict] ?? verdict,
      confidenceLabel: (confidence) => ({
        high: '可信度高：每次采样都读对',
        medium: '可信度中：只有部分采样读对',
        low: '可信度低：证据不足',
      })[confidence] ?? '',
      answerLabel: '端点回答',
      hintLabel: '建议',
      attemptsLabel: '采样次数',
      attemptsOption: (n) => `${n} 次`,
      protocolLabel: '协议',
      samplesTitle: (n) => `采样明细（${n} 次）`,
      sampleOk: '读对',
      sampleMiss: '未读对',
      sampleFailed: '失败',
      lastProbe: (verdict) => `上次探测：${verdict}`,
      noChange: '没有任何改动生效',
      defaultSet: '已设为默认模型',
      imageDeclared: '已声明识图',
      currentDefault: (provider, model) => `当前默认模型：${provider} / ${model}`,
      writePath: (path) => `写入位置：${path}`,
      notWritable: '当前环境无法写入 profile 配置',
      eraseTitle: '抹除',
      eraseIntro: '抹除会把识图声明从配置里删掉（不是改回 [text]），并可选地把默认模型恢复到之前的记录值。',
      erase: '抹除识图声明',
      erasing: '抹除中…',
      imageErased: '识图声明已抹除',
      defaultRestored: '默认模型已恢复',
      restoreDefaultTo: (provider, model) => `同时把默认模型恢复为 ${provider} / ${model}`,
      restoreUnavailable: '没有可恢复的默认模型记录',
      historyTitle: '改动历史',
      historyEmpty: '还没有通过本插件做过改动',
      revert: '回退',
      revertLast: '回退最近一条',
      reverting: '回退中…',
      reverted: (action) => `已回退：${action}`,
      undone: '已回退',
      actionLabel: (action) => ({
        'declare-image': '声明识图',
        'set-default': '设为默认',
        'erase-image': '抹除识图',
        'restore-default': '恢复默认',
      })[action] ?? action,
    }

    const en = {
      nav: 'Model & Vision',
      cardSummary: 'Choose a model supplier route, prove it reads images, then make it the default with an image-input declaration.',
      title: 'Model & Vision',
      intro: 'The probe draws a fresh image with random digits and a colored square, asks the endpoint directly, and can repeat for several samples: only a correct digit read counts as confirmed.',
      routeCount: (n) => `${n} available routes`,
      provider: 'Supplier',
      model: 'Model',
      readonly: 'read-only',
      noModels: 'This supplier has no available model',
      modelsFailed: 'Model list could not be read',
      declared: 'Image input declared',
      notDeclared: 'No image input',
      setDefault: 'Set as the default model',
      declareImage: 'Declare image input: [text, image]',
      probing: 'Probing…',
      applying: 'Applying…',
      probe: 'Probe vision',
      apply: 'Apply',
      loading: 'Reading the supplier list…',
      verdictLabel: (verdict) => ({
        'vision-confirmed': 'Vision confirmed',
        'vision-partial': 'Image seen, read unreliable',
        'no-vision': 'Image content ignored',
        'refused-image': 'Endpoint refuses images',
        'bad-credential': 'Invalid credential',
        'insufficient-credit': 'No balance or quota',
        'rate-limited': 'Rate limited',
        'not-found': 'Endpoint or model missing',
        'endpoint-gone': 'Endpoint retired',
        'server-error': 'Upstream failure',
        timeout: 'Timed out',
        unreachable: 'Unreachable',
        'bad-response': 'Non-JSON response',
        'empty-answer': 'No text answer',
        refused: 'Request refused',
        unsupported: 'Protocol unsupported',
        'bad-request': 'Missing parameters',
        unknown: 'Unknown verdict',
      })[verdict] ?? verdict,
      confidenceLabel: (confidence) => ({
        high: 'High confidence: every sample read correctly',
        medium: 'Medium confidence: only some samples read correctly',
        low: 'Low confidence: not enough evidence',
      })[confidence] ?? '',
      answerLabel: 'Endpoint answer',
      hintLabel: 'Next step',
      attemptsLabel: 'Samples',
      attemptsOption: (n) => `${n}×`,
      protocolLabel: 'Protocol',
      samplesTitle: (n) => `Sample detail (${n})`,
      sampleOk: 'read',
      sampleMiss: 'missed',
      sampleFailed: 'failed',
      lastProbe: (verdict) => `Last probe: ${verdict}`,
      noChange: 'No change took effect',
      defaultSet: 'Set as the default model',
      imageDeclared: 'Image input declared',
      currentDefault: (provider, model) => `Current default: ${provider} / ${model}`,
      writePath: (path) => `Written to: ${path}`,
      notWritable: 'Profile configuration is not writable here',
      eraseTitle: 'Erase',
      eraseIntro: 'Erasing deletes the image declaration from the configuration (it does not rewrite it to [text]), and can optionally restore the default model to its recorded earlier value.',
      erase: 'Erase image declaration',
      erasing: 'Erasing…',
      imageErased: 'Image declaration erased',
      defaultRestored: 'Default model restored',
      restoreDefaultTo: (provider, model) => `Also restore the default model to ${provider} / ${model}`,
      restoreUnavailable: 'No recorded default model to restore',
      historyTitle: 'Change history',
      historyEmpty: 'No changes made through this plugin yet',
      revert: 'Revert',
      revertLast: 'Revert the latest',
      reverting: 'Reverting…',
      reverted: (action) => `Reverted: ${action}`,
      undone: 'Reverted',
      actionLabel: (action) => ({
        'declare-image': 'Declare image',
        'set-default': 'Set default',
        'erase-image': 'Erase image',
        'restore-default': 'Restore default',
      })[action] ?? action,
    }

    const CSS = `
.msp-page { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 24px;
  color: var(--dsw-alias-label-primary); box-sizing: border-box; max-width: 720px; }
.msp-root { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.msp-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.msp-title { font-weight: 600; font-size: 14px; }
.msp-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.msp-intro { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.55; }
.msp-grid { display: flex; flex-direction: column; gap: 10px; }
.msp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.msp-label { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 60px; }
.msp-select { font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); min-width: 240px; max-width: 100%; cursor: pointer; }
.msp-select[disabled] { opacity: .55; cursor: default; }
.msp-btn { border-radius: 8px; padding: 6px 14px; cursor: pointer; font: inherit; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); }
.msp-btn:hover:not([disabled]) { border-color: var(--dsw-alias-border-l2); }
.msp-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent;
  color: #fff; font-weight: 600; }
.msp-btn[disabled] { opacity: .55; cursor: default; }
.msp-msg { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); line-height: 1.55; font-size: 12px; word-break: break-word; }
.msp-msg.err { color: var(--dsw-alias-state-error-primary); }
.msp-msg.ok { color: var(--dsw-alias-state-success-primary); }
.msp-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.msp-tag.on { border-color: transparent; background: var(--dsw-alias-state-success-primary); color: #fff; }
.msp-check { display: flex; align-items: center; gap: 6px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; }
.msp-check[aria-disabled="true"] { opacity: .55; cursor: default; }
.msp-section { display: flex; flex-direction: column; gap: 8px; padding-top: 14px;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.msp-btn.danger { border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); }
.msp-btn.danger:hover:not([disabled]) { background: var(--dsw-alias-state-error-primary); color: #fff; }
.msp-btn.small { padding: 2px 10px; font-size: 12px; }
.msp-history { list-style: none; margin: 0; padding: 0; display: flex;
  flex-direction: column; gap: 6px; }
.msp-history-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.msp-history-item.undone { opacity: .55; }
.msp-history-action { font-weight: 600; }
.msp-history-target { color: var(--dsw-alias-label-secondary); word-break: break-all; }
.msp-history-at { color: var(--dsw-alias-label-secondary); margin-left: auto;
  font-variant-numeric: tabular-nums; }
.msp-probe { display: flex; flex-direction: column; gap: 6px; padding: 10px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.msp-probe .msp-msg { background: transparent; padding: 0; }
.msp-tag.off { border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); }
.msp-samples { list-style: none; margin: 0; padding: 0; display: flex;
  flex-direction: column; gap: 4px; }
.msp-sample { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.msp-sample-answer { color: var(--dsw-alias-label-secondary); max-width: 400px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msp-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
`

    async function request(url, body) {
      const response = await fetch(url, body === undefined
        ? { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * Build the picker UI bound to one locale lookup.
     * @param t - the locale lookup bound to this plugin's namespace.
     * @returns the body component rendered on the card's detail page.
     */
    function makePicker(t) {
      function Picker() {
        const [state, setState] = useState(undefined)
        const [provider, setProvider] = useState('')
        const [model, setModel] = useState('')
        const [declareImage, setDeclareImage] = useState(true)
        const [setDefault, setSetDefault] = useState(true)
        const [restoreDefault, setRestoreDefault] = useState(false)
        const [busy, setBusy] = useState(undefined)
        const [notice, setNotice] = useState(undefined)
        const [probe, setProbe] = useState(undefined)
        const [attempts, setAttempts] = useState(2)

        const load = useCallback(async () => {
          try {
            const next = await request(STATE_URL)
            setState(next)
            setProvider((current) => (current !== '' && next.routes.some((r) => r.provider === current))
              ? current
              : next.selection?.provider ?? next.routes[0]?.provider ?? '')
            setModel((current) => (current !== '' ? current : next.selection?.model ?? ''))
          } catch (error) {
            setState({ error: error instanceof Error ? error.message : String(error) })
          }
        }, [])

        useEffect(() => { void load() }, [load])

        const routes = state?.routes ?? []
        const route = useMemo(() => routes.find((entry) => entry.provider === provider), [routes, provider])
        const models = route?.models ?? []
        const chosen = useMemo(() => models.find((entry) => entry.id === model), [models, model])

        useEffect(() => {
          if (route === undefined) return
          if (model !== '' && models.some((entry) => entry.id === model)) return
          setModel(models[0]?.id ?? '')
        }, [route, models, model])

        useEffect(() => { setProbe(undefined); setNotice(undefined) }, [provider, model])

        // The earliest recorded default is the value this plugin replaced first,
        // which is the closest thing to "the original" the history holds.
        const restoreTo = useMemo(() => {
          const history = state?.history ?? []
          for (let index = history.length - 1; index >= 0; index -= 1) {
            const saved = history[index]?.changes?.default
            if (saved !== null && typeof saved === 'object') return saved
          }
          return undefined
        }, [state])

        async function runProbe() {
          if (provider === '' || model === '') return
          setBusy('probe')
          setProbe(undefined)
          setNotice(undefined)
          try {
            setProbe(await request(PROBE_URL, { provider, model, attempts }))
          } catch (error) {
            setProbe({ ok: false, verdict: 'error', detail: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy(undefined)
          }
        }

        async function runApply() {
          if (provider === '' || model === '') return
          setBusy('apply')
          setNotice(undefined)
          try {
            const result = await request(APPLY_URL, { provider, model, declareImage, setDefault })
            const parts = []
            if (result.defaultSet) parts.push(t('defaultSet'))
            if (result.imageDeclared?.includes('image')) parts.push(t('imageDeclared'))
            setNotice({
              kind: result.warnings?.length ? 'err' : 'ok',
              text: `${parts.length === 0 ? t('noChange') : parts.join(' / ')}${result.warnings?.length ? ` — ${result.warnings.join('; ')}` : ''}`,
            })
            await load()
          } catch (error) {
            setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy(undefined)
          }
        }

        async function runErase() {
          if (provider === '' || model === '') return
          setBusy('erase')
          setNotice(undefined)
          try {
            const result = await request(ERASE_URL, {
              provider,
              model,
              eraseImage: true,
              restoreDefault: restoreDefault && restoreTo !== undefined,
              defaultTo: restoreDefault ? restoreTo : undefined,
            })
            const parts = []
            if (result.imageErased) parts.push(t('imageErased'))
            if (result.defaultRestored) parts.push(t('defaultRestored'))
            setNotice({
              kind: result.warnings?.length ? 'err' : 'ok',
              text: `${parts.length === 0 ? t('noChange') : parts.join(' / ')}${result.warnings?.length ? ` — ${result.warnings.join('; ')}` : ''}`,
            })
            await load()
          } catch (error) {
            setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy(undefined)
          }
        }

        async function runRevert(id) {
          setBusy(`revert:${id ?? ''}`)
          setNotice(undefined)
          try {
            const result = await request(REVERT_URL, id === undefined ? {} : { id })
            setNotice({ kind: 'ok', text: t('reverted')(result.action) })
            await load()
          } catch (error) {
            setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy(undefined)
          }
        }

        if (state === undefined) return h('p', { className: 'msp-msg' }, t('loading'))
        if (state.error !== undefined) return h('p', { className: 'msp-msg err' }, state.error)

        const disabled = busy !== undefined
        const canAct = !disabled && provider !== '' && model !== ''

        return h('div', { className: 'msp-root' },
          h('style', null, CSS),
          h('div', { className: 'msp-head' },
            h('span', { className: 'msp-title' }, t('title')),
            h('span', { className: 'msp-sub' }, t('routeCount')(routes.length)),
          ),
          h('p', { className: 'msp-intro' }, t('intro')),

          state.editable === false
            ? h('p', { className: 'msp-msg err' }, state.editableReason ?? t('notWritable'))
            : null,

          h('div', { className: 'msp-grid' },
            h('div', { className: 'msp-row' },
              h('span', { className: 'msp-label' }, t('provider')),
              h('select', {
                className: 'msp-select',
                value: provider,
                disabled,
                onChange: (event) => { setProvider(event.target.value); setModel('') },
              }, routes.map((entry) => h('option', { key: entry.provider, value: entry.provider },
                `${entry.displayName}${entry.writable === false ? ` (${t('readonly')})` : ''}`))),
              route?.error ? h('span', { className: 'msp-tag' }, t('modelsFailed')) : null,
            ),
            h('div', { className: 'msp-row' },
              h('span', { className: 'msp-label' }, t('model')),
              h('select', {
                className: 'msp-select',
                value: model,
                disabled: disabled || models.length === 0,
                onChange: (event) => setModel(event.target.value),
              }, models.length === 0
                ? h('option', { value: '' }, t('noModels'))
                : models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id))),
              chosen?.declaredImage
                ? h('span', { className: 'msp-tag on' }, t('declared'))
                : h('span', { className: 'msp-tag' }, t('notDeclared')),
              chosen?.lastProbe
                ? h('span', {
                    className: `msp-tag${chosen.lastProbe.ok ? ' on' : ' off'}`,
                  }, t('lastProbe')(t('verdictLabel')(chosen.lastProbe.verdict)))
                : null,
            ),
            route?.error ? h('p', { className: 'msp-msg err' }, route.error) : null,
          ),

          h('div', { className: 'msp-row' },
            h('label', { className: 'msp-check', 'aria-disabled': disabled ? 'true' : 'false' },
              h('input', {
                type: 'checkbox',
                checked: setDefault,
                disabled,
                onChange: () => setSetDefault((value) => !value),
              }),
              t('setDefault')),
            h('label', { className: 'msp-check', 'aria-disabled': disabled ? 'true' : 'false' },
              h('input', {
                type: 'checkbox',
                checked: declareImage,
                disabled,
                onChange: () => setDeclareImage((value) => !value),
              }),
              t('declareImage')),
          ),

          h('div', { className: 'msp-row' },
            h('span', { className: 'msp-label' }, t('attemptsLabel')),
            h('select', {
              className: 'msp-select',
              style: { minWidth: 0, width: 96 },
              value: attempts,
              disabled,
              onChange: (event) => setAttempts(Number(event.target.value)),
            }, [1, 2, 3].map((count) => h('option', { key: count, value: count }, t('attemptsOption')(count)))),
          ),

          h('div', { className: 'msp-row' },
            h('button', {
              type: 'button',
              className: 'msp-btn',
              disabled: !canAct,
              onClick: () => { void runProbe() },
            }, busy === 'probe' ? t('probing') : t('probe')),
            h('button', {
              type: 'button',
              className: 'msp-btn primary',
              disabled: !canAct,
              onClick: () => { void runApply() },
            }, busy === 'apply' ? t('applying') : t('apply')),
          ),

          probe === undefined ? null : h('div', { className: 'msp-probe' },
            h('div', { className: 'msp-inline' },
              h('span', { className: `msp-tag${probe.ok ? ' on' : ' off'}` }, t('verdictLabel')(probe.verdict)),
              probe.confidence ? h('span', { className: 'msp-sub' }, t('confidenceLabel')(probe.confidence)) : null,
              probe.api ? h('span', { className: 'msp-sub' }, `${t('protocolLabel')} ${probe.api}`) : null,
              probe.elapsedMs !== undefined ? h('span', { className: 'msp-sub' }, `${probe.elapsedMs} ms`) : null,
            ),
            h('p', { className: `msp-msg ${probe.ok ? 'ok' : 'err'}` }, probe.detail ?? probe.verdict),
            probe.answer === undefined ? null : h('p', { className: 'msp-msg' },
              h('strong', null, `${t('answerLabel')}：`), probe.answer),
            probe.hint ? h('p', { className: 'msp-msg' }, h('strong', null, `${t('hintLabel')}：`), probe.hint) : null,
            (probe.warnings ?? []).length === 0
              ? null
              : h('p', { className: 'msp-msg err' }, probe.warnings.join('；')),
            (probe.samples ?? []).length < 2 ? null : h('div', { className: 'msp-inline' },
              h('span', { className: 'msp-sub' }, t('samplesTitle')(probe.samples.length)),
            ),
            (probe.samples ?? []).length < 2 ? null : h('ul', { className: 'msp-samples' },
              probe.samples.map((sample) => h('li', { key: `sample-${sample.index}`, className: 'msp-sample' },
                h('span', { className: 'msp-tag' }, `#${sample.index}`),
                h('span', {
                  className: `msp-tag${sample.outcome !== 'answered' ? ' off' : sample.digitHits ? ' on' : ''}`,
                }, sample.outcome !== 'answered'
                  ? t('sampleFailed')
                  : sample.digitHits ? t('sampleOk') : t('sampleMiss')),
                h('span', { className: 'msp-sample-answer' },
                  sample.answer ?? `${sample.verdict ?? ''} ${sample.detail ?? ''}`.trim()),
                h('span', { className: 'msp-history-at' }, `${sample.elapsedMs ?? '-'} ms`),
              )),
            ),
          ),

          notice === undefined ? null : h('p', { className: `msp-msg ${notice.kind === 'ok' ? 'ok' : 'err'}` }, notice.text),

          h('div', { className: 'msp-section' },
            h('span', { className: 'msp-title' }, t('eraseTitle')),
            h('p', { className: 'msp-intro' }, t('eraseIntro')),
            h('div', { className: 'msp-row' },
              h('label', { className: 'msp-check', 'aria-disabled': (disabled || restoreTo === undefined) ? 'true' : 'false' },
                h('input', {
                  type: 'checkbox',
                  checked: restoreDefault && restoreTo !== undefined,
                  disabled: disabled || restoreTo === undefined,
                  onChange: () => setRestoreDefault((value) => !value),
                }),
                restoreTo === undefined
                  ? t('restoreUnavailable')
                  : t('restoreDefaultTo')(restoreTo.provider, restoreTo.model)),
            ),
            h('div', { className: 'msp-row' },
              h('button', {
                type: 'button',
                className: 'msp-btn danger',
                disabled: !canAct,
                onClick: () => { void runErase() },
              }, busy === 'erase' ? t('erasing') : t('erase')),
            ),
          ),

          h('div', { className: 'msp-section' },
            h('div', { className: 'msp-row' },
              h('span', { className: 'msp-title' }, t('historyTitle')),
              h('button', {
                type: 'button',
                className: 'msp-btn',
                disabled: disabled || (state.history ?? []).every((entry) => entry.undone),
                onClick: () => { void runRevert(undefined) },
              }, busy === 'revert:' ? t('reverting') : t('revertLast')),
            ),
            (state.history ?? []).length === 0
              ? h('p', { className: 'msp-msg' }, t('historyEmpty'))
              : h('ul', { className: 'msp-history' }, (state.history ?? []).map((entry) => h('li', {
                  key: entry.id,
                  className: `msp-history-item${entry.undone ? ' undone' : ''}`,
                },
                h('span', { className: 'msp-history-action' }, t('actionLabel')(entry.action)),
                h('span', { className: 'msp-history-target' }, `${entry.provider}/${entry.model}`),
                h('span', { className: 'msp-history-at' }, entry.at.replace('T', ' ').slice(0, 19)),
                entry.undone
                  ? h('span', { className: 'msp-tag' }, t('undone'))
                  : h('button', {
                      type: 'button',
                      className: 'msp-btn small',
                      disabled,
                      onClick: () => { void runRevert(entry.id) },
                    }, busy === `revert:${entry.id}` ? t('reverting') : t('revert')),
              ))),
          ),

          state.selection
            ? h('p', { className: 'msp-sub' }, t('currentDefault')(state.selection.provider, state.selection.model))
            : null,
          state.documentPath
            ? h('p', { className: 'msp-sub' }, t('writePath')(state.documentPath))
            : null,
        )
      }
      return Picker
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-vision-picker: dictionaries')
        const t = ctx.locale.bind(NS)
        const Picker = makePicker(t)

        // One whole Settings page, placed directly below the plugin market
        // (`dshmarket` registers `order: 40`).
        function SectionPage() {
          return h('div', { className: 'msp-page' },
            h('style', null, CSS),
            h(Picker, null),
          )
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-vision-picker',
          order: 50,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, SectionPage))
      },
    }
  },
})
