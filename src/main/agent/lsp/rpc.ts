// Minimal JSON-RPC 2.0 over a child process's stdio with LSP Content-Length
// framing. Dependency-free, like the rest of the agent's plumbing — the small
// slice of the protocol we need is not worth a client library.
import { ChildProcess } from 'node:child_process'

export type RpcMessage = Record<string, unknown>

/**
 * Incremental frame parser: feed it stdout chunks, get back complete JSON-RPC
 * messages. Split out from the connection so framing is unit-testable.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): RpcMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const out: RpcMessage[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) break
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const m = /content-length:\s*(\d+)/i.exec(header)
      if (!m) {
        // Malformed header block — drop it and resync on the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(m[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) break
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        const parsed: unknown = JSON.parse(body)
        if (parsed && typeof parsed === 'object') out.push(parsed as RpcMessage)
      } catch {
        // Skip an unparsable body rather than wedging the stream.
      }
    }
    return out
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export class JsonRpcConnection {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private parser = new FrameParser()
  private notificationHandlers = new Map<string, (params: unknown) => void>()
  private requestHandlers = new Map<string, (params: unknown) => unknown>()
  private closed = false
  private closeReason = 'connection closed'

  constructor(private child: ChildProcess) {
    child.stdout?.on('data', (d: Buffer) => {
      for (const msg of this.parser.push(d)) this.dispatch(msg)
    })
    child.on('error', (err) => this.close(`language server failed to start: ${err.message}`))
    child.on('close', (code) => this.close(`language server exited (code ${code})`))
  }

  get isClosed(): boolean {
    return this.closed
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  /** Handle a server→client request (servers do send them: configuration,
   *  capability registration, progress tokens). Unhandled methods get a
   *  MethodNotFound error response so the server never hangs on us. */
  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler)
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.closeReason))
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  private send(msg: RpcMessage): void {
    if (this.closed || !this.child.stdin?.writable) return
    const body = Buffer.from(JSON.stringify(msg), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  private dispatch(msg: RpcMessage): void {
    const { id, method } = msg
    if (typeof method === 'string' && id !== undefined) {
      // Server→client request.
      const handler = this.requestHandlers.get(method)
      if (handler) {
        try {
          this.send({ jsonrpc: '2.0', id, result: handler(msg.params) ?? null })
        } catch (e) {
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) }
          })
        }
      } else {
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unhandled method ${method}` } })
      }
      return
    }
    if (typeof method === 'string') {
      this.notificationHandlers.get(method)?.(msg.params)
      return
    }
    if (typeof id === 'number') {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      const err = msg.error as { code?: number; message?: string } | undefined
      if (err) p.reject(new Error(`server error ${err.code ?? ''}: ${err.message ?? 'unknown'}`.trim()))
      else p.resolve(msg.result)
    }
  }
}
