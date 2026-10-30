#!/usr/bin/env node
/**
 * 书童 AI 转发站
 *
 * serve 模式：对书童伪装成 OpenAI 兼容 API。每个请求变成一条任务，按地址里的平台名
 *   （/claude/v1、/gemini/v1、/codex/v1 …）分通道排队，写进收件目录，等外部 AI 交回结果后
 *   再作为 API 响应返回给书童。
 * mcp 模式：stdio MCP 服务器，供 Claude 桌面端、Codex、Gemini CLI 取任务、交结果。
 * 自动模式：relay.config.json 里把某个通道设成 cli，转发站会直接调用对应的命令行工具
 *   （claude -p、codex exec、gemini -p）处理任务，失败时退回人工队列。
 *
 * 只依赖 Node 22 自带模块。
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const PORT = Number(process.env.AI_RELAY_PORT || 8787)
const HOST = '127.0.0.1'
const INBOX = process.env.AI_RELAY_DIR || join(homedir(), 'ai-relay-inbox')
const KEEPALIVE_MS = 15_000
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const CONFIG_PATH = process.env.AI_RELAY_CONFIG || join(dirname(fileURLToPath(import.meta.url)), 'relay.config.json')
const MAX_WAIT_SECONDS = 110

// ===== serve 模式 =====

/** @type {Map<string, Task>} */
const tasks = new Map()

/**
 * state：pending 等人工或 MCP 处理；auto 正由命令行工具处理，不对外发放。
 * @typedef {{ id: string, platform: string, model: string, createdAt: number, claimedAt?: number,
 *   json: boolean, messages: Array<{role: string, content: string}>, prompt: string,
 *   state: 'pending' | 'auto', child?: import('node:child_process').ChildProcess,
 *   finish: (content: string) => void, cancel: () => void }} Task
 */

/**
 * 每次新任务都重新读配置，改了配置不用重启转发站。
 * @returns {{ mode?: 'manual' | 'cli', command?: string, args?: string[], timeoutMinutes?: number } | null}
 */
function channelConfig(platform) {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).channels?.[platform] ?? null
  } catch (error) {
    log(`! 配置文件 ${CONFIG_PATH} 读取失败：${error.message}`)
    return null
  }
}

function renderPrompt(id, platform, body, json) {
  const lines = [
    `<!-- 书童转发任务 ${id} · 通道 ${platform} · 模型 ${body.model ?? ''} -->`,
    '',
    '# 书童写作任务',
    '',
    '下面是书童软件发出的一次生成请求，按 system / user 等角色分段。',
    '请扮演其中 system 段描述的角色，直接写出这一步要求的输出。',
    '不要解释你在做什么，不要加前言或结尾寒暄，不要修改任何文件。',
    json
      ? '这一步要求结构化输出：只输出一个合法的 JSON 对象，不要用代码块包裹。'
      : '按 user 段要求的格式输出；没有特别要求时只输出正文本身。',
    '',
  ]
  for (const message of body.messages) {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => part?.text ?? '').join('')
        : ''
    lines.push(`## ${message.role}`, '', content, '')
  }
  return lines.join('\n')
}

function stripFence(text) {
  const match = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text)
  return match ? match[1] : text.trim()
}

function summary(task) {
  const user = [...task.messages].reverse().find(m => m.role === 'user')
  const text = typeof user?.content === 'string' ? user.content : ''
  return {
    id: task.id,
    platform: task.platform,
    model: task.model,
    json: task.json,
    claimed: Boolean(task.claimedAt),
    state: task.state,
    createdAt: new Date(task.createdAt).toISOString(),
    chars: task.prompt.length,
    preview: text.replace(/\s+/g, ' ').slice(0, 120),
  }
}

