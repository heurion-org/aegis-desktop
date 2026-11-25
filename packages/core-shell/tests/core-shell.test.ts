import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AegisDaemonClient,
  MIN_RECOMMENDED_DAEMON_VERSION,
  applySyncModeFilter,
  isSemverAtLeast,
  type DesktopAgentStatus,
  type DesktopTaskRecord,
  type WorkspaceTreeEntry,
} from '../src/daemon-client.ts'
import {
  DEFAULT_FREE_ENTITLEMENTS,
  decodeEntitlementJwtPayload,
  isEntitlementClaimsFresh,
  resolveFormatAccess,
  type DesktopEntitlements,
} from '../src/entitlements.ts'
import { selectAgentForRole } from '../src/roles.ts'
import { filterTreeEntries, upsertSyncRule } from '../src/components/workspace-tree.ts'
import {
  buildTaskPromptWithRefs,
  extractTaskPrimaryOutput,
  parseTaskPromptDisplay,
} from '../src/components/task-stream.ts'
import { brandMarkSvg, iconHtml } from '../src/icons.ts'
import { renderChatMarkdownHtml } from '../src/markdown.ts'
import { WIZARD_STEPS, shouldShowOnboardingWizard } from '../src/components/onboarding-wizard.ts'

test('Free tier permits local .md and coding files while gating rich CRDT formats to Cloud Pro', () => {
  const md = resolveFormatAccess('notes/architecture.md', DEFAULT_FREE_ENTITLEMENTS)
  assert.equal(md.allowed, true)
  assert.equal(md.mode, 'local_markdown')
  assert.equal(md.requires_upgrade, false)

  const rs = resolveFormatAccess('src/main.rs', DEFAULT_FREE_ENTITLEMENTS)
  assert.equal(rs.allowed, true)
  assert.equal(rs.mode, 'local_code')

  for (const rich of ['paper.docx', 'deck.pptx', 'spec.pdf', 'manuscript.tex']) {
    const locked = resolveFormatAccess(rich, DEFAULT_FREE_ENTITLEMENTS)
    assert.equal(locked.allowed, false, `${rich} must be gated for free tier`)
    assert.equal(locked.mode, 'locked_cloud_pro')
    assert.equal(locked.requires_upgrade, true)
  }

  const proEntitlements: DesktopEntitlements = {
    tier: 'pro',
    local_md_only: false,
    dual_surface_crdt: true,
    rich_formats: ['md', 'docx', 'pptx', 'pdf', 'tex'],
    cloud_yjs_sync: true,
    max_workspaces: 25,
  }
  const proDeck = resolveFormatAccess('deck.pptx', proEntitlements)
  assert.equal(proDeck.allowed, true)
  assert.equal(proDeck.mode, 'cloud_dual_surface')
})

test('applySyncModeFilter forces local_only when cloud_yjs_sync is disabled', () => {
  const entries: WorkspaceTreeEntry[] = [
    { path: 'README.md', name: 'README.md', is_dir: false, ext: 'md', sync_mode: 'cloud_crdt', tier_required: 'free' },
    { path: 'deck.pptx', name: 'deck.pptx', is_dir: false, ext: 'pptx', sync_mode: 'cloud_crdt', tier_required: 'cloud_pro' },
  ]
  const filtered = applySyncModeFilter(entries, DEFAULT_FREE_ENTITLEMENTS)
  assert.deepEqual(
    filtered.map(e => e.sync_mode),
    ['local_only', 'local_only'],
  )
})

test('decodeEntitlementJwtPayload parses valid claims and rejects expired or malformed tokens', () => {
  const payload = Buffer.from(
    JSON.stringify({
      sub_tenant: 'tenant-1',
      tier: 'pro',
      exp: 2_000_000_000,
      entitlements: {
        tier: 'pro',
        local_md_only: false,
        dual_surface_crdt: true,
        rich_formats: ['md', 'docx', 'pptx', 'pdf', 'tex'],
        cloud_yjs_sync: true,
        max_workspaces: 25,
      },
    }),
  ).toString('base64url')
  const claims = decodeEntitlementJwtPayload(`hdr.${payload}.sig`)
  assert.equal(claims?.tier, 'pro')
  assert.equal(isEntitlementClaimsFresh(claims, 1_900_000_000), true)
  assert.equal(isEntitlementClaimsFresh(claims, 2_100_000_000), false)
  assert.equal(decodeEntitlementJwtPayload('bad-token'), null)
})

