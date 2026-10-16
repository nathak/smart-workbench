// Reads the hub's /events?all=1 stream and hands each frame to a callback. Reconnects until stopped.
export function parseFrames(buffer) {
  const frames = []
  let rest = buffer
  for (;;) {
    const at = rest.indexOf('\n\n')
    if (at < 0) break
    const block = rest.slice(0, at)
    rest = rest.slice(at + 2)
    let event = 'message'
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length) frames.push({ event, data: data.join('\n') })
  }
  return { frames, rest }
}

export function followHub({ port, onSessions, onLine, onState = () => {}, fetchImpl = fetch, retryMs = 3000 }) {
  let stopped = false
  let abort
  async function run() {
    while (!stopped) {
      abort = new AbortController()
      try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/events?all=1`, { signal: abort.signal })
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`)
        onState(true)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let ready = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseFrames(buffer)
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            if (frame.event === 'ready') {
              ready = true
              continue
            }
            let body
            try {
              body = JSON.parse(frame.data)
            } catch {
              continue
            }
            if (frame.event === 'sessions') onSessions(Array.isArray(body.sessions) ? body.sessions : [])
            // Lines replayed before "ready" are history, not news.
            else if (frame.event === 'line' && typeof body.s === 'string') {
              // History before "ready" is not news, except an ask that may still wait (its tool.end clears it) and the ends that match.
              if (ready || body.e?.kind === 'tool.end' || body.e?.kind === 'tool.denied' || (body.e?.kind === 'tool.start' && body.e?.policy === 'ask')) onLine(body.s, body.e)
            }
          }
        }
      } catch {
        // The hub is down or restarting; try again below.
      }
      onState(false)
      if (!stopped) await new Promise(resolve => setTimeout(resolve, retryMs))
    }
  }
  void run()
  return {
    stop() {
      stopped = true
      abort?.abort()
    },
  }
}
