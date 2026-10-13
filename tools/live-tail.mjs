// Reads a project's live feed (JSON lines) as it grows. Shared by the single-project server and the hub.
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync } from 'node:fs'

// The feed file is emptied in place (tee appends, so a rename would drop lines) once it is read to the end past this size.
const FEED_CAP = 8 * 1024 * 1024
// A line longer than this is dropped (and counted): a huge or sparse file cannot stall the server.
const LINE_MAX = 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

// The file is opened only if it is a plain file (not a link) and the opened handle is the file that was looked at.
function openPlain(path, flags) {
  const found = lstatSync(path, { throwIfNoEntry: false })
  if (!found || !found.isFile()) return undefined
  const fd = openSync(path, flags | NOFOLLOW)
  const opened = fstatSync(fd)
  if (opened.dev !== found.dev || opened.ino !== found.ino) {
    closeSync(fd)
    return undefined
  }
  return { fd, info: opened }
}

// `onLine(line)` gets every valid line once. `recent` keeps the newest lines (by count and by bytes) to replay to a new connection.
export function makeTail(feed, { onLine, readMax = 8 * 1024 * 1024, recentMax = 2000, recentBytes = 4 * 1024 * 1024 }) {
  let offset = 0
  // The unfinished end of the file, as bytes: a character that is only half written (Korean is three bytes) must not be decoded until it is whole.
  let rest = Buffer.alloc(0)
  let fileId = ''
  let held = 0
  const tail = { recent: [], linesRead: 0, badLines: 0, lastAt: 0, pump: undefined }

  const forget = () => {
    offset = 0
    rest = Buffer.alloc(0)
  }

  tail.pump = () => {
    try {
      const found = lstatSync(feed, { throwIfNoEntry: false })
      if (!found || !found.isFile()) {
        forget()
        fileId = ''
        return
      }
      // The file was replaced (another inode): read the new one from its start. Birth time is not reliable on every file system.
      const id = `${found.dev}:${found.ino}`
      if (fileId !== '' && id !== fileId) forget()
      fileId = id
      if (found.size < offset) forget()
      if (found.size === offset) return
      const opened = openPlain(feed, 0)
      if (!opened) return
      let chunk
      try {
        const buffer = Buffer.alloc(Math.min(opened.info.size - offset, readMax))
        const got = readSync(opened.fd, buffer, 0, buffer.length, offset)
        chunk = buffer.subarray(0, got)
        offset += got
      } finally {
        closeSync(opened.fd)
      }
      let data = Buffer.concat([rest, chunk])
      for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a)) {
        const raw = data.subarray(0, at)
        data = data.subarray(at + 1)
        if (raw.length === 0) continue
        if (raw.length > LINE_MAX) {
          tail.badLines++
          continue
        }
        const line = raw.toString('utf8').replace(/\r$/, '')
        // A line that is not one JSON object (two writers interleaved, a torn write) would break the page's reader and the stream's framing.
        try {
          const parsed = JSON.parse(line)
          if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        } catch {
          tail.badLines++
          continue
        }
        tail.linesRead++
        tail.lastAt = Date.now()
        tail.recent.push(line)
        held += raw.length
        while (tail.recent.length > recentMax || (held > recentBytes && tail.recent.length > 1)) held -= Buffer.byteLength(tail.recent.shift() ?? '')
        onLine(line)
      }
      // The unfinished end waits for its newline; one that never ends is not kept past the limit.
      rest = data.length > LINE_MAX ? Buffer.alloc(0) : Buffer.from(data)
      // Everything is read and no line is half written: a line the plugin appends in these few instructions is lost, which the live view tolerates.
      if (offset > FEED_CAP && rest.length === 0 && lstatSync(feed, { throwIfNoEntry: false })?.size === offset) {
        const writable = openPlain(feed, constants.O_WRONLY)
        if (writable) {
          try {
            ftruncateSync(writable.fd, 0)
            offset = 0
          } finally {
            closeSync(writable.fd)
          }
        }
      }
    } catch {
      // The file vanished or is mid-write; the next tick tries again.
    }
  }

  return tail
}