test('selectAgentForRole routes flat DesktopAgentStatus (writer -> claude, coder -> opencode)', () => {
  const mkAgent = (id: string, installed: boolean, authenticated: boolean): DesktopAgentStatus => ({
    id,
    display_name: id,
    description: `${id} agent`,
    roles: ['coder', 'writer'],
    installed,
    binary_path: installed ? `/usr/bin/${id}` : null,
    version: installed ? '1.0.0' : null,
    authenticated,
    auth_hint: authenticated ? '已就绪' : '点击授权登录',
    install_command_for_os: ['npm', 'install', '-g', id],
    install_recipe: {
      macos: ['npm', 'install', '-g', id],
      linux: ['npm', 'install', '-g', id],
      docs_url: 'https://example.com',
      notes: '',
    },
  })
  const agents = [mkAgent('opencode', true, true), mkAgent('claude', true, true), mkAgent('agy', false, false)]
  assert.equal(selectAgentForRole('coder', agents).selectedAgentId, 'opencode')
  assert.equal(selectAgentForRole('writer', agents).selectedAgentId, 'claude')
  assert.equal(selectAgentForRole('writer', agents, 'agy').ready, false)

  const withCodex = [mkAgent('codex', true, true), mkAgent('agy', true, false)]
  assert.equal(selectAgentForRole('reviewer', withCodex).selectedAgentId, 'codex')
  assert.equal(selectAgentForRole('coder', withCodex, 'codex').ready, true)
})