function listTasks(platform) {
  return [...tasks.values()]
    .filter(t => !platform || t.platform === platform)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 可以交给人工或 MCP 的任务：未领取的排在前面，已领取但迟迟没交回的放后面兜底。 */
function nextPending(platform) {
  const open = listTasks(platform).filter(t => t.state === 'pending')
  return open.find(t => !t.claimedAt) ?? open[0] ?? null
}

async function archive(task, status, answer) {
  const dir = join(INBOX, task.platform)
  const doneDir = join(INBOX, '_done')
  await mkdir(doneDir, { recursive: true })
  for (const suffix of ['.prompt.md', '.answer.md', '.cli-error.txt']) {
    const from = join(dir, task.id + suffix)
    if (existsSync(from)) await rename(from, join(doneDir, `${task.id}.${status}${suffix}`)).catch(() => {})
  }
  if (answer !== undefined && !existsSync(join(doneDir, `${task.id}.${status}.answer.md`))) {
    await writeFile(join(doneDir, `${task.id}.${status}.answer.md`), answer).catch(() => {})
  }
}

function resolveTask(id, content) {
  const task = tasks.get(id)
  if (!task) return false
  tasks.delete(id)
  const cleaned = task.json ? stripFence(content) : content.trim()
  task.finish(cleaned)
  archive(task, 'done', cleaned)
  log(`✓ ${task.platform} ${id} 已交回（${cleaned.length} 字）`)
  return true
}

function log(message) {
  process.stderr.write(`[${new Date().toLocaleTimeString()}] ${message}\n`)
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
/** 每个通道的命令行任务排队串行执行，避免同时开一堆进程。 */
const cliQueues = new Map()

function enqueueCli(task, config) {
  const previous = cliQueues.get(task.platform) ?? Promise.resolve()
  const next = previous.then(() => runCli(task, config)).catch(error => log(`! ${error?.stack ?? error}`))
  cliQueues.set(task.platform, next)
}

async function runCli(task, config) {
  if (!tasks.has(task.id)) return
  const workDir = join(INBOX, '_work', task.id)
  await mkdir(workDir, { recursive: true })
  const outputFile = join(workDir, 'output.md')
  const rawArgs = config.args ?? []
  const promptInArgs = rawArgs.some(arg => arg.includes('{prompt}'))
  const args = rawArgs.map(arg => arg.replaceAll('{prompt}', task.prompt).replaceAll('{output}', outputFile))
  const timeoutMs = (config.timeoutMinutes ?? 20) * 60_000
  log(`⚙ ${task.platform} ${task.id} 交给命令行 ${config.command} 自动处理`)

  const result = await new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(config.command, args, { cwd: workDir, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      return resolve({ ok: false, reason: error.message })
    }
    task.child = child
    const timer = setTimeout(() => { child.kill('SIGTERM'); stderr += `\n超过 ${config.timeoutMinutes ?? 20} 分钟未完成，已终止。` }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, reason: error.code === 'ENOENT' ? `找不到命令 ${config.command}，请确认已安装并在 PATH 里。` : error.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true, stdout } : { ok: false, reason: `退出码 ${code}\n${stderr.slice(-4000)}` })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(promptInArgs ? '' : task.prompt)
  })
  task.child = undefined

  let content = result.ok ? result.stdout : ''
  if (result.ok && existsSync(outputFile)) content = await readFile(outputFile, 'utf8').catch(() => content)
  content = content.replace(ANSI_RE, '').trim()
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
  if (!tasks.has(task.id)) return

  if (content) {
    resolveTask(task.id, content)
    return
  }
  const reason = result.ok ? '命令行没有输出任何内容。' : result.reason
  task.state = 'pending'
  await writeFile(join(INBOX, task.platform, `${task.id}.cli-error.txt`), reason).catch(() => {})
  log(`! ${task.platform} ${task.id} 命令行处理失败，已退回人工队列：${reason.split('\n')[0]}`)
}