test('AegisDaemonClient matches Rust wire shapes for agents, sync-policy, 3-layer workspaces, git ops, tasks, and approvals', async () => {
  const calls: Array<{ url: string; auth: string | null; method: string; body?: string }> = []
  const client = new AegisDaemonClient(
    { protocol: 'aos-desktop/v1', port: 43123, base_url: 'http://127.0.0.1:43123', human_token: 'aht_secret' },
    async (input, init) => {
      const headers = new Headers(init?.headers)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push({ url: input, auth: headers.get('Authorization'), method, body })

      if (input.endsWith('/v1/health')) {
        return new Response(JSON.stringify({ status: 'ok', protocol: 'aos-desktop/v1', version: '0.12.0', runtime_dir: '/tmp' }))
      }
      if (input.endsWith('/v1/agents')) {
        return new Response(
          JSON.stringify({
            agents: [
              {
                id: 'claude',
                display_name: 'Claude Code',
                description: 'Writer agent',
                roles: ['writer', 'coder'],
                installed: true,
                binary_path: '/usr/local/bin/claude',
                version: '1.2.3',
                authenticated: true,
                auth_hint: '已就绪',
                install_command_for_os: [],
                install_recipe: { macos: [], linux: [], docs_url: 'https://docs.anthropic.com', notes: '' },
              },
            ],
          }),
        )
      }
      if (input.endsWith('/sync-policy')) {
        return new Response(
          JSON.stringify({
            workspace_id: 'ws_123',
            sync_policy: {
              default_mode: 'cloud_crdt',
              rules: [{ path_prefix: 'raw_data', mode: 'local_only' }],
            },
          }),
        )
      }
      if (input.endsWith('/v1/workspaces')) {
        return new Response(
          JSON.stringify({
            workspace: {
              id: 'ws_123',
              name: 'aegisdesktop',
              org_id: 'personal',
              path: '/tmp/ws',
              mode: 'local',
              is_git_repo: false,
              child_repos: [{ name: 'aegis-os', rel_path: 'aegis-os', path: '/tmp/ws/aegis-os', branch: 'main' }],
              sync_policy: { default_mode: 'local_only', rules: [] },
            },
          }),
        )
      }
      if (input.includes('/tree?') || input.endsWith('/diff?repo=aegis-os')) {
        return new Response(
          JSON.stringify(
            input.includes('/tree')
              ? { workspace_id: 'ws_123', repo: 'aegis-os', sync_policy: { default_mode: 'local_only', rules: [] }, entries: [] }
              : { repo: 'aegis-os', is_git_repo: true, changed_files: ['M README.md'], diff_text: '+line' },
          ),
        )
      }
      if (input.endsWith('/commit')) {
        return new Response(JSON.stringify({ ok: true, committed: true, repo: 'aegis-os', commit_hash: 'abc1234', summary: 'ok' }))
      }
      if (input.endsWith('/rollback')) {
        return new Response(JSON.stringify({ ok: true, repo: 'aegis-os', restored_paths: ['README.md'] }))
      }
      if (input.endsWith('/tasks')) {
        return new Response(
          JSON.stringify({
            task: {
              task_id: 'tsk_1',
              workspace_id: 'ws_123',
              role: 'writer',
              resolved_agent: 'claude',
              prompt: 'Summarize',
              status: 'queued',
              steps: [{ seq: 1, kind: 'started', summary: 'Assigned', detail: null, raw_log: null, timestamp: '2026-11-24T00:00:00Z' }],
              created_at: '2026-11-24T00:00:00Z',
            },
          }),
        )
      }
      if (input.endsWith('/decide')) {
        return new Response(JSON.stringify({ ok: true, decision: 'approved', lease: { lease_id: 'lease-1' } }))
      }
      return new Response('{}')
    },
  )

  const h = await client.health()
  assert.equal(h.protocol, 'aos-desktop/v1')

  const agents = await client.listAgents()
  assert.equal(agents[0]?.id, 'claude')
  assert.equal(agents[0]?.display_name, 'Claude Code')

  const ws = await client.openWorkspace({ path: '/tmp/ws' })
  assert.equal(ws.org_id, 'personal')
  assert.equal(ws.child_repos?.[0]?.rel_path, 'aegis-os')

  const policy = await client.updateSyncPolicy('ws_123', {
    default_mode: 'cloud_crdt',
    rules: [{ path_prefix: 'raw_data', mode: 'local_only' }],
  })
  assert.equal(policy.default_mode, 'cloud_crdt')
  assert.equal(policy.rules[0]?.path_prefix, 'raw_data')

  const diff = await client.workspaceDiff('ws_123', 'aegis-os')
  assert.equal(diff.repo, 'aegis-os')

  const committed = await client.commitWorkspace('ws_123', { repo: 'aegis-os', message: 'msg' })
  assert.equal(committed.committed, true)

  const rolledBack = await client.rollbackWorkspace('ws_123', { repo: 'aegis-os' })
  assert.deepEqual(rolledBack.restored_paths, ['README.md'])

  const task = await client.startTask('ws_123', { role: 'writer', repo: 'aegis-os', prompt: 'Summarize' })
  assert.equal(task.task_id, 'tsk_1')
  assert.equal(task.resolved_agent, 'claude')
  assert.equal(task.steps[0]?.summary, 'Assigned')

  const decided = await client.decideApproval('esc-1', 'approve', 900)
  assert.equal(decided.decision, 'approved')
  assert.ok(calls.every(c => c.auth === 'Bearer aht_secret'))
})

test('upsertSyncRule adds, overrides, normalizes slashes, and removes default-matching rules', () => {
  const base = { default_mode: 'cloud_crdt' as const, rules: [] }
  const added = upsertSyncRule(base, '/raw_data/**', 'local_only')
  assert.deepEqual(added.rules, [{ path_prefix: 'raw_data', mode: 'local_only' }])

  const overridden = upsertSyncRule(added, './raw_data/', 'cloud_blob')
  assert.deepEqual(overridden.rules, [{ path_prefix: 'raw_data', mode: 'cloud_blob' }])

  const removed = upsertSyncRule(overridden, 'raw_data', 'cloud_crdt')
  assert.deepEqual(removed.rules, [])
})

test('filterTreeEntries keeps matching files and their ancestor directories', () => {
  const entries: WorkspaceTreeEntry[] = [
    { path: 'docs', name: 'docs', is_dir: true, ext: null, sync_mode: 'cloud_crdt', tier_required: 'free' },
    { path: 'docs/specs', name: 'specs', is_dir: true, ext: null, sync_mode: 'cloud_crdt', tier_required: 'free' },
    { path: 'docs/specs/v1.md', name: 'v1.md', is_dir: false, ext: 'md', sync_mode: 'cloud_crdt', tier_required: 'free' },
    { path: 'src', name: 'src', is_dir: true, ext: null, sync_mode: 'local_only', tier_required: 'free' },
    { path: 'src/main.rs', name: 'main.rs', is_dir: false, ext: 'rs', sync_mode: 'local_only', tier_required: 'free' },
  ]
  const filtered = filterTreeEntries(entries, 'V1.MD')
  assert.deepEqual(
    filtered.map(e => e.path),
    ['docs', 'docs/specs', 'docs/specs/v1.md'],
  )
})

test('vector SVG icon helpers and onboarding wizard trigger work cleanly without emojis', () => {
  for (const name of ['shield', 'copy', 'gitBranch', 'trash', 'play'] as const) {
    assert.match(iconHtml(name), /^<svg class="aos-icon" viewBox="0 0 20 20"/)
  }
  const mark = brandMarkSvg('aos-boot-mark')
  assert.match(mark, /class="aos-brand-mark aos-boot-mark"/)

  assert.equal(WIZARD_STEPS.length, 2)
  assert.equal(shouldShowOnboardingWizard({ completedBefore: false, workspaceCount: 2 }), true)
  assert.equal(shouldShowOnboardingWizard({ completedBefore: true, workspaceCount: 0 }), true)
  assert.equal(shouldShowOnboardingWizard({ completedBefore: true, workspaceCount: 1 }), false)
  assert.equal(shouldShowOnboardingWizard({ completedBefore: true, workspaceCount: 1, forceOpen: true }), true)
})

test('isSemverAtLeast enforces minimum daemon version cleanly', () => {
  assert.equal(isSemverAtLeast('0.12.1', MIN_RECOMMENDED_DAEMON_VERSION), true)
  assert.equal(isSemverAtLeast('0.12.10', MIN_RECOMMENDED_DAEMON_VERSION), true)
  assert.equal(isSemverAtLeast('0.13.0', MIN_RECOMMENDED_DAEMON_VERSION), true)
  assert.equal(isSemverAtLeast('1.0.0', MIN_RECOMMENDED_DAEMON_VERSION), true)
  assert.equal(isSemverAtLeast('0.12.0', MIN_RECOMMENDED_DAEMON_VERSION), false)
  assert.equal(isSemverAtLeast('', MIN_RECOMMENDED_DAEMON_VERSION), false)
  assert.equal(isSemverAtLeast(null, MIN_RECOMMENDED_DAEMON_VERSION), false)
})