async function handleCompletion(req, res, platform) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body' } })
  }
  if (!Array.isArray(body.messages)) return sendJson(res, 400, { error: { message: 'messages required' } })

  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 6)}`
  const json = body.response_format?.type === 'json_object'
  const prompt = renderPrompt(id, platform, body, json)
  const stream = body.stream === true
  const model = String(body.model ?? platform)
  const created = Math.floor(Date.now() / 1000)
  let done = false

  // 先把响应头发出去并定期发保活，避免书童的 HTTP 客户端在人工处理期间超时。
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': queued\n\n')
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.write(' ')
  }
  const keepalive = setInterval(() => res.write(stream ? ': waiting\n\n' : ' '), KEEPALIVE_MS)

  const finish = content => {
    if (done) return
    done = true
    clearInterval(keepalive)
    const base = { id: `chatcmpl-${id}`, created, model }
    if (stream) {
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
    }
  }
  const cancel = () => {
    if (done) return
    done = true
    clearInterval(keepalive)
    res.end()
  }

  const config = channelConfig(platform)
  const auto = config?.mode === 'cli' && typeof config.command === 'string' && config.command.length > 0
  const task = { id, platform, model, createdAt: Date.now(), json, messages: body.messages, prompt, state: auto ? 'auto' : 'pending', finish, cancel }
  tasks.set(id, task)
  await mkdir(join(INBOX, platform), { recursive: true })
  await writeFile(join(INBOX, platform, `${id}.prompt.md`), prompt)
  log(`→ ${platform} 新任务 ${id}（${prompt.length} 字${json ? '，要求 JSON' : ''}${auto ? '，自动处理' : ''}）`)
  if (auto) enqueueCli(task, config)

  res.on('close', () => {
    if (done) return
    done = true
    clearInterval(keepalive)
    if (tasks.delete(id)) {
      task.child?.kill('SIGTERM')
      archive(task, 'cancelled')
      log(`× ${platform} ${id} 已被书童取消`)
    }
  })
}

/** 手动模式：在 <平台>/<id>.answer.md 写入结果即可交回。 */
async function scanAnswers() {
  for (const task of tasks.values()) {
    if (task.state !== 'pending') continue
    const file = join(INBOX, task.platform, `${task.id}.answer.md`)
    if (!existsSync(file)) continue
    const content = await readFile(file, 'utf8').catch(() => '')
    if (content.trim()) resolveTask(task.id, content)
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    return sendJson(res, 200, listTasks(url.searchParams.get('platform')).map(summary))
  }
  if (req.method === 'GET' && url.pathname === '/api/next') {
    const platform = url.searchParams.get('platform')
    // wait=秒数 时长轮询：期间来了任务立刻返回，供 MCP 值班模式使用。
    const waitMs = Math.min(Number(url.searchParams.get('wait')) || 0, MAX_WAIT_SECONDS) * 1000
    const deadline = Date.now() + waitMs
    let closed = false
    req.on('close', () => { closed = true })
    let task = nextPending(platform)
    while (!task && !closed && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500))
      task = nextPending(platform)
    }
    if (closed) return
    if (!task) return sendJson(res, 200, { task: null })
    task.claimedAt ??= Date.now()
    return sendJson(res, 200, { task: { ...summary(task), prompt: task.prompt } })
  }
  const taskMatch = /^\/api\/tasks\/([\w-]+)$/.exec(url.pathname)
  if (req.method === 'GET' && taskMatch) {
    const task = tasks.get(taskMatch[1])
    if (!task) return sendJson(res, 404, { error: 'TASK_NOT_FOUND' })
    return sendJson(res, 200, { task: { ...summary(task), prompt: task.prompt } })
  }
  const resultMatch = /^\/api\/tasks\/([\w-]+)\/result$/.exec(url.pathname)
  if (req.method === 'POST' && resultMatch) {
    let content = ''
    try {
      content = String(JSON.parse(await readBody(req)).content ?? '')
    } catch {
      return sendJson(res, 400, { error: 'INVALID_BODY' })
    }
    if (!content.trim()) return sendJson(res, 400, { error: 'EMPTY_CONTENT' })
    return resolveTask(resultMatch[1], content)
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { error: 'TASK_NOT_FOUND' })
  }
  return sendJson(res, 404, { error: 'NOT_FOUND' })
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(PANEL_HTML)
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)

      const parts = url.pathname.split('/').filter(Boolean)
      const platform = parts[0]
      if (!platform || !PLATFORM_RE.test(platform)) return sendJson(res, 404, { error: { message: 'unknown route' } })
      const rest = parts.slice(1).join('/')
      if (req.method === 'GET' && /^(v1\/)?models$/.test(rest)) {
        return sendJson(res, 200, { object: 'list', data: [{ id: `${platform}-relay`, object: 'model', owned_by: 'ai-relay' }] })
      }
      if (req.method === 'POST' && /^(v1\/)?chat\/completions$/.test(rest)) return await handleCompletion(req, res, platform)
      return sendJson(res, 404, { error: { message: 'unknown route' } })
    } catch (error) {
      log(`! ${error?.stack ?? error}`)
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'relay error' } })
      else res.end()
    }
  })
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      log(`端口 ${PORT} 已被别的程序占用。换个端口启动，例如：AI_RELAY_PORT=8790 node relay.mjs serve`)
      process.exit(1)
    }
    throw error
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.listen(PORT, HOST, () => {
    log(`书童转发站已启动：http://${HOST}:${PORT}/`)
    log(`收件目录：${INBOX}`)
    log(`在书童里把模型地址填成 http://${HOST}:${PORT}/<平台名>/v1，例如 /claude/v1`)
  })
  setInterval(() => { scanAnswers().catch(() => {}) }, 1000)
}