test('renderChatMarkdownHtml renders lists, tables, fences, and neutralizes HTML injection', () => {
  const html = renderChatMarkdownHtml(
    '## Report\n\n- item **bold** and `x*y`\n1. first\n\n```sh\necho "<script>"\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<img src=x onerror=alert(1)>',
  )
  assert.match(html, /<h2>Report<\/h2>/)
  assert.match(html, /<ul>\n<li>item <strong>bold<\/strong> and <code>x\*y<\/code><\/li>\n<\/ul>/)
  assert.match(html, /<ol>\n<li>first<\/li>\n<\/ol>/)
  assert.match(html, /<pre><code>echo &quot;&lt;script&gt;&quot;<\/code><\/pre>/)
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody>/)
  assert.doesNotMatch(html, /<img /)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('task prompt context attachment and primary output extraction work cleanly', () => {
  assert.equal(buildTaskPromptWithRefs('Summarize', []), 'Summarize')
  const withRefs = buildTaskPromptWithRefs('Summarize', ['README.md', '@data/metrics.csv'])
  assert.equal(withRefs, '[Workspace context files: @README.md, @data/metrics.csv]\n\nSummarize')

  const parsed = parseTaskPromptDisplay(withRefs)
  assert.deepEqual(parsed.refs, ['@README.md', '@data/metrics.csv'])
  assert.equal(parsed.body, 'Summarize')

  const completedTask: DesktopTaskRecord = {
    task_id: 'tsk_1',
    workspace_id: 'ws_1',
    role: 'coder',
    resolved_agent: 'claude',
    prompt: withRefs,
    status: 'completed',
    created_at: '2026-11-25T00:00:00Z',
    steps: [
      { seq: 1, kind: 'started', summary: 'Started', detail: null, raw_log: null, timestamp: 't1' },
      { seq: 2, kind: 'completed', summary: 'Done', detail: 'Fallback detail', raw_log: '## Answer\n\nAll good.', timestamp: 't2' },
    ],
  }
  const out1 = extractTaskPrimaryOutput(completedTask)
  assert.equal(out1.text, '## Answer\n\nAll good.')
  assert.equal(out1.isError, false)

  const failedHintTask: DesktopTaskRecord = {
    ...completedTask,
    status: 'failed',
    steps: [
      { seq: 1, kind: 'failed', summary: 'Agent missing', detail: 'Install claude first', raw_log: null, timestamp: 't1' },
    ],
  }
  const out2 = extractTaskPrimaryOutput(failedHintTask)
  assert.equal(out2.text, 'Install claude first')
  assert.equal(out2.isError, true)

  const streamingTask: DesktopTaskRecord = {
    ...completedTask,
    status: 'running',
    enforcement: 'enforced',
    session_id: 'ses_live123',
    steps: [
      { seq: 1, kind: 'started', summary: 'Started', detail: null, raw_log: null, timestamp: 't1' },
      { seq: 2, kind: 'session_started', summary: 'CoW (ses_live123)', detail: null, raw_log: null, timestamp: 't2' },
      { seq: 3, kind: 'output', summary: 'First chunk', detail: null, raw_log: 'Line 1', timestamp: 't3' },
      { seq: 4, kind: 'output', summary: 'Second chunk', detail: null, raw_log: 'Line 2', timestamp: 't4' },
    ],
  }
  const outLive = extractTaskPrimaryOutput(streamingTask)
  assert.equal(outLive.streamingText, 'Line 1\nLine 2')
  assert.equal(outLive.text, '')

  const completedStreamTask: DesktopTaskRecord = {
    ...streamingTask,
    status: 'completed',
    steps: [
      ...streamingTask.steps,
      { seq: 5, kind: 'completed', summary: 'Done', detail: 'Line 1', raw_log: null, timestamp: 't5' },
    ],
  }
  const outMerged = extractTaskPrimaryOutput(completedStreamTask)
  assert.equal(outMerged.text, 'Line 1\nLine 2')
})

test('AegisDaemonClient sends CoW session_id and expected_diff_hash on commit and rollback', async () => {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
  const client = new AegisDaemonClient(
    { protocol: 'aos-desktop/v1', port: 43123, base_url: 'http://127.0.0.1:43123', human_token: 'aht_tok' },
    async (input, init) => {
      bodies.push({
        url: input,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      if (input.endsWith('/commit')) {
        return new Response(JSON.stringify({ ok: true, committed: true, source: 'cow_shadow', session_id: 'ses_123', summary: 'Landed' }))
      }
      return new Response(JSON.stringify({ ok: true, source: 'cow_shadow', session_id: 'ses_123', restored_paths: ['a.md'] }))
    },
  )

  const commitRes = await client.commitWorkspace('ws_1', {
    session_id: 'ses_123',
    expected_diff_hash: 'sha256:abcd',
  })
  assert.equal(commitRes.source, 'cow_shadow')
  assert.equal(bodies[0]?.body.session_id, 'ses_123')
  assert.equal(bodies[0]?.body.expected_diff_hash, 'sha256:abcd')

  const rbRes = await client.rollbackWorkspace('ws_1', { session_id: 'ses_123' })
  assert.equal(rbRes.session_id, 'ses_123')
  assert.equal(bodies[1]?.body.session_id, 'ses_123')
})