// ===== mcp 模式 =====

function mcp(platform) {
  const base = `http://${HOST}:${PORT}`
  const scope = platform ? `「${platform}」通道` : '所有通道'
  const tools = [
    {
      name: 'list_tasks',
      description: `列出书童转发站里${scope}正在等待处理的写作任务。`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_next_task',
      description: `取出${scope}最早的一条待处理任务，返回任务 id 和完整提示词。按提示词写出结果后，用 submit_result 交回。`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wait_for_task',
      description: `值班用：等待${scope}的下一条任务，最多等 timeout_seconds 秒（默认 50，最大 ${MAX_WAIT_SECONDS}）。来了任务立刻返回 id 和完整提示词；超时没有任务就返回「暂无任务」，此时可以再调用一次继续等。`,
      inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number' } } },
    },
    {
      name: 'get_task',
      description: '按 id 取回某条待处理任务的完整提示词。',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    {
      name: 'submit_result',
      description: '把某条任务的最终输出交回书童。content 只放书童要的成品（正文或 JSON），不要附加说明。',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' }, content: { type: 'string' } },
        required: ['task_id', 'content'],
      },
    },
  ]

  const call = async (name, args) => {
    const query = platform ? `?platform=${encodeURIComponent(platform)}` : ''
    if (name === 'list_tasks') {
      const list = await (await fetch(`${base}/api/tasks${query}`)).json()
      return list.length ? JSON.stringify(list, null, 2) : `${scope}当前没有待处理任务。`
    }
    if (name === 'get_next_task' || name === 'get_task' || name === 'wait_for_task') {
      const wait = name === 'wait_for_task' ? Math.min(Math.max(Number(args.timeout_seconds) || 50, 1), MAX_WAIT_SECONDS) : 0
      const nextQuery = new URLSearchParams({ ...(platform ? { platform } : {}), ...(wait ? { wait: String(wait) } : {}) }).toString()
      const url = name === 'get_task'
        ? `${base}/api/tasks/${encodeURIComponent(args.task_id ?? '')}`
        : `${base}/api/next${nextQuery ? `?${nextQuery}` : ''}`
      const data = await (await fetch(url)).json()
      if (!data.task) {
        if (name === 'get_task') return `找不到任务 ${args.task_id}，它可能已完成或被取消。`
        return name === 'wait_for_task' ? `等了 ${wait} 秒，${scope}暂无任务。` : `${scope}当前没有待处理任务。`
      }
      return `任务 id：${data.task.id}\n完成后调用 submit_result，task_id 填这个 id。\n\n${data.task.prompt}`
    }
    if (name === 'submit_result') {
      const res = await fetch(`${base}/api/tasks/${encodeURIComponent(args.task_id ?? '')}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: args.content ?? '' }),
      })
      if (res.ok) return `已交回书童（任务 ${args.task_id}）。`
      const error = (await res.json().catch(() => ({}))).error
      throw new Error(error === 'TASK_NOT_FOUND' ? '任务不存在，可能已完成或被书童取消。' : `提交失败：${error ?? res.status}`)
    }
    throw new Error(`未知工具 ${name}`)
  }

  const send = message => process.stdout.write(JSON.stringify(message) + '\n')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', async line => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const { id, method, params } = msg
    if (id === undefined || id === null) return // 通知不回复
    try {
      if (method === 'initialize') {
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'shutong-relay', version: '0.1.0' },
          instructions: `书童转发站${scope}。用户说「处理下一个任务」时：get_next_task 取任务，按提示词写出成品，再 submit_result 交回。`
            + '用户说「开始值班」时：反复执行 wait_for_task → 按提示词写出成品 → submit_result，不要停下来向用户汇报或提问；'
            + '连续 5 次等不到任务、或用户叫停时才结束，结束时用一句话说明处理了几条任务。',
        } })
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } })
      if (method === 'tools/call') {
        try {
          const text = await call(params?.name, params?.arguments ?? {})
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
        } catch (error) {
          const text = error?.cause?.code === 'ECONNREFUSED'
            ? `连不上转发站 ${base}，请先运行 node relay.mjs serve。`
            : String(error?.message ?? error)
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })
        }
      }
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    } catch (error) {
      return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } })
    }
  })
}

// ===== 网页面板 =====

const PANEL_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>书童转发站</title>
<style>
:root{--bg:#f7f8fa;--fg:#1d2433;--muted:#5b6475;--rule:#dde1e8;--accent:#2b4c8c;--box:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#14171e;--fg:#e2e6ee;--muted:#9aa3b5;--rule:#2a303c;--accent:#8fb0ec;--box:#1c212b;color-scheme:dark}}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:24px max(16px,4vw)}
h1{font-size:22px;margin:0 0 4px}p.m{color:var(--muted);margin:0 0 20px}
.task{border-top:1px solid var(--rule);padding:16px 0;display:grid;gap:8px}
.meta{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:13px;color:var(--muted)}
.chip{background:var(--accent);color:var(--bg);border-radius:4px;padding:0 8px;font-weight:600}
textarea{width:100%;box-sizing:border-box;min-height:140px;background:var(--box);color:var(--fg);border:1px solid var(--rule);border-radius:6px;padding:8px;font:13px/1.5 ui-monospace,Menlo,monospace}
.row{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--accent);background:none;color:var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:var(--bg)}.empty{color:var(--muted)}
</style>
<h1>书童转发站</h1><p class="m">复制提示词到任意 AI，把回答粘回来交给书童。页面每 3 秒刷新任务列表。</p>
<div id="list"></div>
<script>
const list=document.getElementById('list');const drafts={};
async function load(){
  const tasks=await fetch('/api/tasks').then(r=>r.json()).catch(()=>[]);
  for(const el of list.querySelectorAll('textarea'))drafts[el.dataset.id]=el.value;
  if(!tasks.length){list.innerHTML='<p class="empty">现在没有待处理的任务。在书童里点一个生成按钮，任务会出现在这里。</p>';return}
  list.innerHTML=tasks.map(t=>'<div class="task"><div class="meta"><span class="chip">'+t.platform+'</span><span>'+t.id+'</span><span>'+t.chars+' 字</span>'+(t.json?'<span>要求 JSON</span>':'')+'</div><div>'+t.preview.replace(/</g,'&lt;')+'…</div>'+(t.state==='auto'?'<p class="empty">命令行正在自动处理，完成后会自动交回。</p></div>':'<div class="row"><button data-copy="'+t.id+'">复制提示词</button></div><textarea data-id="'+t.id+'" placeholder="把 AI 的回答粘贴到这里"></textarea><div class="row"><button class="primary" data-send="'+t.id+'">交回书童</button></div></div>')).join('');
  for(const el of list.querySelectorAll('textarea'))el.value=drafts[el.dataset.id]||'';
}
list.addEventListener('click',async e=>{
  const copy=e.target.dataset.copy,send=e.target.dataset.send;
  if(copy){const d=await fetch('/api/tasks/'+copy).then(r=>r.json());await navigator.clipboard.writeText(d.task.prompt);e.target.textContent='已复制'}
  if(send){const content=list.querySelector('textarea[data-id="'+send+'"]').value;if(!content.trim())return;
    const r=await fetch('/api/tasks/'+send+'/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
    e.target.textContent=r.ok?'已交回':'提交失败';delete drafts[send];setTimeout(load,500)}
});
load();setInterval(()=>{if(!list.contains(document.activeElement)||document.activeElement.tagName!=='TEXTAREA')load()},3000);
</script></html>`

// ===== 入口 =====

const [mode, ...args] = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

if (mode === 'serve') {
  serve()
} else if (mode === 'mcp') {
  const platform = flag('platform')
  if (platform && !PLATFORM_RE.test(platform)) {
    process.stderr.write('平台名只能用小写字母、数字和连字符\n')
    process.exit(1)
  }
  mcp(platform)
} else {
  process.stderr.write('用法：\n  node relay.mjs serve                 启动转发站\n  node relay.mjs mcp --platform claude  作为 MCP 服务器运行（供 AI 工具调用）\n')
  process.exit(1)
}
